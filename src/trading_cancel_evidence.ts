import { compareDecimal, decimal, subtractDecimal } from './trading_decimal.js';
import { CANCEL_RETRY_MS } from './trading_cancel_budget.js';
import type { ExchangeAcquisitionEvidence, ExchangeOpenState, ExchangeOrderSnapshot, TradingAccount } from './trading_types.js';

export interface CancelOrder {
  account_id: string; intent_id: string; client_order_id: string; exchange_order_id: string | null; provider_symbol: string | null;
  symbol: string; role: string; side: string; status: string; quantity: string; filled_quantity: string; reduce_only: number;
  price: string | null; trigger_price: string | null;
}
export interface ActiveCancelEvidence { order: ExchangeOrderSnapshot; acquiredAt: number; remainingQuantity: string }
export class CancellationEvidenceError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'CancellationEvidenceError'; }
}

function validAcquisitionClock(value: { startedAt: number; completedAt: number }): boolean {
  return Number.isSafeInteger(value.startedAt) && Number.isSafeInteger(value.completedAt) && value.completedAt >= value.startedAt;
}

function acquisitionWindowFresh(acquisition: ExchangeAcquisitionEvidence, after: number, now: number): boolean {
  return acquisition.version === 1 && validAcquisitionClock(acquisition) && acquisition.startedAt >= after
    && acquisition.completedAt <= now && now - acquisition.startedAt <= CANCEL_RETRY_MS;
}

function sourceWithinAcquisition(source: ExchangeAcquisitionEvidence['sources'][number], acquisition: ExchangeAcquisitionEvidence): boolean {
  return validAcquisitionClock(source) && source.startedAt >= acquisition.startedAt && source.completedAt <= acquisition.completedAt;
}

function completeAcquisitionSource(acquisition: ExchangeAcquisitionEvidence, name: string): boolean {
  const sources = acquisition.sources.filter(source => source.source === name);
  const source = sources[0];
  if (sources.length !== 1 || !source) return false;
  return source.completeness === 'complete' && source.reason === null && sourceWithinAcquisition(source, acquisition);
}

function acquisitionReason(remote: ExchangeOpenState, after: number, now: number): string | null {
  const acquisition = remote.acquisition;
  if (!acquisition) return 'ACQUISITION_MISSING';
  if (!acquisitionWindowFresh(acquisition, after, now)) return 'ACQUISITION_NOT_FRESH';
  const complete = ['orders', 'positions', 'fills', 'targeted_orders'].every(name => completeAcquisitionSource(acquisition, name));
  return complete ? null : 'SOURCE_INCOMPLETE';
}

export function cancelAcquisitionFresh(remote: ExchangeOpenState, after: number, now = Date.now()): boolean {
  return acquisitionReason(remote, after, now) === null;
}

export function assertCancelAcquisition(remote: ExchangeOpenState, after = 0): void {
  const reason = acquisitionReason(remote, after, Date.now());
  if (reason) throw new CancellationEvidenceError(reason, `${reason}: cancellation requires newly acquired complete account evidence within ten seconds.`);
}

function exactOrder(local: CancelOrder, orders: ExchangeOrderSnapshot[]): ExchangeOrderSnapshot | undefined {
  const candidates = orders.filter(order => order.clientOrderId === local.client_order_id
    || (order.exchangeOrderId === local.exchange_order_id && order.providerSymbol === local.provider_symbol));
  const order = candidates[0];
  if (candidates.length !== 1 || !order) return undefined;
  const fields = { clientOrderId: local.client_order_id, exchangeOrderId: local.exchange_order_id,
    providerSymbol: local.provider_symbol, symbol: local.symbol, role: local.role, side: local.side,
    reduceOnly: local.reduce_only === 1, price: local.price, triggerPrice: local.trigger_price };
  return Object.entries(fields).every(([key, value]) => order[key as keyof ExchangeOrderSnapshot] === value) ? order : undefined;
}

function observedActiveOrder(order: ExchangeOrderSnapshot): order is ExchangeOrderSnapshot & { filledQuantity: string } {
  return ['open', 'partially_filled'].includes(order.status) && typeof order.filledQuantity === 'string';
}

function unchangedOrderProgress(local: CancelOrder, quantity: string, filled: string): boolean {
  return compareDecimal(quantity, local.quantity) === 0 && compareDecimal(filled, local.filled_quantity) >= 0;
}

function activeRemaining(local: CancelOrder, order: ExchangeOrderSnapshot): string | null {
  if (!observedActiveOrder(order)) return null;
  try {
    const quantity = decimal(order.quantity, { positive: true });
    const filled = decimal(order.filledQuantity);
    if (!unchangedOrderProgress(local, quantity, filled)) return null;
    const remaining = subtractDecimal(quantity, filled);
    return compareDecimal(remaining, '0') > 0 ? remaining : null;
  } catch { return null; }
}

function cancellationAccountBound(local: CancelOrder, remote: ExchangeOpenState, account: TradingAccount): boolean {
  if (local.account_id !== account.id || !local.exchange_order_id || !local.provider_symbol) return false;
  return remoteAccountBound(remote, account);
}

function remoteAccountBound(remote: ExchangeOpenState, account: TradingAccount): boolean {
  if (account.exchange === 'paper') return true;
  const fingerprint = 'accountFingerprint' in remote ? remote.accountFingerprint : undefined;
  return Boolean(account.externalAccountId && account.credentialGeneration && fingerprint === account.externalAccountId);
}

function freshBoundAcquisition(local: CancelOrder, remote: ExchangeOpenState, account: TradingAccount, after: number, now: number): ExchangeAcquisitionEvidence | null {
  const acquisition = remote.acquisition;
  if (!acquisition || !cancellationAccountBound(local, remote, account) || !cancelAcquisitionFresh(remote, after, now)) return null;
  return acquisition;
}

/** Positive newly acquired evidence only. This proves a cancellable target, never terminal drain/closure. */
export function exactActiveCancelEvidence(
  local: CancelOrder, remote: ExchangeOpenState, account: TradingAccount, after: number, now = Date.now(),
): ActiveCancelEvidence | null {
  const acquisition = freshBoundAcquisition(local, remote, account, after, now);
  if (!acquisition) return null;
  const order = exactOrder(local, remote.orders);
  if (!order) return null;
  const remainingQuantity = activeRemaining(local, order);
  return remainingQuantity === null ? null : { order, remainingQuantity, acquiredAt: acquisition.startedAt };
}
