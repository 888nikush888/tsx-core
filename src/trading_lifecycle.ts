import { getDatabase, withDatabaseTransaction } from './db.js';
import { compareDecimal } from './trading_decimal.js';
import { entryCommitmentReason, TERMINAL_ORDER_STATES } from './trading_entry_commitment.js';
import { loadOwnershipProof } from './trading_ownership.js';
import { transitionTradingOperation, type TradingOperationPhase } from './trading_recovery.js';
import type { TradingSide } from './trading_types.js';

export interface LifecycleOrder {
  client_order_id: string; role: string; status: string; exchange_order_id: string | null; provider_symbol: string | null;
}

/** Local lifecycle proof only. Acquisition completeness and account release require additional evidence. */
export async function loadTradeLifecycle(intentId: string, side: TradingSide) {
  const orders = await getDatabase().all<LifecycleOrder[]>(
    'SELECT client_order_id, role, status, exchange_order_id, provider_symbol FROM trading_orders WHERE intent_id = ?', [intentId]);
  const pending = await getDatabase().get<{ count: number; entries: number }>(
    `SELECT COUNT(*) AS count, COALESCE(SUM(CASE WHEN EXISTS (
       SELECT 1 FROM json_each(operation.expected_orders_json) AS expected JOIN trading_orders AS orders
         ON orders.client_order_id = json_extract(expected.value, '$.client_order_id') AND orders.intent_id = operation.intent_id
       WHERE orders.role = 'entry') THEN 1 ELSE 0 END), 0) AS entries
     FROM trading_operations AS operation WHERE operation.intent_id = ? AND operation.phase IN ('dispatching', 'unresolved')`, [intentId]);
  const ownership = await loadOwnershipProof(intentId, side);
  const entries = orders.filter(order => order.role === 'entry');
  const entriesTerminal = entries.length > 0 && entries.every(order => entryCommitmentReason(order.status, Number(pending?.entries ?? 0) > 0) === null);
  const ordersTerminal = entriesTerminal && orders.every(order => (TERMINAL_ORDER_STATES as readonly string[]).includes(order.status));
  return { orders, ownership, entriesTerminal, ordersTerminal, operationsResolved: Number(pending?.count ?? 0) === 0,
    flat: compareDecimal(ownership.netQuantity, '0') === 0 };
}

/** Prove an individual exit never dispatched. Caller must separately justify cleanup or safe replacement. */
export async function retireUndispatchedExit(intentId: string, clientOrderId: string): Promise<boolean> {
  return withDatabaseTransaction(async () => {
    const order = await getDatabase().get<{ id: string }>(
      `SELECT id FROM trading_orders WHERE intent_id = ? AND client_order_id = ? AND role <> 'entry'
       AND status = 'created' AND exchange_order_id IS NULL AND filled_quantity = '0'`, [intentId, clientOrderId]);
    if (!order || await getDatabase().get('SELECT id FROM trading_fills WHERE order_id = ? LIMIT 1', [order.id])) return false;
    const operations = await getDatabase().all<Array<{ id: string; phase: TradingOperationPhase; expected_orders_json: string }>>(
      `SELECT id, phase, expected_orders_json FROM trading_operations WHERE intent_id = ? AND EXISTS (
         SELECT 1 FROM json_each(expected_orders_json) WHERE json_extract(value, '$.client_order_id') = ?)`, [intentId, clientOrderId]);
    if (operations.some(operation => !['prepared', 'abandoned'].includes(operation.phase)
      || JSON.parse(operation.expected_orders_json).length !== 1)) return false;
    for (const operation of operations) {
      if (operation.phase === 'prepared') await transitionTradingOperation(operation.id, 'prepared', 'abandoned');
    }
    const changed = await getDatabase().run(
      "UPDATE trading_orders SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'created'", [Date.now(), order.id]);
    return changed.changes === 1;
  });
}
