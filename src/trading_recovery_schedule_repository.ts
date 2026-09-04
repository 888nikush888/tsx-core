import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { getDatabase, withDatabaseTransaction } from './db.js';
import { validateAcquisitionEvidence } from './exchange_contract_validation.js';
import { requireFxAccountContext, snapshotFxAccount, type FxAccount } from './trading_fx_repository.js';
import { planScheduledRecovery, recoveryHistoryKey, type RecoveryScheduleState, type ScheduledRecoveryQuery } from './trading_recovery_schedule.js';
import { validateRecoveryScheduleInputs, validateRecoveryScheduleProgress, type RecoveryScheduleBinding } from './trading_recovery_schedule_contract.js';
import type { ExchangeAcquisitionEvidence, ExchangeRecoveryQuery, TradingAccount } from './trading_types.js';

type Attempt = { id: string; schedule_id: string; account_id: string; base_revision: number; phase: number;
  advances_phase: number; history_selection: string | null; status: string; request_json: string; started_at: number; lease_until: number };
type Failure = 'transport_unresolved' | 'contract_invalid' | 'read_failed' | 'lease_expired';
function fail(reason: string): never { throw new Error(`RECOVERY_SCHEDULE_${reason}`); }
function instant(now: number): void { if (!Number.isSafeInteger(now) || now < 0 || now > Date.now() + 1000) fail('INVALID_TIME'); }
async function accountBinding(account: FxAccount): Promise<RecoveryScheduleBinding> {
  const context = await requireFxAccountContext(account);
  return { accountId: account.id, accountFingerprint: account.externalAccountId!, credentialGeneration: account.credentialGeneration!,
    mode: context.mode, executionProfileHash: context.profileHash };
}
function scheduleId(binding: RecoveryScheduleBinding): string {
  return createHash('sha256').update(`tsx-recovery-scope-v1\n${JSON.stringify(binding)}`).digest('hex');
}
/** Eligibility is not entry permission; the reservation still rechecks the authoritative DB binding. */
export function usesScheduledFxRecovery(account: TradingAccount): boolean {
  return account.exchange === 'bybit' && ['live', 'testnet'].includes(account.mode)
    && typeof account.lastVerifiedAt === 'number' && account.lastVerifiedAt > 0 && account.capabilities?.profileVersion === 1
    && (account.capabilities?.executionCapabilities as Record<string, unknown> | undefined)?.provider_api_version === 'bybit-v5'
    && typeof account.capabilities?.executionProfileHash === 'string' && /^[a-f0-9]{64}$/.test(account.capabilities.executionProfileHash);
}
async function activeAttempt(id: string): Promise<Attempt | undefined> {
  return getDatabase().get<Attempt>("SELECT * FROM trading_recovery_schedule_attempts WHERE schedule_id=? AND status='reserved' AND advances_phase=1", [id]);
}
async function schedule(binding: RecoveryScheduleBinding, now: number): Promise<RecoveryScheduleState> {
  const id = scheduleId(binding);
  await getDatabase().run(`INSERT INTO trading_recovery_schedules(id,account_id,binding_json,updated_at)
    VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING`, [id, binding.accountId, JSON.stringify(binding), now]);
  return (await getDatabase().get<RecoveryScheduleState>('SELECT * FROM trading_recovery_schedules WHERE id=?', [id]))!;
}
/** Used within the existing account coordinator, never a new timer or source of trade authority. */
export async function scheduledRecoveryDue(account: FxAccount, now = Date.now()): Promise<boolean> {
  account = snapshotFxAccount(account);
  instant(now);
  const id = scheduleId(await accountBinding(account));
  const state = await getDatabase().get<RecoveryScheduleState>('SELECT * FROM trading_recovery_schedules WHERE id=?', [id]);
  if (!state) return true;
  const active = await activeAttempt(id);
  return (!active || active.lease_until <= now) && Math.max(state.next_due_at, state.cooldown_until) <= now;
}
export async function reserveScheduledRecovery(account: FxAccount, query: ExchangeRecoveryQuery,
  now = Date.now()): Promise<ScheduledRecoveryQuery> {
  account = snapshotFxAccount(account); query = structuredClone(query);
  instant(now);
  return withDatabaseTransaction(async () => {
    const binding = await accountBinding(account);
    let state = await schedule(binding, now), active = await activeAttempt(state.id);
    if (active && active.lease_until <= now) {
      await closeFailure(active, 'lease_expired', now);
      state = await schedule(binding, now); active = undefined;
    }
    const attemptId = randomUUID();
    const request = planScheduledRecovery(query, binding, state, attemptId, now, active !== undefined);
    validateRecoveryScheduleInputs(request, binding);
    const advances = request.recoverySchedule.grants.some(grant => grant.maxCalls > 0);
    await getDatabase().run(`INSERT INTO trading_recovery_schedule_attempts
      (id,schedule_id,account_id,base_revision,phase,advances_phase,history_selection,status,request_json,started_at,lease_until)
      VALUES (?,?,?,?,?,?,?,'reserved',?,?,?)`, [attemptId, state.id, account.id, state.revision, state.phase, Number(advances),
    request.history?.[0] ? recoveryHistoryKey(request.history[0]) : null, JSON.stringify(request), now, now + 35000]);
    return request;
  });
}
function assertAttemptBinding(account: FxAccount, attempt: Attempt): void {
  const query = JSON.parse(attempt.request_json) as ScheduledRecoveryQuery;
  const bound = query.recoverySchedule.binding;
  if (attempt.account_id !== account.id || bound.accountId !== account.id || bound.mode !== account.mode
    || bound.accountFingerprint !== account.externalAccountId || bound.credentialGeneration !== account.credentialGeneration
    || bound.executionProfileHash !== account.capabilities?.executionProfileHash) fail('ATTEMPT_BINDING_CHANGED');
}
async function advance(attempt: Attempt, now: number, cooldown: number): Promise<void> {
  if (!attempt.advances_phase) return;
  const changed = await getDatabase().run(`UPDATE trading_recovery_schedules SET revision=revision+1,phase=(phase+1)%4,
    fx_rotation=CASE WHEN phase IN (0,2) THEN (fx_rotation+1)%4 ELSE fx_rotation END,
    logs_first=CASE WHEN phase=3 THEN 1-logs_first ELSE logs_first END,
    history_after=COALESCE(?,history_after),next_due_at=?,cooldown_until=MAX(cooldown_until,?),updated_at=?
    WHERE id=? AND revision=? AND phase=?`, [attempt.history_selection, now + 2000, cooldown, now,
  attempt.schedule_id, attempt.base_revision, attempt.phase]);
  if (changed.changes !== 1) fail('REVISION_CHANGED');
}
async function closeFailure(attempt: Attempt, reason: Failure, now: number): Promise<void> {
  if (now < attempt.started_at || attempt.status !== 'reserved') fail('ATTEMPT_NOT_OPEN');
  const changed = await getDatabase().run(`UPDATE trading_recovery_schedule_attempts
    SET status='failed',error_code=?,calls=NULL,completed_at=? WHERE id=? AND status='reserved'`, [reason, now, attempt.id]);
  if (changed.changes !== 1) fail('ATTEMPT_CHANGED');
  await advance(attempt, now, 0);
}
/** A lost response never means zero calls, empty history, a missing order, or a fresh quote. */
export async function failScheduledRecovery(account: FxAccount, attemptId: string, reason: Failure, now = Date.now()): Promise<void> {
  account = snapshotFxAccount(account);
  instant(now);
  if (!['transport_unresolved', 'contract_invalid', 'read_failed', 'lease_expired'].includes(reason)) fail('INVALID_FAILURE');
  await withDatabaseTransaction(async () => {
    const attempt = await getDatabase().get<Attempt>('SELECT * FROM trading_recovery_schedule_attempts WHERE id=?', [attemptId]);
    if (!attempt) return fail('ATTEMPT_MISSING');
    assertAttemptBinding(account, attempt);
    if (attempt.status !== 'reserved') return;
    await closeFailure(attempt, reason, now);
  });
}
/** Pin the exact held request and its absolute transport ceiling, including any later token wait. */
export async function scheduledRecoveryDeadline(account: FxAccount, query: ExchangeRecoveryQuery): Promise<number | undefined> {
  account = snapshotFxAccount(account); query = structuredClone(query);
  if (!query.recoverySchedule) return undefined;
  const expected = await accountBinding(account);
  validateRecoveryScheduleInputs(query, expected);
  const attempt = await getDatabase().get<Attempt>('SELECT * FROM trading_recovery_schedule_attempts WHERE id=?', [query.recoverySchedule.attemptId]);
  if (!attempt || attempt.status !== 'reserved') return fail('ATTEMPT_NOT_OPEN');
  assertAttemptBinding(account, attempt);
  if (!isDeepStrictEqual(JSON.parse(attempt.request_json), query)) fail('REQUEST_CHANGED');
  if (Date.now() >= attempt.lease_until) fail('READ_LEASE_EXPIRED');
  return attempt.lease_until;
}
async function heldAcquisition(account: FxAccount, evidence: ExchangeAcquisitionEvidence) {
  const clean = validateAcquisitionEvidence(evidence);
  if (!clean.recoverySchedule) {
    if (clean.fxEvidence || clean.accountLogs?.readSkipped !== undefined) fail('MISSING_REQUEST');
    return null;
  }
  const expected = await accountBinding(account);
  const attempt = await getDatabase().get<Attempt>('SELECT * FROM trading_recovery_schedule_attempts WHERE id=?', [clean.recoverySchedule.attemptId]);
  if (!attempt || attempt.status !== 'reserved') return fail('ATTEMPT_NOT_OPEN');
  assertAttemptBinding(account, attempt);
  if (clean.startedAt < attempt.started_at || clean.completedAt > attempt.lease_until) fail('READ_LEASE_EXPIRED');
  const request = JSON.parse(attempt.request_json) as ScheduledRecoveryQuery;
  const progress = validateRecoveryScheduleProgress(clean.recoverySchedule, request, clean, expected);
  if (!progress) return fail('PROGRESS_MISSING');
  return { attempt, progress };
}
/** Validate the held request before any source checkpoint or original observation is written. */
export async function assertScheduledAcquisition(account: FxAccount, evidence: ExchangeAcquisitionEvidence): Promise<void> {
  account = snapshotFxAccount(account);
  await heldAcquisition(account, structuredClone(evidence));
}
/** Called in the existing acquisition transaction, only after originals and source progress are durable. */
export async function completeScheduledRecovery(account: FxAccount, acquisitionId: string): Promise<void> {
  account = snapshotFxAccount(account);
  await withDatabaseTransaction(async () => {
    const row = await getDatabase().get<{ payload_json: string }>(`SELECT payload_json FROM trading_acquisition_evidence
      WHERE id=? AND account_id=? AND account_fingerprint=?`, [acquisitionId, account.id, account.externalAccountId]);
    if (!row) return fail('ACQUISITION_NOT_PERSISTED');
    const held = await heldAcquisition(account, JSON.parse(row.payload_json));
    if (!held) return;
    const { attempt, progress } = held, now = Date.now();
    const updated = await getDatabase().run(`UPDATE trading_recovery_schedule_attempts SET status='succeeded',
      response_json=?,calls=?,completed_at=? WHERE id=? AND status='reserved'`,
    [JSON.stringify(progress), progress.calls, now, attempt.id]);
    if (updated.changes !== 1) fail('ATTEMPT_CHANGED');
    await advance(attempt, now, progress.cooldownUntil);
  });
}
