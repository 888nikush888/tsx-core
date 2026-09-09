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

function rejectedWithExecution(current: LocalOrderStatus, incoming: LocalOrderStatus, filled: string): boolean {
  return (current === 'rejected' || incoming === 'rejected') && compareDecimal(filled, '0') > 0;
}

function settledThenCurrent(current: LocalOrderStatus): LocalOrderStatus | null {
  return ['filled', 'rejected'].includes(current) ? current : null;
}

function cancelledKeepOrTakeFilled(current: LocalOrderStatus, incoming: LocalOrderStatus, filled: string, quantity: string): LocalOrderStatus | null {
  if (current !== 'cancelled') return null;
  return incoming === 'filled' && compareDecimal(filled, quantity) === 0 ? 'filled' : current;
}

function mergedStatus(current: LocalOrderStatus, incoming: LocalOrderStatus, filled: string, quantity: string): LocalOrderStatus {
  if (rejectedWithExecution(current, incoming, filled)) {
    throw new Error('Rejected order has conflicting execution evidence.');
  }
  return settledThenCurrent(current) ?? cancelledKeepOrTakeFilled(current, incoming, filled, quantity)
    ?? mergedIncomingStatus(current, incoming, filled);
}

function mergedIncomingStatus(current: LocalOrderStatus, incoming: LocalOrderStatus, filled: string): LocalOrderStatus {
  if (['filled', 'cancelled', 'rejected'].includes(incoming)) return incoming;
  return heldOrPartialStatus(current, incoming, filled);
}

function heldOrPartialStatus(current: LocalOrderStatus, incoming: LocalOrderStatus, filled: string): LocalOrderStatus {
  if (current === 'cancel_pending') return current;
  if (incoming === 'unknown' || incoming === 'cancel_pending') return incoming;
  if (compareDecimal(filled, '0') > 0) return 'partially_filled';
  if (['created', 'submitting'].includes(incoming) && current !== 'created') return current;
  return incoming;
}

function selectedFilledQuantity(previous: string, reported: string): string {
  return compareDecimal(previous, reported) >= 0 ? previous : reported;
}

function incomingAverageWins(incomingFilledQuantity: string | null, reported: string, previous: string): boolean {
  return incomingFilledQuantity !== null && compareDecimal(reported, previous) >= 0;
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
  const filledQuantity = selectedFilledQuantity(previous, reported);
  if (compareDecimal(filledQuantity, quantity) > 0) throw new Error('Executed quantity exceeds order quantity.');
  const oldAverage = current.averagePrice == null ? null : decimal(current.averagePrice, { positive: true });
  const newAverage = incoming.averagePrice == null ? null : decimal(incoming.averagePrice, { positive: true });
  return {
    status: mergedStatus(current.status, incoming.status, filledQuantity, quantity),
    filledQuantity,
    averagePrice: incomingAverageWins(incoming.filledQuantity, reported, previous) ? newAverage ?? oldAverage : oldAverage,
  };
}
