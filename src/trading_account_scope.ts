import { getDatabase, withDatabaseTransaction } from './db.js';
import { signedDecimal } from './trading_decimal.js';
import { accountLogSource, validateAccountLogReceipt, type AccountLogRecord, type StoredAccountLogReceipt } from './trading_account_log_contract.js';
import { pendingAccountLogReceipts, setAccountLogConsumerResult } from './trading_account_log_repository.js';
import { accountOriginScope, type AccountOriginScope } from './trading_account_mode.js';
import { requiredAccountEvidenceSince } from './trading_account_baseline.js';
import { executionMatches, observedOrderExecutions, type ObservedOrderExecutionSet, type ScopeOrder } from './trading_scope_execution.js';
import type { TradingAccount } from './trading_types.js';

export interface AccountScopeRecord {
  ordinal: number; ledgerId: string | null; status: 'non_execution' | 'correlated_execution' | 'unresolved_activity';
  reason: string | null; orderId?: string; executionId?: string;
}
interface ScopeResult {
  version: 1; profile: 'bybit_uta_v1'; receiptId: string; observation: 'provider_as_observed';
  windowSince: number; windowUntil: number; observedAt: number; projectedAt: number; exhausted: boolean;
  finality: 'not_proven'; finalizedThrough: null; finalityReason: 'provider_delivery_delay_unbounded';
  origin: AccountOriginScope; records: AccountScopeRecord[]; orders: ObservedOrderExecutionSet[];
}
function nonExecution(record: AccountLogRecord): boolean {
  try {
    if (!record.currency) return false;
    if (record.type === 'SETTLEMENT' && record.category === 'linear' && record.funding != null) {
      signedDecimal(record.funding); return true;
    }
    if (!['TRANSFER_IN', 'TRANSFER_OUT'].includes(record.type!) || record.orderId || record.tradeId || record.orderLinkId || record.side) return false;
    signedDecimal(record.change!);
    return ['qty', 'funding', 'fee'].every(field => record[field] == null || record[field] === '' || signedDecimal(record[field]!) === '0');
  } catch { return false; }
}
async function conflictingOccurrence(account: TradingAccount, stored: StoredAccountLogReceipt, record: AccountLogRecord): Promise<boolean> {
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(record).sort(([a], [b]) => a < b ? -1 : Number(a > b))));
  const conflict = await getDatabase().get(`SELECT occurrence.receipt_id
    FROM trading_account_log_records occurrence JOIN trading_account_log_receipts receipt ON receipt.id=occurrence.receipt_id
    WHERE receipt.account_id=? AND receipt.account_fingerprint=? AND receipt.namespace=? AND json_extract(occurrence.payload_json,'$.id')=?
      AND (SELECT json_group_object(key,value) FROM (SELECT key,value FROM json_each(occurrence.payload_json) ORDER BY key)) <> ? LIMIT 1`,
  [account.id, account.externalAccountId, stored.receipt.namespace, record.id, canonical]);
  if (conflict) {
    // Invalidate previously completed projections too. Original occurrences are never rewritten or deduplicated away.
    await getDatabase().run(`UPDATE trading_account_log_consumers SET status='unresolved' WHERE consumer='scope' AND receipt_id IN (
      SELECT receipt.id FROM trading_account_log_receipts receipt JOIN trading_account_log_records occurrence ON occurrence.receipt_id=receipt.id
      WHERE receipt.account_id=? AND receipt.account_fingerprint=? AND receipt.namespace=? AND json_extract(occurrence.payload_json,'$.id')=?)`,
    [account.id, account.externalAccountId, stored.receipt.namespace, record.id]);
  }
  return Boolean(conflict);
}
function validRecord(record: AccountLogRecord, stored: StoredAccountLogReceipt): boolean {
  if (!record.id || !/^\d+$/.test(record.transactionTime ?? '')) return false;
  const time = Number(record.transactionTime);
  return Number.isSafeInteger(time) && time >= stored.receipt.since && time <= stored.receipt.until;
}
async function classifyTrade(account: TradingAccount, record: AccountLogRecord, output: AccountScopeRecord,
  orders: Map<string, ObservedOrderExecutionSet>): Promise<void> {
  if (record.type !== 'TRADE' || record.category !== 'linear') { output.reason = 'unsupported_product_or_activity'; return; }
  if (!record.orderId || !record.tradeId) { output.reason = 'trade_identity_unproved'; return; }
  const order = await getDatabase().get<ScopeOrder>('SELECT * FROM trading_orders WHERE account_id=? AND exchange_order_id=?', [account.id, record.orderId]);
  if (!order) { output.reason = 'unowned_order_activity'; return; }
  if (record.side !== (order.side === 'buy' ? 'Buy' : 'Sell') || (record.orderLinkId && record.orderLinkId !== order.client_order_id)) {
    output.reason = 'owned_order_identity_conflict'; return;
  }
  const observed = await observedOrderExecutions(account, order);
  orders.set(order.id, observed.proof);
  const matches = observed.executions.filter(execution => executionMatches(record, execution));
  if (matches.length !== 1) { output.reason = matches.length ? 'ambiguous_real_executions' : 'real_execution_not_observed'; return; }
  if (observed.proof.status !== 'observed_terminal_execution_set') { output.reason = 'terminal_execution_set_unproved'; return; }
  output.status = 'correlated_execution'; output.reason = null; output.orderId = record.orderId; output.executionId = matches[0]!.executionId;
}
async function projectReceipt(account: TradingAccount, stored: StoredAccountLogReceipt, origin: AccountOriginScope): Promise<void> {
  const receipt = validateAccountLogReceipt(stored.receipt);
  if (receipt.namespace !== accountLogSource('bybit')!.namespace || receipt.accountFingerprint !== account.externalAccountId
    || receipt.credentialGeneration !== account.credentialGeneration || receipt.records.length > 50
    || (receipt.providerAccountUid !== null && origin.providerAccountUid !== null && receipt.providerAccountUid !== origin.providerAccountUid)) {
    await setAccountLogConsumerResult(stored.id, 'scope', 'unresolved', { version: 1, finality: 'not_proven', reason: 'receipt_source_binding_unproved' }); return;
  }
  const orders = new Map<string, ObservedOrderExecutionSet>(), records: AccountScopeRecord[] = [];
  for (const [ordinal, record] of receipt.records.entries()) {
    const output: AccountScopeRecord = { ordinal, ledgerId: record.id || null, status: 'unresolved_activity', reason: 'record_identity_or_time_unproved' };
    records.push(output);
    if (!validRecord(record, stored)) continue;
    if (await conflictingOccurrence(account, stored, record)) { output.reason = 'provider_record_conflict'; continue; }
    if (nonExecution(record)) { output.status = 'non_execution'; output.reason = null; continue; }
    await classifyTrade(account, record, output, orders);
  }
  const result: ScopeResult = { version: 1, profile: 'bybit_uta_v1', receiptId: stored.id, observation: 'provider_as_observed',
    windowSince: receipt.since, windowUntil: receipt.until, observedAt: receipt.completedAt, projectedAt: Date.now(), exhausted: receipt.exhausted,
    finality: 'not_proven', finalizedThrough: null, finalityReason: 'provider_delivery_delay_unbounded', origin, records, orders: [...orders.values()] };
  if (Buffer.byteLength(JSON.stringify(result)) > 32768) {
    result.orders = [];
    result.records = records.map(row => ({ ordinal: row.ordinal, ledgerId: null, status: 'unresolved_activity', reason: 'projection_evidence_budget_exceeded' }));
  }
  const unresolved = result.records.some(row => row.status === 'unresolved_activity');
  await setAccountLogConsumerResult(stored.id, 'scope', unresolved ? 'unresolved' : 'complete', result);
}

/** No provider requests, no new cursor and no fill/ownership mutations. Completion is consumer work, never account finality. */
export async function projectAccountLogScope(account: TradingAccount): Promise<void> {
  if (account.exchange !== 'bybit' || !account.externalAccountId || !account.credentialGeneration) return;
  await withDatabaseTransaction(async () => {
    const current = await getDatabase().get<{ external_account_id: string; credential_generation: string }>(
      'SELECT external_account_id,credential_generation FROM trading_accounts WHERE id=?', [account.id]);
    if (current?.external_account_id !== account.externalAccountId || current?.credential_generation !== account.credentialGeneration) throw new Error('Scope consumer account binding changed.');
    const origin = await accountOriginScope(account, await requiredAccountEvidenceSince(account));
    const work = await pendingAccountLogReceipts(account.id, 'scope');
    for (const stored of work) await projectReceipt(account, stored, origin);
    // A new conflicting occurrence may have invalidated an older complete receipt after it was selected.
    const invalidated = await pendingAccountLogReceipts(account.id, 'scope');
    const seen = new Set(work.map(row => row.id));
    for (const stored of invalidated.filter(row => !seen.has(row.id))) await projectReceipt(account, stored, origin);
  });
}

export async function accountScopeObservation(account: TradingAccount): Promise<{
  observation: 'provider_as_observed' | 'missing'; finality: 'not_proven'; finalizedThrough: null;
  observedAt: number | null; unresolvedOccurrences: number; pendingReceipts: number; origin: AccountOriginScope;
}> {
  const row = await getDatabase().get<{ observed_at: number | null; unresolved: number | null; pending: number | null }>(`SELECT
    MAX(json_extract(work.result_json,'$.observedAt')) AS observed_at,
    SUM((SELECT COUNT(*) FROM json_each(work.result_json,'$.records') WHERE json_extract(value,'$.status')='unresolved_activity')) AS unresolved,
    SUM(CASE WHEN work.status='pending' OR json_type(work.result_json,'$.records') IS NULL
      OR (work.status='unresolved' AND NOT EXISTS (SELECT 1 FROM json_each(work.result_json,'$.records')
        WHERE json_extract(value,'$.status')='unresolved_activity')) THEN 1 ELSE 0 END) AS pending
    FROM trading_account_log_consumers work JOIN trading_account_log_receipts receipt ON receipt.id=work.receipt_id
    WHERE receipt.account_id=? AND receipt.account_fingerprint=? AND receipt.credential_generation=? AND work.consumer='scope'`,
  [account.id, account.externalAccountId, account.credentialGeneration]);
  const observedAt = row?.observed_at ?? null;
  return { observation: observedAt === null ? 'missing' : 'provider_as_observed', finality: 'not_proven', finalizedThrough: null,
    observedAt, unresolvedOccurrences: row?.unresolved ?? 0, pendingReceipts: row?.pending ?? 0,
    origin: await accountOriginScope(account, await requiredAccountEvidenceSince(account)) };
}
