import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateRecoveryScheduleRequest, validateRecoveryScheduleInputs,
  validateRecoveryScheduleProgress, validateFxEvidenceProgress,
  parseRecoveryScheduleAcquisitionFields,
} from '../src/trading_recovery_schedule_contract.ts';
import { fxReceipt, FX_CONTEXT, sealFxReceipt } from './fixtures/fx_receipts.js';
import { accountModeDigest } from '../src/trading_account_mode_contract.ts';
import { accountLogSource } from '../src/trading_account_log_contract.ts';

const at = Date.now() - 1000;
const expected = { accountId: 'schedule-account', accountFingerprint: 'b'.repeat(64), credentialGeneration: 'c'.repeat(64),
  mode: FX_CONTEXT.mode, executionProfileHash: FX_CONTEXT.profileHash };
const lanes = ['targeted', 'mode', 'logs', 'history', 'fx'];
const legIds = ['bybit:btc-usd-index:v1', 'bybit:btc-usdt-index:v1', 'bybit:usdc-usd-index:v1'];
const clone = value => structuredClone(value);
const read = { startedAt: at - 100, completedAt: at + 100 };

function fixture() {
  const recoverySchedule = { version: 1, profile: 'bybit-usd-fx-recovery-v1',
    attemptId: '12345678-1234-4123-8123-123456789abc', revision: 7, phase: 0, binding: clone(expected), cooldownUntil: 0,
    grants: lanes.map(lane => ({ lane, maxCalls: lane === 'targeted' ? 2 : lane === 'fx' ? 3 : 0,
      deferredReason: ['targeted', 'fx'].includes(lane) ? null : 'phase_deferred' })) };
  const recovery = { recoverySchedule, history: [], fxEvidence: { version: 1, legIds: [...legIds] } };
  const fxEvidence = { version: 1, calls: 3, receipts: ['usd', 'usdt', 'usdc'].map(kind => fxReceipt(kind, at)), reason: null, nextReadAt: 0 };
  const progress = { version: 1, profile: recoverySchedule.profile, attemptId: recoverySchedule.attemptId,
    baseRevision: 7, phase: 0, binding: clone(expected), calls: 5, cooldownUntil: 0,
    lanes: recoverySchedule.grants.map(row => ({ lane: row.lane, calls: row.maxCalls, reason: row.deferredReason })) };
  return { recovery, progress, acquisition: { ...read, targetedCalls: 2, history: [], fxEvidence } };
}

function check(row, context = expected) {
  return validateRecoveryScheduleProgress(row.progress, row.recovery, row.acquisition, context);
}
function rejectMutation(mutate, validate = check) {
  const row = fixture(); mutate(row);
  assert.throws(() => validate(row), /RECOVERY_SCHEDULE|FX/);
}
function setGrant(row, lane, maxCalls, deferredReason = 'phase_deferred') {
  Object.assign(row.recovery.recoverySchedule.grants.find(item => item.lane === lane),
    { maxCalls, deferredReason: maxCalls ? null : deferredReason });
}
function phaseFixture(phase, allocations) {
  const row = fixture(), schedule = row.recovery.recoverySchedule;
  schedule.phase = phase; row.progress.phase = phase;
  for (const lane of lanes) setGrant(row, lane, allocations[lane] ?? 0);
  row.acquisition.targetedCalls = allocations.targeted ?? 0;
  if (!allocations.fx) { delete row.recovery.fxEvidence; delete row.acquisition.fxEvidence; }
  else {
    row.recovery.fxEvidence.legIds = legIds.slice(0, allocations.fx);
    row.acquisition.fxEvidence.calls = allocations.fx;
    row.acquisition.fxEvidence.receipts = row.acquisition.fxEvidence.receipts.slice(0, allocations.fx);
  }
  if (allocations.mode) {
    row.recovery.readAccountMode = true;
    const original = { version: 1, profile: 'bybit_uta_v1', accountFingerprint: expected.accountFingerprint,
      credentialGeneration: expected.credentialGeneration, providerAccountUid: '4242', parentAccountUid: '42', isMaster: false,
      unifiedMarginStatus: 5, accountUpdatedAt: 0, ...read };
    row.acquisition.accountMode = { calls: 2, observation: { ...original, evidenceHash: accountModeDigest(original) }, reason: null };
  }
  if (allocations.logs) {
    const checkpoint = { version: 1, ...accountLogSource('bybit'), accountFingerprint: expected.accountFingerprint,
      credentialGeneration: expected.credentialGeneration, revision: 4, requiredSince: at - 1000, windowSince: at - 1000,
      windowUntil: null, cursor: null, scannedThrough: null, nextReadAt: 0, lastServedAt: 0, providerAccountUid: null, reason: null };
    row.recovery.accountLogs = checkpoint;
    row.acquisition.accountLogs = { baseRevision: 4, calls: 1, receipts: [], checkpoint: { ...checkpoint, revision: 5 } };
  }
  if (allocations.history) {
    const checkpoint = { source: 'fills', providerSymbol: null, revision: 4, baselineSince: at - 1000, windowSince: at - 1000,
      windowUntil: null, cursor: null, scannedThrough: null, nextReadAt: 0, completeness: 'unknown', reason: null };
    row.recovery.history = [checkpoint];
    row.acquisition.history = [{ baseRevision: 4, pages: allocations.history, checkpoint: { ...checkpoint, revision: 5 } }];
  }
  row.progress.lanes = schedule.grants.map(grant => ({ lane: grant.lane, calls: grant.maxCalls, reason: grant.deferredReason }));
  row.progress.calls = Object.values(allocations).reduce((sum, count) => sum + count, 0);
  return row;
}

function testRequestBoundary() {
  const validate = row => validateRecoveryScheduleInputs(row.recovery, expected);
  for (const delta of [{ version: true }, { version: 2 }, { profile: 'custom' }, { revision: -1 }, { revision: 0.5 },
    { revision: Number.MAX_SAFE_INTEGER + 1 }, { phase: true }, { phase: '0' }, { phase: 4 }, { cooldownUntil: null },
    { cooldownUntil: NaN }, { attemptId: '12345678-1234-4123-8123-123456789ABC' }, { extra: true }]) {
    rejectMutation(row => Object.assign(row.recovery.recoverySchedule, delta), validate);
  }
  for (const id of ['', ' spaced', 'x\u0000', 'x\u0080', '\ud800', 'x'.repeat(257)]) {
    rejectMutation(row => { row.recovery.recoverySchedule.binding.accountId = id; }, validate);
  }
  for (const field of ['accountFingerprint', 'credentialGeneration', 'executionProfileHash']) {
    for (const invalid of ['A'.repeat(64), 'a'.repeat(63), null, true]) {
      rejectMutation(row => { row.recovery.recoverySchedule.binding[field] = invalid; }, validate);
    }
  }
  for (const mutate of [
    row => { row.recovery.recoverySchedule.grants.pop(); },
    row => { row.recovery.recoverySchedule.grants.push(clone(row.recovery.recoverySchedule.grants[0])); },
    row => { row.recovery.recoverySchedule.grants[1].lane = 'targeted'; },
    row => { row.recovery.recoverySchedule.grants[1].lane = 'hidden'; },
    row => { row.recovery.recoverySchedule.grants[0].maxCalls = true; },
    row => { row.recovery.recoverySchedule.grants[0].deferredReason = 'not_due'; },
    row => { row.recovery.recoverySchedule.grants[1].deferredReason = null; },
    row => { row.recovery.recoverySchedule.grants[1].extra = 0; },
    row => { row.recovery.fxEvidence.legIds = [legIds[0], legIds[0], legIds[2]]; },
    row => { row.recovery.fxEvidence.legIds[0] = 'unreviewed-route'; },
    row => { row.recovery.fxEvidence.legIds.pop(); },
    row => { row.recovery.fxEvidence.url = 'https://invalid.example'; },
    row => { delete row.recovery.fxEvidence; },
    row => { delete row.recovery.recoverySchedule; },
    row => { row.recovery.accountLogs = null; },
    row => { row.recovery.history = [{}]; },
    row => { row.recovery.history = null; },
    row => { row.recovery.readAccountMode = 'false'; },
  ]) rejectMutation(mutate, validate);
  for (const lane of lanes) {
    for (const count of [-1, 0.5, 5, Number.MAX_SAFE_INTEGER + 1]) {
      rejectMutation(row => setGrant(row, lane, count), validate);
    }
  }
  for (const phase of [0, 1, 2, 3]) {
    const allowed = phase === 1 ? ['history', 'logs'] : phase === 3 ? ['mode', 'logs', 'targeted'] : ['fx', 'targeted'];
    for (const lane of lanes.filter(item => !allowed.includes(item))) {
      const row = phaseFixture(phase, {}); setGrant(row, lane, { targeted: 2, mode: 2, logs: 1, history: 4, fx: 1 }[lane]);
      assert.throws(() => validate(row), /RECOVERY_SCHEDULE/);
    }
  }
  assert.equal(validateRecoveryScheduleInputs({ history: [] }, expected), undefined);
  assert.equal(validateRecoveryScheduleProgress(undefined, {}, read, expected), undefined);
  assert.throws(() => validateRecoveryScheduleProgress({}, {}, read, expected), /RECOVERY_SCHEDULE/);
  assert.throws(() => validateRecoveryScheduleProgress(undefined, {}, { ...read, fxEvidence: {} }, expected), /RECOVERY_SCHEDULE/);
}

function testEveryPhaseAndOmission() {
  for (const [phase, allocation] of [[0, { targeted: 2, fx: 3 }], [1, { history: 4, logs: 1 }],
    [2, { targeted: 2, fx: 1 }], [3, { mode: 2, logs: 1, targeted: 2 }]]) {
    const row = phaseFixture(phase, allocation);
    assert.deepEqual(check(row), row.progress);
    row.recovery.recoverySchedule.grants.reverse(); row.progress.lanes.reverse();
    assert.deepEqual(check(row), row.progress, 'Grant order is execution order, not a validator-invented reordering.');
  }
  for (const phase of [0, 1, 2, 3]) {
    for (const reason of ['not_due', 'cooldown', 'phase_deferred', 'not_needed']) {
      const row = phaseFixture(phase, {});
      row.recovery.recoverySchedule.grants.forEach(grant => { grant.deferredReason = reason; });
      row.progress.lanes.forEach(lane => { lane.reason = reason; });
      assert.deepEqual(check(row), row.progress, 'Explicit empty protection reads must never enable a legacy read lane.');
      row.recovery.readAccountMode = true;
      row.acquisition.accountMode = { calls: 0, observation: null, reason: 'budget_exhausted' };
      assert.deepEqual(check(row), row.progress);
      for (const delta of [{ calls: 1 }, { observation: {} }, { reason: null }]) {
        const wrong = clone(row); Object.assign(wrong.acquisition.accountMode, delta);
        assert.throws(() => check(wrong), /RECOVERY_SCHEDULE/);
      }
    }
  }
  for (const field of ['accountMode', 'accountLogs', 'fxEvidence']) {
    const absent = phaseFixture(0, {}); absent.acquisition[field] = {};
    assert.throws(() => check(absent), /RECOVERY_SCHEDULE/);
  }
  const unexpectedHistory = phaseFixture(0, {}); unexpectedHistory.acquisition.history = [{}];
  assert.throws(() => check(unexpectedHistory), /RECOVERY_SCHEDULE/);
  for (const [phase, allocation, field] of [[0, { fx: 3 }, 'fxEvidence'], [3, { mode: 2 }, 'accountMode'],
    [1, { logs: 1 }, 'accountLogs'], [1, { history: 4 }, 'history']]) {
    const row = phaseFixture(phase, allocation); delete row.acquisition[field];
    assert.throws(() => check(row), /RECOVERY_SCHEDULE/);
  }
  const noModeRequest = phaseFixture(3, { mode: 2 }); delete noModeRequest.recovery.readAccountMode;
  assert.throws(() => check(noModeRequest), /RECOVERY_SCHEDULE/);
}

function testSourceCountsAndContinuation() {
  for (const [phase, allocation, field] of [[3, { mode: 2 }, 'accountMode'], [1, { logs: 1 }, 'accountLogs']]) {
    const row = phaseFixture(phase, allocation); row.acquisition[field].calls++;
    assert.throws(() => check(row), /RECOVERY_SCHEDULE/);
  }
  for (const delta of [{ baseRevision: 3 }, { pages: 5 }, { pages: true }]) {
    const row = phaseFixture(1, { history: 4 }); Object.assign(row.acquisition.history[0], delta);
    assert.throws(() => check(row), /RECOVERY_SCHEDULE/);
  }
  for (const [field, value] of [['source', 'orders'], ['providerSymbol', 'BTC/USDT:USDT'], ['baselineSince', 1], ['revision', 9]]) {
    const row = phaseFixture(1, { history: 4 }); row.acquisition.history[0].checkpoint[field] = value;
    assert.throws(() => check(row), /RECOVERY_SCHEDULE/);
  }
  for (const field of ['accountFingerprint', 'credentialGeneration', 'filterHash', 'namespace']) {
    const row = phaseFixture(1, { logs: 1 }); row.acquisition.accountLogs.checkpoint[field] = 'd'.repeat(64);
    assert.throws(() => check(row), /RECOVERY_SCHEDULE/);
  }
  for (const field of ['accountFingerprint', 'credentialGeneration']) {
    const row = phaseFixture(3, { mode: 2 }); row.acquisition.accountMode.observation[field] = 'd'.repeat(64);
    assert.throws(() => check(row), /RECOVERY_SCHEDULE/);
  }
  for (const mutate of [
    row => { row.progress.lanes.reverse(); }, row => { row.progress.lanes.pop(); },
    row => { row.progress.lanes[1] = clone(row.progress.lanes[0]); }, row => { row.progress.lanes[0].calls = 3; },
    row => { row.progress.lanes[0].reason = 'not_due'; }, row => { row.progress.lanes[1].reason = 'not_needed'; },
    row => { row.progress.lanes[0].extra = true; }, row => { row.progress.extra = true; },
    row => { row.progress.calls = true; }, row => { row.progress.binding.extra = true; },
    row => { row.acquisition.history = null; },
    row => { row.acquisition.startedAt = read.completedAt + 1; }, row => { row.acquisition.completedAt = read.startedAt + 35001; },
  ]) rejectMutation(mutate);
}

function testFxPartialFailuresAndCooldown() {
  for (const reason of ['budget_exhausted', 'transient', 'unsupported', 'invalid_evidence']) {
    for (const prefix of [0, 1, 2]) {
      for (const consumedFailure of [0, 1]) {
        const row = fixture(), fx = row.acquisition.fxEvidence;
        fx.receipts = fx.receipts.slice(0, prefix); fx.calls = prefix + consumedFailure; fx.reason = reason;
        row.progress.calls = 2 + fx.calls;
        Object.assign(row.progress.lanes[4], { calls: fx.calls, reason });
        assert.deepEqual(check(row), row.progress, 'A successful ordered prefix survives a later bounded failure.');
      }
    }
  }
  for (const mutate of [
    row => { row.acquisition.fxEvidence.calls = 4; },
    row => { row.acquisition.fxEvidence.receipts.pop(); },
    row => { row.acquisition.fxEvidence.reason = 'unsupported'; },
    row => { row.acquisition.fxEvidence.receipts = [row.acquisition.fxEvidence.receipts[1]]; },
    row => { row.acquisition.fxEvidence.receipts = [row.acquisition.fxEvidence.receipts[0], row.acquisition.fxEvidence.receipts[0]]; },
    row => { row.acquisition.fxEvidence.extra = true; },
    row => { row.acquisition.fxEvidence.nextReadAt = -1; },
    row => { row.acquisition.startedAt = at; },
    row => { row.acquisition.completedAt = at; },
  ]) rejectMutation(mutate);
  const row = fixture(), future = Date.now() + 15000;
  row.recovery.recoverySchedule.cooldownUntil = future;
  row.progress.cooldownUntil = future; row.progress.calls = 0; row.acquisition.targetedCalls = 0;
  Object.assign(row.acquisition.fxEvidence, { calls: 0, receipts: [], reason: 'budget_exhausted', nextReadAt: future });
  for (const lane of row.progress.lanes) if (lane.calls) { lane.calls = 0; lane.reason = 'cooldown'; }
  assert.deepEqual(check(row), row.progress, 'Future cooldown is a valid request but not permission for any additional call.');
  const regressed = clone(row); regressed.progress.cooldownUntil--;
  assert.throws(() => check(regressed), /RECOVERY_SCHEDULE/);
  const inflated = clone(row);
  inflated.progress.cooldownUntil = read.completedAt + 86_400_001;
  inflated.acquisition.fxEvidence.nextReadAt = inflated.progress.cooldownUntil;
  assert.throws(() => check(inflated), /RECOVERY_SCHEDULE/);
  const carried = clone(row), oldLongCooldown = read.completedAt + 7 * 86_400_000;
  carried.recovery.recoverySchedule.cooldownUntil = oldLongCooldown;
  carried.progress.cooldownUntil = oldLongCooldown;
  carried.acquisition.fxEvidence.nextReadAt = oldLongCooldown;
  assert.deepEqual(check(carried), carried.progress, 'An existing longer cooldown can be retained but not extended arbitrarily.');
  carried.progress.cooldownUntil++;
  assert.throws(() => check(carried), /RECOVERY_SCHEDULE/);
  const lateFailure = fixture();
  Object.assign(lateFailure.acquisition.fxEvidence, { calls: 2, receipts: [lateFailure.acquisition.fxEvidence.receipts[0]], reason: 'transient', nextReadAt: future });
  Object.assign(lateFailure.progress.lanes[4], { calls: 2, reason: 'transient' });
  Object.assign(lateFailure.progress, { calls: 4, cooldownUntil: future });
  assert.deepEqual(check(lateFailure), lateFailure.progress);
  lateFailure.progress.cooldownUntil = 0;
  assert.throws(() => check(lateFailure), /RECOVERY_SCHEDULE/);
  const spentDuringCooldown = fixture();
  spentDuringCooldown.recovery.recoverySchedule.cooldownUntil = future;
  spentDuringCooldown.progress.cooldownUntil = future;
  assert.throws(() => check(spentDuringCooldown), /RECOVERY_SCHEDULE/);
}

function testSkippedLogOriginalCheckpoint() {
  for (const reason of ['budget_exhausted', 'transient', 'unsupported', 'invalid_evidence']) {
    const row = phaseFixture(1, { logs: 1 });
    row.acquisition.accountLogs = { baseRevision: row.recovery.accountLogs.revision, calls: 0, receipts: [],
      checkpoint: clone(row.recovery.accountLogs), readSkipped: reason };
    Object.assign(row.progress.lanes[2], { calls: 0, reason }); row.progress.calls = 0;
    assert.deepEqual(check(row), row.progress);
    for (const change of [
      value => { value.calls = 1; }, value => { value.receipts = [{}]; }, value => { value.baseRevision++; },
      value => { value.checkpoint.revision++; }, value => { value.checkpoint.cursor = 'skipped-page'; },
      value => { value.checkpoint.reason = reason; }, value => { value.checkpoint.extra = null; }, value => { value.readSkipped = 'not_due'; },
      value => { delete value.readSkipped; value.checkpoint.revision++; },
    ]) {
      const wrong = clone(row); change(wrong.acquisition.accountLogs);
      assert.throws(() => check(wrong), /RECOVERY_SCHEDULE/);
    }
  }
  for (const [phase, allocation, field, sourceReason] of [[1, { logs: 1 }, 'accountLogs', 'transient'],
    [1, { history: 4 }, 'history', 'history_transient']]) {
    const row = phaseFixture(phase, allocation), future = Date.now() + 15000;
    const source = field === 'history' ? row.acquisition.history[0] : row.acquisition[field];
    Object.assign(source.checkpoint, { reason: sourceReason, nextReadAt: future });
    row.progress.lanes.find(lane => lane.lane === (field === 'history' ? 'history' : 'logs')).reason = 'transient';
    row.progress.cooldownUntil = future;
    assert.deepEqual(check(row), row.progress);
    row.progress.cooldownUntil--;
    assert.throws(() => check(row), /RECOVERY_SCHEDULE/);
  }
}

function testStructuralParserIsNotAuthorization() {
  const row = fixture(), fields = { recoverySchedule: row.progress, fxEvidence: row.acquisition.fxEvidence };
  assert.deepEqual(parseRecoveryScheduleAcquisitionFields(fields), fields);
  assert.deepEqual(parseRecoveryScheduleAcquisitionFields({}), {});
  assert.throws(() => parseRecoveryScheduleAcquisitionFields({ fxEvidence: fields.fxEvidence }), /RECOVERY_SCHEDULE/);
  const decoded = parseRecoveryScheduleAcquisitionFields(fields);
  decoded.fxEvidence.receipts[0].value = 'changed';
  assert.notEqual(fields.fxEvidence.receipts[0].value, 'changed', 'Decoding preserves and detaches the retained originals.');
  const foreign = clone(fields); foreign.recoverySchedule.binding.accountId = 'a-different-account';
  assert.deepEqual(parseRecoveryScheduleAcquisitionFields(foreign), foreign, 'Structural parsing cannot select the authorized local account.');
  assert.throws(() => validateRecoveryScheduleProgress(foreign.recoverySchedule, row.recovery, row.acquisition, expected), /RECOVERY_SCHEDULE/);
  for (const mutate of [
    value => { value.recoverySchedule.lanes[0].calls = -1; },
    value => { value.recoverySchedule.lanes[0].calls = 3; },
    value => { value.recoverySchedule.lanes.push(clone(value.recoverySchedule.lanes[0])); },
    value => { value.recoverySchedule.nextPhase = 1; },
    value => { value.fxEvidence.receipts[0].extra = true; },
    value => { value.fxEvidence.calls = 0; },
    value => { value.fxEvidence.nextReadAt = true; },
  ]) {
    const invalid = clone(fields); mutate(invalid);
    assert.throws(() => parseRecoveryScheduleAcquisitionFields(invalid), /RECOVERY_SCHEDULE|FX/);
  }
  for (const bad of [Array(5), Object.assign(clone(row.recovery.recoverySchedule.grants), { extra: true })]) {
    rejectMutation(value => { value.recovery.recoverySchedule.grants = bad; }, value => validateRecoveryScheduleInputs(value.recovery, expected));
  }
}

function testPinnedPythonRoundtrip() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const emitted = spawnSync(process.env.TSX_TEST_PYTHON || 'python', ['-B', path.join(root, 'exchange_executor/tests/recovery_schedule_fixture.py')], {
    cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 512000, windowsHide: true,
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP,
      PYTHONNOUSERSITE: '1', PYTHONIOENCODING: 'utf-8' },
  });
  assert.ifError(emitted.error); assert.equal(emitted.status, 0, emitted.stderr);
  const output = JSON.parse(emitted.stdout);
  assert.ok(output.cases.length >= 6);
  for (const row of output.cases) {
    validateRecoveryScheduleInputs(row.recovery, output.context);
    const decoded = parseRecoveryScheduleAcquisitionFields(row.acquisition);
    assert.deepEqual(decoded.recoverySchedule, row.acquisition.recoverySchedule);
    assert.deepEqual(validateRecoveryScheduleProgress(decoded.recoverySchedule, row.recovery, row.acquisition, output.context), decoded.recoverySchedule);
  }
}

const original = fixture();
assert.deepEqual(validateRecoveryScheduleRequest(original.recovery.recoverySchedule, expected), original.recovery.recoverySchedule);
assert.deepEqual(validateRecoveryScheduleInputs(original.recovery, expected),
  { recoverySchedule: original.recovery.recoverySchedule, fxEvidence: original.recovery.fxEvidence });
assert.deepEqual(check(original), original.progress);
assert.deepEqual(validateFxEvidenceProgress(original.acquisition.fxEvidence, original.recovery.fxEvidence, expected, read), original.acquisition.fxEvidence);
assert.deepEqual(original, fixture(), 'Validation must not rewrite the request, original receipts or response.');

for (const field of ['accountId', 'accountFingerprint', 'credentialGeneration', 'mode', 'executionProfileHash']) {
  const changed = { ...expected, [field]: field === 'mode' ? 'live' : field === 'accountId' ? 'other-account' : 'd'.repeat(64) };
  assert.throws(() => check(original, changed), /RECOVERY_SCHEDULE|FX/);
}
rejectMutation(row => { row.progress.binding.executionProfileHash = 'd'.repeat(64); });
rejectMutation(row => { row.progress.attemptId = '12345678-1234-4123-8123-123456789abd'; });
rejectMutation(row => { row.progress.baseRevision++; });
rejectMutation(row => { row.progress.phase = 2; });
rejectMutation(row => { row.progress.calls = 4; });
rejectMutation(row => { row.acquisition.targetedCalls = 1; });
rejectMutation(row => { delete row.acquisition.targetedCalls; });
rejectMutation(row => { row.acquisition.fxEvidence.receipts.reverse(); });
rejectMutation(row => { row.acquisition.fxEvidence.receipts[0] = sealFxReceipt({ ...row.acquisition.fxEvidence.receipts[0], profileHash: 'd'.repeat(64) }); });
testRequestBoundary();
testEveryPhaseAndOmission();
testSourceCountsAndContinuation();
testFxPartialFailuresAndCooldown();
testSkippedLogOriginalCheckpoint();
testStructuralParserIsNotAuthorization();
testPinnedPythonRoundtrip();

console.log('Recovery schedule binding, exact grants, call accounting and FX-prefix boundary tests passed.');
