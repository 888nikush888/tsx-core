import { createHash, randomUUID } from 'node:crypto';
import { getDatabase } from './db.js';
import { addDecimal, compareDecimal, quantizeDecimalDown, subtractDecimal, sumDecimals } from './trading_decimal.js';
import { allocateTargetQuantities } from './trading_risk.js';
import type { OwnershipProof } from './trading_ownership.js';
import type { ExchangeOpenState, PlannedOrder, TradingPlan } from './trading_types.js';

export interface RecoverableTargetRow {
  client_order_id: string; exchange_order_id: string | null; provider_symbol: string | null;
  status: string; price: string | null; quantity: string; filled_quantity: string; request_json: string; created_at: number;
}

export class TakeProfitReviewRequiredError extends Error {
  readonly code = 'TP_ALLOCATION_REVIEW_REQUIRED';
  constructor(reason: string) {
    super(`TP_ALLOCATION_REVIEW_REQUIRED: ${reason}. Existing own stop protection must continue; target budgets are not inferred.`);
    this.name = 'TakeProfitReviewRequiredError';
  }
}

function plannedRequest(row: RecoverableTargetRow, target: PlannedOrder): PlannedOrder {
  const request = JSON.parse(row.request_json) as PlannedOrder;
  const unchanged = Object.entries(target).every(([key, value]) => ['clientOrderId', 'quantity'].includes(key)
    || request[key as keyof PlannedOrder] === value);
  if (!unchanged || request.clientOrderId !== row.client_order_id || request.quantity !== row.quantity || request.price !== row.price) {
    throw new TakeProfitReviewRequiredError('Target request does not match its stored order and immutable signal');
  }
  return request;
}

function exactCurrentTarget(row: RecoverableTargetRow, target: PlannedOrder, remote: ExchangeOpenState, symbol: string): boolean {
  const matches = remote.orders.filter(order => order.clientOrderId === row.client_order_id && order.exchangeOrderId === row.exchange_order_id
    && order.providerSymbol === row.provider_symbol);
  if (matches.length !== 1) return false;
  const order = matches[0]!;
  return order.symbol === symbol
    && order.side === target.side && order.reduceOnly && order.status === row.status && order.quantity === row.quantity
    && order.filledQuantity === row.filled_quantity && order.price === target.price;
}

function proveTargetBasis(rows: RecoverableTargetRow[], target: PlannedOrder, remote: ExchangeOpenState, symbol: string) {
  for (const row of rows) plannedRequest(row, target);
  if (rows.some(row => !['open', 'partially_filled', 'filled', 'cancelled', 'rejected'].includes(row.status))) {
    throw new TakeProfitReviewRequiredError('Target has an unfinished dispatch or replacement');
  }
  const active = rows.filter(row => ['open', 'partially_filled'].includes(row.status));
  const finished = rows.filter(row => row.status === 'filled' && compareDecimal(row.quantity, row.filled_quantity) === 0);
  const filled = sumDecimals(rows.map(row => row.filled_quantity));
  if (active.length === 1 && finished.length === 0 && exactCurrentTarget(active[0]!, target, remote, symbol)) {
    return { total: addDecimal(filled, subtractDecimal(active[0]!.quantity, active[0]!.filled_quantity)), completed: false };
  }
  if (active.length === 0 && finished.length === 1 && rows.every(row => row === finished[0] || row.created_at < finished[0]!.created_at)) {
    return { total: filled, completed: true };
  }
  throw new TakeProfitReviewRequiredError('Target completion or remaining budget is ambiguous');
}

async function assertNoPendingTargetOperation(intentId: string): Promise<void> {
  const pending = await getDatabase().get(
    `SELECT operation.id FROM trading_operations AS operation WHERE operation.intent_id = ?
     AND operation.phase NOT IN ('resolved', 'abandoned') AND EXISTS (
       SELECT 1 FROM json_each(operation.expected_orders_json) AS expected JOIN trading_orders AS orders
       ON orders.client_order_id = json_extract(expected.value, '$.client_order_id') AND orders.intent_id = operation.intent_id
       WHERE orders.role = 'take_profit') LIMIT 1`, [intentId]);
  if (pending) throw new TakeProfitReviewRequiredError('Target operation has no resolved outcome');
}

/** Only pristine unsent plans or positively evidenced current/fully executed target generations can establish a missing basis. */
export async function recoverTakeProfitBasis(intentId: string, plan: TradingPlan, rows: RecoverableTargetRow[], ownership: OwnershipProof,
  remote: ExchangeOpenState) {
  const targets = plan.orders.filter(order => order.role === 'take_profit');
  const pristine = rows.length === targets.length && rows.every(row => {
    const target = targets.find(order => order.clientOrderId === row.client_order_id);
    return target && row.status === 'created' && row.exchange_order_id === null && row.filled_quantity === '0'
      && Object.entries(target).every(([key, value]) => JSON.parse(row.request_json)[key] === value) && row.quantity === target.quantity;
  });
  await assertNoPendingTargetOperation(intentId);
  if (pristine) return { totals: allocateTargetQuantities(ownership.entryQuantity, plan.targetAllocationsPercent, plan.quantityStep),
    completed: targets.map(() => false), recovered: false };
  const bases = targets.map(target => proveTargetBasis(rows.filter(row => JSON.parse(row.request_json).targetIndex === target.targetIndex), target, remote, plan.symbol));
  const remaining = subtractDecimal(sumDecimals(bases.map(basis => basis.total)), sumDecimals(rows.map(row => row.filled_quantity)));
  if (compareDecimal(remaining, quantizeDecimalDown(ownership.netQuantity, plan.quantityStep)) < 0) {
    throw new TakeProfitReviewRequiredError('Existing target budgets do not cover the proved owned remainder');
  }
  const evidence = { version: 1, source: 'exact_target_generations', planHash: createHash('sha256').update(JSON.stringify(plan)).digest('hex'),
    targets: bases, orders: rows.map(row => ({ id: row.client_order_id, exchangeId: row.exchange_order_id, status: row.status,
      quantity: row.quantity, filledQuantity: row.filled_quantity })), observedAt: remote.observedAt };
  await getDatabase().run(`INSERT INTO trading_risk_events (id, severity, code, account_id, intent_id, details_json, created_at)
    SELECT ?, 'info', 'TP_ALLOCATION_RECOVERED', account_id, id, ?, ? FROM trading_trade_intents WHERE id = ?`,
  [randomUUID(), JSON.stringify(evidence), Date.now(), intentId]);
  return { totals: bases.map(basis => basis.total), completed: bases.map(basis => basis.completed), recovered: true };
}
