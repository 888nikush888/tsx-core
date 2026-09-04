import { getDatabase } from './db.js';
import { compareDecimal, decimal, signedDecimal, sumDecimals } from './trading_decimal.js';
import { validateFillAccounting } from './trading_accounting_contract.js';
import { accountLogDigest } from './trading_account_log_contract.js';
import type { AccountLogRecord } from './trading_account_log_contract.js';
import type { TradingAccount } from './trading_types.js';

export interface ScopeOrder {
  id: string; account_id: string; exchange_order_id: string; client_order_id: string; provider_symbol: string;
  side: string; status: string; quantity: string; filled_quantity: string;
}
interface StoredExecution {
  id: string; exchange_fill_id: string; price: string; quantity: string; fee: string; fee_asset: string;
  filled_at: number; raw_json: string; account_fingerprint: string; accounting_json: string; accounting_conflict: number;
}
export interface RealExecution { executionId: string; quantity: string; price: string; fee: string; currency: string; timestamp: number; symbol: string }
export interface ObservedOrderExecutionSet {
  orderId: string; status: 'observed_terminal_execution_set' | 'not_proven'; executionIds?: string[];
  executionCount: number | null; executionSetHash: string | null; reason: string | null;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Execution source object is missing.');
  return value as Record<string, unknown>;
}
function assertIdentity(fill: StoredExecution, order: ScopeOrder, account: TradingAccount, raw: Record<string, unknown>, info: Record<string, unknown>): void {
  if (fill.accounting_conflict || fill.account_fingerprint !== account.externalAccountId) throw new Error('Unbound/conflicting execution.');
  const matches = [typeof fill.exchange_fill_id === 'string' && fill.exchange_fill_id.length > 0,
    raw.id === fill.exchange_fill_id, info.execId === fill.exchange_fill_id, raw.order === order.exchange_order_id,
    info.orderId === order.exchange_order_id, raw.symbol === order.provider_symbol, raw.side === order.side,
    info.side === (order.side === 'buy' ? 'Buy' : 'Sell'), info.execType === 'Trade', typeof info.symbol === 'string' && info.symbol.length > 0,
    !info.orderLinkId || info.orderLinkId === order.client_order_id];
  if (!matches.every(Boolean)) throw new Error('Original execution identity conflicts with its owned order.');
}
function realExecution(fill: StoredExecution, order: ScopeOrder, account: TradingAccount): RealExecution | null {
  try {
    const raw = object(JSON.parse(fill.raw_json)), info = object(raw.info);
    assertIdentity(fill, order, account, raw, info);
    if (['execQty', 'execPrice', 'execFee', 'execTime'].some(field => typeof info[field] !== 'string')) return null;
    const market = validateFillAccounting(JSON.parse(fill.accounting_json), order.provider_symbol);
    if (market.source !== 'ccxt-market-v1' || market.settlementAsset !== fill.fee_asset) return null;
    const quantity = decimal(String(info.execQty), { positive: true }), price = decimal(String(info.execPrice), { positive: true });
    const fee = signedDecimal(String(info.execFee));
    if (compareDecimal(quantity, fill.quantity) !== 0 || compareDecimal(price, fill.price) !== 0 || fee !== signedDecimal(fill.fee)) return null;
    if (!/^\d+$/.test(String(info.execTime)) || Number(info.execTime) !== fill.filled_at || raw.timestamp !== fill.filled_at) return null;
    if (info.feeCurrency && info.feeCurrency !== fill.fee_asset) return null;
    return { executionId: fill.exchange_fill_id, quantity, price, fee, currency: fill.fee_asset, timestamp: fill.filled_at, symbol: String(info.symbol) };
  } catch { return null; }
}

export async function observedOrderExecutions(account: TradingAccount, order: ScopeOrder): Promise<{
  executions: RealExecution[]; proof: ObservedOrderExecutionSet;
}> {
  const fills = await getDatabase().all<StoredExecution[]>(`SELECT * FROM trading_fills WHERE account_id=? AND order_id=? ORDER BY exchange_fill_id LIMIT 201`,
    [account.id, order.id]);
  const executions = fills.map(fill => realExecution(fill, order, account)).filter((value): value is RealExecution => value !== null);
  const proof: ObservedOrderExecutionSet = { orderId: order.exchange_order_id, status: 'not_proven',
    executionCount: null, executionSetHash: null, reason: 'terminal_execution_set_unproved' };
  if (fills.length > 200 || executions.length !== fills.length || new Set(executions.map(row => row.executionId)).size !== fills.length) return { executions: [], proof };
  try {
    decimal(order.quantity, { positive: true });
    const total = sumDecimals(executions.map(row => row.quantity));
    const terminal = ['filled', 'cancelled', 'rejected'].includes(order.status);
    if (terminal && compareDecimal(total, order.filled_quantity) === 0 && compareDecimal(total, order.quantity) <= 0
      && (order.status !== 'filled' || compareDecimal(total, order.quantity) === 0)) {
      proof.status = 'observed_terminal_execution_set'; proof.reason = null;
      proof.executionCount = executions.length; proof.executionSetHash = accountLogDigest(executions);
      if (executions.length <= 8) proof.executionIds = executions.map(row => row.executionId);
    }
  } catch { /* Missing or invalid cumulative quantities are not repaired by a ledger row. */ }
  return { executions, proof };
}

/** Ledger tradeId and execId have different contracts. Correlate exact owned order plus a unique full economic match. */
export function executionMatches(record: AccountLogRecord, execution: RealExecution): boolean {
  try {
    return record.symbol === execution.symbol && record.currency === execution.currency && Number(record.transactionTime) === execution.timestamp
      && decimal(record.qty!, { positive: true }) === execution.quantity && decimal(record.tradePrice!, { positive: true }) === execution.price
      && signedDecimal(record.fee!) === execution.fee;
  } catch { return false; }
}
