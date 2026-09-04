import { getDatabase } from './db.js';
import { compareDecimal, sumDecimals } from './trading_decimal.js';
import type { ExchangeUnresolvedEvent } from './trading_types.js';

interface KnownHistoryOrder {
  id: string; client_order_id: string; side: string; reduce_only: number; role: string; quantity: string; filled_quantity: string;
}

/** Classify an old event's ownership only. It may never mutate current order/position state. */
export async function provesManagedHistory(accountId: string, evidence: ExchangeUnresolvedEvent['evidence'], providerSymbol: string | null): Promise<boolean> {
  if (!providerSymbol || evidence.providerSymbol !== providerSymbol || typeof evidence.exchangeOrderId !== 'string') return false;
  const orders = await getDatabase().all<KnownHistoryOrder[]>(
    `SELECT id, client_order_id, side, reduce_only, role, quantity, filled_quantity FROM trading_orders
     WHERE account_id = ? AND exchange_order_id = ? AND provider_symbol = ?`, [accountId, evidence.exchangeOrderId, providerSymbol],
  );
  if (orders.length !== 1 || !matchesKnownOrder(orders[0], evidence)) return false;
  if (!validQuantity(evidence.providerReportedQuantity)) return false;
  if (evidence.filledQuantity === null && String(evidence.eventType).startsWith('OrderTrigger')) {
    return orders[0].reduce_only === 1 && ['stop_loss', 'take_profit'].includes(orders[0].role);
  }
  if (typeof evidence.filledQuantity !== 'string') return false;
  const fills = await getDatabase().all<Array<{ quantity: string }>>('SELECT quantity FROM trading_fills WHERE order_id = ?', [orders[0].id]);
  try {
    const reported = evidence.filledQuantity;
    const executed = sumDecimals(fills.map(fill => fill.quantity));
    return compareDecimal(reported, orders[0].filled_quantity) <= 0 && compareDecimal(reported, executed) <= 0
      && compareDecimal(executed, orders[0].quantity) <= 0 && compareDecimal(executed, orders[0].filled_quantity) === 0;
  } catch { return false; }
}

function validQuantity(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try { return compareDecimal(value, '0') >= 0; } catch { return false; }
}

function matchesKnownOrder(order: KnownHistoryOrder, evidence: ExchangeUnresolvedEvent['evidence']): boolean {
  return (evidence.clientOrderId === null || evidence.clientOrderId === order.client_order_id)
    && typeof evidence.side === 'string' && evidence.side.toLowerCase() === order.side
    && typeof evidence.reduceOnly === 'boolean' && evidence.reduceOnly === (order.reduce_only === 1);
}
