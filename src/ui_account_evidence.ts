import { getDatabase } from './db.js';
import { getTradingAccount } from './trading_repository.js';
import { getAccountBaseline, requiredAccountEvidenceSince } from './trading_account_baseline.js';
import { moneyLedgerSnapshot } from './trading_money_ledger.js';
import { riskFingerprint } from './trading_risk_sources.js';
import { decodeUiCursor, encodeUiCursor, filterFingerprint } from './ui_cursor.js';
import { uiObjectId } from './ui_trading_reads.js';
import { redactReview } from './ui_change_review.js';

function accountRiskObservation(accountId: string, observationId: string | null) {
  return getDatabase().get(`SELECT observation.id, observation.account_id AS accountId, observation.account_fingerprint AS fingerprint,
    observation.credential_generation AS credentialGeneration, observation.observed_at AS observedAt, observation.expires_at AS expiresAt,
    observation.utc_day AS utcDay, observation.recorded_at AS recordedAt,
    json_extract(observation.evidence_json, '$.reportingCurrency') AS reportingCurrency,
    json_array_length(observation.evidence_json, '$.reservations') AS reservationCount,
    current.observation_id AS currentObservationId, current.observation_id AS balanceSourceObservationId, current.balance_reason AS balanceReason,
    json_extract(current.balance_json, '$.equity') AS equity, json_extract(current.balance_json, '$.availableBalance') AS availableBalance,
    json_extract(current.balance_json, '$.unrealizedPnl') AS unrealizedPnl,
    json_extract(current.balance_json, '$.accounting.reportingCurrency') AS balanceCurrency,
    json_extract(current.balance_json, '$.accounting.observedAt') AS balanceObservedAt
    FROM trading_risk_observations observation LEFT JOIN trading_risk_current current ON current.account_id = observation.account_id
    WHERE observation.account_id = ? AND observation.id = COALESCE(?, current.observation_id)`, [accountId, observationId]);
}
function observationSummary(row: any, account: NonNullable<Awaited<ReturnType<typeof getTradingAccount>>>, now: number) {
  if (!row) return null;
  const { fingerprint, credentialGeneration, ...visible } = row;
  return { ...redactReview(visible), identityMatches: fingerprint === riskFingerprint(account), credentialGenerationMatches: credentialGeneration === account.credentialGeneration,
    timestampFresh: row.observedAt <= now && row.expiresAt > now && row.utcDay === new Date(now).setUTCHours(0, 0, 0, 0),
    isCurrentObservation: row.id === row.currentObservationId,
    scope: 'Stored reconciliation projection. Timestamp/identity checks do not validate the current entry epoch, changed orders or FX proofs; not an entry authorization.' };
}

export async function uiAccountEvidence(accountId: string) {
  uiObjectId(accountId); const account = await getTradingAccount(accountId); if (!account) return null;
  const now = Date.now(); const day = new Date(now).setUTCHours(0, 0, 0, 0);
  const sources = await Promise.allSettled([
    accountRiskObservation(accountId, null), getAccountBaseline(account), requiredAccountEvidenceSince(account), moneyLedgerSnapshot(accountId, day, now + 1),
  ]);
  const [observation, baseline, requiredSince, daily] = sources.map(source => source.status === 'fulfilled' ? source.value : null);
  return { contractVersion: 1, observedAt: now, account: { id: account.id, name: account.name, exchange: account.exchange, mode: account.mode },
    risk: observationSummary(observation, account, now), baseline, requiredHistorySince: requiredSince,
    daily: daily ? dailyEvidence(daily, day, now + 1) : null,
    errors: sources.map((source, index) => source.status === 'rejected' ? { source: ['risk', 'baseline', 'required-history', 'daily-money'][index], reason: redactReview(String(source.reason)) } : null).filter(Boolean),
    interpretation: 'Abrechnungswerte aus dem bestehenden Geld-Ledger für den UTC-Tag. Keine eigenständige Summierung interner Tabellen, keine neue Handelsfreigabe. Fehlende Historie und ungeklärte Bewertungen bleiben sichtbar.' };
}
function dailyEvidence(daily: Awaited<ReturnType<typeof moneyLedgerSnapshot>>, since: number, until: number) {
  const { unresolvedEventIds, ...summary } = daily;
  return { ...summary, since, until, unresolvedEventIds: unresolvedEventIds.slice(0, 100), unresolvedEventCount: unresolvedEventIds.length };
}

function evidencePage(query: URLSearchParams, selection: Record<string, unknown>) {
  const limit = Number(query.get('limit') || 20);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Evidence page size must be 1–50.');
  const filter = filterFingerprint({ ...selection, limit }); const cursor = decodeUiCursor(query.get('cursor'), filter);
  return { limit, filter, cursor, observedAt: cursor?.observedAt ?? Date.now() };
}
function nextEvidenceCursor(page: ReturnType<typeof evidencePage>, rows: any[], createdAt: number, id: string) {
  return rows.length > page.limit ? encodeUiCursor({ version: 1, filter: page.filter, observedAt: page.observedAt, createdAt, id }) : null;
}

export async function uiAccountReservations(accountId: string, query: URLSearchParams) {
  uiObjectId(accountId); const account = await getTradingAccount(accountId); if (!account) return null;
  const observationId = query.has('observationId') ? uiObjectId(query.get('observationId'), 64) : null;
  const observation = await accountRiskObservation(accountId, observationId); if (!observation) return null;
  const page = evidencePage(query, { kind: 'reservations', accountId, observationId: observation.id });
  const after = page.cursor ? Number(page.cursor.id) : -1;
  if (!Number.isSafeInteger(after) || after < -1) throw new Error('Invalid reservation cursor.');
  // Read bounded fields from the immutable observation, not the potentially large source/order arrays.
  const rows = await getDatabase().all(`SELECT CAST(item.key AS INTEGER) AS ordinal,
    json_extract(item.value, '$.intentId') AS intentId, json_extract(item.value, '$.sourceHash') AS sourceHash,
    CASE WHEN length(CAST(json_extract(item.value, '$.amounts') AS BLOB)) <= 16384 THEN json_extract(item.value, '$.amounts') END AS amounts,
    CASE WHEN length(CAST(json_extract(item.value, '$.amounts') AS BLOB)) > 16384 THEN 1 ELSE 0 END AS amountsOmitted,
    json_extract(item.value, '$.input.markPrice') AS markPrice,
    json_extract(item.value, '$.input.averageEntryPrice') AS averageEntryPrice, json_extract(item.value, '$.input.stopPrice') AS stopPrice,
    json_extract(item.value, '$.input.protectionProven') AS protectionProven,
    json_extract(item.value, '$.fx.id') AS fxId, json_extract(item.value, '$.fx.conversion.expiresAt') AS fxExpiresAt,
    json_extract(item.value, '$.fx.conversion.rate') AS fxRate
    FROM trading_risk_observations observation, json_each(observation.evidence_json, '$.reservations') item
    WHERE observation.id = ? AND observation.account_id = ? AND CAST(item.key AS INTEGER) > ? ORDER BY CAST(item.key AS INTEGER) LIMIT ?`, [observation.id, accountId, after, page.limit + 1]);
  const last = rows[Math.min(page.limit, rows.length) - 1];
  return { contractVersion: 1, observedAt: page.observedAt, observation: observationSummary(observation, account, Date.now()),
    entries: redactReview(rows.slice(0, page.limit).map(row => ({ ...row, amounts: row.amounts ? JSON.parse(row.amounts) : null }))), hasMore: rows.length > page.limit,
    nextCursor: last ? nextEvidenceCursor(page, rows, 0, String(last.ordinal)) : null,
    interpretation: 'Originale gespeicherte Risikoreservierungen. Betrag und Mark gehören zum Beobachtungszeitpunkt; die Engine prüft Quellen, Frische und FX vor neuen Entries erneut.' };
}

export async function uiAccountHistory(accountId: string, query: URLSearchParams) {
  uiObjectId(accountId); const account = await getTradingAccount(accountId); if (!account) return null;
  const page = evidencePage(query, { kind: 'history', accountId, fingerprint: account.externalAccountId });
  const after = page.cursor ? Number(page.cursor.id) : 0;
  if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid history cursor.');
  const rows = await getDatabase().all(`SELECT rowid AS id, source, provider_symbol AS providerSymbol, revision, updated_at AS updatedAt,
    json_extract(checkpoint_json, '$.baselineSince') AS baselineSince, json_extract(checkpoint_json, '$.windowSince') AS windowSince,
    json_extract(checkpoint_json, '$.windowUntil') AS windowUntil, json_extract(checkpoint_json, '$.scannedThrough') AS scannedThrough,
    json_extract(checkpoint_json, '$.nextReadAt') AS nextReadAt, json_extract(checkpoint_json, '$.completeness') AS completeness,
    json_extract(checkpoint_json, '$.reason') AS reason, json_extract(checkpoint_json, '$.coverage') AS coverage,
    json_extract(checkpoint_json, '$.retention') AS retention,
    CASE WHEN json_extract(checkpoint_json, '$.cursor') IS NULL THEN 0 ELSE 1 END AS cursorPresent
    FROM trading_history_checkpoints WHERE account_id = ? AND account_fingerprint = ? AND rowid > ? ORDER BY rowid LIMIT ?`, [accountId, account.externalAccountId, after, page.limit + 1]);
  const last = rows[Math.min(page.limit, rows.length) - 1];
  return { contractVersion: 1, observedAt: page.observedAt, entries: redactReview(rows.slice(0, page.limit).map(row => ({ ...row,
    coverage: row.coverage ? JSON.parse(row.coverage) : null, retention: row.retention ? JSON.parse(row.retention) : null }))), hasMore: rows.length > page.limit,
    nextCursor: last ? nextEvidenceCursor(page, rows, 0, String(last.id)) : null,
    interpretation: 'Gespeicherter Scanfortschritt für die aktuelle Kontoidentität; keine Abfrage beim Provider und keine Änderung von Checkpoints. Seiten lesen den jeweils aktuellen Fortschritt. Cursorende allein beweist keine vollständige Vergangenheit.' };
}
