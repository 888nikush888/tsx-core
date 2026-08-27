import { getDatabase } from './db.js';
import { compareDecimal } from './trading_decimal.js';
import type { TradingCredentialStore } from './trading_credentials.js';
import type {
  ExchangeOpenState,
  ExchangeOrderRequest,
  ExchangeOrderResult,
  ExchangeStreamBatch,
  ExchangeStreamEventType,
  TradingAccount,
  TradingAccountSnapshot,
  TradingExchangeAdapter,
  TradingMarketSnapshot,
} from './trading_types.js';
import { TradingSymbolUnavailableError } from './trading_errors.js';

interface ExecutorErrorPayload {
  error?: string;
  code?: string;
  sideEffects?: boolean;
  details?: { exchange?: string; accountId?: string; symbol?: string };
}

class ExecutorHttpError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'ExecutorHttpError';
  }
}

export interface VerifiedExternalAccount {
  verified: boolean;
  equity: string;
  externalAccountId: string;
  accountFingerprint: string;
  capabilities?: Record<string, unknown>;
}

function executorUrl(): string {
  const value = process.env.EXCHANGE_EXECUTOR_URL?.trim() || 'http://exchange-executor:8090';
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('EXCHANGE_EXECUTOR_URL must be a plain internal HTTP origin.');
  }
  return parsed.origin;
}

function accountPayload(account: TradingAccount): Record<string, string> {
  return { id: account.id, exchange: account.exchange, mode: account.mode };
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

function assertOrderResult(value: unknown): ExchangeOrderResult {
  const result = assertObject(value, 'Exchange executor');
  if (typeof result.clientOrderId !== 'string' || typeof result.exchangeOrderId !== 'string') {
    throw new TypeError('Exchange executor returned an invalid order identifier contract.');
  }
  if (!['open', 'partially_filled', 'filled', 'cancelled', 'rejected', 'unknown'].includes(result.status)) {
    throw new Error('Exchange executor returned an invalid order status.');
  }
  return result as ExchangeOrderResult;
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
  '/v1/account-snapshot',
  '/v1/market-snapshot',
  '/v1/open-state',
  '/v1/stream-events',
]);

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
  readonly exchange: 'hyperliquid' | 'bybit' | 'krakenfutures';
  private readonly baseUrl: string;

  constructor(exchange: 'hyperliquid' | 'bybit' | 'krakenfutures', private readonly credentials: TradingCredentialStore) {
    this.exchange = exchange;
    this.baseUrl = executorUrl();
  }

  async verifyAccount(account: TradingAccount): Promise<VerifiedExternalAccount> {
    const result = assertObject(
      await this.post('/v1/verify-account', { account: accountPayload(account) }, 30_000),
      'Exchange executor',
    );
    if (result.verified !== true || typeof result.equity !== 'string'
      || typeof result.externalAccountId !== 'string' || !/^[a-f0-9]{64}$/.test(result.externalAccountId)
      || result.accountFingerprint !== result.externalAccountId) {
      throw new Error('Exchange executor returned an invalid verified-account identity contract.');
    }
    if (result.capabilities !== undefined && (!result.capabilities || typeof result.capabilities !== 'object'
      || Array.isArray(result.capabilities))) {
      throw new Error('Exchange executor returned invalid account capabilities.');
    }
    return result as unknown as VerifiedExternalAccount;
  }

  async accountSnapshot(account: TradingAccount): Promise<TradingAccountSnapshot> {
    const result = assertObject(
      await this.post('/v1/account-snapshot', { account: accountPayload(account) }, 30_000),
      'Exchange executor',
    );
    for (const field of ['equity', 'availableBalance', 'unrealizedPnl', 'marginUsed', 'fundingPnlToday']) {
      if (typeof result[field] !== 'string') {
        throw new TypeError(`Exchange executor account snapshot omitted ${field}.`);
      }
    }
    return result as TradingAccountSnapshot;
  }

  async marketSnapshot(account: TradingAccount, symbol: string): Promise<TradingMarketSnapshot> {
    return this.post(
      '/v1/market-snapshot',
      { account: accountPayload(account), symbol },
      30_000,
    ) as Promise<TradingMarketSnapshot>;
  }

  async submitOrder(account: TradingAccount, request: ExchangeOrderRequest): Promise<ExchangeOrderResult> {
    const timeoutSeconds = Number.isSafeInteger(request.timeoutSeconds)
      && request.timeoutSeconds >= 2
      && request.timeoutSeconds <= 30
      ? request.timeoutSeconds
      : 12;
    return assertOrderResult(await this.post(
      '/v1/submit-order',
      { account: accountPayload(account), request },
      timeoutSeconds * 1_000,
    ));
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
      { account: accountPayload(account), entry, protectiveStop },
      timeoutSeconds * 1_000,
    ), 'Exchange executor');
    return {
      entry: assertOrderResult(result.entry),
      protectiveStop: assertOrderResult(result.protectiveStop),
    };
  }

  async cancelOrder(account: TradingAccount, clientOrderId: string): Promise<ExchangeOrderResult> {
    const local = await getDatabase().get<{ symbol: string }>(
      `SELECT intent.symbol FROM trading_orders AS orders
       JOIN trading_trade_intents AS intent ON intent.id = orders.intent_id
       WHERE orders.account_id = ? AND orders.client_order_id = ?`,
      [account.id, clientOrderId],
    );
    if (!local) throw new Error('Cannot cancel an order without a local symbol mapping.');
    return assertOrderResult(await this.post('/v1/cancel-order', {
      account: accountPayload(account),
      clientOrderId,
      symbol: local.symbol,
    }));
  }

  async openState(account: TradingAccount): Promise<ExchangeOpenState> {
    const state = assertObject(
      await this.post('/v1/open-state', { account: accountPayload(account) }, 30_000),
      'Exchange executor',
    );
    if (!Array.isArray(state.orders) || !Array.isArray(state.positions) || !Array.isArray(state.fills)) {
      throw new TypeError('Exchange executor returned an invalid open-state contract.');
    }
    if (typeof state.accountFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(state.accountFingerprint)) {
      throw new Error('Exchange executor returned an invalid account fingerprint.');
    }
    const localOrders = await getDatabase().all<Array<{
      client_order_id: string;
      exchange_order_id: string | null;
      role: string;
      symbol: string;
      trigger_price: string | null;
      reduce_only: number;
      side: string;
      quantity: string;
    }>>(
      `SELECT orders.client_order_id, orders.exchange_order_id, orders.role, intent.symbol,
              orders.trigger_price, orders.reduce_only, orders.side, orders.quantity
       FROM trading_orders AS orders
       JOIN trading_trade_intents AS intent ON intent.id = orders.intent_id
       WHERE orders.account_id = ?`,
      [account.id],
    );
    const roles = new Map(localOrders.map(order => [order.client_order_id, order.role]));
    const byExchangeId = new Map(localOrders
      .filter(order => Boolean(order.exchange_order_id))
      .map(order => [order.exchange_order_id!, order]));
    const decimalEquals = (left: unknown, right: unknown) => {
      if (typeof left !== 'string' || typeof right !== 'string') return false;
      try {
        return compareDecimal(left, right) === 0;
      } catch {
        return false;
      }
    };
    state.orders = state.orders.map((order: any) => {
      const exactClient = typeof order.clientOrderId === 'string'
        ? localOrders.find(local => local.client_order_id === order.clientOrderId)
        : undefined;
      const exactExchange = typeof order.exchangeOrderId === 'string'
        ? byExchangeId.get(order.exchangeOrderId)
        : undefined;
      const attachedStops = exactClient || exactExchange ? [] : localOrders.filter(local =>
        local.role === 'stop_loss'
        && local.symbol === order.symbol
        && local.reduce_only === 1
        && local.side === order.side
        && decimalEquals(local.trigger_price, order.triggerPrice)
        && decimalEquals(local.quantity, order.quantity)
        && order.reduceOnly === true);
      const local = exactClient || exactExchange || (attachedStops.length === 1 ? attachedStops[0] : undefined);
      const clientOrderId = local?.client_order_id || order.clientOrderId || null;
      return {
        ...order,
        clientOrderId,
        role: roles.get(clientOrderId) || order.role || 'entry',
      };
    });
    state.fills = state.fills.map((fill: any) => {
      const exactClient = typeof fill.clientOrderId === 'string'
        ? localOrders.find(local => local.client_order_id === fill.clientOrderId)
        : undefined;
      const exactExchange = typeof fill.exchangeOrderId === 'string'
        ? byExchangeId.get(fill.exchangeOrderId)
        : undefined;
      return {
        ...fill,
        clientOrderId: exactClient?.client_order_id || exactExchange?.client_order_id || fill.clientOrderId || null,
      };
    });
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

  private async post(endpoint: string, payload: unknown, timeoutMs = 12_000): Promise<unknown> {
    const token = await this.credentials.getOrCreateExecutorToken();
    const bodyPayload = assertObject(payload, 'Exchange executor request');
    const deadlineAt = Date.now() + Math.max(1, timeoutMs - 250);
    const maximumAttempts = RETRYABLE_READ_ENDPOINTS.has(endpoint) ? 3 : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
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
