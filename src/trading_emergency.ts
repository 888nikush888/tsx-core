import { getDatabase, withDatabaseTransaction } from './db.js';
import { compareDecimal } from './trading_decimal.js';
import { requestEntryDrain } from './trading_entry_commitment.js';
import { createGeneratedTradingOrder } from './trading_order_repository.js';
import { retireUndispatchedExit } from './trading_lifecycle.js';
import { recoverPreparedExits } from './trading_recovery.js';
import type { PlannedOrder, TradingAccount, TradingIntent } from './trading_types.js';

export async function requestEmergencyExit(accountId: string, intentId: string, reason: string): Promise<boolean> {
  return withDatabaseTransaction(async () => {
    const result = await getDatabase().run(
      `UPDATE trading_positions SET status = 'emergency', emergency_requested_at = COALESCE(emergency_requested_at, ?),
         emergency_reason = COALESCE(emergency_reason, ?), updated_at = ?
       WHERE account_id = ? AND intent_id = ? AND status IN ('opening', 'open', 'closing', 'emergency')`,
      [Date.now(), reason.slice(0, 300), Date.now(), accountId, intentId]);
    if (result.changes !== 1) return false;
    await requestEntryDrain(accountId, 'Emergency exit requires entry drain', intentId);
    return true;
  });
}

/** Called only with newly reconciled, fill-proved own quantity. No snapshot absence is a retry signal. */
export async function prepareEmergencyReduction(account: TradingAccount, intent: TradingIntent, quantity: string): Promise<PlannedOrder> {
  await recoverPreparedExits(account, intent.id, 'flatten');
  const previous = await getDatabase().get<{ client_order_id: string; status: string; quantity: string; filled_quantity: string; updated_at: number }>(
    `SELECT client_order_id, status, quantity, filled_quantity, updated_at FROM trading_orders
     WHERE intent_id = ? AND role = 'flatten' ORDER BY created_at DESC, rowid DESC LIMIT 1`, [intent.id]);
  if (previous && ['submitting', 'unknown', 'cancel_pending', 'open', 'partially_filled'].includes(previous.status)) {
    throw new Error(`Emergency flatten status is ${previous.status}; exchange reconciliation is required.`);
  }
  if (previous?.status === 'filled' && compareDecimal(previous.filled_quantity, previous.quantity) !== 0) {
    throw new Error('Emergency flatten terminal evidence does not prove its claimed complete execution.');
  }
  if (previous?.status === 'rejected' && Date.now() - previous.updated_at < 10_000) {
    throw new Error('Emergency flatten retry is pending its persistent rejection cooldown.');
  }
  if (previous?.status === 'created' && compareDecimal(previous.quantity, quantity) !== 0) {
    if (!await retireUndispatchedExit(intent.id, previous.client_order_id)) {
      throw new Error('Prepared emergency quantity changed without a no-dispatch proof.');
    }
  }
  return createGeneratedTradingOrder(intent, {
    clientOrderId: '', role: 'flatten', side: intent.side === 'LONG' ? 'sell' : 'buy', orderType: 'market', quantity,
    price: null, triggerPrice: null, reduceOnly: true, postOnly: false, targetIndex: null,
  });
}
