import { compareDecimal, decimal } from './trading_decimal.js';
import type { TradingIntentStatus } from './trading_types.js';

const INTENT_TRANSITIONS: Record<TradingIntentStatus, readonly TradingIntentStatus[]> = {
  pending: ['planned', 'blocked', 'failed', 'unknown'],
  planned: ['submitting', 'blocked', 'failed', 'unknown'],
  submitting: ['monitoring', 'completed', 'blocked', 'failed', 'unknown'],
  monitoring: ['completed', 'blocked', 'failed', 'unknown'],
  unknown: ['monitoring', 'completed', 'blocked', 'failed'],
  completed: [],
  blocked: [],
  failed: [],
};

export function canTransitionIntent(current: string, next: string): boolean {
  if (!Object.hasOwn(INTENT_TRANSITIONS, current) || !Object.hasOwn(INTENT_TRANSITIONS, next)) return false;
  return current === next || INTENT_TRANSITIONS[current as TradingIntentStatus].includes(next as TradingIntentStatus);
}

export const ORDER_STATUSES = [
  'created', 'submitting', 'open', 'partially_filled', 'cancel_pending',
  'filled', 'cancelled', 'rejected', 'unknown',
] as const;
export type LocalOrderStatus = typeof ORDER_STATUSES[number];

export interface OrderEvidence {
  status: LocalOrderStatus;
  filledQuantity: string | null;
  averagePrice?: string | null;
}

export interface LocalOrderEvidence extends OrderEvidence {
  quantity: string;
  filledQuantity: string;
}

function validStatus(value: string): asserts value is LocalOrderStatus {
  if (!(ORDER_STATUSES as readonly string[]).includes(value)) throw new Error('Invalid order evidence status.');
}

function mergedStatus(current: LocalOrderStatus, incoming: LocalOrderStatus, filled: string, quantity: string): LocalOrderStatus {
  if ((current === 'rejected' || incoming === 'rejected') && compareDecimal(filled, '0') > 0) {
    throw new Error('Rejected order has conflicting execution evidence.');
  }
  if (['filled', 'rejected'].includes(current)) return current;
  if (current === 'cancelled') return incoming === 'filled' && compareDecimal(filled, quantity) === 0 ? 'filled' : current;
  if (['filled', 'cancelled', 'rejected'].includes(incoming)) return incoming;
  if (current === 'cancel_pending') return current;
  if (incoming === 'unknown' || incoming === 'cancel_pending') return incoming;
  if (compareDecimal(filled, '0') > 0) return 'partially_filled';
  if (['created', 'submitting'].includes(incoming) && current !== 'created') return current;
  return incoming;
}

/** Lifecycle and cumulative execution are independent: cancelled orders can acquire late fills. */
export function mergeOrderEvidence(current: LocalOrderEvidence, incoming: OrderEvidence): {
  status: LocalOrderStatus; filledQuantity: string; averagePrice: string | null;
} {
  validStatus(current.status);
  validStatus(incoming.status);
  const quantity = decimal(current.quantity, { positive: true });
  const previous = decimal(current.filledQuantity);
  const reported = incoming.filledQuantity === null ? previous : decimal(incoming.filledQuantity);
  const filledQuantity = compareDecimal(previous, reported) >= 0 ? previous : reported;
  if (compareDecimal(filledQuantity, quantity) > 0) throw new Error('Executed quantity exceeds order quantity.');
  const oldAverage = current.averagePrice == null ? null : decimal(current.averagePrice, { positive: true });
  const newAverage = incoming.averagePrice == null ? null : decimal(incoming.averagePrice, { positive: true });
  return {
    status: mergedStatus(current.status, incoming.status, filledQuantity, quantity),
    filledQuantity,
    averagePrice: incoming.filledQuantity !== null && compareDecimal(reported, previous) >= 0 ? newAverage ?? oldAverage : oldAverage,
  };
}
