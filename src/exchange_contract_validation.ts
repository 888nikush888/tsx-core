import { compareDecimal, decimal, signedDecimal } from './trading_decimal.js';
import { validateHistoryProgress } from './exchange_history_contract.js';
import { validateAccountModeProgress } from './trading_account_mode_contract.js';
import { validateAccountingEvidence, validateFillAccounting, validateFundingValue } from './trading_accounting_contract.js';
import { accountLogAcquisitionFields } from './trading_account_log_contract.js';
import { parseRecoveryScheduleAcquisitionFields } from './trading_recovery_schedule_contract.js';
import { validateFillIdentity } from './trading_fill_identity.js';
import { validateFillQuantityNormalization } from './trading_fill_quantity_contract.js';
import { validateOrderIdentityEvidence } from './exchange_order_identity_contract.js';
import type {
  ExchangeFill, ExchangeOpenState, ExchangeOrderRequest, ExchangeOrderResult,
  ExchangeOrderSnapshot, ExchangePositionSnapshot, ExchangeUnresolvedEvent, TradingAccountSnapshot, TradingMarketSnapshot,
} from './trading_types.js';

const REMOTE_STATUSES = ['open', 'partially_filled', 'filled', 'cancelled', 'rejected', 'unknown'];
const MAX_CLOCK_AHEAD_MS = 60_000;

export function contractObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Exchange executor returned an invalid contract.');
  return value as Record<string, unknown>;
}

function identifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f]/.test(value)) {
    throw new Error(`Invalid exchange ${label} identifier.`);
  }
}

function nullableIdentifier(value: unknown, label: string): void {
  if (value !== null) identifier(value, label);
}

function amount(value: unknown, positive = false, signed = false): string {
  if (typeof value !== 'string' || value.trim() !== value) throw new Error('Invalid exchange decimal contract.');
  return signed ? signedDecimal(value) : decimal(value, { positive });
}

function nullablePrice(value: unknown): void {
  if (value !== null) amount(value, true);
}

function timestamp(value: unknown, maximumAge?: number): void {
  const now = Date.now();
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0
    || value > now + MAX_CLOCK_AHEAD_MS || (maximumAge !== undefined && now - value > maximumAge)) {
    throw new Error('Invalid or stale exchange timestamp.');
  }
}

function status(value: unknown): void {
  if (typeof value !== 'string' || !REMOTE_STATUSES.includes(value)) throw new Error('Invalid exchange order status.');
}

function executionFields(result: Record<string, unknown>, quantity?: string, nullableFilled = false): void {
  identifier(result.exchangeOrderId, 'order');
  status(result.status);
  const filled = nullableFilled && result.filledQuantity === null ? null : amount(result.filledQuantity);
  if (filled !== null && quantity !== undefined && compareDecimal(filled, amount(quantity, true)) > 0) {
    throw new Error('Exchange executed quantity exceeds requested order quantity.');
  }
  nullablePrice(result.averagePrice);
  if (result.error !== null && typeof result.error !== 'string') throw new Error('Invalid exchange error contract.');
}

export function validateOrderResult(value: unknown, expected: Pick<ExchangeOrderRequest, 'clientOrderId'> & {
  quantity?: string; exchangeOrderId?: string | null;
}): ExchangeOrderResult {
  const result = contractObject(value);
  validateOrderIdentityEvidence(result);
  identifier(result.clientOrderId, 'client order');
  if (result.clientOrderId !== expected.clientOrderId) throw new Error('Exchange result identifier does not match the requested order.');
  executionFields(result, expected.quantity);
  if (result.providerSymbol !== undefined) identifier(result.providerSymbol, 'provider symbol');
  if (expected.exchangeOrderId && result.exchangeOrderId !== expected.exchangeOrderId) {
    throw new Error('Exchange result identifier does not match the known remote order.');
  }
  return result as unknown as ExchangeOrderResult;
}

// Incomplete batches must retain independently proven legs without treating
// the overall dispatch as successful. Duplicate identities prove neither leg.
export function confirmedOrderEvidence(values: unknown, expected: Array<Pick<ExchangeOrderRequest, 'clientOrderId'> & {
  quantity?: string; exchangeOrderId?: string | null;
}>): ExchangeOrderResult[] {
  if (!Array.isArray(values) || values.length > 2) return [];
  const records = values.filter(value => value && typeof value === 'object' && !Array.isArray(value));
  return expected.flatMap(request => {
    const candidates = records.filter(value => value.clientOrderId === request.clientOrderId);
    if (candidates.length !== 1) return [];
    const candidate = candidates[0];
    if (records.filter(value => value.exchangeOrderId === candidate.exchangeOrderId).length !== 1) return [];
    try { return [validateOrderResult(candidate, request)]; } catch { return []; }
  });
}

export function validateMarketSnapshot(value: unknown, symbol: string): TradingMarketSnapshot {
  const result = contractObject(value);
  if (result.symbol !== symbol) throw new Error('Exchange market symbol does not match the request.');
  for (const key of ['markPrice', 'priceTick', 'quantityStep', 'minimumQuantity', 'minimumNotional']) amount(result[key], true);
  if (typeof result.maxLeverage !== 'number' || !Number.isSafeInteger(result.maxLeverage)
    || result.maxLeverage < 1 || result.maxLeverage > 50) throw new Error('Invalid exchange maximum leverage.');
  timestamp(result.observedAt, 60_000);
  if (result.accounting !== undefined && result.accounting !== null) return { ...result,
    accounting: validateFillAccounting(result.accounting, result.providerSymbol as string | undefined) } as unknown as TradingMarketSnapshot;
  return result as unknown as TradingMarketSnapshot;
}

export function validateAccountSnapshot(value: unknown): TradingAccountSnapshot {
  const result = contractObject(value);
  for (const key of ['equity', 'availableBalance', 'marginUsed']) amount(result[key]);
  amount(result.unrealizedPnl, false, true);
  if (result.fundingPnlToday !== null) amount(result.fundingPnlToday, false, true);
  const fundingValue = validateFundingValue(result.fundingPnlToday as string | null, result.fundingPnlTodayValue);
  if (fundingValue && result.accounting === undefined) throw new Error('Funding money value lacks accounting evidence.');
  const fields = fundingValue === undefined ? {} : { fundingPnlTodayValue: fundingValue };
  if (result.accounting !== undefined) return { ...result,
    ...fields, accounting: validateAccountingEvidence(result.accounting, result.fundingPnlToday as string | null, fundingValue) } as unknown as TradingAccountSnapshot;
  return { ...result, ...fields } as unknown as TradingAccountSnapshot;
}

export function validateRemoteOrder(value: unknown): ExchangeOrderSnapshot {
  const result = contractObject(value);
  validateOrderIdentityEvidence(result);
  nullableIdentifier(result.clientOrderId, 'client order');
  identifier(result.symbol, 'symbol');
  if (result.providerSymbol !== undefined) identifier(result.providerSymbol, 'provider symbol');
  if (result.providerTimestamp !== undefined && result.providerTimestamp !== null) timestamp(result.providerTimestamp);
  const quantity = amount(result.quantity, true);
  executionFields(result, quantity, true);
  if (!['entry', 'take_profit', 'stop_loss', 'flatten'].includes(String(result.role))
    || !['buy', 'sell'].includes(String(result.side)) || typeof result.reduceOnly !== 'boolean') {
    throw new Error('Invalid remote order semantics.');
  }
  nullablePrice(result.price);
  nullablePrice(result.triggerPrice);
  return result as unknown as ExchangeOrderSnapshot;
}

function validatePosition(value: unknown): ExchangePositionSnapshot {
  const result = contractObject(value);
  identifier(result.symbol, 'symbol');
  if (result.providerSymbol !== undefined) identifier(result.providerSymbol, 'position provider symbol');
  if (!['LONG', 'SHORT'].includes(String(result.side))) throw new Error('Invalid exchange position side.');
  amount(result.quantity, true);
  amount(result.averageEntryPrice, true);
  if (result.unrealizedPnl !== null) amount(result.unrealizedPnl, false, true);
  if (result.markPrice !== undefined && result.markPrice !== null) amount(result.markPrice, true);
  if (result.accounting !== undefined && result.accounting !== null) return { ...result,
    accounting: validateFillAccounting(result.accounting, result.providerSymbol as string | undefined) } as unknown as ExchangePositionSnapshot;
  return result as unknown as ExchangePositionSnapshot;
}

function validateFill(value: unknown): ExchangeFill {
  const result = contractObject(value);
  if (result.identity !== undefined) validateFillIdentity(result.identity);
  identifier(result.exchangeFillId, 'fill');
  identifier(result.exchangeOrderId, 'fill order');
  if (result.symbol !== undefined) identifier(result.symbol, 'fill symbol');
  if (result.providerSymbol !== undefined) identifier(result.providerSymbol, 'fill provider symbol');
  nullableIdentifier(result.clientOrderId, 'fill client order');
  nullableIdentifier(result.feeAsset, 'fee asset');
  amount(result.price, true);
  amount(result.quantity, true);
  amount(result.fee, false, true);
  timestamp(result.filledAt);
  if (result.quantityNormalization !== undefined) validateFillQuantityNormalization(result.quantityNormalization, result as unknown as ExchangeFill);
  if (result.accounting !== undefined && result.accounting !== null) return { ...result,
    accounting: validateFillAccounting(result.accounting, result.providerSymbol as string | undefined) } as unknown as ExchangeFill;
  return result as unknown as ExchangeFill;
}

function validateUnresolvedEvent(value: unknown): ExchangeUnresolvedEvent {
  const result = contractObject(value);
  if (!['fill', 'order'].includes(String(result.kind)) || !['fetchMyTrades', 'fetchOrders'].includes(String(result.source))
    || typeof result.reason !== 'string' || !/^[a-z_]{1,64}$/.test(result.reason)) {
    throw new Error('Invalid unresolved exchange event contract.');
  }
  nullableIdentifier(result.providerId, 'unresolved event');
  nullableIdentifier(result.providerSymbol, 'unresolved provider symbol');
  const evidence = contractObject(result.evidence);
  if (Object.keys(evidence).length > 40 || JSON.stringify(evidence).length > 16_384) throw new Error('Unresolved event evidence exceeds its size limit.');
  for (const item of Object.values(evidence)) {
    if (item !== null && typeof item !== 'string' && typeof item !== 'boolean' && !(typeof item === 'number' && Number.isFinite(item))) {
      throw new Error('Unresolved event evidence must contain only bounded economic fields.');
    }
  }
  return result as unknown as ExchangeUnresolvedEvent;
}

export function validateOpenState(value: unknown, expectedAccountFingerprint?: string | null): ExchangeOpenState & { accountFingerprint: string } {
  const result = contractObject(value);
  if (typeof result.accountFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(result.accountFingerprint)
    || (expectedAccountFingerprint && result.accountFingerprint !== expectedAccountFingerprint)) {
    throw new Error('Exchange account identity does not match the bound account.');
  }
  for (const name of ['orders', 'positions', 'fills']) {
    if (!Array.isArray(result[name]) || result[name].length > 100_000) throw new Error('Invalid exchange open-state collection.');
  }
  if (result.unresolvedEvents !== undefined && (!Array.isArray(result.unresolvedEvents) || result.unresolvedEvents.length > 100_000)) {
    throw new Error('Invalid unresolved exchange event collection.');
  }
  timestamp(result.observedAt, 60_000);
  return {
    ...result,
    accountFingerprint: result.accountFingerprint,
    orders: (result.orders as unknown[]).map(validateRemoteOrder),
    positions: (result.positions as unknown[]).map(validatePosition),
    fills: (result.fills as unknown[]).map(validateFill),
    unresolvedEvents: (result.unresolvedEvents as unknown[] | undefined)?.map(validateUnresolvedEvent) ?? [],
    ...(result.acquisition === undefined ? {} : { acquisition: validateAcquisitionEvidence(result.acquisition) }),
    observedAt: result.observedAt as number,
  };
}

export function validateAcquisitionEvidence(value: unknown): NonNullable<ExchangeOpenState['acquisition']> {
  const result = contractObject(value);
  timestamp(result.startedAt, 60_000);
  timestamp(result.completedAt, 60_000);
  if (result.version !== 1 || Number(result.startedAt) > Number(result.completedAt)
    || Number(result.completedAt) - Number(result.startedAt) > 35_000
    || !Array.isArray(result.sources) || result.sources.length !== 4
    || !Array.isArray(result.checkedOrders) || result.checkedOrders.length > 250) {
    throw new Error('Invalid exchange acquisition evidence.');
  }
  const sources = result.sources.map(source => acquisitionSource(source, Number(result.startedAt), Number(result.completedAt)));
  const checkedOrders = result.checkedOrders.map(acquisitionOrder);
  if (new Set(sources.map(source => source.source)).size !== 4
    || new Set(checkedOrders.map(order => order.clientOrderId)).size !== checkedOrders.length) {
    throw new Error('Duplicate exchange acquisition evidence.');
  }
  return { version: 1, startedAt: Number(result.startedAt), completedAt: Number(result.completedAt), sources, checkedOrders,
    ...(result.accountMode === undefined ? {} : { accountMode: validateAccountModeProgress(result.accountMode,
      { startedAt: Number(result.startedAt), completedAt: Number(result.completedAt) }) }),
    ...accountLogAcquisitionFields(result),
    ...parseRecoveryScheduleAcquisitionFields(result),
    ...(result.history === undefined ? {} : { history: validateHistoryProgress(result.history) }) };
}

function acquisitionSource(value: unknown, startedAt: number, completedAt: number): NonNullable<ExchangeOpenState['acquisition']>['sources'][number] {
  const row = contractObject(value);
  if (!['positions', 'orders', 'targeted_orders', 'fills'].includes(String(row.source))
    || !['complete', 'partial', 'unknown'].includes(String(row.completeness))) throw new Error('Invalid acquisition source.');
  timestamp(row.startedAt, 60_000);
  timestamp(row.completedAt, 60_000);
  if (Number(row.startedAt) < startedAt || Number(row.completedAt) > completedAt || Number(row.startedAt) > Number(row.completedAt)) {
    throw new Error('Acquisition source falls outside its request window.');
  }
  if (row.since !== null) timestamp(row.since);
  if (row.since !== null && Number(row.since) > Number(row.completedAt)) throw new Error('Acquisition start exceeds its completion.');
  if (row.reason !== null && (typeof row.reason !== 'string' || !/^[a-z_]{1,80}$/.test(row.reason))) throw new Error('Invalid acquisition reason.');
  return { source: row.source, startedAt: row.startedAt, completedAt: row.completedAt,
    completeness: row.completeness, reason: row.reason, since: row.since,
    ...(row.scopes === undefined ? {} : { scopes: acquisitionScopes(row.scopes, row.completeness === 'complete') }),
  } as NonNullable<ExchangeOpenState['acquisition']>['sources'][number];
}

function acquisitionScopes(value: unknown, complete: boolean): Array<{ scope: string; pages: number; complete: boolean }> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) throw new Error('Invalid acquisition scopes.');
  const scopes = value.map(acquisitionScope);
  if (new Set(scopes.map(row => row.scope)).size !== scopes.length || scopes.reduce((sum, row) => sum + row.pages, 0) > 64
    || (complete && scopes.some(row => !row.complete))) throw new Error('Incomplete or duplicate acquisition scope.');
  return scopes;
}

function acquisitionScope(value: unknown): { scope: string; pages: number; complete: boolean } {
  const row = contractObject(value);
  if (typeof row.scope !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(row.scope)
    || typeof row.complete !== 'boolean' || !Number.isInteger(row.pages) || Number(row.pages) < (row.complete ? 1 : 0)
    || Number(row.pages) > 64) throw new Error('Invalid acquisition scope evidence.');
  return { scope: row.scope, pages: Number(row.pages), complete: row.complete };
}

function acquisitionOrder(value: unknown): NonNullable<ExchangeOpenState['acquisition']>['checkedOrders'][number] {
  const row = contractObject(value);
  identifier(row.clientOrderId, 'acquisition client order');
  if (!['observed', 'not_found', 'unsupported', 'budget_exhausted', 'transient'].includes(String(row.status))) {
    throw new Error('Invalid acquisition order result.');
  }
  return { clientOrderId: row.clientOrderId, status: row.status } as NonNullable<ExchangeOpenState['acquisition']>['checkedOrders'][number];
}
