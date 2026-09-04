import { createHash } from 'node:crypto';
import { getDatabase, withDatabaseTransaction } from './db.js';
import { addDecimal, allocateDecimalExact, compareDecimal, multiplyExactSignedDecimal, signedDifference, subtractDecimal } from './trading_decimal.js';
import { validateFillAccounting } from './trading_accounting_contract.js';
import {
  getReportingCurrencyBinding, moneyEventsForIntent, recordFeeEvent, recordMoneyEvent, sumMoneyEventValues, type MoneyEvent,
} from './trading_money_ledger.js';
import type { MoneyValue } from './trading_money_value.js';
import { proveOwnedQuantity, type OwnershipOrder } from './trading_ownership.js';
import type { ExchangeFill, ExchangeFillAccounting, TradingAccount, TradingSide } from './trading_types.js';

interface AccountingFill {
  id: string; order_id: string; account_id: string; exchange_fill_id: string;
  price: string; quantity: string; fee: string; fee_asset: string | null; filled_at: number;
  account_fingerprint: string | null; accounting_json: string | null; accounting_conflict: number;
  remote_fill_key: string | null; identity_json: string | null; identity_status: string; fill_provider_symbol: string | null;
  role: string; provider_symbol: string | null; exchange_order_id: string | null; client_order_id: string;
}

interface IntentSource {
  id: string; account_id: string; side: TradingSide; exchange: string;
  mode: string; external_account_id: string | null;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function fingerprint(source: Pick<IntentSource, 'exchange' | 'mode' | 'account_id' | 'external_account_id'>): string | null {
  return source.exchange === 'paper' && source.mode === 'paper' ? `paper:${source.account_id}` : source.external_account_id;
}

/** Called in the existing correlated-fill transaction. Economic ownership is established by its caller. */
export async function captureFillAccounting(account: TradingAccount, fill: ExchangeFill, fillId: string): Promise<void> {
  const row = await getDatabase().get<{ id: string; order_id: string; account_fingerprint: string | null; accounting_json: string | null }>(
    'SELECT id, order_id, account_fingerprint, accounting_json FROM trading_fills WHERE account_id = ? AND id = ?', [account.id, fillId]);
  if (!row) throw new Error('Cannot attach accounting evidence to an unpersisted fill.');
  const identity = account.exchange === 'paper' && account.mode === 'paper' ? `paper:${account.id}` : account.externalAccountId;
  let accounting: string | null = null;
  if (fill.accounting) accounting = JSON.stringify(validateFillAccounting(fill.accounting, fill.providerSymbol));
  const conflict = (row.account_fingerprint !== null && row.account_fingerprint !== identity)
    || (row.accounting_json !== null && accounting !== null && row.accounting_json !== accounting);
  if (conflict) {
    const order = await getDatabase().get<{ intent_id: string }>('SELECT intent_id FROM trading_orders WHERE id = ?', [row.order_id]);
    const received = JSON.stringify({ fillId: row.id, accountFingerprint: identity, accounting });
    await getDatabase().run(`INSERT OR IGNORE INTO trading_accounting_projection_evidence
      (id, intent_id, account_id, evidence_json, status, reason, created_at) VALUES (?, ?, ?, ?, 'unresolved', 'fill_accounting_conflict', ?)`,
    [hash(received), order!.intent_id, account.id, received, Date.now()]);
    await getDatabase().run('UPDATE trading_fills SET accounting_conflict = 1 WHERE id = ?', [row.id]);
    return;
  }
  if (row.account_fingerprint === identity && (row.accounting_json !== null || accounting === null)) return;
  await getDatabase().run(`UPDATE trading_fills SET account_fingerprint = COALESCE(account_fingerprint, ?),
    accounting_json = COALESCE(accounting_json, ?) WHERE id = ?`, [identity, accounting, row.id]);
}

interface PositionAuditSource {
  id: string; status: string; quantity: string; average_entry_price: string | null; realized_pnl: string;
  opened_at: number | null; closed_at: number | null;
}

async function readSource(intentId: string): Promise<{ intent: IntentSource; fills: AccountingFill[]; orders: OwnershipOrder[]; hasPosition: boolean; position: PositionAuditSource | null }> {
  const intent = await getDatabase().get<IntentSource>(`SELECT intent.id, intent.account_id, intent.side, account.exchange, account.mode, account.external_account_id
    FROM trading_trade_intents intent JOIN trading_accounts account ON account.id = intent.account_id WHERE intent.id = ?`, [intentId]);
  if (!intent) throw new Error('Accounting projection references an absent intent.');
  const fills = await getDatabase().all<AccountingFill[]>(`SELECT fills.id, fills.order_id, fills.account_id, fills.exchange_fill_id,
    fills.price, fills.quantity, fills.fee, fills.fee_asset, fills.filled_at, fills.account_fingerprint,
    fills.accounting_json, fills.accounting_conflict, fills.remote_fill_key, fills.identity_json, fills.identity_status,
    fills.provider_symbol AS fill_provider_symbol, orders.role, orders.provider_symbol, orders.exchange_order_id, orders.client_order_id FROM trading_fills fills
    JOIN trading_orders orders ON orders.id = fills.order_id WHERE orders.intent_id = ?
    ORDER BY fills.filled_at, CASE WHEN orders.role = 'entry' THEN 0 ELSE 1 END, fills.exchange_fill_id, fills.id`, [intentId]);
  const orders = await getDatabase().all<OwnershipOrder[]>(
    'SELECT id, role, side, reduce_only, quantity, filled_quantity FROM trading_orders WHERE intent_id = ? ORDER BY id', [intentId]);
  const position = await getDatabase().get<PositionAuditSource>(`SELECT id, status, quantity, average_entry_price, realized_pnl, opened_at, closed_at
    FROM trading_positions WHERE intent_id = ?`, [intentId]);
  const hasPosition = !!position && (position.status !== 'opening' || position.quantity !== '0');
  // The compatibility total is read for the existing row contract, not used as an economic source.
  return { intent, fills, orders, hasPosition, position: position ?? null };
}

async function recoverPaperProvenance(source: IntentSource, fill: AccountingFill): Promise<void> {
  if (source.exchange !== 'paper' || source.mode !== 'paper' || !fill.provider_symbol || fill.account_fingerprint !== null) return;
  const proof = await getDatabase().get(`SELECT fills.exchange_fill_id FROM trading_paper_fills fills
    JOIN trading_paper_orders orders ON orders.exchange_order_id = fills.exchange_order_id
    WHERE fills.account_id = ? AND fills.exchange_fill_id = ?
    AND fills.price = ? AND fills.quantity = ? AND fills.fee = ? AND fills.fee_asset IS ? AND fills.filled_at = ?
    AND fills.exchange_order_id = ? AND orders.client_order_id = ? AND orders.symbol = ? AND orders.role = ?`,
  [source.account_id, fill.exchange_fill_id, fill.price, fill.quantity, fill.fee, fill.fee_asset, fill.filled_at,
    fill.exchange_order_id, fill.client_order_id, fill.provider_symbol, fill.role]);
  if (!proof) return;
  fill.account_fingerprint = `paper:${source.account_id}`;
  fill.accounting_json = JSON.stringify({ version: 1, source: 'paper-contract-v1', providerSymbol: fill.provider_symbol,
    settlementAsset: 'USDT', linear: true, quantityUnit: 'base' });
  await getDatabase().run('UPDATE trading_fills SET account_fingerprint = ?, accounting_json = ? WHERE id = ?',
    [fill.account_fingerprint, fill.accounting_json, fill.id]);
}

function fillMarket(fill: AccountingFill): ExchangeFillAccounting {
  if (fill.accounting_conflict) throw new Error('fill_accounting_conflict');
  if (!fill.accounting_json || !fill.provider_symbol) throw new Error('fill_market_accounting_unproven');
  return validateFillAccounting(JSON.parse(fill.accounting_json), fill.provider_symbol);
}

async function postFees(intent: IntentSource, fills: AccountingFill[]): Promise<string[]> {
  const reasons: string[] = [];
  const identity = fingerprint(intent);
  for (const fill of fills) {
    await recoverPaperProvenance(intent, fill);
    if (!identity || fill.account_fingerprint !== identity) { reasons.push('legacy_fill_account_binding_unproven'); continue; }
    try {
      await recordFeeEvent({ accountId: intent.account_id, accountFingerprint: identity, providerEventId: fill.exchange_fill_id,
        source: `${intent.exchange}:own-fill-v1`, basis: 'fill', occurredAt: fill.filled_at, fee: fill.fee,
        asset: fill.fee_asset, intentId: intent.id, fillId: fill.id });
    } catch (error) { reasons.push(error instanceof Error ? error.message : 'fee_posting_unresolved'); }
  }
  return reasons;
}

function assertChronologicalCostBasis(fills: AccountingFill[]): void {
  const timestamps = new Map<number, AccountingFill[]>();
  for (const fill of fills) timestamps.set(fill.filled_at, [...(timestamps.get(fill.filled_at) ?? []), fill]);
  let priorEntries = 0;
  for (const group of timestamps.values()) {
    const entries = group.filter(fill => fill.role === 'entry');
    if (entries.length && group.length > entries.length && (priorEntries > 0 || entries.length > 1)) {
      throw new Error('same_timestamp_cost_basis_order_unproven');
    }
    priorEntries += entries.length;
  }
}

async function postPricePnl(source: Awaited<ReturnType<typeof readSource>>): Promise<void> {
  const { intent, fills, orders, hasPosition } = source;
  const identity = fingerprint(intent);
  if (fills.length === 0 && hasPosition) throw new Error('legacy_position_has_no_execution_evidence');
  proveOwnedQuantity(orders, fills, intent.side);
  assertChronologicalCostBasis(fills);
  const markets = fills.map(fillMarket);
  const expectedSource = intent.exchange === 'paper' ? 'paper-contract-v1' : 'ccxt-market-v1';
  if (markets.some(market => market.source !== expectedSource)) throw new Error('fill_market_source_profile_conflict');
  if (!identity || fills.some(fill => fill.account_fingerprint !== identity)) throw new Error('fill_account_binding_unproven');
  if (markets.some(market => market.settlementAsset !== markets[0]?.settlementAsset || market.providerSymbol !== markets[0]?.providerSymbol)) {
    throw new Error('fill_settlement_or_market_conflict');
  }
  let quantity = '0';
  let cost = '0';
  let basis = 'moving-average-exact-v1';
  for (const fill of fills) {
    const notional = multiplyExactSignedDecimal(fill.price, fill.quantity);
    const priorBasis = basis;
    basis = hash([basis, fill.exchange_fill_id, fill.price, fill.quantity, fill.filled_at, fill.role]);
    if (fill.role === 'entry') { quantity = addDecimal(quantity, fill.quantity); cost = addDecimal(cost, notional); continue; }
    if (compareDecimal(fill.quantity, quantity) > 0) throw new Error('exit_precedes_its_proven_entries');
    const allocatedCost = allocateDecimalExact(cost, fill.quantity, quantity);
    await recordMoneyEvent({ accountId: intent.account_id, accountFingerprint: identity, providerEventId: fill.exchange_fill_id,
      kind: 'realized_price_pnl', source: `${intent.exchange}:own-fill-v1`, basis: 'fill', occurredAt: fill.filled_at,
      amount: intent.side === 'LONG' ? signedDifference(notional, allocatedCost) : signedDifference(allocatedCost, notional),
      asset: markets[0]!.settlementAsset, intentId: intent.id, fillId: fill.id,
      derivation: hash({ method: 'moving-average-exact-v1', priorBasis, quantity, cost, allocatedCost }) });
    quantity = subtractDecimal(quantity, fill.quantity);
    cost = subtractDecimal(cost, allocatedCost);
  }
}

export interface IntentMoneyTotals {
  amount: string | null; currency: string | null; eventCount: number;
  value: MoneyValue | null; valuationHash: string;
}

function summarizeMoneyEvents(intentId: string, events: MoneyEvent[]): IntentMoneyTotals {
  const valuationHash = hash({ version: 1, intentId, events });
  const currencies = new Set(events.map(event => event.reportingCurrency));
  const unresolved = events.some(event => event.valuationStatus !== 'valued' || !event.reportingValue
    || event.reportingCurrency === null || !event.valuationEvidenceId);
  if (unresolved || currencies.size > 1) {
    return { amount: null, currency: null, eventCount: events.length, value: null, valuationHash };
  }
  const value = sumMoneyEventValues(events);
  return { amount: value.decimal, currency: events[0]?.reportingCurrency ?? null, eventCount: events.length, value, valuationHash };
}

/** Shared original/proof reader: valued rational amounts need not have an exact decimal scalar. */
export async function intentMoneyTotals(intentId: string): Promise<IntentMoneyTotals> {
  return summarizeMoneyEvents(intentId, await moneyEventsForIntent(intentId));
}

async function economicSource(source: Awaited<ReturnType<typeof readSource>>) {
  if (!source.position) return source;
  // Preserve the first legacy total as audit provenance, not as monetary input.
  // Re-reading our newly projected compatibility scalar would invalidate a native replay itself.
  const original = await getDatabase().get<{ amount: string }>(`SELECT json_extract(evidence_json, '$.source.position.realized_pnl') AS amount
    FROM trading_accounting_projection_evidence WHERE intent_id=? AND account_id=?
      AND json_extract(evidence_json, '$.source.position.id')=?
      AND json_type(evidence_json, '$.source.position.realized_pnl')='text'
    ORDER BY created_at,rowid LIMIT 1`, [source.intent.id, source.intent.account_id, source.position.id]);
  return { ...source, position: { ...source.position, realized_pnl: original?.amount ?? source.position.realized_pnl },
    compatibilityTotalBasis: 'first_retained_position_snapshot' };
}

function projectionResult(reasons: string[], totals: IntentMoneyTotals, binding: Awaited<ReturnType<typeof getReportingCurrencyBinding>>) {
  const failures = [...reasons];
  if (!binding || totals.value === null || (totals.eventCount > 0 && totals.currency !== binding.reportingCurrency)) {
    failures.push('monetary_valuation_unresolved');
  }
  const status = failures.length ? 'unresolved' : 'complete';
  const reason = [...new Set(failures)].join('; ').slice(0, 1024) || null;
  const value = status === 'complete' ? totals.value : null;
  return { status, reason, amount: value?.decimal ?? null, currency: binding?.reportingCurrency ?? null, value };
}

async function projectIntent(intentId: string): Promise<void> {
  await withDatabaseTransaction(async () => {
    const source = await readSource(intentId);
    const reasons = await postFees(source.intent, source.fills);
    try { await postPricePnl(source); } catch (error) { reasons.push(error instanceof Error ? error.message : 'price_pnl_unresolved'); }
    const events = await moneyEventsForIntent(intentId);
    const totals = summarizeMoneyEvents(intentId, events);
    const identity = fingerprint(source.intent);
    const binding = identity ? await getReportingCurrencyBinding(source.intent.account_id, identity) : null;
    const projection = projectionResult(reasons, totals, binding);
    const { status, reason, amount, currency, value } = projection;
    const evidence = { version: 2, source: await economicSource(source), binding, valuation: { events, totals }, projection };
    const payload = JSON.stringify(evidence);
    const evidenceHash = hash(evidence);
    const valueJson = value ? JSON.stringify(value) : null;
    await getDatabase().run(`INSERT INTO trading_accounting_projection_evidence
      (id, intent_id, account_id, evidence_json, status, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
    [hash([evidenceHash, status, reason]), intentId, source.intent.account_id, payload, status, reason, Date.now()]);
    await getDatabase().run(`INSERT INTO trading_accounting_projections
      (intent_id, account_id, evidence_hash, status, reason, reporting_currency, realized_pnl, value_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(intent_id) DO UPDATE SET evidence_hash = excluded.evidence_hash, status = excluded.status,
      reason = excluded.reason, reporting_currency = excluded.reporting_currency, realized_pnl = excluded.realized_pnl,
      value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [intentId, source.intent.account_id, evidenceHash, status, reason, currency, amount, valueJson, Date.now()]);
    await getDatabase().run(`UPDATE trading_positions SET ledger_realized_pnl = ?, ledger_realized_value_json = ?, accounting_status = ?, reporting_currency = ?,
      realized_pnl = COALESCE(?, realized_pnl) WHERE intent_id = ?`, [amount, valueJson, status, currency, amount, intentId]);
    await getDatabase().run('DELETE FROM trading_accounting_pending WHERE intent_id = ?', [intentId]);
  });
}

/** Bounded lazy backfill/replay. Pending work is durable; incomplete monetary data never interrupts protection. */
export async function projectAccountFillAccounting(accountId: string, limit = 100): Promise<{ processed: number; pending: number }> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid accounting projection budget.');
  const rows = await getDatabase().all<Array<{ intent_id: string }>>(
    'SELECT intent_id FROM trading_accounting_pending WHERE account_id = ? ORDER BY intent_id LIMIT ?', [accountId, limit]);
  for (const row of rows) await projectIntent(row.intent_id);
  const pending = await getDatabase().get<{ n: number }>('SELECT COUNT(*) AS n FROM trading_accounting_pending WHERE account_id = ?', [accountId]);
  return { processed: rows.length, pending: pending!.n };
}

export async function projectAllFillAccounting(): Promise<void> {
  const accounts = await getDatabase().all<Array<{ account_id: string }>>('SELECT DISTINCT account_id FROM trading_accounting_pending ORDER BY account_id');
  for (const account of accounts) await projectAccountFillAccounting(account.account_id);
}
