import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { initDb, closeDb, getDatabase, saveSignal } from '../src/db.js';
import { listTradingStrategies } from '../src/trading_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { recordMoneyEvent } from '../src/trading_money_ledger.js';
import { dropFxSchema } from './fixtures/fx_schema.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'fill-identity-migration-'));
const fillColumns = 'id,order_id,account_id,exchange_fill_id,price,quantity,fee,fee_asset,filled_at,raw_json,account_fingerprint,accounting_json,accounting_conflict';
async function originals(database) {
  return { fills: await database.all(`SELECT ${fillColumns} FROM trading_fills ORDER BY id`), money: await database.all('SELECT * FROM trading_money_events ORDER BY id'),
    valuation: await database.all('SELECT * FROM trading_money_valuations ORDER BY event_id'), conflict: await database.all('SELECT * FROM trading_money_conflicts ORDER BY id'),
    pending: await database.all('SELECT * FROM trading_accounting_pending ORDER BY intent_id') };
}
async function fixture(filename, duplicate) {
  await initDb(filename);
  await seedTradingFixtures();
  const [strategy] = await listTradingStrategies();
  await saveSignal('migration-fill', '-fill', 1, '<signal/>', '<signal/>');
  await getDatabase().run(`INSERT INTO trading_trade_intents(id,source_signal_id,root_source_signal_id,channel_id,strategy_version_id,
    account_id,exchange,mode,symbol,side,status,signal_json,created_at,updated_at)
    VALUES('intent','migration-fill','migration-fill','-fill',?,'paper-default','paper','paper','BTCUSDT','LONG','monitoring','{}',1,1)`, [strategy.id]);
  await getDatabase().run(`INSERT INTO trading_orders(id,intent_id,account_id,client_order_id,exchange_order_id,provider_symbol,
    role,side,order_type,status,quantity,filled_quantity,reduce_only,request_json,created_at,updated_at)
    VALUES('order','intent','paper-default','client','remote-order','BTCUSDT','entry','buy','limit','filled','1','1',0,'{}',1,1)`);
  await getDatabase().run(`INSERT INTO trading_fills(${fillColumns}) VALUES('original-fill','order','paper-default','original-provider-fill',
    '100','1','0.1','USDT',123,'{"preserve":"original raw bytes"}','paper:paper-default',NULL,1)`);
  await closeDb();
  // Raw SQLite is restricted to this newly-created temporary migration fixture.
  const database = await open({ filename, driver: sqlite3.Database });
  try {
    await database.exec('PRAGMA foreign_keys=OFF');
    // Remove later cross-table FX triggers before reconstructing v39 money tables.
    await database.exec(dropFxSchema);
    const triggers = await database.all("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN ('trading_accounting_fill_insert','trading_accounting_fill_update','trading_accounting_valuation_insert','trading_accounting_conflict_insert')");
    for (const trigger of triggers) await database.exec(`DROP TRIGGER ${trigger.name}`);
    await database.exec(`DROP TABLE trading_fill_quantity_evidence;
      DROP TRIGGER trading_kraken_occurrence_insert;
      DROP TABLE trading_kraken_cashleg_evidence;
      DROP TABLE trading_kraken_log_occurrences;
      DROP TABLE trading_order_identity_bindings;
      CREATE TABLE fills_v39(id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES trading_orders(id) ON DELETE RESTRICT,
        account_id TEXT NOT NULL REFERENCES trading_accounts(id) ON DELETE RESTRICT,exchange_fill_id TEXT NOT NULL,
        price TEXT NOT NULL,quantity TEXT NOT NULL,fee TEXT NOT NULL,fee_asset TEXT,filled_at INTEGER NOT NULL,raw_json TEXT NOT NULL,
        account_fingerprint TEXT,accounting_json TEXT,accounting_conflict INTEGER NOT NULL DEFAULT 0,UNIQUE(account_id,exchange_fill_id));
      INSERT INTO fills_v39 SELECT ${fillColumns} FROM trading_fills;
      DROP TABLE trading_fills; ALTER TABLE fills_v39 RENAME TO trading_fills;
      CREATE INDEX idx_trading_fills_order ON trading_fills(order_id,filled_at);
      CREATE TABLE money_v39(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES trading_accounts(id) ON DELETE RESTRICT,
        account_fingerprint TEXT NOT NULL,provider_event_id TEXT NOT NULL,kind TEXT NOT NULL,source TEXT NOT NULL,basis TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,amount TEXT NOT NULL,asset TEXT,intent_id TEXT,fill_id TEXT,content_json TEXT NOT NULL,recorded_at INTEGER NOT NULL,
        UNIQUE(account_id,account_fingerprint,provider_event_id,kind));
      INSERT INTO money_v39 SELECT * FROM trading_money_events;
      DROP TABLE trading_money_events; ALTER TABLE money_v39 RENAME TO trading_money_events;
      CREATE INDEX idx_trading_money_events_window ON trading_money_events(account_id,occurred_at);
      CREATE INDEX idx_money_events_intent ON trading_money_events(intent_id,occurred_at);
      DELETE FROM schema_migrations WHERE version>=40;`);
    for (const trigger of triggers) await database.exec(trigger.sql);
    const event = { accountId: 'paper-default', accountFingerprint: 'paper:paper-default', providerEventId: 'original-provider-fill',
      kind: 'fee', source: 'paper:own-fill-v1', basis: 'fill', occurredAt: 123, amount: '-0.1', asset: 'USDT', intentId: 'intent', fillId: 'original-fill' };
    for (const suffix of duplicate ? ['', '-ambiguous'] : ['']) await database.run(`INSERT INTO trading_money_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [`original-money${suffix}`, event.accountId, event.accountFingerprint, `${event.providerEventId}${suffix}`, event.kind, event.source,
        event.basis, event.occurredAt, event.amount, event.asset, event.intentId, event.fillId, JSON.stringify({ ...event, providerEventId: `${event.providerEventId}${suffix}` }), 456]);
    await database.run("INSERT INTO trading_money_valuations VALUES('original-money','USDT','-0.1','1','native-asset',123,'original-value','{\"original\":true}',456)");
    await database.run("INSERT INTO trading_money_conflicts VALUES('original-conflict','original-money','event','{\"oldContradiction\":true}',456)");
    return { before: await originals(database), event };
  } finally { await database.close(); }
}
try {
  const valid = path.join(directory, 'valid.db');
  const { before, event } = await fixture(valid, false);
  await initDb(valid);
  assert.deepEqual(await originals(getDatabase()), before, 'Migration40 preserves every local ID, original byte string, valuation, conflict and pending revision.');
  assert.equal((await getDatabase().get("SELECT identity_status FROM trading_fills WHERE id='original-fill'")).identity_status, 'legacy_unresolved');
  assert.equal((await recordMoneyEvent({ ...event, source: 'new-transport', providerEventId: 'new-transport-label' })).id, 'original-money');
  assert.deepEqual((await originals(getDatabase())).money, before.money, 'Canonical fill replay preserves the legacy money original and ID.');
  await closeDb(); await initDb(valid);
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  await closeDb();
  const conflict = path.join(directory, 'conflict.db');
  const blocked = await fixture(conflict, true);
  await assert.rejects(initDb(conflict), error => /ambiguous originals/.test(error.cause?.message));
  await closeDb();
  const unchanged = await open({ filename: conflict, driver: sqlite3.Database });
  try {
    assert.deepEqual(await originals(unchanged), blocked.before);
    assert.equal((await unchanged.get('SELECT MAX(version) AS version FROM schema_migrations')).version, 39);
    assert.equal((await unchanged.all('PRAGMA table_info(trading_fills)')).some(row => row.name === 'remote_fill_key'), false);
    assert.deepEqual(await unchanged.all('PRAGMA foreign_key_check'), []);
  } finally { await unchanged.close(); }
  console.log('Migration40: lossless originals, legacy money identity, FK restart and ambiguity rollback passed.');
} finally { await closeDb(); await rm(directory, { recursive: true, force: true }); }
