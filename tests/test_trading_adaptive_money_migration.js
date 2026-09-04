import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { backupDatabase, closeDb, getDatabase, initDb, LATEST_SCHEMA_VERSION } from '../src/db.js';
import { dropAdaptiveMoneySchema } from './fixtures/fx_schema.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-adaptive-money-migration-'));
const tables = ['trading_channel_risk_evaluations', 'workflow_adaptive_risk_evaluations'];
const commonColumns = `week_started_at,week_ended_at,closed_trades,wins,losses,realized_pnl,starting_equity,
  return_percent,previous_tier,recommended_tier,applied_tier,action,reason,created_at`;
const identityColumns = ['id,channel_id,policy_version', 'id,state_key,policy_sha256'];
const newColumns = ['realized_pnl_value_json', 'return_percent_value_json', 'reporting_currency',
  'source_hash', 'source_json', 'invalidated_at', 'invalidation_reason'];
const stateKey = 'a'.repeat(64), policy = 'b'.repeat(64);

async function originals(database) {
  const result = {};
  for (const [index, table] of tables.entries()) result[table] = await database.all(
    `SELECT rowid,${identityColumns[index]},${commonColumns},hex(realized_pnl) pnl_bytes,
     hex(return_percent) return_bytes,hex(reason) reason_bytes FROM ${table} ORDER BY rowid`);
  result.accounts = await database.all('SELECT * FROM trading_accounts ORDER BY id');
  result.states = await database.all('SELECT * FROM workflow_adaptive_risk_state ORDER BY state_key');
  result.migrations = await database.all('SELECT * FROM schema_migrations WHERE version<=45 ORDER BY version');
  return result;
}
async function schema(database) {
  return database.all('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name');
}
async function version(expected, database = getDatabase()) {
  assert.equal((await database.get('SELECT MAX(version) n FROM schema_migrations')).n, expected);
  assert.deepEqual(await database.all('PRAGMA foreign_key_check'), []);
  assert.equal((await database.get('PRAGMA integrity_check')).integrity_check, 'ok');
}
async function metadata(database) {
  const result = {};
  for (const table of tables) {
    const indexes = await database.all(`PRAGMA index_list(${table})`);
    result[table] = { columns: await database.all(`PRAGMA table_info(${table})`),
      foreignKeys: await database.all(`PRAGMA foreign_key_list(${table})`), indexes: [] };
    for (const index of indexes) result[table].indexes.push({ ...index,
      columns: await database.all(`PRAGMA index_xinfo(${index.name})`) });
  }
  return result;
}
async function noIncomingDependencies(database) {
  for (const { name } of await database.all("SELECT name FROM sqlite_master WHERE type='table'")) {
    const foreignKeys = await database.all(`PRAGMA foreign_key_list(${JSON.stringify(name)})`);
    assert.deepEqual(foreignKeys.filter(key => tables.includes(key.table)), [], `Unexpected incoming FK in ${name}.`);
  }
  for (const table of tables) assert.deepEqual(await database.all(
    "SELECT name FROM sqlite_master WHERE type IN ('view','trigger') AND sql LIKE ?", [`%${table}%`]), []);
}
async function seedLegacyRows() {
  const database = getDatabase();
  await database.run(`INSERT INTO trading_accounts(id,name,exchange,mode,status,enabled,created_at,updated_at)
    VALUES ('adaptive-migration','Fixture','paper','paper','ready',1,1,1)`);
  await database.run(`INSERT INTO workflow_adaptive_risk_state(state_key,channel_id,account_id,resource_id,
    current_tier,policy_sha256,updated_at) VALUES (?,'original-channel','adaptive-migration','original-resource',1,?,1)`, [stateKey, policy]);
  for (const [index, table] of tables.entries()) {
    for (const [ordinal, pnl, returns] of [[7, '-0.000000000000000001', '-00.000000000000000100'],
      [41, '000123.4500', '+001.234500'], [99, '-0.0000', '0.000000']]) {
      await database.run(`INSERT INTO ${table}(rowid,${identityColumns[index]},${commonColumns})
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [ordinal, `${index}-original-${ordinal}`,
      index === 0 ? 'original-channel' : stateKey, index === 0 ? 3 : policy,
      ordinal, ordinal + 1, 5, 2, 3, pnl, '00010000.0000', returns, 2, 1, 1, 'decrease',
      ` Original reason ${ordinal}: Verlust € / \u0000 retained `, 1234]);
    }
  }
}
async function schema45(filename) {
  await initDb(filename);
  await seedLegacyRows();
  // Before M46 exists this fixture is already schema45; afterwards exercise the shared rewind too.
  if (LATEST_SCHEMA_VERSION >= 46) await getDatabase().exec(dropAdaptiveMoneySchema);
  await version(45);
  await noIncomingDependencies(getDatabase());
  for (const table of tables) {
    await assert.rejects(getDatabase().run(`UPDATE ${table} SET realized_pnl=NULL`), /NOT NULL/);
    await assert.rejects(getDatabase().run(`UPDATE ${table} SET return_percent=NULL`), /NOT NULL/);
  }
  return { before: await originals(getDatabase()), metadata: await metadata(getDatabase()) };
}
async function assertUpgraded(fixture) {
  await version(LATEST_SCHEMA_VERSION);
  assert.deepEqual(await originals(getDatabase()), fixture.before, 'All original text bytes, IDs, sparse rowids, parent rows and migration records survive.');
  const after = await metadata(getDatabase());
  for (const table of tables) {
    const before = fixture.metadata[table];
    assert.deepEqual(after[table].foreignKeys, before.foreignKeys);
    assert.deepEqual(after[table].indexes, before.indexes, 'PK, scoped UNIQUE and descending time indexes are identical.');
    assert.deepEqual(after[table].columns.slice(0, before.columns.length), before.columns.map(column =>
      ['realized_pnl', 'return_percent'].includes(column.name) ? { ...column, notnull: 0 } : column));
    assert.deepEqual(after[table].columns.slice(before.columns.length).map(column =>
      [column.name, column.type, column.notnull, column.dflt_value]), newColumns.map(name =>
      [name, name === 'invalidated_at' ? 'INTEGER' : 'TEXT', 0, null]));
    assert.ok((await getDatabase().all(`SELECT ${newColumns.join(',')} FROM ${table}`))
      .every(row => newColumns.every(column => row[column] === null)));
  }
}
async function oldConstraints() {
  for (const [index, table] of tables.entries()) {
    await assert.rejects(getDatabase().run(`INSERT INTO ${table}(${identityColumns[index]},${commonColumns})
      SELECT 'duplicate-week',${index === 0 ? 'channel_id,policy_version' : 'state_key,policy_sha256'},${commonColumns}
      FROM ${table} LIMIT 1`), /UNIQUE/);
    await assert.rejects(getDatabase().run(`UPDATE ${table} SET action='invented'`), /CHECK/);
    await assert.rejects(getDatabase().run(`UPDATE ${table} SET starting_equity=NULL`), /NOT NULL/);
    await assert.rejects(getDatabase().run(`UPDATE ${table} SET id='same-id'`), /UNIQUE/);
  }
  await assert.rejects(getDatabase().run("UPDATE workflow_adaptive_risk_evaluations SET state_key=?", ['f'.repeat(64)]), /FOREIGN KEY/);
  await assert.rejects(getDatabase().run("UPDATE workflow_adaptive_risk_evaluations SET policy_sha256='short'"), /CHECK/);
  await assert.rejects(getDatabase().run('DELETE FROM workflow_adaptive_risk_state WHERE state_key=?', [stateKey]), /FOREIGN KEY/);
}
async function rejectLossyRewind() {
  const beforeSchema = await schema(getDatabase()), before = await currentRows();
  await assert.rejects(getDatabase().exec(dropAdaptiveMoneySchema), /malformed JSON/);
  assert.deepEqual(await schema(getDatabase()), beforeSchema, 'Lossy rewind fails before any DDL.');
  assert.deepEqual(await currentRows(), before);
  await version(LATEST_SCHEMA_VERSION);
}
async function newValues() {
  const exactLoss = JSON.stringify({ lower: '-0.000000000000000001', upper: '0',
    exact: { numerator: '-1', denominator: '1000000000000000000000000000000000000' },
    decimal: null, precision: 'exact_rational', terms: 1 });
  for (const table of tables) {
    await getDatabase().run(`UPDATE ${table} SET realized_pnl=NULL,return_percent=NULL,
      realized_pnl_value_json=?,return_percent_value_json=?,reporting_currency='USD' WHERE rowid=7`, [exactLoss, exactLoss]);
    const value = await getDatabase().get(`SELECT * FROM ${table} WHERE rowid=7`);
    assert.equal(value.realized_pnl, null); assert.equal(value.return_percent, null);
    assert.equal(value.realized_pnl_value_json, exactLoss); assert.equal(value.return_percent_value_json, exactLoss);
    for (const column of newColumns.slice(0, 2)) {
      for (const invalid of ['{', 'null\u0000', `"${'x'.repeat(16382)}"`, `"${'€'.repeat(5461)}"`]) {
        await assert.rejects(getDatabase().run(`UPDATE ${table} SET ${column}=? WHERE rowid=41`, [invalid]), /CHECK/);
      }
      // SQL guards syntax and bytes only; MoneyValue semantics are the consumer's separate boundary.
      const lastAllowed = `"${'x'.repeat(16381)}"`;
      await getDatabase().run(`UPDATE ${table} SET ${column}=? WHERE rowid=41`, [lastAllowed]);
      assert.equal((await getDatabase().get(`SELECT ${column} value FROM ${table} WHERE rowid=41`)).value, lastAllowed);
      await getDatabase().run(`UPDATE ${table} SET ${column}=NULL WHERE rowid=41`);
    }
    const source = JSON.stringify({ profile: 'isolated-migration-fixture-v1', originalReceiptIds: ['receipt-before-invalidation'] });
    await getDatabase().run(`UPDATE ${table} SET source_hash=?,source_json=?,invalidated_at=1700000000000,
      invalidation_reason='later original quote conflict' WHERE rowid=7`, [createHash('sha256').update(source).digest('hex'), source]);
  }
  await rejectLossyRewind();
}
async function provenanceConstraints() {
  const database = getDatabase(), hash = 'c'.repeat(64);
  for (const table of tables) {
    for (const invalid of [null, 'short', 'f'.repeat(63), 'g'.repeat(64), 'F'.repeat(64), `${hash}\u0000extra`]) {
      await assert.rejects(database.run(`UPDATE ${table} SET source_hash=?,source_json='{}' WHERE rowid=99`, [invalid]), /CHECK/);
    }
    for (const invalid of [null, '{', 'null\u0000', `"${'x'.repeat(262142)}"`, `"${'€'.repeat(87381)}"`]) {
      await assert.rejects(database.run(`UPDATE ${table} SET source_hash=?,source_json=? WHERE rowid=99`, [hash, invalid]), /CHECK/);
    }
    await assert.rejects(database.run(`UPDATE ${table} SET invalidated_at=-1 WHERE rowid=99`), /CHECK/);
    const original = await originals(database);
    const lastAllowed = `"${'x'.repeat(262141)}"`;
    await database.run(`UPDATE ${table} SET source_hash=?,source_json=? WHERE rowid=99`, [hash, lastAllowed]);
    assert.equal((await database.get(`SELECT source_json FROM ${table} WHERE rowid=99`)).source_json, lastAllowed);
    await rejectLossyRewind();
    await database.run(`UPDATE ${table} SET source_hash=NULL,source_json=NULL WHERE rowid=99`);
    for (const update of ["invalidated_at=0", "invalidation_reason='later quote conflict'", "reporting_currency='USD'",
      'realized_pnl=NULL', 'return_percent=NULL']) {
      await database.exec('SAVEPOINT original_adaptive_fixture');
      try {
        await database.run(`UPDATE ${table} SET ${update} WHERE rowid=99`);
        await rejectLossyRewind();
      } finally { await database.exec('ROLLBACK TO original_adaptive_fixture; RELEASE original_adaptive_fixture'); }
    }
    assert.deepEqual(await originals(database), original, 'Metadata probes cannot change original economics.');
  }
}
async function currentRows() {
  const result = {};
  for (const table of tables) result[table] = await getDatabase().all(`SELECT rowid,* FROM ${table} ORDER BY rowid`);
  return result;
}
async function upgradeAndRestore() {
  const filename = path.join(directory, 'upgrade.db'), fixture = await schema45(filename);
  const backup45 = path.join(directory, 'schema45-backup.db'); await backupDatabase(backup45);
  await closeDb(); await initDb(filename);
  await assertUpgraded(fixture); await oldConstraints(); await provenanceConstraints(); await newValues();
  const saved = await currentRows(), current = path.join(directory, 'schema-current-backup.db');
  await backupDatabase(current); await closeDb(); await initDb(current);
  assert.deepEqual(await currentRows(), saved); await oldConstraints(); await rejectLossyRewind();
  await closeDb(); await initDb(current); assert.deepEqual(await currentRows(), saved);
  await closeDb(); await initDb(backup45); await assertUpgraded(fixture);
  await closeDb(); await initDb(backup45); await assertUpgraded(fixture); await closeDb();
}
async function rollback(kind, obstruction, remove) {
  const filename = path.join(directory, `rollback-${kind}.db`), fixture = await schema45(filename);
  await getDatabase().exec(obstruction); const beforeSchema = await schema(getDatabase());
  await closeDb();
  await assert.rejects(initDb(filename), error => /migration 46/.test(error.message) && /already exists/.test(error.cause?.message));
  await closeDb();
  // Raw handle is exclusively this closed, temporary failed-migration fixture.
  const database = await open({ filename, driver: sqlite3.Database });
  try {
    await version(45, database);
    assert.deepEqual(await originals(database), fixture.before);
    assert.deepEqual(await schema(database), beforeSchema, 'Early/late DDL failure rolls back both table copies, drops, renames and indexes.');
    await database.exec(remove); // Only the exact obstruction inserted above.
  } finally { await database.close(); }
  await initDb(filename); await assertUpgraded(fixture); await oldConstraints(); await closeDb();
}

try {
  await upgradeAndRestore();
  for (const table of tables) await rollback(table, `CREATE TABLE ${table}_v46(original_marker TEXT);
    INSERT INTO ${table}_v46 VALUES ('keep-original-obstruction');`, `DROP TABLE ${table}_v46`);
  await rollback('last-index', `DROP INDEX idx_workflow_adaptive_risk_evaluations;
    CREATE INDEX idx_workflow_adaptive_risk_evaluations ON trading_accounts(created_at);`, 'DROP INDEX idx_workflow_adaptive_risk_evaluations');
  console.log('Migration46: byte-preserving nullable adaptive MoneyValues, exact old constraints, bounded JSON, lossless fixture rewind, backup restore and early/middle/late rollback passed.');
} finally {
  await closeDb(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  assert.match(path.basename(directory), /^tsx-adaptive-money-migration-/);
  await rm(directory, { recursive: true, force: true });
}
