import { compareDecimal, decimal, subtractDecimal } from './trading_decimal.js';
import { CANCEL_RETRY_MS } from './trading_cancel_budget.js';
import type { ExchangeOpenState, ExchangeOrderSnapshot, TradingAccount } from './trading_types.js';

export interface CancelOrder {
  account_id: string; intent_id: string; client_order_id: string; exchange_order_id: string | null; provider_symbol: string | null;
  symbol: string; role: string; side: string; status: string; quantity: string; filled_quantity: string; reduce_only: number;
  price: string | null; trigger_price: string | null;
}
export interface ActiveCancelEvidence { order: ExchangeOrderSnapshot; acquiredAt: number; remainingQuantity: string }
export class CancellationEvidenceError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'CancellationEvidenceError'; }
}

function acquisitionReason(remote: ExchangeOpenState, after: number, now: number): string | null {
  const acquisition = remote.acquisition;
  if (!acquisition) return 'ACQUISITION_MISSING';
  if (acquisition.version !== 1 || !Number.isSafeInteger(acquisition.startedAt)
    || acquisition.startedAt < after || acquisition.completedAt < acquisition.startedAt || acquisition.completedAt > now
    || now - acquisition.startedAt > CANCEL_RETRY_MS) return 'ACQUISITION_NOT_FRESH';
  const complete = ['orders', 'positions', 'fills', 'targeted_orders'].every(name => {
    const sources = acquisition.sources.filter(source => source.source === name);
    return sources.length === 1 && sources[0]!.completeness === 'complete' && sources[0]!.reason === null
      && sources[0]!.startedAt >= acquisition.startedAt && sources[0]!.completedAt >= sources[0]!.startedAt
      && sources[0]!.completedAt <= acquisition.completedAt;
  });
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
  if (candidates.length !== 1) return undefined;
  const order = candidates[0]!;
  const fields = { clientOrderId: local.client_order_id, exchangeOrderId: local.exchange_order_id,
    providerSymbol: local.provider_symbol, symbol: local.symbol, role: local.role, side: local.side,
    reduceOnly: local.reduce_only === 1, price: local.price, triggerPrice: local.trigger_price };
  return Object.entries(fields).every(([key, value]) => order[key as keyof ExchangeOrderSnapshot] === value) ? order : undefined;
}

function activeRemaining(local: CancelOrder, order: ExchangeOrderSnapshot): string | null {
  if (!['open', 'partially_filled'].includes(order.status) || order.filledQuantity === null) return null;
  try {
    const quantity = decimal(order.quantity, { positive: true });
    const filled = decimal(order.filledQuantity);
    if (compareDecimal(quantity, local.quantity) !== 0 || compareDecimal(filled, local.filled_quantity) < 0) return null;
    const remaining = subtractDecimal(quantity, filled);
    return compareDecimal(remaining, '0') > 0 ? remaining : null;
  } catch { return null; }
}

/** Positive newly acquired evidence only. This proves a cancellable target, never terminal drain/closure. */
export function exactActiveCancelEvidence(
  local: CancelOrder, remote: ExchangeOpenState, account: TradingAccount, after: number, now = Date.now(),
): ActiveCancelEvidence | null {
  if (local.account_id !== account.id || !local.exchange_order_id || !local.provider_symbol
    || !cancelAcquisitionFresh(remote, after, now)) return null;
  const fingerprint = (remote as ExchangeOpenState & { accountFingerprint?: string }).accountFingerprint;
  if (account.exchange !== 'paper' && (!account.externalAccountId || !account.credentialGeneration
    || fingerprint !== account.externalAccountId)) return null;
  const order = exactOrder(local, remote.orders);
  if (!order) return null;
  const remainingQuantity = activeRemaining(local, order);
  return remainingQuantity === null ? null : { order, remainingQuantity, acquiredAt: remote.acquisition!.startedAt };
}
