import { getDatabase } from '../../src/db.js';
import { accountModeDigest } from '../../src/trading_account_mode_contract.js';
import { bindPostUta2Baseline, persistAccountModeObservation } from '../../src/trading_account_mode.js';

/** Local source evidence only; never creates or calls a provider account. */
export async function seedPostUta2Origin(account, boundary) {
  const mode = startedAt => {
    const value = { version: 1, profile: 'bybit_uta_v1', accountFingerprint: account.externalAccountId,
      credentialGeneration: account.credentialGeneration, providerAccountUid: '123', parentAccountUid: '0',
      isMaster: true, unifiedMarginStatus: 5, accountUpdatedAt: 0, startedAt, completedAt: startedAt + 10 };
    return { ...value, evidenceHash: accountModeDigest(value) };
  };
  const first = mode(boundary - 100), second = mode(boundary + 100);
  for (const observation of [first, second]) await persistAccountModeObservation(account,
    { calls: 2, observation, reason: null }, observation);
  const id = `origin-${account.id}`;
  const proof = { first: { modeBeforeBoundary: first }, second: { accountMode: { observation: second } } };
  await getDatabase().run(`INSERT INTO trading_account_baselines (id,account_id,account_fingerprint,credential_generation,status,
    boundary_at,first_completed_at,last_observed_at,first_evidence_json,proof_json) VALUES (?,?,?,?,'established',?,?,?,'{}',?)`,
  [id, account.id, account.externalAccountId, account.credentialGeneration, boundary, boundary + 50, second.completedAt, JSON.stringify(proof)]);
  await bindPostUta2Baseline(account, id, boundary, first, second);
}

export function logProgress(checkpoint, records, now = Date.now(), cursor = null, lane = 'forward') {
  const current = lane === 'audit' ? checkpoint.audit : checkpoint;
  const until = current.windowUntil ?? now;
  const receipt = { version: 1, namespace: checkpoint.namespace, filterHash: checkpoint.filterHash, lane,
    accountFingerprint: checkpoint.accountFingerprint, credentialGeneration: checkpoint.credentialGeneration,
    since: current.windowSince, until, cursor: current.cursor, nextCursor: cursor,
    startedAt: now, completedAt: now, providerResponseAt: now, providerAccountUid: checkpoint.providerAccountUid,
    exhausted: cursor === null, records };
  const next = { ...checkpoint, revision: checkpoint.revision + 1, lastServedAt: now };
  if (lane === 'audit') next.audit = auditProgress(checkpoint, current, until, now, cursor);
  else Object.assign(next, { windowSince: cursor === null ? Math.max(checkpoint.requiredSince,
    until >= now - 1000 ? Math.floor(until / 86400000) * 86400000 - 86400000 : until - 1000) : current.windowSince,
  cursor, windowUntil: cursor === null ? null : until, scannedThrough: cursor === null ? Math.max(until, checkpoint.scannedThrough ?? 0) : checkpoint.scannedThrough });
  return { baseRevision: checkpoint.revision, calls: 1, receipts: [receipt], checkpoint: next };
}
function auditProgress(checkpoint, current, until, now, cursor) {
  const since = until >= Math.floor(now / 86400000) * 86400000 ? checkpoint.requiredSince : Math.max(checkpoint.requiredSince, until - 1000);
  return { windowSince: cursor === null ? since : current.windowSince, windowUntil: cursor === null ? null : until,
    cursor, completedAt: cursor === null ? now : current.completedAt };
}
