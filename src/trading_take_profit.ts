import { createHash } from 'node:crypto';
import { getDatabase, withDatabaseTransaction } from './db.js';
import { addDecimal, compareDecimal, decimal, divideDecimal, minDecimal, multiplyDecimal, quantizeDecimalDown, subtractDecimal, sumDecimals } from './trading_decimal.js';
import { loadOwnershipProof } from './trading_ownership.js';
import { TERMINAL_ORDER_STATES } from './trading_entry_commitment.js';
import { retireUndispatchedExit } from './trading_lifecycle.js';
import { createGeneratedTradingOrder } from './trading_order_repository.js';
import { recoverTakeProfitBasis, type RecoverableTargetRow } from './trading_take_profit_recovery.js';
import type { ExchangeOpenState, PlannedOrder, TradingIntent, TradingPlan, TradingSide } from './trading_types.js';

export type TakeProfitOrderRow = RecoverableTargetRow;

export function targetIndexFromOrderRow(row: TakeProfitOrderRow): number | null {
  try {
    const index = (JSON.parse(row.request_json) as PlannedOrder).targetIndex;
    return Number.isSafeInteger(index) && Number(index) > 0 ? Number(index) : null;
  } catch { return null; }
}

export async function loadTakeProfitOrders(intentId: string): Promise<TakeProfitOrderRow[]> {
  return getDatabase().all<TakeProfitOrderRow[]>(
    `SELECT client_order_id, exchange_order_id, provider_symbol, status, price, quantity, filled_quantity, request_json, created_at FROM trading_orders
     WHERE intent_id = ? AND role = 'take_profit' ORDER BY created_at, client_order_id`, [intentId]);
}

/** Never rewrite a dispatched request. Matching prepared orders retain their identity across restart. */
export async function prepareTargetOrder(intent: TradingIntent, original: PlannedOrder, remaining: string, rows: TakeProfitOrderRow[]): Promise<PlannedOrder | null> {
  return withDatabaseTransaction(async () => {
    const desired = { ...original, quantity: remaining };
    let prepared: PlannedOrder | null = null;
    for (const row of rows.filter(order => order.status === 'created')) {
      const candidate = JSON.parse(row.request_json) as PlannedOrder;
      const same = remaining !== '0' && row.quantity === remaining && row.price === original.price
        && Object.entries(desired).every(([key, value]) => key === 'clientOrderId' || candidate[key as keyof PlannedOrder] === value)
        && candidate.clientOrderId === row.client_order_id;
      if (same && !prepared) { prepared = candidate; continue; }
      if (!await retireUndispatchedExit(intent.id, row.client_order_id)) throw new Error('Prepared TP has no positive no-dispatch proof.');
    }
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

/** Scale only unconsumed target budgets. Filled targets never get recreated on later resize. */
export function resizeTargetTotals(previous: string[], filled: string[], netQuantity: string, step: string) {
  if (previous.length === 0 || previous.length !== filled.length) throw new Error('Invalid TP allocation dimensions.');
  const weights = previous.map((value, index) => {
    const executed = decimal(filled[index]!);
    const total = decimal(value);
    return compareDecimal(total, executed) > 0 ? subtractDecimal(total, executed) : '0';
  });
  const weight = sumDecimals(weights);
  const available = quantizeDecimalDown(decimal(netQuantity), decimal(step, { positive: true }));
  if (weight === '0' && available !== '0') throw new Error('TP_TARGETS_EXHAUSTED_WITH_EXPOSURE');
  const remaining = weights.map(value => weight === '0' ? '0'
    : quantizeDecimalDown(divideDecimal(multiplyDecimal(available, value), weight), step));
  let remainder = subtractDecimal(available, sumDecimals(remaining));
  // Deterministic rounding; keep the last-target remainder convention without exceeding an old cap on shrink.
  for (let index = weights.length - 1; index >= 0 && remainder !== '0'; index -= 1) {
    if (weights[index] === '0') continue;
    const room = compareDecimal(available, weight) <= 0
      ? quantizeDecimalDown(subtractDecimal(weights[index]!, remaining[index]!), step) : remainder;
    const extra = minDecimal(room, remainder);
    remaining[index] = addDecimal(remaining[index]!, extra);
    remainder = subtractDecimal(remainder, extra);
  }
  return { totals: remaining.map((value, index) => addDecimal(value, filled[index]!)), remaining,
    unallocatedQuantity: subtractDecimal(netQuantity, sumDecimals(remaining)) };
}

interface AllocationRow {
  plan_hash: string; target_totals_json: string; observed_fills_json: string; completed_targets_json: string;
  unallocated_quantity: string; state_version: number;
}

export function completedTargetEvidence(totals: string[], previousFilled: string[], completed: boolean[], filled: string[]): boolean[] {
  if ([previousFilled, completed, filled].some(values => values.length !== totals.length)) throw new Error('Invalid target completion dimensions.');
  return totals.map((total, index) => {
    const before = previousFilled[index]!;
    const current = filled[index]!;
    if (compareDecimal(current, before) < 0) throw new Error('TP fill evidence regressed.');
    return completed[index]! || (compareDecimal(total, before) > 0 && compareDecimal(current, before) > 0 && compareDecimal(current, total) >= 0);
  });
}

function completionState(row: AllocationRow | undefined, totals: string[], filled: string[]): boolean[] {
  const previousFilled = row ? JSON.parse(row.observed_fills_json) : totals.map(() => '0');
  const completed = row ? JSON.parse(row.completed_targets_json) : totals.map(() => false);
  if (!Array.isArray(previousFilled) || !Array.isArray(completed) || completed.some(value => typeof value !== 'boolean')) {
    throw new Error('Invalid stored TP completion evidence.');
  }
  return completedTargetEvidence(totals, previousFilled, completed, filled);
}

function previousTotals(row: AllocationRow, plan: TradingPlan, hash: string): string[] {
  if (row.plan_hash !== hash) throw new Error('Persisted TP allocation conflicts with the immutable trade plan.');
  const parsed: unknown = JSON.parse(row.target_totals_json);
  if (!Array.isArray(parsed) || parsed.length !== plan.targetAllocationsPercent.length) throw new Error('Invalid stored TP allocation.');
  return parsed.map(value => decimal(value));
}

async function persistAllocation(intentId: string, hash: string, row: AllocationRow | undefined,
  allocation: ReturnType<typeof resizeTargetTotals>, filled: string[], completed: boolean[]): Promise<void> {
  const json = JSON.stringify(allocation.totals);
  const fillsJson = JSON.stringify(filled);
  const completedJson = JSON.stringify(completed);
  if (row?.target_totals_json === json && row.unallocated_quantity === allocation.unallocatedQuantity
    && row.observed_fills_json === fillsJson && row.completed_targets_json === completedJson) return;
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

/** Called only after authoritative ingestion; actual fill ledger is mandatory, acknowledgements alone do not allocate. */
export async function loadTakeProfitAllocation(intentId: string, plan: TradingPlan, remote: ExchangeOpenState) {
  return withDatabaseTransaction(async () => {
    const entries = await getDatabase().all<Array<{ status: string }>>(
      "SELECT status FROM trading_orders WHERE intent_id = ? AND role = 'entry'", [intentId]);
    if (entries.length === 0 || entries.some(entry => !(TERMINAL_ORDER_STATES as readonly string[]).includes(entry.status))) return null;
    const intent = await getDatabase().get<{ side: TradingSide }>('SELECT side FROM trading_trade_intents WHERE id = ?', [intentId]);
    if (!intent) throw new Error('TP allocation has no managed intent.');
    const proof = await loadOwnershipProof(intentId, intent.side);
    if (proof.entryQuantity === '0') return null;
    const rows = await loadTakeProfitOrders(intentId);
    const targets = plan.orders.filter(order => order.role === 'take_profit');
    if (targets.length !== plan.targetAllocationsPercent.length) throw new Error('TP target count conflicts with plan allocation.');
    const filled = targets.map(() => '0');
    for (const order of rows) {
      const index = targetIndexFromOrderRow(order);
      if (index === null || index > targets.length) throw new Error('Take-profit order has no valid target index.');
      filled[index - 1] = addDecimal(filled[index - 1]!, order.filled_quantity);
    }
    const row = await getDatabase().get<AllocationRow>('SELECT * FROM trading_take_profit_allocations WHERE intent_id = ?', [intentId]);
    const hash = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
    const basis = row ? null : await recoverTakeProfitBasis(intentId, plan, rows, proof, remote);
    const previous = row ? previousTotals(row, plan, hash) : basis!.totals;
    const completed = row ? completionState(row, previous, filled) : basis!.completed;
    const allocation = resizeTargetTotals(previous, filled, proof.netQuantity, plan.quantityStep);
    await persistAllocation(intentId, hash, row, allocation, filled, completed);
    return { ...allocation, filled, rows, completed: completed.filter(Boolean).length };
  });
}
