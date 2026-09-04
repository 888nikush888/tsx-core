import { getDatabase } from './db.js';
import { addDecimal, compareDecimal, decimal, subtractDecimal } from './trading_decimal.js';
import type { ExchangePositionSnapshot, TradingSide } from './trading_types.js';

export class TradingOwnershipError extends Error {
  constructor(readonly code: string, message: string) {
    super(`Ownership proof failed (${code}): ${message}`);
    this.name = 'TradingOwnershipError';
  }
}

export interface OwnershipOrder {
  id: string; role: string; side: string; reduce_only: number; quantity: string; filled_quantity: string;
}
export interface OwnershipFill { order_id: string; quantity: string }
export interface OwnershipProof { entryQuantity: string; exitQuantity: string; netQuantity: string }

function assertOrderSemantics(order: OwnershipOrder, side: TradingSide): void {
  const entry = order.role === 'entry';
  const entrySide = side === 'LONG' ? 'buy' : 'sell';
  const expectedSide = entry ? entrySide : entrySide === 'buy' ? 'sell' : 'buy';
  if (order.side !== expectedSide || Number(order.reduce_only) !== (entry ? 0 : 1)) {
    throw new TradingOwnershipError('ORDER_SEMANTICS', `Order ${order.id} cannot prove an owned ${side} execution.`);
  }
}

/** Cumulative acknowledgements are cross-checks, not substitutes for the fill ledger. */
export function proveOwnedQuantity(orders: OwnershipOrder[], fills: OwnershipFill[], side: TradingSide): OwnershipProof {
  const totals = new Map<string, string>();
  const ids = new Set(orders.map(order => order.id));
  for (const fill of fills) {
    if (!ids.has(fill.order_id)) throw new TradingOwnershipError('UNMAPPED_FILL', 'A fill has no managed order.');
    totals.set(fill.order_id, addDecimal(totals.get(fill.order_id) ?? '0', decimal(fill.quantity, { positive: true })));
  }
  let entryQuantity = '0';
  let exitQuantity = '0';
  for (const order of orders) {
    assertOrderSemantics(order, side);
    const executed = totals.get(order.id) ?? '0';
    if (compareDecimal(executed, decimal(order.quantity, { positive: true })) > 0) {
      throw new TradingOwnershipError('ORDER_OVERFILLED', `Fill sum exceeds order ${order.id} quantity.`);
    }
    if (compareDecimal(executed, decimal(order.filled_quantity)) !== 0) {
      throw new TradingOwnershipError('CUMULATIVE_EXECUTION_MISMATCH', `Fill ledger and cumulative execution disagree for order ${order.id}.`);
    }
    if (order.role === 'entry') entryQuantity = addDecimal(entryQuantity, executed);
    else exitQuantity = addDecimal(exitQuantity, executed);
  }
  if (compareDecimal(exitQuantity, entryQuantity) > 0) {
    throw new TradingOwnershipError('EXITS_EXCEED_ENTRIES', 'Owned exits exceed owned entries.');
  }
  return { entryQuantity, exitQuantity, netQuantity: subtractDecimal(entryQuantity, exitQuantity) };
}

export async function loadOwnershipProof(intentId: string, side: TradingSide): Promise<OwnershipProof> {
  const [orders, fills] = await Promise.all([
    getDatabase().all<OwnershipOrder[]>(
      'SELECT id, role, side, reduce_only, quantity, filled_quantity FROM trading_orders WHERE intent_id = ?', [intentId],
    ),
    getDatabase().all<OwnershipFill[]>(
      `SELECT fills.order_id, fills.quantity FROM trading_fills AS fills
       JOIN trading_orders AS orders ON orders.id = fills.order_id WHERE orders.intent_id = ?`, [intentId],
    ),
  ]);
  return proveOwnedQuantity(orders, fills, side);
}

export async function assertAccountOwnership(
  locals: Array<{ intent_id: string; symbol: string; side: TradingSide }>, positions: ExchangePositionSnapshot[],
): Promise<void> {
  const symbols = new Set<string>();
  for (const local of locals) {
    if (symbols.has(local.symbol)) throw new TradingOwnershipError('AMBIGUOUS_LOCAL_OWNERSHIP', 'Multiple local positions claim the same symbol.');
    symbols.add(local.symbol);
    const remote = positions.filter(position => position.symbol === local.symbol);
    if (remote.length > 1) throw new TradingOwnershipError('AMBIGUOUS_REMOTE_POSITION', 'Multiple remote positions use one canonical symbol.');
    const proof = await loadOwnershipProof(local.intent_id, local.side);
    if (remote.length === 0 && compareDecimal(proof.netQuantity, '0') > 0) {
      throw new TradingOwnershipError('REMOTE_POSITION_ABSENT', `Remote position ${local.symbol} is absent without terminal fill proof.`);
    }
    if (remote[0] && (remote[0].side !== local.side || compareDecimal(remote[0].quantity, proof.netQuantity) !== 0)) {
      throw new TradingOwnershipError('REMOTE_QUANTITY_MISMATCH', `Remote ${local.symbol} quantity does not equal the proved owned quantity.`);
    }
    if (remote[0]) await assertOwnedPositionNamespace(local.intent_id, remote[0]);
  }
}

export function assertPositionNamespace(position: ExchangePositionSnapshot, executedEntrySymbols: Array<string | null>): void {
  if (!position.providerSymbol || executedEntrySymbols.length === 0
    || executedEntrySymbols.some(symbol => !symbol || symbol !== position.providerSymbol)) {
    throw new TradingOwnershipError('POSITION_NAMESPACE_MISMATCH', 'Remote position market is not the exact market of every owned entry execution.');
  }
}

export async function assertOwnedPositionNamespace(intentId: string, position: ExchangePositionSnapshot): Promise<void> {
  const entries = await getDatabase().all<Array<{ provider_symbol: string | null; filled_quantity: string }>>(
    `SELECT provider_symbol, filled_quantity FROM trading_orders WHERE intent_id = ? AND role = 'entry'`, [intentId]);
  assertPositionNamespace(position, entries.filter(entry => compareDecimal(entry.filled_quantity, '0') > 0).map(entry => entry.provider_symbol));
}
