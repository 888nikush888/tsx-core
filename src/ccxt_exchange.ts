import { getDatabase } from './db.js';
import { correlateNativeOrderEvidence } from './trading_order_identity_bindings.js';
import { correlateRemoteFills, correlateRemoteOrders, type LocalCorrelationOrder } from './exchange_order_correlation.js';
import type { TradingCredentialStore } from './trading_credentials.js';
import type {
  ExchangeOpenState,
  ExchangeOrderRequest,
  ExchangeOrderResult,
  ExchangeEntryConstraints,
  ExchangeStreamBatch,
  ExchangeStreamEventType,
  TradingAccount,
  TradingAccountSnapshot,
  TradingExchange,
  TradingExchangeAdapter,
  TradingMarketSnapshot,
} from './trading_types.js';
import { tradingExchangeId } from './trading_types.js';
import { exchangeRecoveryQuery } from './trading_recovery.js';
import { reserveScheduledRecovery, failScheduledRecovery, scheduledRecoveryDeadline, usesScheduledFxRecovery } from './trading_recovery_schedule_repository.js';
import { requireFxAccountContext } from './trading_fx_repository.js';
import { validateRecoveryScheduleProgress } from './trading_recovery_schedule_contract.js';
import { assertHistoryResponse } from './exchange_history_contract.js';
import { assertCompleteFillCoverage } from './exchange_history_coverage.js';
import { assertAccountLogResponse } from './trading_account_log_contract.js';
import { assertAccountModeResponse } from './trading_account_mode_contract.js';
import { observedFundingEvidence } from './trading_funding_observation.js';
import { bindAccountReportingCurrency } from './trading_money_ledger.js';
import { assertAccountModeObservation, assertEntryModeEvidence, rejectModeReadback } from './trading_execution_constraints.js';
import { TradingSymbolUnavailableError, TradingUnresolvedOrderError } from './trading_errors.js';
import { internalExecutorOrigin } from './executor_origin.js';
import { captureEntryDeadline } from './exchange_entry_deadline.js';
import {
  confirmedOrderEvidence, validateAccountSnapshot, validateMarketSnapshot, validateOpenState, validateOrderResult,
} from './exchange_contract_validation.js';

interface ExecutorErrorPayload {
  error?: string;
  code?: string;
  sideEffects?: boolean;
  details?: { exchange?: string; accountId?: string; symbol?: string; confirmedOrders?: unknown };
}

class ExecutorHttpError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'ExecutorHttpError';
  }
}

export interface VerifiedExternalAccount {
  verified: boolean;
  entryAllowed: false;
  reason: null;
  equity: string;
  externalAccountId: string;
  accountFingerprint: string;
  credentialGeneration: string;
  capabilities?: Record<string, unknown>;
}

function executorUrl(): string {
  return internalExecutorOrigin(process.env.EXCHANGE_EXECUTOR_URL);
}

function accountPayload(account: TradingAccount): Record<string, string> {
  return { id: account.id, exchange: account.exchange, mode: account.mode };
}

function boundAccountPayload(account: TradingAccount): Record<string, string> {
  if (!account.externalAccountId || !/^[a-f0-9]{64}$/.test(account.externalAccountId)
    || !account.credentialGeneration || !/^[a-f0-9]{64}$/.test(account.credentialGeneration)) {
    throw new Error('Verify the exchange account before submitting or cancelling orders: identity binding is missing.');
  }
  return {
    ...accountPayload(account),
    expectedAccountFingerprint: account.externalAccountId,
    credentialGeneration: account.credentialGeneration,
  };
}

function assertObject(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} returned an invalid contract.`);
  return value as Record<string, any>;
}

function isTypedSymbolUnavailableResponse(input: {
  endpoint: string;
  status: number;
  body: ExecutorErrorPayload;
  request: Record<string, any>;
  exchange: CcxtExchangeAdapter['exchange'];
}): input is typeof input & { body: ExecutorErrorPayload & {
  error?: string;
  details: { exchange: string; accountId: string; symbol: string };
} } {
  const account = input.request.account;
  const details = input.body.details;
  return input.endpoint === '/v1/market-snapshot'
    && input.status === 422
    && input.body.code === 'SYMBOL_UNAVAILABLE'
    && input.body.sideEffects === false
    && Boolean(account && typeof account === 'object' && !Array.isArray(account))
    && typeof input.request.symbol === 'string'
    && details?.exchange === input.exchange
    && details.accountId === account.id
    && details.symbol === input.request.symbol;
}

const STREAM_EVENT_TYPES = new Set<ExchangeStreamEventType>([
  'order',
  'execution',
  'position',
  'market',
  'candle',
  'stream_status',
]);

const RETRYABLE_READ_ENDPOINTS = new Set([
  '/v1/verify-account',
  '/v1/entry-constraints',
  '/v1/account-snapshot',
  '/v1/market-snapshot',
  '/v1/open-state',
  '/v1/stream-events',
]);

function executorReadAttempts(endpoint: string, payload: Record<string, any>): number {
  const budgeted = endpoint === '/v1/open-state'
    && (payload.recovery?.accountLogs !== undefined || payload.recovery?.recoverySchedule !== undefined);
  return !budgeted && RETRYABLE_READ_ENDPOINTS.has(endpoint) ? 3 : 1;
}

function retryableExecutorStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

function retryableTransportFailure(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : 'unknown transport failure';
  return /(?:timeout|timed out|abort(?:ed|error)?|fetch failed|econn(?:reset|refused)|temporarily unavailable)/i.test(message);
}

function retryableExecutorFailure(error: unknown): boolean {
  return error instanceof ExecutorHttpError
    ? error.retryable
    : retryableTransportFailure(error);
}

async function waitForExecutorRetry(attempt: number, deadlineAt: number): Promise<boolean> {
  const availableBackoff = deadlineAt - Date.now();
  if (availableBackoff <= 0) return false;
  const backoffMs = attempt === 1 ? 100 : 250;
  await new Promise(resolve => setTimeout(resolve, Math.min(backoffMs, availableBackoff)));
  return true;
}

function isSafeIntegerAtLeast(value: unknown, minimum: number): boolean {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}

function isNullableTimestamp(value: unknown): boolean {
  return value === null || isSafeIntegerAtLeast(value, 0);
}

function isNullableSequence(value: unknown): boolean {
  return value === null || Number.isSafeInteger(value);
}

function isNullableSymbol(value: unknown): boolean {
  return value === null || (typeof value === 'string' && value.length <= 40);
}

function assertStreamHealth(value: unknown): void {
  const health = assertObject(value, 'Exchange stream health');
  const statusValid = ['starting', 'healthy', 'degraded', 'stopped'].includes(health.status);
  const errorValid = health.lastError === null || typeof health.lastError === 'string';
  if (!statusValid || !isNullableTimestamp(health.startedAt)
    || !isNullableTimestamp(health.lastEventAt) || !errorValid) {
    throw new Error('Exchange executor returned invalid stream health.');
  }
}

function assertStreamEvent(value: unknown): void {
  const event = assertObject(value, 'Exchange stream event');
  const keyValid = typeof event.eventKey === 'string' && /^[a-f0-9]{64}$/.test(event.eventKey);
  const typeValid = STREAM_EVENT_TYPES.has(event.eventType);
  if (!isSafeIntegerAtLeast(event.cursor, 1) || !keyValid || !typeValid
    || !isNullableSymbol(event.symbol) || !isNullableSequence(event.sequence)
    || !isSafeIntegerAtLeast(event.occurredAt, 0) || !isSafeIntegerAtLeast(event.receivedAt, 0)) {
    throw new Error('Exchange executor returned an invalid stream event.');
  }
}

function assertStreamBatch(value: unknown): ExchangeStreamBatch {
  const batch = assertObject(value, 'Exchange stream');
  const eventsValid = Array.isArray(batch.events);
  if (!eventsValid || !isSafeIntegerAtLeast(batch.nextCursor, 0) || typeof batch.gap !== 'boolean') {
    throw new Error('Exchange executor returned an invalid stream batch contract.');
  }
  assertStreamHealth(batch.health);
  batch.events.forEach(assertStreamEvent);
  return batch as ExchangeStreamBatch;
}

export class CcxtExchangeAdapter implements TradingExchangeAdapter {
  readonly exchange: TradingExchange;
  private readonly baseUrl: string;

  constructor(exchange: string, private readonly credentials: TradingCredentialStore) {
    this.exchange = tradingExchangeId(exchange);
    if (this.exchange === 'paper') throw new Error('Paper trading must use the isolated paper adapter.');
    this.baseUrl = executorUrl();
  }

  async verifyAccount(account: TradingAccount): Promise<VerifiedExternalAccount> {
    const result = assertObject(
      await this.post('/v1/verify-account', { account: accountPayload(account) }, 30_000),
      'Exchange executor',
    );
    if (typeof result.verified !== 'boolean' || typeof result.equity !== 'string'
      || typeof result.externalAccountId !== 'string' || !/^[a-f0-9]{64}$/.test(result.externalAccountId)
      || typeof result.credentialGeneration !== 'string' || !/^[a-f0-9]{64}$/.test(result.credentialGeneration)
      || result.accountFingerprint !== result.externalAccountId) {
      throw new Error('Exchange executor returned an invalid verified-account identity contract.');
    }
    if (result.verified === false) rejectModeReadback(result.reason);
    if (result.capabilities !== undefined && (!result.capabilities || typeof result.capabilities !== 'object'
      || Array.isArray(result.capabilities))) {
      throw new Error('Exchange executor returned invalid account capabilities.');
    }
    assertAccountModeObservation(account, result);
    return result as unknown as VerifiedExternalAccount;
  }

  async accountSnapshot(account: TradingAccount): Promise<TradingAccountSnapshot> {
    const result = assertObject(
      await this.post('/v1/account-snapshot', { account: boundAccountPayload(account) }, 30_000),
      'Exchange executor',
    );
    for (const field of ['equity', 'availableBalance', 'unrealizedPnl', 'marginUsed', 'fundingPnlToday']) {
      if (typeof result[field] !== 'string' && !(field === 'fundingPnlToday' && result[field] === null)) {
        throw new TypeError(`Exchange executor account snapshot omitted ${field}.`);
      }
    }
    const snapshot = validateAccountSnapshot(result);
    if (snapshot.accounting && snapshot.accounting.accountFingerprint !== account.externalAccountId) {
      throw new Error('Accounting evidence does not match the requested account fingerprint.');
    }
    if (!snapshot.accounting) throw new Error('Account snapshot omitted its accounting reporting unit.');
    await bindAccountReportingCurrency({ accountId: account.id, accountFingerprint: snapshot.accounting.accountFingerprint,
      profile: account.exchange, reportingCurrency: snapshot.accounting.reportingCurrency, settlementAssets: snapshot.accounting.settlementAssets,
      source: snapshot.accounting.source, verifiedAt: snapshot.accounting.observedAt });
    const funding = await observedFundingEvidence(account);
    return { ...snapshot, fundingPnlToday: funding.observation?.amount ?? null,
      fundingPnlTodayValue: funding.observation?.value ?? null, accounting: { ...snapshot.accounting, funding } };
  }

  async entryConstraints(account: TradingAccount, symbol: string): Promise<ExchangeEntryConstraints> {
    const evidence = await this.post('/v1/entry-constraints', { account: boundAccountPayload(account), symbol }) as ExchangeEntryConstraints;
    assertEntryModeEvidence(account, symbol, evidence);
    return evidence;
  }

  async marketSnapshot(account: TradingAccount, symbol: string): Promise<TradingMarketSnapshot> {
    return validateMarketSnapshot(await this.post(
        '/v1/market-snapshot',
        { account: boundAccountPayload(account), symbol },
      30_000,
    ), symbol);
  }

  async submitOrder(account: TradingAccount, request: ExchangeOrderRequest): Promise<ExchangeOrderResult> {
    const timeoutSeconds = Number.isSafeInteger(request.timeoutSeconds)
      && request.timeoutSeconds >= 2
      && request.timeoutSeconds <= 30
      ? request.timeoutSeconds
      : 12;
    return validateOrderResult(await this.post(
      '/v1/submit-order',
      { account: boundAccountPayload(account), request },
      timeoutSeconds * 1_000,
    ), request);
  }

  async submitProtectedEntry(
    account: TradingAccount,
    entry: ExchangeOrderRequest,
    protectiveStop: ExchangeOrderRequest,
  ): Promise<{ entry: ExchangeOrderResult; protectiveStop: ExchangeOrderResult }> {
    const timeoutSeconds = Number.isSafeInteger(entry.timeoutSeconds)
      && entry.timeoutSeconds >= 2
      && entry.timeoutSeconds <= 30
      ? entry.timeoutSeconds
      : 12;
    const result = assertObject(await this.post(
      '/v1/submit-protected-entry',
      { account: boundAccountPayload(account), entry, protectiveStop },
      timeoutSeconds * 1_000,
    ), 'Exchange executor');
    const confirmed = confirmedOrderEvidence([result.entry, result.protectiveStop], [entry, protectiveStop]);
    if (confirmed.length !== 2) {
      throw new TradingUnresolvedOrderError('Protected order acknowledgement is incomplete or has conflicting identities.', confirmed);
    }
    return {
      entry: confirmed[0],
      protectiveStop: confirmed[1],
    };
  }

  async cancelOrder(account: TradingAccount, clientOrderId: string): Promise<ExchangeOrderResult> {
    const local = await getDatabase().get<{ symbol: string; exchange_order_id: string | null; provider_symbol: string | null; quantity: string }>(
      `SELECT intent.symbol, orders.exchange_order_id, orders.provider_symbol, orders.quantity FROM trading_orders AS orders
       JOIN trading_trade_intents AS intent ON intent.id = orders.intent_id
       WHERE orders.account_id = ? AND orders.client_order_id = ?`,
      [account.id, clientOrderId],
    );
    if (!local) throw new Error('Cannot cancel an order without a local symbol mapping.');
    return validateOrderResult(await this.post('/v1/cancel-order', {
      account: boundAccountPayload(account),
      clientOrderId,
      exchangeOrderId: local.exchange_order_id,
      providerSymbol: local.provider_symbol,
      symbol: local.symbol,
    }), { clientOrderId, exchangeOrderId: local.exchange_order_id, quantity: local.quantity });
  }

  async openState(account: TradingAccount): Promise<ExchangeOpenState> {
    account = structuredClone(account);
    const initial = await exchangeRecoveryQuery(account);
    const recovery = usesScheduledFxRecovery(account) ? await reserveScheduledRecovery(account, initial) : initial;
    try { return await this.readOpenState(account, recovery); } catch (error) {
      if (recovery.recoverySchedule) await failScheduledRecovery(account, recovery.recoverySchedule.attemptId, 'read_failed');
      throw error;
    }
  }

  private async readOpenState(account: TradingAccount, recovery: Awaited<ReturnType<typeof exchangeRecoveryQuery>>): Promise<ExchangeOpenState> {
    const absoluteDeadline = await scheduledRecoveryDeadline(account, recovery);
    const response = assertObject(
      await this.post('/v1/open-state', { account: recovery.accountLogs || recovery.readAccountMode || recovery.recoverySchedule
        ? boundAccountPayload(account) : accountPayload(account), recovery }, 30_000, absoluteDeadline),
      'Exchange executor',
    );
    if (!Array.isArray(response.orders) || !Array.isArray(response.positions) || !Array.isArray(response.fills)) {
      throw new TypeError('Exchange executor returned an invalid open-state contract.');
    }
    if (typeof response.accountFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(response.accountFingerprint)) {
      throw new Error('Exchange executor returned an invalid account fingerprint.');
    }
    if (!response.acquisition) throw new Error('Exchange executor omitted acquisition evidence.');
    const state = validateOpenState(response, account.externalAccountId);
    assertHistoryResponse(recovery.history, state.acquisition!.history);
    assertCompleteFillCoverage(account.exchange, state.acquisition!, recovery.since);
    const requested = new Set(recovery.orders.map(order => order.clientOrderId));
    if (state.acquisition!.checkedOrders.length !== requested.size
      || state.acquisition!.checkedOrders.some(order => !requested.has(order.clientOrderId))) {
      throw new Error('Exchange acquisition evidence does not match the requested recovery scope.');
    }
    assertAccountLogResponse(recovery.accountLogs, state.acquisition!.accountLogs);
    assertAccountModeResponse(recovery.readAccountMode, state.acquisition!.accountMode,
      { accountFingerprint: account.externalAccountId, credentialGeneration: account.credentialGeneration });
    if (recovery.recoverySchedule) {
      const context = await requireFxAccountContext(account);
      validateRecoveryScheduleProgress(state.acquisition!.recoverySchedule, recovery, state.acquisition!, {
        accountId: account.id, accountFingerprint: account.externalAccountId!, credentialGeneration: account.credentialGeneration!,
        mode: context.mode, executionProfileHash: context.profileHash,
      });
    } else if (state.acquisition!.recoverySchedule || state.acquisition!.fxEvidence) throw new Error('Unexpected scheduled recovery evidence.');
    state.orders = await correlateNativeOrderEvidence(account, state.orders);
    const localOrders = await getDatabase().all<LocalCorrelationOrder[]>(
      `SELECT orders.client_order_id, orders.exchange_order_id, orders.provider_symbol, orders.role, intent.symbol,
              orders.trigger_price, orders.reduce_only, orders.side, orders.quantity
       FROM trading_orders AS orders
       JOIN trading_trade_intents AS intent ON intent.id = orders.intent_id
       WHERE orders.account_id = ?`,
      [account.id],
    );
    // Parameter similarity is not an ownership proof, including attached stops.
    // Unbound provider-created stops await explicit parent/batch evidence.
    state.orders = correlateRemoteOrders(localOrders, state.orders);
    state.fills = correlateRemoteFills(localOrders, state.fills);
    return state as ExchangeOpenState;
  }

  async streamEvents(
    account: TradingAccount,
    cursor: number,
    symbols: string[],
  ): Promise<ExchangeStreamBatch> {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Exchange stream cursor is invalid.');
    if (!Array.isArray(symbols) || symbols.length > 100
      || symbols.some(symbol => !/^[A-Z0-9]{2,30}(?:USD|USDC|USDT)$/.test(symbol))) {
      throw new Error('Exchange stream symbols must be bounded USD pairs.');
    }
    return assertStreamBatch(await this.post('/v1/stream-events', {
      account: accountPayload(account),
      cursor,
      symbols: [...new Set(symbols)].sort((left, right) => left.localeCompare(right)),
    }, 30_000));
  }

  private async post(endpoint: string, payload: unknown, timeoutMs = 12_000, absoluteDeadline = Infinity): Promise<unknown> {
    const originalPayload = assertObject(payload, 'Exchange executor request');
    const entryDeadline = captureEntryDeadline(endpoint, originalPayload);
    const bodyPayload = structuredClone(originalPayload);
    const deadlineAt = Math.min(Date.now() + Math.max(1, timeoutMs - 250), entryDeadline.expiresAt ?? Infinity, absoluteDeadline);
    const token = await this.credentials.getOrCreateExecutorToken();
    entryDeadline.assertCurrent();
    const maximumAttempts = executorReadAttempts(endpoint, bodyPayload);
    let lastError: unknown;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      entryDeadline.assertCurrent();
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) break;
      try {
        return await this.postOnce(endpoint, bodyPayload, token, deadlineAt, timeoutMs, remainingMs);
      } catch (error) {
        lastError = error;
        if (!retryableExecutorFailure(error) || attempt === maximumAttempts) throw error;
      }
      if (!await waitForExecutorRetry(attempt, deadlineAt)) break;
    }
    throw lastError instanceof Error ? lastError : new Error('Exchange executor request timed out.');
  }

  private async postOnce(
    endpoint: string,
    bodyPayload: Record<string, any>,
    token: string,
    deadlineAt: number,
    timeoutMs: number,
    remainingMs: number,
  ): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...bodyPayload, deadlineAt }),
      signal: AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, remainingMs))),
    });
    const body = await response.json().catch(() => ({})) as ExecutorErrorPayload;
    if (response.ok) return body;
    if (body.code === 'ORDER_OUTCOME_UNRESOLVED' && body.sideEffects === true
      && ['/v1/submit-order', '/v1/submit-protected-entry', '/v1/cancel-order'].includes(endpoint)) {
      const requests = endpoint === '/v1/submit-protected-entry'
        ? [bodyPayload.entry, bodyPayload.protectiveStop]
        : [bodyPayload.request || bodyPayload];
      throw new TradingUnresolvedOrderError(
        'Exchange order outcome is unresolved; authoritative reconciliation is required.',
        confirmedOrderEvidence(body.details?.confirmedOrders, requests),
      );
    }
    if (isTypedSymbolUnavailableResponse({
      endpoint, status: response.status, body, request: bodyPayload, exchange: this.exchange,
    })) {
      throw new TradingSymbolUnavailableError(
        body.error || 'The requested symbol is unavailable on this exchange account.',
        body.details,
      );
    }
    const code = typeof body.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(body.code)
      ? ` [${body.code}]`
      : '';
    throw new ExecutorHttpError(
      `Exchange executor request failed (${response.status}): ${body.error || 'invalid response'}${code}`,
      retryableExecutorStatus(response.status),
    );
  }
}
