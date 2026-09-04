import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { backupDatabase, closeDb, getDatabase, initDb, LATEST_SCHEMA_VERSION } from '../src/db.js';
import { getTradingAccount } from '../src/trading_repository.js';
import { accountLogCheckpoint } from '../src/trading_account_log_repository.js';
import { historyCheckpoints } from '../src/trading_history_repository.js';
import { captureFxReceipts, persistFxConversion, readFxConversion } from '../src/trading_fx_repository.ts';
import { failScheduledRecovery, reserveScheduledRecovery, scheduledRecoveryDue } from '../src/trading_recovery_schedule_repository.ts';
import { appendCashlegs, cashlegAccount, cashlegFill, cashlegRows } from './fixtures/kraken_cashleg.js';
import { fxReceipt, FX_CONTEXT } from './fixtures/fx_receipts.js';
import { dropRecoveryScheduleSchema } from './fixtures/fx_schema.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-schedule-migration-'));
const originalTables = ['trading_accounts', 'trading_orders', 'trading_fills', 'trading_money_events',
  'trading_money_valuations', 'trading_accounting_projections', 'trading_account_log_checkpoints',
  'trading_account_log_receipts', 'trading_account_log_records', 'trading_account_log_consumers',
  'trading_history_checkpoints', 'trading_fx_receipts', 'trading_fx_conversions', 'trading_fx_conversion_receipts'];
async function originals(database) {
  const result = {};
  for (const table of originalTables) {
    const columns = table === 'trading_accounting_projections'
      ? 'intent_id,account_id,evidence_hash,status,reason,reporting_currency,realized_pnl,updated_at' : '*';
    result[table] = await database.all(`SELECT ${columns} FROM ${table} ORDER BY rowid`);
  }
  result.migrations = await database.all('SELECT * FROM schema_migrations WHERE version<=43 ORDER BY version');
  return result;
}
async function schema(database) {
  return database.all('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name');
}
async function scheduleRows() {
  return { schedules: await getDatabase().all('SELECT * FROM trading_recovery_schedules ORDER BY id'),
    attempts: await getDatabase().all('SELECT * FROM trading_recovery_schedule_attempts ORDER BY id') };
}
async function assertVersion(version, database = getDatabase()) {
  assert.equal((await database.get('SELECT MAX(version) n FROM schema_migrations')).n, version);
  assert.deepEqual(await database.all('PRAGMA foreign_key_check'), []);
}
async function schema43(filename) {
  await initDb(filename);
  const cashleg = await cashlegFill(await cashlegAccount('schedule-original-money'), { feeAsset: 'USD' });
  await appendCashlegs(cashleg, cashlegRows(cashleg));
  const at = Date.now() - 1000;
  await getDatabase().run(`INSERT INTO trading_accounts(id,name,exchange,mode,status,enabled,credential_ref,
    external_account_id,credential_generation,capabilities_json,last_verified_at,created_at,updated_at)
    VALUES ('schedule-migration','Schedule','bybit','testnet','ready',1,'fixture',?,?,?,?,?,?)`,
  ['a'.repeat(64), 'b'.repeat(64), JSON.stringify({ executionProfileHash: FX_CONTEXT.profileHash, profileVersion: 1,
    executionCapabilities: { provider_api_version: 'bybit-v5' } }), at - 2000, at - 3000, at]);
  const account = await getTradingAccount('schedule-migration');
  const recovery = { since: at - 2000, orders: [], readAccountMode: true,
    accountLogs: await accountLogCheckpoint(account), history: await historyCheckpoints(account, at - 2000) };
  await captureFxReceipts(account, ['usd', 'usdt', 'usdc'].map(kind => fxReceipt(kind, at)),
    { startedAt: at - 20, completedAt: at + 20 });
  const conversion = await persistFxConversion(account, 'USDT', 'USD', at);
  await getDatabase().exec(dropRecoveryScheduleSchema);
  await assertVersion(43);
  assert.deepEqual(await getDatabase().all("SELECT name FROM sqlite_master WHERE name LIKE 'trading_recovery_schedule%'"), []);
  const before = await originals(getDatabase());
  for (const table of originalTables) assert.ok(before[table].length > 0, `${table} must contain real preserved fixture evidence.`);
  return { account, recovery, conversion, before };
}
async function assertUpgraded(before) {
  await assertVersion(LATEST_SCHEMA_VERSION);
  assert.deepEqual(await originals(getDatabase()), before, 'M44 must not rewrite any original evidence, money, quote or source cursor.');
  assert.deepEqual(await scheduleRows(), { schedules: [], attempts: [] }, 'Migration cannot invent past reads or scheduler progress.');
}
async function assertRestoredReservations(fixture, saved, reserved, failedId, at) {
  assert.deepEqual(await scheduleRows(), saved, 'Backup restore preserves original requests, unknown calls, leases and phase rotation.');
  assert.deepEqual(await originals(getDatabase()), fixture.before);
  assert.deepEqual(await readFxConversion(fixture.account, fixture.conversion.id), fixture.conversion);
  await assert.rejects(getDatabase().run("UPDATE trading_recovery_schedule_attempts SET request_json='{}' WHERE id=?",
    [reserved.recoverySchedule.attemptId]), /reservation is immutable/);
  await assert.rejects(getDatabase().run('UPDATE trading_recovery_schedule_attempts SET calls=0 WHERE id=?', [failedId]), /Completed recovery attempt is immutable/);
  await assert.rejects(getDatabase().run('DELETE FROM trading_recovery_schedule_attempts WHERE id=?', [failedId]), /must be retained/);
  assert.equal(await scheduledRecoveryDue(fixture.account, at + 2002), false);
  const deferred = await reserveScheduledRecovery(fixture.account, fixture.recovery, at + 2002);
  assert.ok(deferred.recoverySchedule.grants.every(grant => grant.maxCalls === 0), 'Restoring an unexpired lease cannot start overlapping extra reads.');
  assert.deepEqual((await scheduleRows()).schedules, saved.schedules);
  assert.deepEqual(await originals(getDatabase()), fixture.before);
  await assertVersion(LATEST_SCHEMA_VERSION);
}
async function upgradeAndBackup() {
  const filename = path.join(directory, 'upgrade.db');
  const fixture = await schema43(filename);
  const oldBackup = path.join(directory, 'schema43-backup.db');
  await backupDatabase(oldBackup);
  await closeDb(); await initDb(filename);
  await assertUpgraded(fixture.before);
  const at = Date.now() - 3000;
  const failed = await reserveScheduledRecovery(fixture.account, fixture.recovery, at);
  await failScheduledRecovery(fixture.account, failed.recoverySchedule.attemptId, 'transport_unresolved', at + 1);
  const reserved = await reserveScheduledRecovery(fixture.account, fixture.recovery, at + 2001);
  const saved = await scheduleRows();
  assert.deepEqual(saved.schedules.map(row => [row.phase, row.revision, row.fx_rotation]), [[1, 1, 1]]);
  assert.deepEqual(saved.attempts.find(row => row.id === failed.recoverySchedule.attemptId).calls, null);
  const snapshot = path.join(directory, 'current-schema-backup.db');
  await backupDatabase(snapshot); await closeDb(); await initDb(snapshot);
  await assertRestoredReservations(fixture, saved, reserved, failed.recoverySchedule.attemptId, at);
  // Restore the genuine older SQLite backup: opening it must migrate once, not fabricate reservations.
  await closeDb(); await initDb(oldBackup);
  await assertUpgraded(fixture.before);
  assert.deepEqual(await readFxConversion(fixture.account, fixture.conversion.id), fixture.conversion);
  await closeDb(); await initDb(oldBackup);
  await assertUpgraded(fixture.before);
  await closeDb();
}
async function rollbackCollision(kind, obstruction, remove) {
  const filename = path.join(directory, `rollback-${kind}.db`);
  const fixture = await schema43(filename);
  await getDatabase().exec(obstruction);
  const beforeSchema = await schema(getDatabase());
  await closeDb();
  await assert.rejects(initDb(filename), error => /already exists/.test(error.cause?.message));
  await closeDb();
  // Raw SQLite is limited to this closed, isolated failed-migration fixture, never an operative DB.
  const database = await open({ filename, driver: sqlite3.Database });
  try {
    await assertVersion(43, database);
    assert.deepEqual(await originals(database), fixture.before);
    assert.deepEqual(await schema(database), beforeSchema, 'Every partial M44 table/index/trigger must roll back, preserving the preexisting obstruction.');
    if (kind === 'table') assert.deepEqual(await database.all('SELECT * FROM trading_recovery_schedule_attempts'), [{ original_marker: 'keep-before-migration' }]);
    await database.exec(remove); // Remove only the named obstruction created by this fixture.
  } finally { await database.close(); }
  await initDb(filename);
  await assertUpgraded(fixture.before);
  await closeDb();
}

try {
  await upgradeAndBackup();
  await rollbackCollision('table', `CREATE TABLE trading_recovery_schedule_attempts(original_marker TEXT);
    INSERT INTO trading_recovery_schedule_attempts VALUES ('keep-before-migration');`, 'DROP TABLE trading_recovery_schedule_attempts');
  await rollbackCollision('last-trigger', `CREATE TRIGGER recovery_attempt_no_delete BEFORE DELETE ON trading_accounts
    BEGIN SELECT RAISE(ABORT,'preexisting isolated fixture trigger'); END;`, 'DROP TRIGGER recovery_attempt_no_delete');
  console.log('Migration44: real schema43 upgrade, original evidence, old/current SQLite backup restore, immutable leases and early/late DDL rollback passed.');
} finally {
  await closeDb();
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  assert.match(path.basename(directory), /^tsx-schedule-migration-/);
  await rm(directory, { recursive: true, force: true });
}
