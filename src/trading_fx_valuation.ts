import { getDatabase, withDatabaseTransaction } from './db.js';
import { fxEvidenceDigest, invalidFx } from './trading_fx_contract.js';
import { persistFxConversion, readFxConversion, requireFxAccountContext, snapshotFxAccount, type FxAccount } from './trading_fx_repository.js';
import { moneyValueFromRational, type MoneyValue } from './trading_money_value.js';
import { multiplyRational, rationalFromDecimal } from './trading_rational.js';
import type { MoneyEventInput, ReportingCurrencyBinding } from './trading_money_contract.js';

interface OriginalEvent { id: string; account_id: string; account_fingerprint: string; occurred_at: number;
  amount: string; asset: string | null; content_json: string }
interface ValuationRow { event_id: string; account_id: string; conversion_id: string; reporting_currency: string;
  payload_json: string; content_hash: string }
export interface FxMoneyValuation {
  version: 1; eventId: string; accountId: string; accountFingerprint: string; eventHash: string;
  conversionId: string; reportingCurrency: string; value: MoneyValue;
  basis: 'provider_snapshot_index_asof'; contentHash: string;
}
const STABLE_ASSETS = new Set(['USD', 'USDT', 'USDC']);

function parseOriginal(row: OriginalEvent): MoneyEventInput {
  const event = JSON.parse(row.content_json) as MoneyEventInput;
  if (event.accountId !== row.account_id || event.accountFingerprint !== row.account_fingerprint
    || event.amount !== row.amount || event.asset !== row.asset || event.occurredAt !== row.occurred_at) invalidFx('MONEY_ORIGINAL_CHANGED');
  return event;
}
async function originalEvent(eventId: string): Promise<OriginalEvent> {
  const row = await getDatabase().get<OriginalEvent>('SELECT * FROM trading_money_events WHERE id=?', [eventId]);
  if (!row) return invalidFx('MONEY_EVENT_UNAVAILABLE');
  parseOriginal(row);
  return row;
}
async function accountForOriginal(row: OriginalEvent): Promise<FxAccount> {
  const current = await getDatabase().get<{ exchange: FxAccount['exchange']; mode: FxAccount['mode'];
    external_account_id: string; credential_generation: string; capabilities_json: string }>(
    'SELECT exchange,mode,external_account_id,credential_generation,capabilities_json FROM trading_accounts WHERE id=?', [row.account_id]);
  if (!current || current.external_account_id !== row.account_fingerprint) return invalidFx('ACCOUNT_BINDING_CHANGED');
  return { id: row.account_id, exchange: current.exchange, mode: current.mode, externalAccountId: current.external_account_id,
    credentialGeneration: current.credential_generation, capabilities: JSON.parse(current.capabilities_json) };
}
async function reportingBinding(account: FxAccount, row: OriginalEvent): Promise<ReportingCurrencyBinding> {
  await requireFxAccountContext(account);
  if (account.id !== row.account_id || account.externalAccountId !== row.account_fingerprint) invalidFx('MONEY_ACCOUNT_MISMATCH');
  const stored = await getDatabase().get<{ content_json: string; reporting_currency: string }>(
    'SELECT content_json,reporting_currency FROM trading_money_bindings WHERE account_id=? AND account_fingerprint=?',
    [account.id, row.account_fingerprint]);
  if (!stored) return invalidFx('REPORTING_BINDING_UNAVAILABLE');
  const binding = JSON.parse(stored.content_json) as ReportingCurrencyBinding;
  if (binding.accountId !== account.id || binding.accountFingerprint !== row.account_fingerprint || binding.profile !== 'bybit'
    || binding.reportingCurrency !== stored.reporting_currency || binding.source !== 'bybit-wallet-balance-v1'
    || !STABLE_ASSETS.has(binding.reportingCurrency) || !STABLE_ASSETS.has(row.asset ?? '')
    || row.asset === binding.reportingCurrency || row.amount === '0') invalidFx('MONEY_PAIR_UNSUPPORTED');
  return binding;
}
async function assertUnconflicted(eventId: string): Promise<void> {
  if (await getDatabase().get('SELECT id FROM trading_money_conflicts WHERE event_id=? LIMIT 1', [eventId])) invalidFx('MONEY_EVENT_CONFLICT');
  if (await getDatabase().get('SELECT event_id FROM trading_money_valuations WHERE event_id=?', [eventId])) invalidFx('NATIVE_OR_ALREADY_VALUED');
}
function valuation(row: OriginalEvent, conversionId: string, reportingCurrency: string,
  rate: Parameters<typeof multiplyRational>[1]): FxMoneyValuation {
  const body = { version: 1 as const, eventId: row.id, accountId: row.account_id, accountFingerprint: row.account_fingerprint,
    eventHash: fxEvidenceDigest('tsx-fx-money-event-v1', parseOriginal(row)), conversionId, reportingCurrency,
    value: moneyValueFromRational(multiplyRational(rationalFromDecimal(row.amount), rate)), basis: 'provider_snapshot_index_asof' as const };
  return { ...body, contentHash: fxEvidenceDigest('tsx-fx-money-valuation-v1', body) };
}
async function verifyValuation(account: FxAccount, row: OriginalEvent, stored: ValuationRow): Promise<FxMoneyValuation> {
  await assertUnconflicted(row.id);
  const binding = await reportingBinding(account, row);
  const { conversion } = await readFxConversion(account, stored.conversion_id);
  if (conversion.baseAsset !== row.asset || conversion.quoteAsset !== binding.reportingCurrency || conversion.at !== row.occurred_at) {
    invalidFx('MONEY_CONVERSION_MISMATCH');
  }
  const proof = valuation(row, stored.conversion_id, binding.reportingCurrency, conversion.rate);
  if (Buffer.byteLength(stored.payload_json) >= 16384 || stored.payload_json.includes('\0')) invalidFx('MONEY_PAYLOAD_INVALID');
  if (stored.event_id !== row.id || stored.account_id !== account.id || stored.reporting_currency !== proof.reportingCurrency
    || stored.content_hash !== proof.contentHash || fxEvidenceDigest('tsx-fx-money-valuation-v1', JSON.parse(stored.payload_json))
      !== fxEvidenceDigest('tsx-fx-money-valuation-v1', proof)) invalidFx('MONEY_VALUATION_CHANGED');
  return proof;
}

/** Pinned event-time valuation; elapsed wall time never reprices a historical event. */
export async function readFxMoneyValuation(eventId: string): Promise<FxMoneyValuation | null> {
  return withDatabaseTransaction(async db => {
    const stored = await db.get<ValuationRow>('SELECT * FROM trading_fx_money_valuations WHERE event_id=?', [eventId]);
    if (!stored) return null;
    const row = await originalEvent(eventId);
    return verifyValuation(await accountForOriginal(row), row, stored);
  });
}
/** Only an event ID and the held account are accepted. Amount, currencies, time and rate come from originals. */
export async function valueFxMoneyEvent(account: FxAccount, eventId: string): Promise<FxMoneyValuation> {
  account = snapshotFxAccount(account);
  return withDatabaseTransaction(async db => {
    const row = await originalEvent(eventId), binding = await reportingBinding(account, row);
    const existing = await db.get<ValuationRow>('SELECT * FROM trading_fx_money_valuations WHERE event_id=?', [eventId]);
    if (existing) return verifyValuation(account, row, existing);
    await assertUnconflicted(eventId);
    const conversion = await persistFxConversion(account, row.asset!, binding.reportingCurrency, row.occurred_at);
    const proof = valuation(row, conversion.id, binding.reportingCurrency, conversion.conversion.rate);
    await db.run(`INSERT INTO trading_fx_money_valuations
      (event_id,account_id,conversion_id,reporting_currency,payload_json,content_hash,recorded_at) VALUES (?,?,?,?,?,?,?)`,
    [row.id, account.id, conversion.id, binding.reportingCurrency, JSON.stringify(proof), proof.contentHash, Date.now()]);
    return (await readFxMoneyValuation(eventId))!;
  });
}

/** Durable oldest-attempt-first replay; unresolved originals cannot starve later events. No provider calls. */
export async function valueFxAccountMoney(account: FxAccount, limit = 100): Promise<{ processed: number; unresolved: number }> {
  account = snapshotFxAccount(account);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) invalidFx('MONEY_WORK_LIMIT');
  await requireFxAccountContext(account);
  const rows = await getDatabase().all<Array<{ id: string }>>(`SELECT event.id FROM trading_money_events event
    LEFT JOIN trading_fx_valuation_work work ON work.event_id=event.id
    WHERE event.account_id=? AND event.account_fingerprint=? AND event.asset IN ('USD','USDT','USDC')
      AND NOT EXISTS(SELECT 1 FROM trading_money_valuations old WHERE old.event_id=event.id)
      AND NOT EXISTS(SELECT 1 FROM trading_fx_money_valuations fx WHERE fx.event_id=event.id)
      AND NOT EXISTS(SELECT 1 FROM trading_money_conflicts conflict WHERE conflict.event_id=event.id)
    ORDER BY COALESCE(work.last_attempt_at,0),event.occurred_at,event.id LIMIT ?`, [account.id, account.externalAccountId, limit]);
  let unresolved = 0;
  for (const row of rows) {
    let reason: string | null = null;
    try { await valueFxMoneyEvent(account, row.id); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('FX_')) throw error;
      reason = error.message; unresolved += 1;
    }
    await getDatabase().run(`INSERT INTO trading_fx_valuation_work (event_id,account_id,last_attempt_at,reason) VALUES (?,?,?,?)
      ON CONFLICT(event_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,reason=excluded.reason`,
    [row.id, account.id, Date.now(), reason]);
  }
  return { processed: rows.length, unresolved };
}
