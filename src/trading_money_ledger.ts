import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { getDatabase, withDatabaseTransaction } from './db.js';
import { decimal, multiplyExactSignedDecimal, negateSignedDecimal, signedDecimal } from './trading_decimal.js';
import { addMoneyValues, moneyValueFromDecimal, type MoneyValue } from './trading_money_value.js';
import { readFxMoneyValuation } from './trading_fx_valuation.js';
import type { MoneyEvent, MoneyEventInput, ReportingCurrencyBinding } from './trading_money_contract.js';
export type { MoneyEvent, MoneyEventInput, ReportingCurrencyBinding } from './trading_money_contract.js';
import { KrakenCashlegError } from './trading_kraken_cashleg_contract.js';
import { readKrakenCashlegProof, persistKrakenCashlegProof, type KrakenCashlegRequest } from './trading_kraken_cashleg_repository.js';

function codeUnitOrder(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export interface EventTimeValuation {
  eventId: string;
  route: string;
  baseAsset: string;
  quoteAsset: string;
  rate: string;
  observedAt: number;
  evidenceId: string;
}

function identifier(value: string): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > 256) throw new Error('Invalid monetary evidence identifier.');
  return value;
}

function asset(value: string): string {
  if (typeof value !== 'string' || !/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(value)) throw new Error('Invalid monetary asset.');
  return value;
}

function timestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid monetary event timestamp.');
  return value;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function assertAccountBinding(accountId: string, fingerprint: string, profile?: string): Promise<void> {
  const account = await getDatabase().get<{ exchange: string; mode: string; external_account_id: string | null }>(
    'SELECT exchange, mode, external_account_id FROM trading_accounts WHERE id = ?', [accountId]);
  const expected = account?.exchange === 'paper' && account.mode === 'paper' ? `paper:${accountId}` : account?.external_account_id;
  if (!expected || expected !== fingerprint || (profile && profile !== account?.exchange)) throw new Error('Monetary account binding is not verified.');
}

function cleanBinding(value: ReportingCurrencyBinding): ReportingCurrencyBinding {
  const settlementAssets = [...new Set(value.settlementAssets.map(asset))].sort(codeUnitOrder);
  const providerUsdReport = value.profile === 'bybit' && value.reportingCurrency === 'USD' && value.source === 'bybit-wallet-balance-v1';
  if (!settlementAssets.includes(value.reportingCurrency) && !providerUsdReport) throw new Error('Reporting currency must be evidenced by account settlement metadata.');
  return { accountId: identifier(value.accountId), accountFingerprint: identifier(value.accountFingerprint), profile: identifier(value.profile),
    reportingCurrency: asset(value.reportingCurrency), settlementAssets, source: identifier(value.source), verifiedAt: timestamp(value.verifiedAt) };
}

export async function bindAccountReportingCurrency(value: ReportingCurrencyBinding): Promise<void> {
  const clean = cleanBinding(value);
  await withDatabaseTransaction(async () => {
    await assertAccountBinding(clean.accountId, clean.accountFingerprint, clean.profile);
    const current = await getReportingCurrencyBinding(clean.accountId, clean.accountFingerprint);
    if (current) {
      // A repeated verification can have a later timestamp; the immutable currency contract cannot drift.
      if (JSON.stringify({ ...current, verifiedAt: 0 }) !== JSON.stringify({ ...clean, verifiedAt: 0 })) throw new Error('Reporting currency binding conflict.');
      return;
    }
    await getDatabase().run(`INSERT INTO trading_money_bindings
      (account_id, account_fingerprint, reporting_currency, profile, settlement_assets_json, source, verified_at, content_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [clean.accountId, clean.accountFingerprint, clean.reportingCurrency, clean.profile,
      JSON.stringify(clean.settlementAssets), clean.source, clean.verifiedAt, JSON.stringify(clean)]);
  });
}

export async function getReportingCurrencyBinding(accountId: string, fingerprint: string): Promise<ReportingCurrencyBinding | null> {
  const row = await getDatabase().get<{ content_json: string }>(
    'SELECT content_json FROM trading_money_bindings WHERE account_id = ? AND account_fingerprint = ?', [accountId, fingerprint]);
  return row ? JSON.parse(row.content_json) as ReportingCurrencyBinding : null;
}

function cleanEvent(value: MoneyEventInput): MoneyEventInput {
  if (!['fee', 'funding', 'realized_price_pnl'].includes(value.kind) || !['fill', 'provider'].includes(value.basis)) throw new Error('Invalid monetary event kind/basis.');
  // The current linear contract derives price PnL from fills. Provider settlement PnL is evidence, never a second posting.
  if (value.kind === 'realized_price_pnl' && value.basis !== 'fill') throw new Error('Realized price PnL uses derived fills, not additional provider postings.');
  return { accountId: identifier(value.accountId), accountFingerprint: identifier(value.accountFingerprint), providerEventId: identifier(value.providerEventId),
    kind: value.kind, source: identifier(value.source), basis: value.basis, occurredAt: timestamp(value.occurredAt), amount: signedDecimal(value.amount),
    asset: value.asset === null ? null : asset(value.asset), intentId: value.intentId ? identifier(value.intentId) : null,
    fillId: value.fillId ? identifier(value.fillId) : null,
    ...(value.derivation !== undefined ? { derivation: identifier(value.derivation) } : {}) };
}

async function recordConflict(eventId: string, kind: 'event' | 'valuation', payload: string): Promise<void> {
  await getDatabase().run(`INSERT INTO trading_money_conflicts (id, event_id, kind, received_json, recorded_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(event_id, kind, received_json) DO NOTHING`,
  [digest(JSON.stringify([eventId, kind, payload])), eventId, kind, payload, Date.now()]);
}

async function appendValuation(event: MoneyEvent, valuation: EventTimeValuation): Promise<boolean> {
  const reportingAmount = multiplyExactSignedDecimal(event.amount, valuation.rate);
  const payload = JSON.stringify({ ...valuation, reportingAmount });
  if (await getDatabase().get('SELECT event_id FROM trading_fx_money_valuations WHERE event_id=?', [event.id])) {
    await recordConflict(event.id, 'valuation', payload);
    return false;
  }
  const existing = await getDatabase().get<{ content_json: string }>('SELECT content_json FROM trading_money_valuations WHERE event_id = ?', [event.id]);
  if (existing) {
    if (existing.content_json === payload) return true;
    await recordConflict(event.id, 'valuation', payload);
    return false;
  }
  await getDatabase().run(`INSERT INTO trading_money_valuations
    (event_id, reporting_currency, reporting_amount, rate, source, valued_at, evidence_id, content_json, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [event.id, valuation.quoteAsset, reportingAmount, valuation.rate,
    valuation.route, valuation.observedAt, valuation.evidenceId, payload, Date.now()]);
  return true;
}

async function nativeValuation(event: MoneyEvent): Promise<void> {
  const binding = await getReportingCurrencyBinding(event.accountId, event.accountFingerprint);
  if (!binding || (event.amount !== '0' && event.asset !== binding.reportingCurrency)) return;
  await appendValuation(event, { eventId: event.id, route: event.amount === '0' ? 'zero-no-conversion' : 'native-asset',
    baseAsset: event.asset ?? binding.reportingCurrency, quoteAsset: binding.reportingCurrency, rate: '1',
    observedAt: event.occurredAt, evidenceId: `account-binding:${event.accountFingerprint}` });
}

/** Bounded replay of originals received before their verified reporting binding.
 * Consumer traversal completion never substitutes for event valuation. */
export async function valueNativeAccountMoney(accountId: string, fingerprint: string): Promise<void> {
  await withDatabaseTransaction(async () => {
    await assertAccountBinding(accountId, fingerprint);
    const binding = await getReportingCurrencyBinding(accountId, fingerprint);
    if (!binding) return;
    const rows = await getDatabase().all<Array<{ id: string; content_json: string }>>(`
      SELECT event.id,event.content_json FROM trading_money_events event
      WHERE event.account_id=? AND event.account_fingerprint=? AND (event.asset=? OR event.amount='0')
        AND NOT EXISTS(SELECT 1 FROM trading_money_valuations valuation WHERE valuation.event_id=event.id)
      ORDER BY event.occurred_at,event.id LIMIT 1000`, [accountId, fingerprint, binding.reportingCurrency]);
    for (const row of rows) await nativeValuation({ ...JSON.parse(row.content_json), id: row.id,
      valuationStatus: 'unresolved', reportingAmount: null, reportingCurrency: null });
  });
}

export async function recordMoneyEvent(value: MoneyEventInput): Promise<MoneyEvent> {
  const clean = cleanEvent(value);
  const payload = JSON.stringify(clean);
  const outcome = await withDatabaseTransaction(async () => {
    await assertAccountBinding(clean.accountId, clean.accountFingerprint);
    const id = await canonicalMoneyIdentity(clean, payload);
    if (id === null) return { id: '', accepted: false };
    const existing = await getDatabase().get<{ content_json: string }>('SELECT content_json FROM trading_money_events WHERE id = ?', [id]);
    if (existing && !sameMoneyOriginal(existing.content_json, clean)) {
      await recordConflict(id, 'event', payload);
      return { id, accepted: false };
    }
    if (!existing) await getDatabase().run(`INSERT INTO trading_money_events
      (id, account_id, account_fingerprint, provider_event_id, kind, source, basis, occurred_at, amount, asset, intent_id, fill_id, content_json, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, clean.accountId, clean.accountFingerprint, clean.providerEventId, clean.kind,
      clean.source, clean.basis, clean.occurredAt, clean.amount, clean.asset, clean.intentId, clean.fillId, payload, Date.now()]);
    await nativeValuation({ ...(existing ? JSON.parse(existing.content_json) : clean), id,
      valuationStatus: 'unresolved', reportingAmount: null, reportingCurrency: null });
    return { id, accepted: true };
  });
  if (!outcome.accepted) throw new Error('Monetary event conflict; contradictory evidence was retained.');
  return (await getMoneyEvent(outcome.id))!;
}

function sameMoneyOriginal(payload: string, clean: MoneyEventInput): boolean {
  if (clean.basis !== 'fill') return payload === JSON.stringify(clean);
  const original = JSON.parse(payload) as MoneyEventInput;
  // A real persisted fill identity may have been reported by another transport source.
  // Keep original ID/source/JSON/valuations, but never accept changed economics or derivation.
  return isDeepStrictEqual({ ...original, providerEventId: clean.providerEventId, source: clean.source }, clean);
}

async function canonicalMoneyIdentity(clean: MoneyEventInput, payload: string): Promise<string | null> {
  if (clean.basis === 'provider') return digest(JSON.stringify([clean.accountId, clean.accountFingerprint, clean.providerEventId, clean.kind]));
  if (!clean.fillId || clean.kind === 'funding') throw new Error('Fill monetary evidence requires an actual persisted fill identity.');
  const fill = await getDatabase().get<{ intent_id: string; filled_at: number }>(`SELECT orders.intent_id, fills.filled_at FROM trading_fills fills
    JOIN trading_orders orders ON orders.id=fills.order_id WHERE fills.id=? AND fills.account_id=? AND fills.account_fingerprint=?`,
  [clean.fillId, clean.accountId, clean.accountFingerprint]);
  if (!fill || fill.filled_at !== clean.occurredAt || (clean.intentId && clean.intentId !== fill.intent_id)) {
    throw new Error('Fill monetary evidence does not match its persisted account, intent and event time.');
  }
  const candidates = await getDatabase().all<Array<{ id: string }>>(`SELECT id FROM trading_money_events
    WHERE account_id=? AND account_fingerprint=? AND basis='fill' AND kind=?
      AND (fill_id=? OR (fill_id IS NULL AND provider_event_id=?))`,
  [clean.accountId, clean.accountFingerprint, clean.kind, clean.fillId, clean.providerEventId]);
  if (candidates.length > 1) {
    for (const candidate of candidates) await recordConflict(candidate.id, 'event', payload);
    return null;
  }
  if (candidates[0]) {
    const existing = await getDatabase().get<{ fill_id: string | null }>('SELECT fill_id FROM trading_money_events WHERE id=?', [candidates[0].id]);
    if (existing?.fill_id !== clean.fillId) { await recordConflict(candidates[0].id, 'event', payload); return null; }
    return candidates[0].id;
  }
  return digest(JSON.stringify(['fill-money-v1', clean.accountId, clean.accountFingerprint, clean.fillId, clean.kind]));
}

export function recordFeeEvent(value: Omit<MoneyEventInput, 'amount' | 'kind'> & { fee: string }): Promise<MoneyEvent> {
  return recordMoneyEvent({ ...value, amount: negateSignedDecimal(value.fee), kind: 'fee' });
}

interface MoneyReadRow { id: string; content_json: string; reporting_amount: string | null; reporting_currency: string | null;
  valuation_json: string | null; fx_event_id: string | null; conflict: number }
const MONEY_READ = `SELECT event.id,event.content_json,valuation.reporting_amount,valuation.reporting_currency,
  valuation.content_json AS valuation_json,fx.event_id AS fx_event_id,
  EXISTS(SELECT 1 FROM trading_money_conflicts WHERE event_id=event.id) AS conflict FROM trading_money_events event
  LEFT JOIN trading_money_valuations valuation ON valuation.event_id=event.id
  LEFT JOIN trading_fx_money_valuations fx ON fx.event_id=event.id`;

async function decodeMoneyRow(row: MoneyReadRow): Promise<MoneyEvent> {
  const event: MoneyEvent = { ...JSON.parse(row.content_json), id: row.id, valuationStatus: 'unresolved',
    reportingAmount: row.reporting_amount, reportingCurrency: row.reporting_currency, reportingValue: null, valuationEvidenceId: null };
  if (row.conflict) return event;
  if (row.fx_event_id) {
    try {
      const proof = (await readFxMoneyValuation(row.id))!;
      return { ...event, valuationStatus: 'valued', reportingValue: proof.value, reportingAmount: proof.value.decimal,
        reportingCurrency: proof.reportingCurrency, valuationEvidenceId: proof.contentHash };
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('FX_')) throw error;
      return event;
    }
  }
  if (row.reporting_amount === null) return event;
  return { ...event, valuationStatus: 'valued', reportingValue: moneyValueFromDecimal(row.reporting_amount),
    valuationEvidenceId: digest(row.valuation_json!) };
}

export async function getMoneyEvent(id: string): Promise<MoneyEvent | null> {
  const row = await getDatabase().get<MoneyReadRow>(`${MONEY_READ} WHERE event.id=?`, [id]);
  return row ? decodeMoneyRow(row) : null;
}

/** Shared projection reader; a complete rational valuation may have no exact decimal scalar. */
export async function moneyEventsForIntent(intentId: string): Promise<MoneyEvent[]> {
  return withDatabaseTransaction(async db => {
    const rows = await db.all<MoneyReadRow[]>(`${MONEY_READ} WHERE event.intent_id=? ORDER BY event.occurred_at,event.id`, [intentId]);
    const events: MoneyEvent[] = [];
    for (const row of rows) events.push(await decodeMoneyRow(row));
    return events;
  });
}

export function sumMoneyEventValues(events: MoneyEvent[]): MoneyValue {
  return events.reduce((sum, event) => {
    if (event.valuationStatus !== 'valued' || !event.reportingValue) throw new Error('Monetary event remains unresolved.');
    return addMoneyValues(sum, event.reportingValue);
  }, { ...moneyValueFromDecimal('0'), terms: 0 });
}

/** Sole live native-asset supplement: all amounts/units come from immutable originals, never the caller. */
export async function valueKrakenCashlegFee(request: KrakenCashlegRequest): Promise<MoneyEvent> {
  if (Object.keys(request).sort(codeUnitOrder).join(',')
    !== 'cashOccurrence,eventId,positionOccurrence') throw new Error('Invalid native cashleg request.');
  const outcome = await withDatabaseTransaction(async () => {
    const event = await getMoneyEvent(identifier(request.eventId));
    if (!event) throw new KrakenCashlegError('missing_original_fee');
    const binding = await getReportingCurrencyBinding(event.accountId, event.accountFingerprint);
    if (!binding || binding.profile !== 'krakenfutures') throw new KrakenCashlegError('reporting_binding_unproven');
    try {
      const proof = await readKrakenCashlegProof(request, event, binding);
      await persistKrakenCashlegProof(proof);
      const accepted = await appendKrakenNativeValuation(event, proof.id, proof.asset);
      return { accepted, reason: 'native_valuation_conflict' };
    } catch (error) {
      if (!(error instanceof KrakenCashlegError) || !error.conflict) throw error;
      await recordConflict(event.id, 'valuation', JSON.stringify({ source: 'kraken-native-cashleg-v1', request, reason: error.message }));
      return { accepted: false, reason: error.message };
    }
  });
  const result = (await getMoneyEvent(request.eventId))!;
  if (!outcome.accepted || result.valuationStatus !== 'valued') throw new KrakenCashlegError(outcome.reason, true);
  return result;
}

async function appendKrakenNativeValuation(event: MoneyEvent, evidenceId: string, nativeAsset: string): Promise<boolean> {
  const current = await getDatabase().get<{ content_json: string }>('SELECT content_json FROM trading_money_valuations WHERE event_id=?', [event.id]);
  if (current) {
    const original = JSON.parse(current.content_json) as EventTimeValuation & { reportingAmount: string };
    if (original.baseAsset === nativeAsset && original.quoteAsset === nativeAsset && original.rate === '1'
      && original.reportingAmount === event.amount && original.observedAt === event.occurredAt) return true;
  }
  return appendValuation(event, { eventId: event.id, route: 'kraken-native-cashleg-v1', baseAsset: nativeAsset,
    quoteAsset: nativeAsset, rate: '1', observedAt: event.occurredAt, evidenceId });
}

/** Caller-supplied decimal quotes remain paper-only. Live index proofs use their separate original-bound path. */
function validateEventTimeQuote(event: MoneyEvent, binding: ReportingCurrencyBinding, quote: EventTimeValuation): EventTimeValuation {
  if (quote.observedAt !== event.occurredAt) throw new Error('Valuation must be evidenced at the monetary event time.');
  if (quote.baseAsset !== event.asset || quote.quoteAsset !== binding.reportingCurrency) throw new Error('Valuation asset pair does not match the event/reporting binding.');
  const supportedPairs = new Set(['BNB/USDT', 'BTC/USDT', 'USDC/USDT', 'USDT/USD', 'USDC/USD']);
  if (binding.profile !== 'paper' || quote.route !== 'paper:event-time-rate:v1' || !supportedPairs.has(`${quote.baseAsset}/${quote.quoteAsset}`)) {
    throw new Error('No certified profile-bound event-time valuation route.');
  }
  return { eventId: event.id, route: quote.route, baseAsset: asset(quote.baseAsset), quoteAsset: asset(quote.quoteAsset),
    rate: decimal(quote.rate, { positive: true }), observedAt: timestamp(quote.observedAt), evidenceId: identifier(quote.evidenceId) };
}

export async function valueMoneyEvent(quote: EventTimeValuation): Promise<void> {
  const accepted = await withDatabaseTransaction(async () => {
    const event = await getMoneyEvent(identifier(quote.eventId));
    if (!event) throw new Error('Monetary event does not exist.');
    await assertAccountBinding(event.accountId, event.accountFingerprint);
    const binding = await getReportingCurrencyBinding(event.accountId, event.accountFingerprint);
    if (!binding) throw new Error('Monetary reporting currency binding is unresolved.');
    return appendValuation(event, validateEventTimeQuote(event, binding, quote));
  });
  if (!accepted) throw new Error('Monetary valuation conflict; contradictory evidence was retained.');
}

async function snapshotReadiness(accountId: string) {
  const bindings = await getDatabase().all<Array<{ reporting_currency: string; account_fingerprint: string }>>(
    'SELECT reporting_currency, account_fingerprint FROM trading_money_bindings WHERE account_id = ?', [accountId]);
  const binding = bindings.length === 1 ? bindings[0]! : null;
  let bindingCurrent = false;
  try { await assertAccountBinding(accountId, binding?.account_fingerprint ?? ''); bindingCurrent = true; } catch { /* Unverified is not zero. */ }
  const counts = await getDatabase().get<{ conflictCount: number; pendingProjections: number; unresolvedProjections: number }>(`SELECT
    (SELECT COUNT(*) FROM trading_money_conflicts conflict JOIN trading_money_events event ON event.id = conflict.event_id WHERE event.account_id = ?) AS conflictCount,
    (SELECT COUNT(*) FROM trading_accounting_pending WHERE account_id = ?) AS pendingProjections,
    (SELECT COUNT(*) FROM trading_accounting_projections WHERE account_id = ? AND status <> 'complete') AS unresolvedProjections`, [accountId, accountId, accountId]);
  return { currency: binding?.reporting_currency ?? null, fingerprint: binding?.account_fingerprint ?? null,
    ready: bindingCurrent && Object.values(counts!).every(count => count === 0), ...counts! };
}

/** Valuation status describes only persisted events; provider history coverage is a separate mandatory gate. */
export interface MoneyLedgerSnapshot {
  reportingCurrency: string | null; valuationStatus: 'valued' | 'unresolved'; historyCompleteness: 'unproven';
  amount: string | null; valuedSubtotal: string | null; unresolvedEventIds: string[]; conflictCount: number;
  pendingProjections: number; unresolvedProjections: number;
  pricePnl: string | null; fees: string | null; funding: string | null;
  value: MoneyValue | null; valuedSubtotalValue: MoneyValue; pricePnlValue: MoneyValue | null;
  feesValue: MoneyValue | null; fundingValue: MoneyValue | null; valuationHash: string;
}
export async function moneyLedgerSnapshot(accountId: string, since: number, until: number): Promise<MoneyLedgerSnapshot> {
  timestamp(since); timestamp(until);
  if (until <= since) throw new Error('Monetary snapshot window is inverted.');
  return withDatabaseTransaction(() => readMoneyLedger(accountId, since, until));
}

async function readMoneyLedger(accountId: string, since: number, until: number): Promise<MoneyLedgerSnapshot> {
  const rows = await getDatabase().all<MoneyReadRow[]>(`${MONEY_READ}
    WHERE event.account_id=? AND event.occurred_at>=? AND event.occurred_at<? ORDER BY event.occurred_at,event.id`, [accountId, since, until]);
  const readiness = await snapshotReadiness(accountId);
  const { currency, fingerprint } = readiness;
  const events: MoneyEvent[] = [];
  for (const row of rows) events.push(await decodeMoneyRow(row));
  const valued = events.filter(event => event.valuationStatus === 'valued' && event.reportingValue
    && event.reportingCurrency === currency && event.accountFingerprint === fingerprint);
  const valuedIds = new Set(valued.map(event => event.id));
  const unresolvedEventIds = events.filter(event => !valuedIds.has(event.id)).map(event => event.id);
  const subtotal = sumMoneyEventValues(valued);
  const complete = readiness.ready && unresolvedEventIds.length === 0;
  const component = (kind: string) => complete ? sumMoneyEventValues(valued.filter(event => event.kind === kind)) : null;
  const pricePnlValue = component('realized_price_pnl'), feesValue = component('fee'), fundingValue = component('funding');
  return { reportingCurrency: currency, valuationStatus: complete ? 'valued' : 'unresolved', historyCompleteness: 'unproven',
    amount: complete ? subtotal.decimal : null, valuedSubtotal: subtotal.decimal, unresolvedEventIds, conflictCount: readiness.conflictCount,
    pendingProjections: readiness.pendingProjections, unresolvedProjections: readiness.unresolvedProjections,
    pricePnl: pricePnlValue?.decimal ?? null, fees: feesValue?.decimal ?? null, funding: fundingValue?.decimal ?? null,
    value: complete ? subtotal : null, valuedSubtotalValue: subtotal, pricePnlValue, feesValue, fundingValue,
    valuationHash: digest(JSON.stringify(events.map(event => [event.id, event.valuationStatus, event.valuationEvidenceId]))) };
}
