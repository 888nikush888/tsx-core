import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, withDatabaseTransaction } from '../src/db.js';
import { getTradingAccount } from '../src/trading_repository.js';
import { accountLogCheckpoint } from '../src/trading_account_log_repository.js';
import { historyCheckpoints } from '../src/trading_history_repository.js';
import { reserveScheduledRecovery, failScheduledRecovery, scheduledRecoveryDue } from '../src/trading_recovery_schedule_repository.ts';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-recovery-schedule-'));
const filename = path.join(directory, 'schedule.db');
const initial = Date.now() - 1000000;
async function state() { return getDatabase().get('SELECT * FROM trading_recovery_schedules'); }
async function sourceState() {
  return { history: await getDatabase().all('SELECT * FROM trading_history_checkpoints ORDER BY source'),
    logs: await getDatabase().all('SELECT * FROM trading_account_log_checkpoints') };
}
const positive = request => request.recoverySchedule.grants.filter(grant => grant.maxCalls > 0);
try {
  await initDb(filename);
  await getDatabase().run(`INSERT INTO trading_accounts (id,name,exchange,mode,status,enabled,credential_ref,
    external_account_id,credential_generation,capabilities_json,last_verified_at,created_at,updated_at)
    VALUES ('schedule','schedule','bybit','testnet','ready',1,'fixture',?,?,?,?,?,?)`, ['a'.repeat(64), 'b'.repeat(64),
  JSON.stringify({ executionProfileHash: 'c'.repeat(64), profileVersion: 1,
    executionCapabilities: { provider_api_version: 'bybit-v5' } }), initial - 1000, initial - 2000, initial]);
  const account = await getTradingAccount('schedule');
  const recovery = { since: initial - 1000, orders: [{ clientOrderId: 'client', exchangeOrderId: 'remote',
    providerSymbol: 'BTC/USDT:USDT', symbol: 'BTCUSDT', role: 'entry' }], readAccountMode: true,
  accountLogs: await accountLogCheckpoint(account), history: await historyCheckpoints(account, initial - 1000) };
  const originals = await sourceState();
  assert.equal(await scheduledRecoveryDue(account, initial), true);
  const first = await reserveScheduledRecovery(account, recovery, initial);
  assert.deepEqual(positive(first).map(row => [row.lane, row.maxCalls]), [['fx', 3], ['targeted', 2]]);
  assert.equal(await scheduledRecoveryDue(account, initial + 1000), false);
  const deferred = await reserveScheduledRecovery(account, recovery, initial + 1000);
  assert.deepEqual(positive(deferred), []);
  await failScheduledRecovery(account, deferred.recoverySchedule.attemptId, 'transport_unresolved', initial + 1001);
  assert.equal((await state()).phase, 0, 'An explicitly deferred current-state read never skips the next scheduled phase.');
  await failScheduledRecovery(account, first.recoverySchedule.attemptId, 'transport_unresolved', initial + 1010);
  assert.equal((await state()).phase, 1);
  const one = await reserveScheduledRecovery(account, recovery, initial + 3010);
  assert.deepEqual(positive(one).map(row => [row.lane, row.maxCalls]), [['history', 4], ['logs', 1]]);
  assert.equal(one.history.length, 1);
  const historyFirst = one.history[0].source;
  await failScheduledRecovery(account, one.recoverySchedule.attemptId, 'contract_invalid', initial + 3020);
  const two = await reserveScheduledRecovery(account, recovery, initial + 5020);
  assert.deepEqual(positive(two).map(row => [row.lane, row.maxCalls]), [['targeted', 2], ['fx', 3]]);
  assert.notDeepEqual(two.fxEvidence.legIds, first.fxEvidence.legIds, 'A bad first FX leg cannot permanently starve the other legs.');
  await failScheduledRecovery(account, two.recoverySchedule.attemptId, 'read_failed', initial + 5030);
  const three = await reserveScheduledRecovery(account, recovery, initial + 7030);
  assert.deepEqual(positive(three).map(row => [row.lane, row.maxCalls]), [['mode', 2], ['logs', 1], ['targeted', 2]]);
  await failScheduledRecovery(account, three.recoverySchedule.attemptId, 'read_failed', initial + 7040);
  const four = await reserveScheduledRecovery(account, recovery, initial + 9040);
  await failScheduledRecovery(account, four.recoverySchedule.attemptId, 'read_failed', initial + 9050);
  const five = await reserveScheduledRecovery(account, recovery, initial + 11050);
  assert.notEqual(five.history[0].source, historyFirst, 'Failed history attempts rotate too, without advancing source coverage.');
  assert.deepEqual(await sourceState(), originals, 'Scheduling alone cannot change a provider cursor, log revision or history proof.');
  await closeDb(); await initDb(filename);
  const stillRunning = await reserveScheduledRecovery(account, recovery, initial + 11051);
  assert.deepEqual(positive(stillRunning), [], 'Restart does not overlap an unexpired read lease.');
  await failScheduledRecovery(account, stillRunning.recoverySchedule.attemptId, 'read_failed', initial + 11052);
  const recovered = await reserveScheduledRecovery(account, recovery, initial + 47000);
  assert.equal(recovered.recoverySchedule.phase, 2, 'An expired unknown attempt advances scheduling only, never blocks all later lanes.');
  const lost = await getDatabase().get('SELECT status,calls,error_code FROM trading_recovery_schedule_attempts WHERE id=?', [five.recoverySchedule.attemptId]);
  assert.deepEqual(lost, { status: 'failed', calls: null, error_code: 'lease_expired' });
  assert.deepEqual(await sourceState(), originals);
  const before = await state();
  await assert.rejects(withDatabaseTransaction(async () => {
    await failScheduledRecovery(account, recovered.recoverySchedule.attemptId, 'read_failed', initial + 47010);
    throw new Error('simulated atomic rollback');
  }), /simulated atomic rollback/);
  assert.deepEqual(await state(), before);
  await assert.rejects(failScheduledRecovery({ ...account, credentialGeneration: 'd'.repeat(64) }, recovered.recoverySchedule.attemptId,
    'read_failed', initial + 47010), /SCHEDULE/);
  assert.equal((await getDatabase().get('SELECT status FROM trading_recovery_schedule_attempts WHERE id=?', [recovered.recoverySchedule.attemptId])).status, 'reserved');
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  console.log('Durable recovery phase/leg/history fairness, deferred reads, unknown calls, restart leases and atomic rollback passed.');
} finally {
  await closeDb(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  await rm(directory, { recursive: true, force: true });
}
