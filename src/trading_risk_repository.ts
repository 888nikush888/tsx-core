import { getDatabase, withDatabaseTransaction } from './db.js';
import { addMoneyValues, moneyValueFromDecimal, validateMoneyValue, type MoneyValue } from './trading_money_value.js';
import { verifyRiskFxConversions } from './trading_fx_risk.js';
import type { StoredFxConversion } from './trading_fx_repository.js';
import { validateFillAccounting } from './trading_accounting_contract.js';
import { TradingRiskError } from './trading_risk.js';
import { moneyLedgerSnapshot } from './trading_money_ledger.js';
import { assertRiskFresh, RISK_EVIDENCE_TTL_MS } from './trading_risk_reservations.js';
import { deriveRiskReservation, loadRiskSources, riskFingerprint, riskHash } from './trading_risk_sources.js';
import type { ExchangeOpenState, TradingAccount, TradingAccountSnapshot, TradingMarketSnapshot } from './trading_types.js';

type Reservation = Awaited<ReturnType<typeof deriveRiskReservation>>;
interface StoredRiskObservation {
  id: string; account_id: string; account_fingerprint: string; credential_generation: string | null; entry_epoch: string;
  observed_at: number; expires_at: number; utc_day: number; evidence_json: string;
}
export interface ExistingRiskProof { commitment: string | null; value: MoneyValue; fxConversions: StoredFxConversion[];
  reservations: Reservation[]; sourceHash: string;
  observedAt: number; expiresAt: number; utcDay: number; observationId: string | null }
function unresolved(reason: string): never { throw new TradingRiskError('RISK_EVIDENCE_UNRESOLVED', `Current risk evidence is unresolved: ${reason}`); }

/** A market contract is pinned to the account and credential generation, never guessed from a ticker suffix. */
export async function bindRiskContract(account: TradingAccount, intentId: string, market: TradingMarketSnapshot): Promise<void> {
  const metadata = validateFillAccounting(market.accounting);
  if (metadata.source !== (account.exchange === 'paper' ? 'paper-contract-v1' : 'ccxt-market-v1')) unresolved('market evidence profile changed.');
  const encoded = JSON.stringify(metadata);
  await withDatabaseTransaction(async db => {
    const previous = await db.get<{ metadata_json: string; account_fingerprint: string; credential_generation: string | null }>(
      'SELECT metadata_json, account_fingerprint, credential_generation FROM trading_risk_contracts WHERE intent_id = ?', [intentId]);
    if (previous && (previous.metadata_json !== encoded || previous.account_fingerprint !== riskFingerprint(account)
      || previous.credential_generation !== account.credentialGeneration)) unresolved('pinned contract identity changed.');
    await db.run(`INSERT OR IGNORE INTO trading_risk_contracts (intent_id, account_id, account_fingerprint, credential_generation, metadata_json, observed_at)
      VALUES (?, ?, ?, ?, ?, ?)`, [intentId, account.id, riskFingerprint(account), account.credentialGeneration, encoded, market.observedAt]);
  });
}

/** Called only after ownership/protection reconciliation. Amounts are derived, original orders/plans stay untouched. */
export async function observeRiskReservations(account: TradingAccount, remote: ExchangeOpenState, epoch: string): Promise<string> {
  return withDatabaseTransaction(async db => {
    const binding = await db.get<{ reporting_currency: string }>(
      'SELECT reporting_currency FROM trading_money_bindings WHERE account_id = ? AND account_fingerprint = ?', [account.id, riskFingerprint(account)]);
    const currency = binding?.reporting_currency ?? 'UNRESOLVED';
    const source = await loadRiskSources(account.id);
    const reservations = await Promise.all(source.map(row => deriveRiskReservation(row, account, remote, currency)));
    const observedAt = remote.observedAt;
    const utcDay = new Date(observedAt).setUTCHours(0, 0, 0, 0);
    const costs = await moneyLedgerSnapshot(account.id, 0, Number.MAX_SAFE_INTEGER);
    const moneySources = await db.all(`SELECT event.id, event.content_json, valuation.content_json AS valuation FROM trading_money_events event
      LEFT JOIN trading_money_valuations valuation ON valuation.event_id = event.id WHERE event.account_id = ? ORDER BY event.id`, [account.id]);
    const expiresAt = reservations.reduce((expiry, reservation) => Math.min(expiry, reservation.fx?.conversion.expiresAt ?? expiry),
      observedAt + RISK_EVIDENCE_TTL_MS);
    const evidence = { version: 2, source, reservations, reportingCurrency: currency, costs, ledgerGeneration: riskHash([costs, moneySources]) };
    const id = riskHash([account.id, riskFingerprint(account), account.credentialGeneration, epoch, observedAt, evidence]);
    await db.run(`INSERT OR IGNORE INTO trading_risk_observations (id, account_id, account_fingerprint, credential_generation, entry_epoch,
      observed_at, expires_at, utc_day, evidence_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, account.id, riskFingerprint(account), account.credentialGeneration, epoch, observedAt,
      expiresAt, utcDay, JSON.stringify(evidence), Date.now()]);
    await db.run(`INSERT INTO trading_risk_current (account_id, observation_id) VALUES (?, ?)
      ON CONFLICT(account_id) DO UPDATE SET observation_id = excluded.observation_id, balance_json = NULL, balance_reason = NULL`, [account.id, id]);
    return id;
  });
}

export async function riskExposureExists(accountId: string): Promise<boolean> { return (await loadRiskSources(accountId)).length > 0; }

/** Balance-read failures annotate risk only; they never fail the completed protection reconciliation. */
export async function recordRiskBalance(accountId: string, observationId: string, snapshot: TradingAccountSnapshot | null, reason: string | null): Promise<void> {
  await getDatabase().run('UPDATE trading_risk_current SET balance_json = ?, balance_reason = ? WHERE account_id = ? AND observation_id = ?',
    [snapshot === null ? null : JSON.stringify(snapshot), reason, accountId, observationId]);
}

export async function existingRiskCommitment(account: TradingAccount, excludedIntent: string, epoch: string, currency: string): Promise<ExistingRiskProof> {
  return withDatabaseTransaction(async db => {
    const source = await loadRiskSources(account.id, excludedIntent);
    const sourceHash = riskHash(source);
    const now = Date.now();
    const utcDay = new Date(now).setUTCHours(0, 0, 0, 0);
    if (!source.length) return { commitment: '0', value: { ...moneyValueFromDecimal('0'), terms: 0 }, fxConversions: [], reservations: [], sourceHash, observedAt: now,
      expiresAt: now + RISK_EVIDENCE_TTL_MS, utcDay, observationId: null };
    const row = await db.get<StoredRiskObservation>(`SELECT observation.* FROM trading_risk_observations observation
      JOIN trading_risk_current current ON current.observation_id = observation.id WHERE current.account_id = ?`, [account.id]);
    if (!row || row.account_fingerprint !== riskFingerprint(account) || row.credential_generation !== account.credentialGeneration
      || row.entry_epoch !== epoch) unresolved('missing observation or changed identity/epoch.');
    const timing = { observedAt: row.observed_at, expiresAt: row.expires_at, utcDay: row.utc_day };
    try { assertRiskFresh(timing, now); } catch { unresolved('stale market/protection observation.'); }
    const evidence = JSON.parse(row.evidence_json) as { reservations: Reservation[]; reportingCurrency: string };
    if (currency !== evidence.reportingCurrency) unresolved('reporting currency changed.');
    const reservations = source.map(current => {
      const reservation = evidence.reservations.find(candidate => candidate.intentId === current.id);
      if (!reservation || reservation.sourceHash !== riskHash(current)) unresolved('order/fill/stop sources changed since observation.');
      if (reservation.amounts.status !== 'complete' || !reservation.amounts.additionalRiskValue) unresolved(reservation.amounts.reason ?? 'unproved reserve.');
      return reservation;
    });
    const fxConversions = [...new Map(reservations.flatMap(reservation => reservation.fx ? [[reservation.fx.id, reservation.fx] as const] : [])).values()];
    try { await verifyRiskFxConversions(account, fxConversions); }
    catch (error) { unresolved(error instanceof Error ? error.message : 'FX originals unresolved.'); }
    const value = reservations.reduce((sum, reservation) => addMoneyValues(sum, validateMoneyValue(reservation.amounts.additionalRiskValue)),
      { ...moneyValueFromDecimal('0'), terms: 0 });
    return { commitment: value.decimal, value, fxConversions, reservations, sourceHash, ...timing, observationId: row.id };
  });
}
