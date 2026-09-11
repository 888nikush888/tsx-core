import { createHash, timingSafeEqual } from 'node:crypto';
import { getDatabase, withDatabaseTransaction } from './db.js';
import { addDecimal, compareDecimal, decimal, divideDecimal, minDecimal, multiplyDecimal, quantizeDecimalDown, subtractDecimal, sumDecimals } from './trading_decimal.js';
import { loadOwnershipProof } from './trading_ownership.js';
import { TERMINAL_ORDER_STATES } from './trading_entry_commitment.js';
import { retireUndispatchedExit } from './trading_lifecycle.js';
import { createGeneratedTradingOrder } from './trading_order_repository.js';
import { recoverTakeProfitBasis, type RecoverableTargetRow } from './trading_take_profit_recovery.js';
import type { ExchangeOpenState, PlannedOrder, TradingIntent, TradingPlan, TradingSide } from './trading_types.js';

export type PlannedTakeProfitOrder = PlannedOrder & { price: string; targetIndex: number };

/** Verify every pinned target before recovering, cancelling, or submitting exit orders. */
export function requireTakeProfitTargets(plan: TradingPlan): PlannedTakeProfitOrder[] {
  return plan.orders.filter(order => order.role === 'take_profit').map((order, index) => {
    if (typeof order.price !== 'string' || order.targetIndex !== index + 1) {
      throw new Error('Take-profit plan has no valid target price or ordered index.');
    }
    decimal(order.price, { positive: true });
    return { ...order, price: order.price, targetIndex: order.targetIndex };
  });
}

export function requireTakeProfitAllocation(totals: string[], remaining: string[], index: number) {
  const desired = totals[index];
  const outstanding = remaining[index];
  if (typeof desired !== 'string' || typeof outstanding !== 'string') {
    throw new Error('Take-profit allocation has no quantity for a planned target.');
  }
  decimal(desired);
  decimal(outstanding);
  return { desired, remaining: outstanding };
}

export type TakeProfitOrderRow = RecoverableTargetRow;

export function targetIndexFromOrderRow(row: TakeProfitOrderRow): number | null {
  try {
    const index = (JSON.parse(row.request_json) as PlannedOrder).targetIndex;
    return Number.isSafeInteger(index) && Number(index) > 0 ? Number(index) : null;
  } catch { return null; }
}

export async function loadTakeProfitOrders(intentId: string): Promise<TakeProfitOrderRow[]> {
  return await getDatabase().all<TakeProfitOrderRow[]>(
    `SELECT client_order_id, exchange_order_id, provider_symbol, status, price, quantity, filled_quantity, request_json, created_at FROM trading_orders
     WHERE intent_id = ? AND role = 'take_profit' ORDER BY created_at, client_order_id`, [intentId]);
}

function samePreparedTarget(row: TakeProfitOrderRow, candidate: PlannedOrder, desired: PlannedOrder): boolean {
  return desired.quantity !== '0' && row.quantity === desired.quantity && row.price === desired.price
    && Object.entries(desired).every(([key, value]) => key === 'clientOrderId' || candidate[key as keyof PlannedOrder] === value)
    && candidate.clientOrderId === row.client_order_id;
}

async function selectPreparedTarget(intentId: string, desired: PlannedOrder, rows: TakeProfitOrderRow[]): Promise<PlannedOrder | null> {
  let prepared: PlannedOrder | null = null;
  for (const row of rows.filter(order => order.status === 'created')) {
    const candidate = JSON.parse(row.request_json) as PlannedOrder;
    if (samePreparedTarget(row, candidate, desired) && !prepared) { prepared = candidate; continue; }
    if (!await retireUndispatchedExit(intentId, row.client_order_id)) throw new Error('Prepared TP has no positive no-dispatch proof.');
  }
  return prepared;
}

/** Never rewrite a dispatched request. Matching prepared orders retain their identity across restart. */
export async function prepareTargetOrder(intent: TradingIntent, original: PlannedOrder, remaining: string, rows: TakeProfitOrderRow[]): Promise<PlannedOrder | null> {
  return await withDatabaseTransaction(async () => {
    const desired = { ...original, quantity: remaining };
    const prepared = await selectPreparedTarget(intent.id, desired, rows);
    if (remaining === '0') return null;
    return prepared ?? createGeneratedTradingOrder(intent, desired);
  });
}

export function targetOrderCoverage(rows: TakeProfitOrderRow[], price: string) {
  const active = rows.filter(row => ['open', 'partially_filled'].includes(row.status));
  const filled = sumDecimals(rows.map(row => row.filled_quantity));
  const remaining = sumDecimals(active.map(row => subtractDecimal(row.quantity, row.filled_quantity)));
  return { active, filled, remaining, covered: addDecimal(filled, remaining),
    pricesMatch: active.every(row => row.price !== null && compareDecimal(row.price, price) === 0) };
}

function targetQuantity(values: string[], index: number): string {
  const value = values[index];
  if (typeof value !== 'string') throw new Error('TP allocation has a missing or invalid target quantity.');
  return value;
}

function assertTargetQuantities(...collections: string[][]): void {
  for (const values of collections) {
    for (const [index] of values.entries()) decimal(targetQuantity(values, index));
  }
}

function targetCompletion(values: boolean[], index: number): boolean {
  const value = values[index];
  if (typeof value !== 'boolean') throw new Error('TP allocation has missing or invalid completion evidence.');
  return value;
}

function allocateRoundingRemainder(weights: string[], remaining: string[], available: string, weight: string, step: string): void {
  let remainder = subtractDecimal(available, sumDecimals(remaining));
  // Deterministic rounding; keep the last-target remainder convention without exceeding an old cap on shrink.
  for (let index = weights.length - 1; index >= 0 && remainder !== '0'; index -= 1) {
    if (weights[index] === '0') continue;
    const room = compareDecimal(available, weight) <= 0
      ? quantizeDecimalDown(subtractDecimal(targetQuantity(weights, index), targetQuantity(remaining, index)), step) : remainder;
    const extra = minDecimal(room, remainder);
    remaining[index] = addDecimal(targetQuantity(remaining, index), extra);
    remainder = subtractDecimal(remainder, extra);
  }
}

/** Scale only unconsumed target budgets. Filled targets never get recreated on later resize. */
export function resizeTargetTotals(previous: string[], filled: string[], netQuantity: string, step: string) {
  if (previous.length === 0 || previous.length !== filled.length) throw new Error('Invalid TP allocation dimensions.');
  assertTargetQuantities(previous, filled);
  const weights = previous.map((value, index) => {
    const executed = decimal(targetQuantity(filled, index));
    const total = decimal(value);
    return compareDecimal(total, executed) > 0 ? subtractDecimal(total, executed) : '0';
  });
  const weight = sumDecimals(weights);
  const available = quantizeDecimalDown(decimal(netQuantity), decimal(step, { positive: true }));
  if (weight === '0' && available !== '0') throw new Error('TP_TARGETS_EXHAUSTED_WITH_EXPOSURE');
  const remaining = weights.map(value => weight === '0' ? '0'
    : quantizeDecimalDown(divideDecimal(multiplyDecimal(available, value), weight), step));
  allocateRoundingRemainder(weights, remaining, available, weight, step);
  return { totals: remaining.map((value, index) => addDecimal(value, targetQuantity(filled, index))), remaining,
    unallocatedQuantity: subtractDecimal(netQuantity, sumDecimals(remaining)) };
}

interface AllocationRow {
  plan_hash: string; target_totals_json: string; observed_fills_json: string; completed_targets_json: string;
  unallocated_quantity: string; state_version: number;
}

export function completedTargetEvidence(totals: string[], previousFilled: string[], completed: boolean[], filled: string[]): boolean[] {
  if ([previousFilled, completed, filled].some(values => values.length !== totals.length)) throw new Error('Invalid target completion dimensions.');
  assertTargetQuantities(totals, previousFilled, filled);
  return totals.map((total, index) => {
    const before = targetQuantity(previousFilled, index);
    const current = targetQuantity(filled, index);
    if (compareDecimal(current, before) < 0) throw new Error('TP fill evidence regressed.');
    return targetCompletion(completed, index) || (compareDecimal(total, before) > 0 && compareDecimal(current, before) > 0 && compareDecimal(current, total) >= 0);
  });
}

function completionState(row: AllocationRow, totals: string[], filled: string[]): boolean[] {
  const previousFilled = JSON.parse(row.observed_fills_json);
  const completed = JSON.parse(row.completed_targets_json);
  if (!Array.isArray(previousFilled) || !Array.isArray(completed) || completed.some(value => typeof value !== 'boolean')) {
    throw new Error('Invalid stored TP completion evidence.');
  }
  return completedTargetEvidence(totals, previousFilled, completed, filled);
}

function previousTotals(row: AllocationRow, plan: TradingPlan, hash: string): string[] {
  const stored = Buffer.from(row.plan_hash, 'utf8');
  const expected = Buffer.from(hash, 'utf8');
  if (stored.length !== expected.length || !timingSafeEqual(stored, expected)) throw new Error('Persisted TP allocation conflicts with the immutable trade plan.');
  const parsed: unknown = JSON.parse(row.target_totals_json);
  if (!Array.isArray(parsed) || parsed.length !== plan.targetAllocationsPercent.length) throw new Error('Invalid stored TP allocation.');
  return parsed.map(value => decimal(value));
}

function unchangedAllocation(row: AllocationRow | undefined, json: string, fillsJson: string, completedJson: string, unallocated: string): boolean {
  return Boolean(row && row.target_totals_json === json && row.unallocated_quantity === unallocated
    && row.observed_fills_json === fillsJson && row.completed_targets_json === completedJson);
}

async function persistAllocation(intentId: string, hash: string, row: AllocationRow | undefined,
  allocation: ReturnType<typeof resizeTargetTotals>, filled: string[], completed: boolean[]): Promise<void> {
  const json = JSON.stringify(allocation.totals);
  const fillsJson = JSON.stringify(filled);
  const completedJson = JSON.stringify(completed);
  if (unchangedAllocation(row, json, fillsJson, completedJson, allocation.unallocatedQuantity)) return;
  if (!row) {
    await getDatabase().run(`INSERT INTO trading_take_profit_allocations
      (intent_id, plan_hash, target_totals_json, observed_fills_json, completed_targets_json, unallocated_quantity, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [intentId, hash, json, fillsJson, completedJson, allocation.unallocatedQuantity, Date.now()]);
    return;
  }
  const changed = await getDatabase().run(`UPDATE trading_take_profit_allocations
    SET target_totals_json = ?, observed_fills_json = ?, completed_targets_json = ?, unallocated_quantity = ?, state_version = state_version + 1, updated_at = ?
    WHERE intent_id = ? AND plan_hash = ? AND state_version = ?`,
  [json, fillsJson, completedJson, allocation.unallocatedQuantity, Date.now(), intentId, hash, row.state_version]);
  if (changed.changes !== 1) throw new Error('TP allocation changed before its update could commit.');
}

async function terminalEntryProof(intentId: string) {
    const entries = await getDatabase().all<Array<{ status: string }>>(
      "SELECT status FROM trading_orders WHERE intent_id = ? AND role = 'entry'", [intentId]);
    if (entries.length === 0 || entries.some(entry => !(TERMINAL_ORDER_STATES as readonly string[]).includes(entry.status))) return null;
    const intent = await getDatabase().get<{ side: TradingSide }>('SELECT side FROM trading_trade_intents WHERE id = ?', [intentId]);
    if (!intent) throw new Error('TP allocation has no managed intent.');
    const proof = await loadOwnershipProof(intentId, intent.side);
    if (proof.entryQuantity === '0') return null;
    return proof;
}

function filledTargetQuantities(rows: TakeProfitOrderRow[], targetCount: number): string[] {
  const filled = Array.from({ length: targetCount }, () => '0');
  for (const order of rows) {
    const index = targetIndexFromOrderRow(order);
    if (index === null || index > targetCount) throw new Error('Take-profit order has no valid target index.');
    filled[index - 1] = addDecimal(targetQuantity(filled, index - 1), order.filled_quantity);
  }
  return filled;
}

/** Called only after authoritative ingestion; actual fill ledger is mandatory, acknowledgements alone do not allocate. */
export async function loadTakeProfitAllocation(intentId: string, plan: TradingPlan, remote: ExchangeOpenState) {
  return await withDatabaseTransaction(async () => {
    const proof = await terminalEntryProof(intentId);
    if (!proof) return null;
    const rows = await loadTakeProfitOrders(intentId);
    const targets = plan.orders.filter(order => order.role === 'take_profit');
    if (targets.length !== plan.targetAllocationsPercent.length) throw new Error('TP target count conflicts with plan allocation.');
    const filled = filledTargetQuantities(rows, targets.length);
    const row = await getDatabase().get<AllocationRow>('SELECT * FROM trading_take_profit_allocations WHERE intent_id = ?', [intentId]);
    const hash = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
    let previous: string[];
    let completed: boolean[];
    if (row) {
      previous = previousTotals(row, plan, hash);
      completed = completionState(row, previous, filled);
    } else {
      const basis = await recoverTakeProfitBasis(intentId, plan, rows, proof, remote);
      previous = basis.totals;
      completed = basis.completed;
    }
    const allocation = resizeTargetTotals(previous, filled, proof.netQuantity, plan.quantityStep);
    await persistAllocation(intentId, hash, row, allocation, filled, completed);
    return { ...allocation, filled, rows, completed: completed.filter(Boolean).length };
  });
}
