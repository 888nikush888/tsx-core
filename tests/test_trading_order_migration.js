import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { closeDb, expectedDatabaseMigrations, getDatabase, initDb, LATEST_SCHEMA_VERSION } from '../src/db.js';
import { completeLegacyIngressFixture } from './fixtures/legacy_ingress_schema.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'trading-identity-migration-'));
const adaptiveTables = ['trading_channel_risk_evaluations', 'workflow_adaptive_risk_evaluations'];
const adaptiveNewColumns = ['realized_pnl_value_json', 'return_percent_value_json', 'reporting_currency',
  'source_hash', 'source_json', 'invalidated_at', 'invalidation_reason'];

async function seedLegacyAdaptiveRisk(database) {
  const stateKey = 'a'.repeat(64), policyHash = 'b'.repeat(64);
  await database.run(`INSERT INTO workflow_adaptive_risk_state
    (state_key, channel_id, account_id, resource_id, current_tier, policy_sha256, updated_at)
    VALUES (?, 'channel', 'account', 'resource', 1, ?, 123)`, stateKey, policyHash);
  const originals = {};
  for (const table of adaptiveTables) {
    const schema = await database.all(`PRAGMA table_info(${table})`);
    assert.equal(schema.find(column => column.name === 'realized_pnl').notnull, 1);
    assert.equal(schema.find(column => column.name === 'return_percent').notnull, 1);
    assert.equal(schema.some(column => adaptiveNewColumns.includes(column.name)), false);
    const identityColumns = table === adaptiveTables[0] ? 'channel_id, policy_version' : 'state_key, policy_sha256';
    const identityValues = table === adaptiveTables[0] ? ['channel', 1] : [stateKey, policyHash];
    await database.run(`INSERT INTO ${table}
      (rowid, id, ${identityColumns}, week_started_at, week_ended_at, closed_trades, wins, losses,
       realized_pnl, starting_equity, return_percent, previous_tier, recommended_tier, applied_tier, action, reason, created_at)
      VALUES (41, 'old-evaluation', ?, ?, 10, 20, 1, 0, 1, '-000.0100', '00100.00', '-0.0100', 1, 0, 0, 'decrease', ?, 21)`,
    ...identityValues, 'original\0reason');
    originals[table] = await database.get(`SELECT rowid, * FROM ${table}`);
  }
  return originals;
}

async function assertLegacyAdaptiveRisk(database, originals, migrated) {
  for (const table of adaptiveTables) {
    const row = await database.get(`SELECT rowid, * FROM ${table}`);
    assert.deepEqual(Object.fromEntries(Object.keys(originals[table]).map(key => [key, row[key]])), originals[table]);
    if (migrated) for (const column of adaptiveNewColumns) assert.equal(row[column], null);
    else assert.deepEqual(row, originals[table]);
  }
}

async function legacyFixture(filename, duplicate) {
  const db = await open({ filename, driver: sqlite3.Database });
  try {
    await db.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, checksum TEXT, applied_at INTEGER);
      CREATE TABLE trading_accounts (id TEXT PRIMARY KEY, exchange TEXT);
      CREATE TABLE trading_trade_intents (id TEXT PRIMARY KEY, status TEXT);
      CREATE TABLE trading_orders (id TEXT PRIMARY KEY, account_id TEXT, exchange_order_id TEXT, response_json TEXT, role TEXT NOT NULL DEFAULT 'entry');
      CREATE TABLE trading_positions (id TEXT PRIMARY KEY, account_id TEXT, status TEXT, updated_at INTEGER);
      INSERT INTO trading_accounts VALUES ('account', 'bybit');
      INSERT INTO trading_positions VALUES ('legacy-emergency', 'account', 'emergency', 123);
    `);
    for (const migration of expectedDatabaseMigrations().filter(item => item.version < 25)) {
      await db.run('INSERT INTO schema_migrations VALUES (?, ?, ?, 1)', migration.version, migration.name, migration.checksum);
    }
    for (const [id, symbol] of [['first', 'BTC/USDT:USDT'], ['second', duplicate ? 'BTC/USDT:USDT' : 'ETH/USDT:USDT']]) {
      await db.run('INSERT INTO trading_orders (id, account_id, exchange_order_id, response_json) VALUES (?, ?, ?, ?)', id, 'account', 'remote', JSON.stringify({ symbol }));
    }
    await db.run('INSERT INTO trading_orders (id, account_id, exchange_order_id, response_json) VALUES (?, ?, ?, ?)', 'unprovable', 'account', 'different', 'not-json');
    await completeLegacyIngressFixture(db);
    return await seedLegacyAdaptiveRisk(db);
  } finally { await db.close(); }
}
try {
  const conflictFile = path.join(directory, 'conflict.db');
  const conflictOriginals = await legacyFixture(conflictFile, true);
  await assert.rejects(initDb(conflictFile), error => {
    assert.match(error.cause?.message || '', /conflicting local rows/);
    for (const id of ['first', 'second']) assert.ok(error.cause.message.includes(id));
    return true;
  });
  await closeDb();
  const unchanged = await open({ filename: conflictFile, driver: sqlite3.Database });
  try {
    assert.equal((await unchanged.get('SELECT COUNT(*) AS count FROM trading_orders')).count, 3);
    assert.equal((await unchanged.get('SELECT MAX(version) AS version FROM schema_migrations')).version, 24);
    assert.equal((await unchanged.all('PRAGMA table_info(trading_orders)')).some(column => column.name === 'remote_order_key'), false);
    await assertLegacyAdaptiveRisk(unchanged, conflictOriginals, false);
  } finally { await unchanged.close(); }
  const validFile = path.join(directory, 'valid.db');
  const validOriginals = await legacyFixture(validFile, false);
  await initDb(validFile);
  assert.equal((await getDatabase().get('SELECT MAX(version) AS version FROM schema_migrations')).version, LATEST_SCHEMA_VERSION);
  await assertLegacyAdaptiveRisk(getDatabase(), validOriginals, true);
  const before = await getDatabase().all('SELECT * FROM trading_orders ORDER BY id');
  assert.equal((await getDatabase().get("SELECT emergency_requested_at FROM trading_positions WHERE id = 'legacy-emergency'")).emergency_requested_at, 123);
  assert.notEqual(before[0].remote_order_key, before[1].remote_order_key);
  assert.equal(before[2].remote_order_key, null, 'Malformed legacy raw evidence is preserved without invented identity.');
  await closeDb();
  await initDb(validFile);
  assert.deepEqual(await getDatabase().all('SELECT * FROM trading_orders ORDER BY id'), before);
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  await assertLegacyAdaptiveRisk(getDatabase(), validOriginals, true);
  console.log('Remote identity migration conflict, rollback and repeatability tests passed.');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
