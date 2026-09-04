import { getDatabase, withDatabaseTransaction } from './db.js';
import { addDecimal, compareDecimal, decimal, subtractDecimal } from './trading_decimal.js';
import { TERMINAL_ORDER_STATES } from './trading_entry_commitment.js';

export interface ProtectionOrder {
  accountId: string; intentId: string; clientOrderId: string | null; exchangeOrderId: string | null;
  symbol: string; role: string; side: string; status: string; reduceOnly: boolean;
  quantity: string; filledQuantity: string | null; triggerPrice: string | null;
}

export interface ProtectionNeed {
  accountId: string; intentId: string; symbol: string; side: 'LONG' | 'SHORT';
  quantity: string; minimumTrigger: string | null;
}

export interface StopCoverage {
  protected: boolean;
  remainingQuantity: string | null;
  reason: string | null;
}

/** Identity must already be correlated exactly within this account; this predicate never adopts an order. */
export function protectiveStopCoverage(order: ProtectionOrder, need: ProtectionNeed): StopCoverage {
  const no = (reason: string, remainingQuantity: string | null = null): StopCoverage => ({ protected: false, reason, remainingQuantity });
  if (order.accountId !== need.accountId || order.intentId !== need.intentId || order.symbol !== need.symbol
    || !order.clientOrderId || !order.exchangeOrderId) return no('STOP_BINDING_MISMATCH');
  if (!['open', 'partially_filled'].includes(order.status)) return no('STOP_NOT_ACTIVE');
  if (order.role !== 'stop_loss' || !order.reduceOnly || order.side !== (need.side === 'LONG' ? 'sell' : 'buy')) {
    return no('STOP_SEMANTICS_INVALID');
  }
  return stopAmountsCoverage(order, need);
}

function stopAmountsCoverage(order: ProtectionOrder, need: ProtectionNeed): StopCoverage {
  const no = (reason: string, remainingQuantity: string | null = null): StopCoverage => ({ protected: false, reason, remainingQuantity });
  if (order.filledQuantity === null) return no('STOP_QUANTITY_UNKNOWN');
  try {
    const remaining = subtractDecimal(decimal(order.quantity, { positive: true }), decimal(order.filledQuantity));
    if (compareDecimal(remaining, '0') <= 0) return no('STOP_EXHAUSTED', remaining);
    const trigger = decimal(order.triggerPrice!, { positive: true });
    if (need.minimumTrigger !== null) {
      const change = compareDecimal(trigger, decimal(need.minimumTrigger, { positive: true }));
      if ((need.side === 'LONG' && change < 0) || (need.side === 'SHORT' && change > 0)) return no('STOP_TRIGGER_TOO_LOOSE', remaining);
    }
    if (compareDecimal(remaining, decimal(need.quantity)) < 0) return no('STOP_REMAINING_INSUFFICIENT', remaining);
    return { protected: true, remainingQuantity: remaining, reason: null };
  } catch {
    return no('STOP_EVIDENCE_INVALID');
  }
}

/** Current own exposure plus all entry quantities that may still execute, not the original gross plan again. */
export function requiredStopQuantity(positionQuantity: string, entries: Array<Pick<ProtectionOrder, 'status' | 'quantity' | 'filledQuantity'>>): string {
  return entries.reduce((quantity, entry) => {
    if ((TERMINAL_ORDER_STATES as readonly string[]).includes(entry.status)) return quantity;
    if (entry.filledQuantity === null) throw new Error('Entry remaining quantity is not proved.');
    return addDecimal(quantity, subtractDecimal(decimal(entry.quantity, { positive: true }), decimal(entry.filledQuantity)));
  }, decimal(positionQuantity));
}

export async function loadProtectionOrders(accountId: string, intentId: string): Promise<ProtectionOrder[]> {
  const rows = await getDatabase().all<Array<Omit<ProtectionOrder, 'reduceOnly'> & { reduceOnly: number }>>(
    `SELECT orders.account_id AS accountId, orders.intent_id AS intentId, orders.client_order_id AS clientOrderId,
       orders.exchange_order_id AS exchangeOrderId, intent.symbol, orders.role, orders.side, orders.status,
       orders.reduce_only AS reduceOnly, orders.quantity, orders.filled_quantity AS filledQuantity, orders.trigger_price AS triggerPrice
     FROM trading_orders AS orders JOIN trading_trade_intents AS intent ON intent.id = orders.intent_id
     WHERE orders.account_id = ? AND orders.intent_id = ?`, [accountId, intentId]);
  return rows.map(row => ({ ...row, reduceOnly: Number(row.reduceOnly) === 1 }));
}

export async function storedProtectionNeed(accountId: string, intentId: string) {
  return withDatabaseTransaction(async () => {
    const position = await getDatabase().get<ProtectionNeed>(
      `SELECT account_id AS accountId, intent_id AS intentId, symbol, side, quantity, stop_price AS minimumTrigger
       FROM trading_positions WHERE account_id = ? AND intent_id = ? AND status <> 'closed'`, [accountId, intentId]);
    if (!position) throw new Error('Protection check has no active managed position.');
    const orders = await loadProtectionOrders(accountId, intentId);
    const need = { ...position, quantity: requiredStopQuantity(position.quantity, orders.filter(order => order.role === 'entry')) };
    return { need, orders, protected: orders.some(order => protectiveStopCoverage(order, need).protected) };
  });
}
