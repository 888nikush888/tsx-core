import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { closeDb, getDatabase, initDb, withDatabaseTransaction, pruneOperationalData } from '../src/db.js';
import { projectAccountLogMoney } from '../src/trading_account_log_money.js';
import { valueKrakenCashlegFee, getMoneyEvent } from '../src/trading_money_ledger.js';
import { accountLogCheckpoint } from '../src/trading_account_log_repository.js';
import { cashlegAccount, cashlegFill, cashlegRows, appendCashlegs } from './fixtures/kraken_cashleg.js';
import { dropFxSchema } from './fixtures/fx_schema.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-kraken-cashleg-migration-'));
const filename = path.join(directory, 'test.db');
const now = Date.now();
const drop41 = `${dropFxSchema}
  DROP TABLE trading_fill_quantity_evidence;
  DROP TRIGGER trading_kraken_occurrence_insert; DROP TABLE trading_kraken_cashleg_evidence;
  DROP TABLE trading_kraken_log_occurrences; DELETE FROM schema_migrations WHERE version>=41;`;
async function originals(database) {
  return { fills: await database.all('SELECT * FROM trading_fills ORDER BY id'),
    money: await database.all('SELECT * FROM trading_money_events ORDER BY id'),
    receipts: await database.all('SELECT * FROM trading_account_log_receipts ORDER BY sequence'),
    records: await database.all('SELECT * FROM trading_account_log_records ORDER BY receipt_id,ordinal'),
    valuations: await database.all('SELECT * FROM trading_money_valuations ORDER BY event_id') };
}
async function migrationAndRestart() {
  const trade = await cashlegFill(await cashlegAccount('migration41', now));
  await appendCashlegs(trade, cashlegRows(trade));
  const before = await originals(getDatabase());
  await getDatabase().exec(drop41); await closeDb(); await initDb(filename);
  assert.deepEqual(await originals(getDatabase()), before, 'Migration41 adds references without rewriting original evidence or canonical IDs.');
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS n FROM trading_kraken_log_occurrences')).n, 2);
  await projectAccountLogMoney(trade.account);
  assert.equal((await getMoneyEvent(trade.eventId)).reportingAmount, '-0.01');
  const proof = await getDatabase().get('SELECT * FROM trading_kraken_cashleg_evidence WHERE event_id=?', [trade.eventId]);
  await assert.rejects(getDatabase().run("UPDATE trading_kraken_cashleg_evidence SET proof_json='{}' WHERE event_id=?", [trade.eventId]), /immutable/);
  await assert.rejects(getDatabase().run('DELETE FROM trading_kraken_cashleg_evidence WHERE event_id=?', [trade.eventId]), /retained/);
  await assert.rejects(getDatabase().run("UPDATE trading_kraken_log_occurrences SET execution_uid='fake' WHERE receipt_id=?", [proof.cash_receipt_id]), /immutable/);
  await assert.rejects(getDatabase().run('DELETE FROM trading_account_log_records WHERE receipt_id=?', [proof.cash_receipt_id]), /FOREIGN KEY/);
  await assert.rejects(getDatabase().run('DELETE FROM trading_fills WHERE id=?', [trade.fillId]), /FOREIGN KEY/);
  await closeDb(); await initDb(filename);
  assert.deepEqual(await getDatabase().get('SELECT * FROM trading_kraken_cashleg_evidence WHERE event_id=?', [trade.eventId]), proof);
  const explain = await getDatabase().all('EXPLAIN QUERY PLAN SELECT receipt_id,ordinal FROM trading_kraken_log_occurrences WHERE account_id=? AND account_fingerprint=? AND execution_uid=?',
    [trade.account.id, trade.account.externalAccountId, trade.fill.exchangeFillId]);
  assert.match(JSON.stringify(explain), /idx_kraken_occurrence_execution/, 'Crosspage lookup uses the native identity index.');
  await getDatabase().run("UPDATE trading_trade_intents SET status='completed' WHERE id=?", [trade.intentId]);
  const retained = await originals(getDatabase());
  for (let pass = 0; pass < 2; pass++) await pruneOperationalData(90, 100, now + 92 * 86400000);
  assert.deepEqual(await originals(getDatabase()), retained, 'Operational retention must preserve original cashleg/fill/valuation proofs.');
}
async function proofValuationRollback() {
  const trade = await cashlegFill(await cashlegAccount('rollback41', now));
  const receiptId = await appendCashlegs(trade, cashlegRows(trade));
  const request = { eventId: trade.eventId, cashOccurrence: { receiptId, ordinal: 1 }, positionOccurrence: { receiptId, ordinal: 0 } };
  await getDatabase().exec(`CREATE TRIGGER fail_native_value BEFORE INSERT ON trading_money_valuations
    BEGIN SELECT RAISE(ABORT,'simulated native valuation crash'); END;`);
  await assert.rejects(valueKrakenCashlegFee(request), /simulated native valuation crash/);
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS n FROM trading_kraken_cashleg_evidence WHERE event_id=?', [trade.eventId])).n, 0);
  assert.equal((await getMoneyEvent(trade.eventId)).reportingAmount, null);
  await getDatabase().exec('DROP TRIGGER fail_native_value');
  await withDatabaseTransaction(async () => { await valueKrakenCashlegFee(request); });
  await closeDb(); await initDb(filename); await projectAccountLogMoney(trade.account);
  assert.equal((await getMoneyEvent(trade.eventId)).reportingAmount, '-0.01');
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS n FROM trading_kraken_cashleg_evidence WHERE event_id=?', [trade.eventId])).n, 1);
}
async function producerRollback() {
  const trade = await cashlegFill(await cashlegAccount('producer-rollback41', now));
  const checkpoint = await accountLogCheckpoint(trade.account);
  await getDatabase().exec(`CREATE TRIGGER fail_cash_checkpoint BEFORE UPDATE ON trading_account_log_checkpoints
    WHEN NEW.account_id='producer-rollback41' BEGIN SELECT RAISE(ABORT,'simulated cash cursor crash'); END;`);
  await assert.rejects(appendCashlegs(trade, cashlegRows(trade)), /simulated cash cursor crash/);
  assert.equal((await accountLogCheckpoint(trade.account)).revision, checkpoint.revision);
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS n FROM trading_kraken_log_occurrences WHERE account_id=?', [trade.account.id])).n, 0);
  await getDatabase().exec('DROP TRIGGER fail_cash_checkpoint');
}
async function migrationFailureRollback() {
  await closeDb();
  const failed = path.join(directory, 'blocked.db');
  await initDb(failed);
  const trade = await cashlegFill(await cashlegAccount('blocked41', now));
  await appendCashlegs(trade, cashlegRows(trade));
  await getDatabase().exec(drop41);
  await getDatabase().exec('CREATE TABLE trading_kraken_cashleg_evidence (original_marker TEXT)');
  const before = await originals(getDatabase()); await closeDb();
  await assert.rejects(initDb(failed), error => /already exists/.test(error.cause?.message));
  await closeDb();
  const database = await open({ filename: failed, driver: sqlite3.Database });
  try {
    assert.deepEqual(await originals(database), before);
    assert.equal((await database.get('SELECT MAX(version) AS version FROM schema_migrations')).version, 40);
    assert.equal(await database.get("SELECT name FROM sqlite_master WHERE type='table' AND name='trading_kraken_log_occurrences'"), undefined);
    assert.deepEqual(await database.all('PRAGMA foreign_key_check'), []);
  } finally { await database.close(); }
}
try {
  await initDb(filename);
  await migrationAndRestart(); await proofValuationRollback(); await producerRollback();
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  await migrationFailureRollback();
  console.log('Migration41: lossless original backfill, indexed occurrences, immutable FK proofs, nested transaction/crash/restart and migration rollback passed.');
} finally { await closeDb(); await rm(directory, { recursive: true, force: true }); }
