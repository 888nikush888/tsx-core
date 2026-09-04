import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { backupDatabase, closeDb, getDatabase, initDb } from '../src/db.js';
import { persistCorrelatedFill } from '../src/trading_evidence_repository.js';
import { cashlegAccount, cashlegFill } from './fixtures/kraken_cashleg.js';
import { quantityFill, quantityHash, quantityRead } from './fixtures/fill_quantity.js';
import { dropFxSchema } from './fixtures/fx_schema.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-quantity-migration-'));
const drop42 = `${dropFxSchema}\nDROP TABLE trading_fill_quantity_evidence; DELETE FROM schema_migrations WHERE version=42;`;
async function originals(database) {
  return { fills: await database.all('SELECT * FROM trading_fills ORDER BY id'), money: await database.all('SELECT * FROM trading_money_events ORDER BY id'),
    values: await database.all('SELECT * FROM trading_money_valuations ORDER BY event_id') };
}
try {
  const filename = path.join(directory, 'migration.db'); await initDb(filename);
  const trade = await cashlegFill(await cashlegAccount('migration-quantity')), before = await originals(getDatabase());
  await getDatabase().exec(drop42); await closeDb(); await initDb(filename);
  assert.deepEqual(await originals(getDatabase()), before, 'Actual schema41 -> 42 never rewrites original fills/money/valuations.');
  assert.equal((await getDatabase().get('SELECT COUNT(*) n FROM trading_fill_quantity_evidence')).n, 0, 'Migration cannot invent an old normalization.');
  const normalization = quantityFill('1', '1', '1').quantityNormalization;
  trade.fill.quantityNormalization = { ...normalization, nativeIdentity: trade.fill.identity,
    originalExecutionHash: quantityHash('kraken-normalization-original-v1', trade.fill.raw) };
  await persistCorrelatedFill(trade.account, trade.fill, quantityRead(normalization.normalizedAt));
  const proof = await getDatabase().get('SELECT * FROM trading_fill_quantity_evidence');
  assert.equal(proof.observation_kind, 'later_observation');
  const snapshot = path.join(directory, 'snapshot.db'); await backupDatabase(snapshot); await closeDb(); await initDb(snapshot);
  assert.deepEqual(await getDatabase().get('SELECT * FROM trading_fill_quantity_evidence'), proof, 'Real database backup/readback retains the immutable observation.');
  assert.deepEqual(await originals(getDatabase()), before);
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  await closeDb();
  const failed = path.join(directory, 'failed.db'); await initDb(failed);
  await cashlegFill(await cashlegAccount('failed-quantity')); const retained = await originals(getDatabase());
  await getDatabase().exec(drop42); await getDatabase().exec('CREATE TABLE trading_fill_quantity_evidence(original_marker TEXT)');
  await closeDb(); await assert.rejects(initDb(failed), error => /already exists/.test(error.cause?.message)); await closeDb();
  const database = await open({ filename: failed, driver: sqlite3.Database });
  try {
    assert.deepEqual(await originals(database), retained);
    assert.equal((await database.get('SELECT MAX(version) v FROM schema_migrations')).v, 41);
    assert.deepEqual(await database.all('PRAGMA foreign_key_check'), []);
  } finally { await database.close(); }
  console.log('Migration42: real schema41 upgrade, no invented backfill, lossless database backup/restart and failed-migration rollback passed.');
} finally {
  await closeDb(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  await rm(directory, { recursive: true, force: true });
}
