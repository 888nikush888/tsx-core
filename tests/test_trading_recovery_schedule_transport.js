import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb } from '../src/db.js';
import { CcxtExchangeAdapter } from '../src/ccxt_exchange.js';
import { TradingCredentialStore } from '../src/trading_credentials.js';
import { getTradingAccount } from '../src/trading_repository.js';
import { exchangeRecoveryQuery } from '../src/trading_recovery.js';
import { recordAcquisitionEvidence } from '../src/trading_evidence_repository.js';
import { accountModeDigest } from '../src/trading_account_mode_contract.js';
import { fxReceipt, sealFxReceipt } from './fixtures/fx_receipts.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-schedule-transport-'));
const filename = path.join(directory, 'transport.db');
const profileHash = 'd'.repeat(64), generation = 'c'.repeat(64);
const cases = new Map(), requests = [], serverErrors = [];
const credentials = new TradingCredentialStore(directory);
const originalUrl = process.env.EXCHANGE_EXECUTOR_URL;
const position = { symbol: 'BTCUSDT', providerSymbol: 'BTC/USDT:USDT', side: 'LONG', quantity: '0.1',
  averageEntryPrice: '60000', unrealizedPnl: null };
const legKind = { 'bybit:btc-usd-index:v1': 'usd', 'bybit:btc-usdt-index:v1': 'usdt', 'bybit:usdc-usd-index:v1': 'usdc' };

function modeEvidence(account, now, granted) {
  if (!granted) return { calls: 0, observation: null, reason: 'budget_exhausted' };
  const original = { version: 1, profile: 'bybit_uta_v1', accountFingerprint: account.expectedAccountFingerprint,
    credentialGeneration: account.credentialGeneration, providerAccountUid: '4242', parentAccountUid: '42', isMaster: false,
    unifiedMarginStatus: 5, accountUpdatedAt: 0, startedAt: now, completedAt: now };
  return { calls: 2, observation: { ...original, evidenceHash: accountModeDigest(original) }, reason: null };
}
function fxEvidence(recovery, now, partial) {
  const receipts = recovery.fxEvidence.legIds.map(leg => fxReceipt(legKind[leg], now,
    { profileHash, startedAt: now, completedAt: now }));
  return { version: 1, calls: partial ? 2 : receipts.length, receipts: partial ? receipts.slice(0, 1) : receipts,
    reason: partial ? 'invalid_evidence' : null, nextReadAt: 0 };
}
function scheduledReply(payload, control, now) {
  const recovery = payload.recovery, schedule = recovery.recoverySchedule;
  const grant = lane => schedule.grants.find(row => row.lane === lane).maxCalls;
  const acquisition = baseAcquisition(recovery, now);
  if (recovery.readAccountMode) acquisition.accountMode = modeEvidence(payload.account, now, grant('mode'));
  if (recovery.accountLogs) acquisition.accountLogs = { baseRevision: recovery.accountLogs.revision,
    calls: 0, receipts: [], checkpoint: structuredClone(recovery.accountLogs), readSkipped: 'budget_exhausted' };
  acquisition.history = recovery.history.map(checkpoint => ({ baseRevision: checkpoint.revision, pages: 1,
    checkpoint: { ...checkpoint, revision: checkpoint.revision + 1, reason: 'history_pending' } }));
  if (recovery.fxEvidence) acquisition.fxEvidence = fxEvidence(recovery, now, control.partialFx);
  const calls = { targeted: 0, mode: acquisition.accountMode?.calls ?? 0, logs: 0,
    history: acquisition.history.length, fx: acquisition.fxEvidence?.calls ?? 0 };
  const reasons = { targeted: null, mode: acquisition.accountMode?.reason ?? null, logs: 'budget_exhausted',
    history: null, fx: acquisition.fxEvidence?.reason ?? null };
  acquisition.recoverySchedule = { version: 1, profile: schedule.profile, attemptId: schedule.attemptId,
    baseRevision: schedule.revision, phase: schedule.phase, binding: structuredClone(schedule.binding),
    calls: Object.values(calls).reduce((sum, count) => sum + count, 0), cooldownUntil: schedule.cooldownUntil,
    lanes: schedule.grants.map(row => ({ lane: row.lane, calls: calls[row.lane],
      reason: row.maxCalls ? reasons[row.lane] : row.deferredReason })) };
  return acquisition;
}
function baseAcquisition(recovery, now) {
  return { version: 1, startedAt: now, completedAt: now, targetedCalls: 0,
    sources: ['positions', 'orders', 'targeted_orders', 'fills'].map(source => ({ source, startedAt: now, completedAt: now,
      completeness: 'unknown', reason: 'fixture_pending', since: null })),
    checkedOrders: recovery.orders.map(order => ({ clientOrderId: order.clientOrderId, status: 'budget_exhausted' })), history: [] };
}
function legacyReply(payload, now) {
  const recovery = payload.recovery, acquisition = baseAcquisition(recovery, now);
  if (recovery.readAccountMode) acquisition.accountMode = modeEvidence(payload.account, now, false);
  if (recovery.accountLogs) acquisition.accountLogs = { baseRevision: recovery.accountLogs.revision, calls: 0, receipts: [],
    checkpoint: { ...recovery.accountLogs, revision: recovery.accountLogs.revision + 1, reason: 'budget_exhausted' } };
  acquisition.history = recovery.history.map(checkpoint => ({ baseRevision: checkpoint.revision, pages: 0,
    checkpoint: { ...checkpoint, revision: checkpoint.revision + 1, reason: 'history_budget_exhausted' } }));
  return acquisition;
}
function reply(payload, control) {
  const now = Date.now();
  return { orders: [], positions: control.position ? [structuredClone(position)] : [], fills: [], observedAt: now,
    accountFingerprint: control.fingerprint,
    acquisition: payload.recovery.recoverySchedule ? scheduledReply(payload, control, now) : legacyReply(payload, now) };
}
const server = http.createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8'); request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    try {
      const payload = JSON.parse(body), control = cases.get(payload.account.id);
      assert.equal(request.url, '/v1/open-state'); assert.ok(control, 'Only this test owns accounts on this loopback executor.');
      const received = { payload, authorization: request.headers.authorization, receivedAt: Date.now() };
      requests.push(received);
      if (control.hang) return;
      response.setHeader('Content-Type', 'application/json');
      if (control.status) { response.statusCode = control.status; response.end(JSON.stringify({ error: 'fixture unavailable' })); return; }
      const value = reply(payload, control);
      control.mutate?.(value, payload);
      received.reply = structuredClone(value);
      response.end(JSON.stringify(value));
    } catch (error) {
      serverErrors.push(error); response.statusCode = 500; response.end(JSON.stringify({ error: error.message }));
    }
  });
});

async function setup(id, options = {}) {
  const at = Date.now() - 1000, fingerprint = createHash('sha256').update(id).digest('hex');
  const capabilities = options.capabilities === undefined ? { profileVersion: 1, executionProfileHash: profileHash,
    executionCapabilities: { provider_api_version: 'bybit-v5' } } : options.capabilities;
  await getDatabase().run(`INSERT INTO trading_accounts(id,name,exchange,mode,status,enabled,credential_ref,
    external_account_id,credential_generation,capabilities_json,last_verified_at,created_at,updated_at)
    VALUES (?,?,?,'testnet','ready',1,'local-fixture',?,?,?,?,?,?)`, [id, id, options.exchange ?? 'bybit',
    fingerprint, generation, capabilities === null ? null : JSON.stringify(capabilities), options.verified === false ? null : at,
    at - 1000, at]);
  const account = await getTradingAccount(id);
  cases.set(id, { fingerprint, ...options });
  return { account, adapter: new CcxtExchangeAdapter(account.exchange, credentials), control: cases.get(id) };
}
async function count(table, accountId) {
  assert.ok(['trading_fx_receipts', 'trading_acquisition_evidence', 'trading_recovery_schedule_attempts',
    'trading_account_mode_observations'].includes(table));
  return (await getDatabase().get(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id=?`, [accountId])).n;
}
async function attempt(id) { return getDatabase().get('SELECT * FROM trading_recovery_schedule_attempts WHERE id=?', [id]); }
async function schedule(accountId) { return getDatabase().get('SELECT * FROM trading_recovery_schedules WHERE account_id=?', [accountId]); }
async function sources(accountId) {
  return { history: await getDatabase().all('SELECT * FROM trading_history_checkpoints WHERE account_id=? ORDER BY source,provider_symbol', [accountId]),
    logs: await getDatabase().all('SELECT * FROM trading_account_log_checkpoints WHERE account_id=?', [accountId]) };
}
function lastRequest(accountId) { return requests.filter(row => row.payload.account.id === accountId).at(-1); }
async function makeFixtureDue(accountId) {
  // Fixture clock readiness only: source revisions/cursors are never altered to manufacture evidence.
  await getDatabase().run('UPDATE trading_recovery_schedules SET next_due_at=0 WHERE account_id=?', [accountId]);
}
function assertBoundRequest(received, account, token) {
  const payload = received.payload, bound = payload.recovery.recoverySchedule.binding;
  assert.equal(received.authorization, `Bearer ${token}`);
  assert.equal(payload.account.id, account.id); assert.equal(payload.account.expectedAccountFingerprint, account.externalAccountId);
  assert.equal(payload.account.credentialGeneration, generation);
  assert.deepEqual(bound, { accountId: account.id, accountFingerprint: account.externalAccountId,
    credentialGeneration: generation, mode: account.mode, executionProfileHash: profileHash });
  assert.ok(payload.deadlineAt > received.receivedAt && payload.deadlineAt <= received.receivedAt + 35000);
  assert.doesNotMatch(JSON.stringify(payload), /apiSecret|privateKey|walletAddress/);
}

async function testReservedUntilAtomicCommit(token) {
  const { account, adapter, control } = await setup('phase-cycle');
  const first = await adapter.openState(account), received = lastRequest(account.id);
  assert.ok(first.acquisition.recoverySchedule, 'Verified Bybit openState must send and retain its reserved schedule.');
  assertBoundRequest(received, account, token);
  assert.equal(received.payload.recovery.recoverySchedule.phase, 0);
  assert.equal(received.payload.recovery.accountLogs, undefined, 'Phase 0 FX remains single-attempt even without account logs.');
  assert.equal(first.acquisition.fxEvidence.receipts.length, 3);
  const id = first.acquisition.recoverySchedule.attemptId;
  assert.equal((await attempt(id)).status, 'reserved'); assert.equal((await attempt(id)).calls, null);
  assert.equal(await count('trading_fx_receipts', account.id), 0);
  assert.equal(await count('trading_acquisition_evidence', account.id), 0);
  await closeDb(); await initDb(filename);
  assert.equal((await attempt(id)).status, 'reserved', 'An HTTP success is not a durable scheduling completion, including across restart.');
  control.position = true;
  const busy = await adapter.openState(account);
  assert.deepEqual(busy.positions, [position]);
  assert.ok(lastRequest(account.id).payload.recovery.recoverySchedule.grants.every(grant => grant.maxCalls === 0));
  await recordAcquisitionEvidence(account, busy.acquisition);
  assert.equal((await schedule(account.id)).phase, 0, 'A reserved all-zero current-state read cannot consume the active phase.');
  await recordAcquisitionEvidence(account, first.acquisition);
  assert.equal((await attempt(id)).status, 'succeeded'); assert.equal((await attempt(id)).calls, 3);
  assert.equal(await count('trading_fx_receipts', account.id), 3);
  assert.equal((await schedule(account.id)).phase, 1);
  const stored = await getDatabase().all('SELECT payload_json FROM trading_fx_receipts WHERE account_id=? ORDER BY leg_id', [account.id]);
  assert.deepEqual(stored.map(row => JSON.parse(row.payload_json)), [...first.acquisition.fxEvidence.receipts].sort((a, b) => a.legId.localeCompare(b.legId)));
  await testNotDueAndPositivePhases(account, adapter, control);
}
async function testNotDueAndPositivePhases(account, adapter, control) {
  const originalLogs = (await sources(account.id)).logs;
  await getDatabase().run('UPDATE trading_recovery_schedules SET next_due_at=? WHERE account_id=?', [Date.now() + 10000, account.id]);
  const before = await schedule(account.id), notDue = await adapter.openState(account);
  assert.deepEqual(notDue.positions, [position]); assert.equal(notDue.acquisition.fxEvidence, undefined);
  assert.ok(lastRequest(account.id).payload.recovery.recoverySchedule.grants.every(grant => grant.maxCalls === 0 && grant.deferredReason === 'not_due'));
  await recordAcquisitionEvidence(account, notDue.acquisition);
  assert.equal((await schedule(account.id)).revision, before.revision);
  for (const phase of [1, 2, 3]) {
    await makeFixtureDue(account.id); control.partialFx = phase === 2;
    const state = await adapter.openState(account), progress = state.acquisition.recoverySchedule;
    assert.equal(progress.phase, phase);
    if (phase === 1) { assert.equal(state.acquisition.history.length, 1); assert.equal(state.acquisition.history[0].pages, 1); }
    if (phase === 2) { assert.equal(state.acquisition.fxEvidence.calls, 2); assert.equal(state.acquisition.fxEvidence.receipts.length, 1); }
    if (phase === 3) { assert.equal(state.acquisition.accountMode.calls, 2); assert.ok(state.acquisition.accountMode.observation); }
    assert.equal((await attempt(progress.attemptId)).status, 'reserved');
    await recordAcquisitionEvidence(account, state.acquisition);
    assert.equal((await attempt(progress.attemptId)).status, 'succeeded');
    assert.equal((await schedule(account.id)).phase, (phase + 1) % 4);
  }
  assert.equal(await count('trading_fx_receipts', account.id), 4, 'The real positive FX prefix is stored despite its later failed leg.');
  assert.equal(await count('trading_account_mode_observations', account.id), 1);
  assert.deepEqual((await sources(account.id)).logs, originalLogs, 'Scheduled zero-call log fragments preserve their exact original checkpoints.');
}

async function assertFailedRead(fixture, expectedError) {
  const { account, adapter } = fixture;
  await exchangeRecoveryQuery(account);
  const before = await sources(account.id), beforeRequests = requests.length;
  await assert.rejects(adapter.openState(account), expectedError);
  assert.equal(requests.length - beforeRequests, 1, 'A scheduled read has exactly one HTTP attempt, even without accountLogs.');
  const sent = lastRequest(account.id).payload.recovery;
  assert.equal(sent.accountLogs, undefined);
  const failed = await attempt(sent.recoverySchedule.attemptId);
  assert.equal(failed.status, 'failed'); assert.equal(failed.calls, null, 'An invalid or lost response never proves zero provider calls.');
  assert.equal(failed.response_json, null);
  assert.equal((await schedule(account.id)).phase, 1, 'Only scheduling opportunities advance after failure.');
  assert.deepEqual(await sources(account.id), before, 'Failure must not advance a provider cursor, revision or coverage.');
  assert.equal(await count('trading_fx_receipts', account.id), 0);
  assert.equal(await count('trading_acquisition_evidence', account.id), 0);
}
async function testMalformedResponses() {
  for (const [id, mutate] of [
    ['wrong-binding', body => { body.acquisition.recoverySchedule.binding.credentialGeneration = 'e'.repeat(64); }],
    ['wrong-profile', body => { body.acquisition.fxEvidence.receipts[0] = sealFxReceipt({
      ...body.acquisition.fxEvidence.receipts[0], profileHash: 'e'.repeat(64) }); }],
    ['wrong-calls', body => { body.acquisition.recoverySchedule.calls = 2; }],
    ['wrong-attempt', body => { body.acquisition.recoverySchedule.attemptId = '12345678-1234-4123-8123-123456789abc'; }],
    ['missing-schedule', body => { delete body.acquisition.recoverySchedule; }],
    ['wrong-fingerprint', body => { body.accountFingerprint = 'e'.repeat(64); }],
  ]) {
    await assertFailedRead(await setup(id, { mutate }), /RECOVERY_SCHEDULE|FX_|identity|fingerprint|acquisition/i);
  }
}
async function testSingleAttemptHttpAndTimeout() {
  await assertFailedRead(await setup('http-502', { status: 502 }), /502/);
  const fixture = await setup('http-timeout', { hang: true });
  const nativeTimeout = AbortSignal.timeout, requestedTimeouts = [];
  // Exercise the real fetch/loopback abort path, accelerating only this test's clock alarm.
  AbortSignal.timeout = milliseconds => { requestedTimeouts.push(milliseconds); return nativeTimeout(200); };
  try {
    await assertFailedRead(fixture, /abort|timeout|timed out/i);
  } finally { AbortSignal.timeout = nativeTimeout; }
  assert.equal(requestedTimeouts.length, 1);
  assert.ok(requestedTimeouts[0] > 200 && requestedTimeouts[0] <= 30000,
    'The adapter retains its real bounded deadline; only the injected alarm is shortened.');
}
async function testActualResponseAtomicRollback() {
  const { account, adapter } = await setup('transport-rollback');
  const state = await adapter.openState(account), id = state.acquisition.recoverySchedule.attemptId;
  const before = await sources(account.id);
  await getDatabase().exec(`CREATE TRIGGER fail_transport_schedule_commit BEFORE UPDATE ON trading_recovery_schedule_attempts
    WHEN NEW.account_id='transport-rollback' AND NEW.status='succeeded'
    BEGIN SELECT RAISE(ABORT,'fixture atomic commit failure'); END;`);
  try {
    await assert.rejects(recordAcquisitionEvidence(account, state.acquisition), /fixture atomic commit failure/);
    assert.equal(await count('trading_fx_receipts', account.id), 0);
    assert.equal(await count('trading_acquisition_evidence', account.id), 0);
    assert.equal((await attempt(id)).status, 'reserved');
    assert.equal((await schedule(account.id)).revision, 0);
    assert.deepEqual(await sources(account.id), before);
  } finally { await getDatabase().exec('DROP TRIGGER fail_transport_schedule_commit'); }
  await recordAcquisitionEvidence(account, state.acquisition);
  assert.equal((await attempt(id)).status, 'succeeded');
  assert.equal(await count('trading_fx_receipts', account.id), 3);
}
async function testLegacyAndDatabaseAuthority() {
  for (const [id, options] of [
    ['not-verified', { verified: false }], ['legacy-profile', { capabilities: null }],
    ['unreviewed-profile', { capabilities: { profileVersion: 2, executionProfileHash: profileHash,
      executionCapabilities: { provider_api_version: 'bybit-v5' } } }],
    ['another-provider', { exchange: 'krakenfutures' }],
  ]) {
    const { account, adapter } = await setup(id, options);
    const state = await adapter.openState(account);
    assert.equal(lastRequest(account.id).payload.recovery.recoverySchedule, undefined);
    assert.equal(state.acquisition.recoverySchedule, undefined); assert.equal(state.acquisition.fxEvidence, undefined);
    assert.equal(await count('trading_recovery_schedule_attempts', account.id), 0);
  }
  for (const [id, change] of [
    ['database-unverified', { last_verified_at: null }],
    ['database-profile-changed', { capabilities_json: JSON.stringify({ profileVersion: 1, executionProfileHash: 'e'.repeat(64),
      executionCapabilities: { provider_api_version: 'bybit-v5' } }) }],
  ]) {
    const { account, adapter } = await setup(id);
    const field = Object.keys(change)[0];
    assert.ok(['last_verified_at', 'capabilities_json'].includes(field));
    await getDatabase().run(`UPDATE trading_accounts SET ${field}=? WHERE id=?`, [change[field], account.id]);
    const before = requests.length;
    await assert.rejects(adapter.openState(account), /FX_|ACCOUNT|PROFILE|binding/i);
    assert.equal(requests.length, before, 'A caller-copied verified account cannot replace the current durable verification binding.');
    assert.equal(await count('trading_recovery_schedule_attempts', account.id), 0);
  }
}

await credentials.initialize();
const token = await credentials.getOrCreateExecutorToken();
await initDb(filename);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  process.env.EXCHANGE_EXECUTOR_URL = `http://127.0.0.1:${server.address().port}`;
  await testReservedUntilAtomicCommit(token);
  await testMalformedResponses();
  await testSingleAttemptHttpAndTimeout();
  await testActualResponseAtomicRollback();
  await testLegacyAndDatabaseAuthority();
  assert.deepEqual(serverErrors, []);
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  console.log('Scheduled recovery transport: bound loopback requests, reserved/atomic originals, phase fragments, malformed replies, one-attempt HTTP/timeout and legacy isolation passed.');
} finally {
  if (originalUrl === undefined) delete process.env.EXCHANGE_EXECUTOR_URL;
  else process.env.EXCHANGE_EXECUTOR_URL = originalUrl;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await closeDb();
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  assert.match(path.basename(directory), /^tsx-schedule-transport-/);
  await rm(directory, { recursive: true, force: true });
}
