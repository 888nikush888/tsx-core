import { createHash, randomUUID } from 'node:crypto';
import { getDatabase, withDatabaseTransaction } from './db.js';
import { validateOrderResult, validateRemoteOrder } from './exchange_contract_validation.js';
import { compareDecimal } from './trading_decimal.js';
import { canTransitionIntent, mergeOrderEvidence, type LocalOrderStatus } from './trading_state_transitions.js';
import { persistNativeOrderBindingForLocal } from './trading_order_identity_bindings.js';
import type { ExchangeOrderResult, ExchangeOrderSnapshot, PlannedOrder, TradingIntent, TradingIntentStatus, TradingPlan } from './trading_types.js';

export async function transitionTradingIntent(
  id: string, status: TradingIntentStatus,
  options: { plan?: TradingPlan; blockReason?: string; error?: string } = {},
): Promise<void> {
  await withDatabaseTransaction(async () => {
    const current = await getDatabase().get<{ status: string; state_version: number }>(
      'SELECT status, state_version FROM trading_trade_intents WHERE id = ?', [id],
    );
    if (!current || !canTransitionIntent(current.status, status)) {
      throw new Error(`Trading intent transition to ${status} conflicts with its current state.`);
    }
    const update = await getDatabase().run(
      `UPDATE trading_trade_intents SET status = ?, plan_json = COALESCE(?, plan_json),
       block_reason = ?, last_error = ?, updated_at = ?, state_version = state_version + 1
       WHERE id = ? AND status = ? AND state_version = ?`,
      [status, options.plan ? JSON.stringify(options.plan) : null, options.blockReason || null,
        options.error || null, Date.now(), id, current.status, current.state_version],
    );
    if (update.changes !== 1) throw new Error('Trading intent changed before its transition could commit.');
  });
}

interface LocalOrderRow {
  id: string;
  account_id: string;
  exchange: string;
  symbol: string;
  exchange_order_id: string | null;
  provider_symbol: string | null;
  status: LocalOrderStatus;
  quantity: string;
  filled_quantity: string;
  average_price: string | null;
  state_version: number;
}

type IdentifiedOrderEvidence = Omit<ExchangeOrderResult, 'filledQuantity'> & { filledQuantity: string | null };

function providerOrderKey(local: LocalOrderRow, result: IdentifiedOrderEvidence): { symbol: string | null; key: string | null } {
  const symbol = result.providerSymbol ?? local.provider_symbol ?? (local.exchange === 'paper' ? local.symbol : null);
  if (symbol !== null && (!symbol.trim() || symbol.length > 256 || /[\x00-\x1f]/.test(symbol))) {
    throw new Error('Invalid provider symbol for remote order identity.');
  }
  if (local.provider_symbol && symbol !== local.provider_symbol) throw new Error('Remote order namespace changed.');
  return { symbol, key: symbol === null ? null : JSON.stringify(['v1', local.exchange, symbol, result.exchangeOrderId]) };
}

/** A write acknowledgement must address exactly the order that was submitted/cancelled. */
export async function persistTradingOrderResult(
  intentId: string, expectedClientOrderId: string, result: ExchangeOrderResult, observedAt = Date.now(),
): Promise<void> {
  validateOrderResult(result, { clientOrderId: expectedClientOrderId });
  return persistOrderEvidence(intentId, expectedClientOrderId, result, observedAt);
}

export async function persistTradingRemoteOrder(
  intentId: string, expectedClientOrderId: string, result: ExchangeOrderSnapshot, observedAt: number,
): Promise<void> {
  validateRemoteOrder(result);
  if (result.clientOrderId !== expectedClientOrderId) throw new Error('Remote order has no exact local client identity.');
  return persistOrderEvidence(intentId, expectedClientOrderId, { ...result, clientOrderId: expectedClientOrderId }, observedAt);
}

async function persistOrderEvidence(
  intentId: string, expectedClientOrderId: string, result: IdentifiedOrderEvidence, observedAt: number,
): Promise<void> {
  await withDatabaseTransaction(async () => {
    const local = await getDatabase().get<LocalOrderRow>(
      `SELECT orders.*, account.exchange, intent.symbol FROM trading_orders orders
       JOIN trading_trade_intents intent ON intent.id = orders.intent_id
       JOIN trading_accounts account ON account.id = orders.account_id
       WHERE orders.intent_id = ? AND orders.client_order_id = ?`,
      [intentId, expectedClientOrderId],
    );
    if (!local) throw new Error('Order acknowledgement has no matching local order.');
    if (local.exchange_order_id && local.exchange_order_id !== result.exchangeOrderId) {
      throw new Error('Exchange result identifier does not match the known remote order.');
    }
    if (result.filledQuantity !== null && compareDecimal(result.filledQuantity, local.quantity) > 0) {
      throw new Error('Exchange executed quantity exceeds the requested order quantity.');
    }
    const merged = mergeOrderEvidence({
      status: local.status, quantity: local.quantity, filledQuantity: local.filled_quantity, averagePrice: local.average_price,
    }, result);
    const remote = providerOrderKey(local, result);
    await persistNativeOrderBindingForLocal(local.id, result);
    const updated = await getDatabase().run(
      `UPDATE trading_orders SET exchange_order_id = ?, provider_symbol = ?, remote_order_key = ?,
       status = ?, filled_quantity = ?, average_price = ?, response_json = ?, last_error = ?,
       updated_at = MAX(updated_at, ?), state_version = state_version + 1
       WHERE id = ? AND state_version = ?`,
      [result.exchangeOrderId, remote.symbol, remote.key, merged.status, merged.filledQuantity, merged.averagePrice,
        JSON.stringify(result.raw), result.error, observedAt, local.id, local.state_version],
    );
    if (updated.changes !== 1) throw new Error('Order changed before its acknowledgement could commit.');
  });
}

function replacementSlot(order: PlannedOrder): string {
  if (order.role === 'entry' || !order.reduceOnly) throw new Error('Replacement generation is reserved for reduce-only exits.');
  if (order.role !== 'take_profit') return order.role;
  if (!Number.isSafeInteger(order.targetIndex) || Number(order.targetIndex) < 1) throw new Error('Replacement take-profit requires a target index.');
  return `take_profit:${order.targetIndex}`;
}

function samePlannedReplacement(left: PlannedOrder, right: PlannedOrder): boolean {
  const fields: Array<keyof PlannedOrder> = ['role', 'side', 'orderType', 'quantity', 'price', 'triggerPrice', 'reduceOnly', 'postOnly', 'targetIndex'];
  return fields.every(field => left[field] === right[field]);
}

/** Persist a replacement generation with its row, so a crash cannot manufacture a second replacement. */
export async function createGeneratedTradingOrder(intent: Pick<TradingIntent, 'id' | 'accountId'>, template: PlannedOrder): Promise<PlannedOrder> {
  return withDatabaseTransaction(async () => {
    const slot = replacementSlot(template);
    const previous = await getDatabase().get<{ generation: number; client_order_id: string }>(
      'SELECT generation, client_order_id FROM trading_order_generations WHERE intent_id = ? AND slot = ?', [intent.id, slot],
    );
    const unresolved = await getDatabase().get(
      "SELECT id FROM trading_orders WHERE intent_id = ? AND role = ? AND status IN ('submitting', 'unknown', 'cancel_pending') LIMIT 1",
      [intent.id, template.role],
    );
    if (unresolved) throw new Error('Replacement requires exchange reconciliation of the previous unresolved order.');
    if (previous) {
      const row = await getDatabase().get<{ status: string; request_json: string }>(
        'SELECT status, request_json FROM trading_orders WHERE intent_id = ? AND account_id = ? AND client_order_id = ?',
        [intent.id, intent.accountId, previous.client_order_id],
      );
      if (!row) throw new Error('Replacement generation references a missing order.');
      if (row.status === 'created') {
        const prepared = JSON.parse(row.request_json) as PlannedOrder;
        if (!samePlannedReplacement(prepared, template)) throw new Error('Prepared replacement changed; resolve the existing intent before replacing it.');
        return prepared;
      }
    }
    const generation = (previous?.generation ?? 0) + 1;
    const clientOrderId = `0x${createHash('sha256').update(JSON.stringify(['replacement-v1', intent.id, slot, generation])).digest('hex').slice(0, 32)}`;
    const order: PlannedOrder = { ...template, clientOrderId };
    const now = Date.now();
    await getDatabase().run(
      `INSERT INTO trading_orders (id, intent_id, account_id, client_order_id, role, side, order_type, status,
       price, trigger_price, quantity, filled_quantity, reduce_only, request_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, '0', 1, ?, ?, ?)`,
      [randomUUID(), intent.id, intent.accountId, clientOrderId, order.role, order.side, order.orderType,
        order.price, order.triggerPrice, order.quantity, JSON.stringify(order), now, now],
    );
    await getDatabase().run(
      `INSERT INTO trading_order_generations (intent_id, slot, generation, client_order_id) VALUES (?, ?, ?, ?)
       ON CONFLICT(intent_id, slot) DO UPDATE SET generation = excluded.generation, client_order_id = excluded.client_order_id`,
      [intent.id, slot, generation, clientOrderId],
    );
    return order;
  });
}
