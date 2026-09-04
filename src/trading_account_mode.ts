import { getDatabase, withDatabaseTransaction } from './db.js';
import { validateAccountModeObservation, validateAccountModeProgress,
  type AccountModeProgress, type BybitAccountModeObservation } from './trading_account_mode_contract.js';
import type { TradingAccount } from './trading_types.js';

export const ACCOUNT_MODE_PROFILE = 'bybit_uta_v1';
const FRESHNESS = 30_000;
type Interval = { startedAt: number; completedAt: number };

async function assertBinding(account: TradingAccount, mode: BybitAccountModeObservation): Promise<void> {
  const current = await getDatabase().get<{ external_account_id: string; credential_generation: string }>(
    'SELECT external_account_id, credential_generation FROM trading_accounts WHERE id=?', [account.id]);
  if (account.exchange !== 'bybit' || !current || current.external_account_id !== mode.accountFingerprint
    || current.credential_generation !== mode.credentialGeneration || account.externalAccountId !== mode.accountFingerprint
    || account.credentialGeneration !== mode.credentialGeneration) throw new Error('Account-mode binding changed.');
}

/** Immutable authenticated observations, not account creation/upgrade dates and not a replacement identity. */
export async function persistAccountModeObservation(account: TradingAccount, progress: AccountModeProgress, acquisition: Interval): Promise<void> {
  const { observation } = validateAccountModeProgress(progress, acquisition);
  if (!observation) return;
  await withDatabaseTransaction(async () => {
    await assertBinding(account, observation);
    await getDatabase().run(`INSERT INTO trading_account_mode_observations
      (evidence_hash,account_id,account_fingerprint,credential_generation,profile,provider_account_uid,started_at,completed_at,payload_json)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(evidence_hash) DO NOTHING`,
    [observation.evidenceHash, account.id, observation.accountFingerprint, observation.credentialGeneration, observation.profile,
      observation.providerAccountUid, observation.startedAt, observation.completedAt, JSON.stringify(observation)]);
    const stored = await getDatabase().get<{ account_id: string }>(
      'SELECT account_id FROM trading_account_mode_observations WHERE evidence_hash=?', [observation.evidenceHash]);
    if (stored?.account_id !== account.id) throw new Error('Account-mode observation already belongs to another account binding.');
  });
}

export async function latestAccountMode(account: TradingAccount, before = Number.MAX_SAFE_INTEGER): Promise<BybitAccountModeObservation | null> {
  const row = await getDatabase().get<{ payload_json: string }>(`SELECT payload_json FROM trading_account_mode_observations
    WHERE account_id=? AND account_fingerprint=? AND credential_generation=? AND profile=? AND completed_at<=?
    ORDER BY completed_at DESC,evidence_hash LIMIT 1`,
  [account.id, account.externalAccountId, account.credentialGeneration, ACCOUNT_MODE_PROFILE, before]);
  return row ? validateAccountModeObservation(JSON.parse(row.payload_json)) : null;
}

/** Bootstrap reads use the shared recovery scheduler. Established/legacy baselines are never endlessly re-read into a new origin. */
export async function accountModeReadRequired(account: TradingAccount): Promise<boolean> {
  if (account.exchange !== 'bybit' || !account.externalAccountId || !account.credentialGeneration) return false;
  const mode = await latestAccountMode(account);
  if (!mode) return true;
  const baseline = await getDatabase().get<{ status: string; first_completed_at: number; first_evidence_json: string }>(
    'SELECT status,first_completed_at,first_evidence_json FROM trading_account_baselines WHERE account_id=? AND account_fingerprint=?',
    [account.id, account.externalAccountId]);
  if (baseline?.status === 'established') return false;
  if (baseline && JSON.parse(baseline.first_evidence_json).modeBeforeBoundary) return mode.startedAt <= baseline.first_completed_at;
  return Date.now() - mode.completedAt > FRESHNESS;
}

export async function modeBeforeBaseline(account: TradingAccount, acquisition: Interval): Promise<BybitAccountModeObservation | null> {
  const mode = await latestAccountMode(account, acquisition.startedAt);
  return mode && acquisition.startedAt - mode.completedAt <= FRESHNESS ? mode : null;
}

export function sameUta2Mode(first: BybitAccountModeObservation, second: BybitAccountModeObservation): boolean {
  return [5, 6].includes(first.unifiedMarginStatus) && first.unifiedMarginStatus === second.unifiedMarginStatus
    && first.accountFingerprint === second.accountFingerprint && first.credentialGeneration === second.credentialGeneration
    && first.providerAccountUid === second.providerAccountUid && first.parentAccountUid === second.parentAccountUid
    && first.isMaster === second.isMaster;
}

export async function consistentModeHistory(account: TradingAccount, first: BybitAccountModeObservation, through: number): Promise<boolean> {
  const rows = await getDatabase().all<Array<{ payload_json: string }>>(`SELECT payload_json FROM trading_account_mode_observations
    WHERE account_id=? AND account_fingerprint=? AND credential_generation=? AND profile=? AND completed_at<=?`,
  [account.id, account.externalAccountId, account.credentialGeneration, ACCOUNT_MODE_PROFILE, through]);
  return rows.every(row => {
    const mode = validateAccountModeObservation(JSON.parse(row.payload_json));
    const sameIdentity = mode.providerAccountUid === first.providerAccountUid && mode.parentAccountUid === first.parentAccountUid && mode.isMaster === first.isMaster;
    return sameIdentity && (mode.completedAt < first.startedAt || sameUta2Mode(first, mode));
  });
}

async function assertRealBaseline(baselineId: string, account: TradingAccount, boundary: number,
  first: BybitAccountModeObservation, second: BybitAccountModeObservation): Promise<void> {
  const row = await getDatabase().get<{ first_completed_at: number; proof_json: string }>(`SELECT first_completed_at,proof_json
    FROM trading_account_baselines WHERE id=? AND account_id=? AND account_fingerprint=? AND credential_generation=?
      AND boundary_at=? AND status='established'`, [baselineId, account.id, account.externalAccountId, account.credentialGeneration, boundary]);
  const proof = row?.proof_json ? JSON.parse(row.proof_json) : null;
  if (!row || proof?.first?.modeBeforeBoundary?.evidenceHash !== first.evidenceHash
    || proof?.second?.accountMode?.observation?.evidenceHash !== second.evidenceHash || second.startedAt <= row.first_completed_at
    || !await consistentModeHistory(account, first, second.completedAt)) throw new Error('Actual baseline observations do not prove the mode pair.');
}

export async function bindPostUta2Baseline(account: TradingAccount, baselineId: string, boundary: number,
  first: BybitAccountModeObservation, second: BybitAccountModeObservation): Promise<void> {
  if (!sameUta2Mode(first, second) || first.completedAt > boundary || second.startedAt <= boundary) throw new Error('Unproved post-UTA2 baseline origin.');
  await assertBinding(account, second);
  await assertRealBaseline(baselineId, account, boundary, first, second);
  const proof = { version: 1, profile: ACCOUNT_MODE_PROFILE, sourceVersion: 'authenticated-mode-pair-v1',
    firstModeHash: first.evidenceHash, secondModeHash: second.evidenceHash, boundary,
    scope: 'post-baseline-origin-only', finality: 'not_proven' };
  await getDatabase().run(`INSERT INTO trading_account_baseline_bindings
    (baseline_id,profile,account_id,account_fingerprint,credential_generation,provider_account_uid,first_mode_hash,second_mode_hash,boundary_at,proof_json)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, [baselineId, ACCOUNT_MODE_PROFILE, account.id, account.externalAccountId, account.credentialGeneration,
    second.providerAccountUid, first.evidenceHash, second.evidenceHash, boundary, JSON.stringify(proof)]);
}

export interface AccountOriginScope {
  status: 'post_uta2_baseline' | 'not_proven'; baselineId: string | null; boundary: number | null;
  providerAccountUid: string | null; reason: string | null;
}
export async function accountOriginScope(account: TradingAccount, requiredSince: number): Promise<AccountOriginScope> {
  const unknown = (reason: string): AccountOriginScope => ({ status: 'not_proven', baselineId: null, boundary: null, providerAccountUid: null, reason });
  const row = await getDatabase().get<{ baseline_id: string; boundary_at: number; provider_account_uid: string;
    first_json: string; second_json: string }>(`SELECT binding.*, first.payload_json AS first_json, second.payload_json AS second_json
    FROM trading_account_baseline_bindings binding JOIN trading_account_baselines baseline ON baseline.id=binding.baseline_id
    JOIN trading_account_mode_observations first ON first.evidence_hash=binding.first_mode_hash
    JOIN trading_account_mode_observations second ON second.evidence_hash=binding.second_mode_hash
    WHERE binding.account_id=? AND binding.account_fingerprint=? AND binding.credential_generation=? AND binding.profile=?
      AND baseline.status='established' AND baseline.boundary_at=binding.boundary_at
      AND baseline.account_id=binding.account_id AND baseline.account_fingerprint=binding.account_fingerprint
      AND baseline.credential_generation=binding.credential_generation`,
  [account.id, account.externalAccountId, account.credentialGeneration, ACCOUNT_MODE_PROFILE]);
  if (!row) return unknown('baseline_mode_origin_unproved');
  const first = validateAccountModeObservation(JSON.parse(row.first_json)), second = validateAccountModeObservation(JSON.parse(row.second_json));
  if (!sameUta2Mode(first, second) || first.completedAt > row.boundary_at || second.startedAt <= row.boundary_at) return unknown('baseline_mode_binding_conflict');
  if (!await consistentModeHistory(account, first, Number.MAX_SAFE_INTEGER)) return unknown('observed_account_mode_or_uid_conflict');
  await assertRealBaseline(row.baseline_id, account, row.boundary_at, first, second);
  if (requiredSince < row.boundary_at) return unknown('pre_baseline_obligation_requires_legacy_history');
  return { status: 'post_uta2_baseline', baselineId: row.baseline_id, boundary: row.boundary_at, providerAccountUid: row.provider_account_uid, reason: null };
}
