import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { backupDatabase, closeDb, getDatabase, initDb, LATEST_SCHEMA_VERSION } from '../src/db.js';
import { getTradingAccount } from '../src/trading_repository.js';
import { captureFxReceipts, persistFxConversion, readFxConversion } from '../src/trading_fx_repository.ts';
import { cashlegAccount, cashlegFill } from './fixtures/kraken_cashleg.js';
import { fxReceipt, FX_CONTEXT } from './fixtures/fx_receipts.js';
import { dropFxSchema } from './fixtures/fx_schema.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-fx-migration-'));
async function originals(database) {
  return { fills: await database.all('SELECT * FROM trading_fills ORDER BY id'),
    money: await database.all('SELECT * FROM trading_money_events ORDER BY id'),
    values: await database.all('SELECT * FROM trading_money_valuations ORDER BY event_id') };
}
try {
  const filename = path.join(directory, 'upgrade.db'); await initDb(filename);
  await cashlegFill(await cashlegAccount('legacy-fx-migration'));
  const before = await originals(getDatabase());
  await getDatabase().exec(dropFxSchema); await closeDb(); await initDb(filename);
  assert.equal((await getDatabase().get('SELECT MAX(version) n FROM schema_migrations')).n, LATEST_SCHEMA_VERSION);
  assert.deepEqual(await originals(getDatabase()), before);
  assert.equal((await getDatabase().get('SELECT COUNT(*) n FROM trading_fx_receipts')).n, 0,
    'No migration backfills fabricated historical quotes.');
  const at = Date.now() - 100;
  await getDatabase().run(`INSERT INTO trading_accounts(id,name,exchange,mode,status,enabled,credential_ref,
    external_account_id,credential_generation,capabilities_json,last_verified_at,created_at,updated_at)
    VALUES ('fx-migration','FX','bybit','testnet','ready',1,'fixture',?,?,?,?,?,?)`, ['a'.repeat(64), 'b'.repeat(64),
  JSON.stringify({ executionProfileHash: FX_CONTEXT.profileHash, profileVersion: 1,
    executionCapabilities: { provider_api_version: 'bybit-v5' } }), at - 1, at - 1, at]);
  const account = await getTradingAccount('fx-migration');
  await captureFxReceipts(account, [fxReceipt('usd', at), fxReceipt('usdt', at)], { startedAt: at - 20, completedAt: at + 20 });
  const proof = await persistFxConversion(account, 'USDT', 'USD', at);
  const saved = await getDatabase().all('SELECT * FROM trading_fx_receipts ORDER BY id');
  const snapshot = path.join(directory, 'snapshot.db'); await backupDatabase(snapshot); await closeDb(); await initDb(snapshot);
  assert.deepEqual(await readFxConversion(account, proof.id), proof);
  assert.deepEqual(await getDatabase().all('SELECT * FROM trading_fx_receipts ORDER BY id'), saved);
  assert.deepEqual(await originals(getDatabase()), before);
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  await closeDb();
  const failed = path.join(directory, 'failed.db'); await initDb(failed);
  await cashlegFill(await cashlegAccount('failed-fx-migration')); const retained = await originals(getDatabase());
  await getDatabase().exec(dropFxSchema);
  await getDatabase().exec('CREATE TABLE trading_fx_receipts(original_marker TEXT)');
  await closeDb(); await assert.rejects(initDb(failed), error => /already exists/.test(error.cause?.message)); await closeDb();
  const database = await open({ filename: failed, driver: sqlite3.Database });
  try {
    assert.equal((await database.get('SELECT MAX(version) n FROM schema_migrations')).n, 42);
    assert.deepEqual(await originals(database), retained);
    assert.deepEqual(await database.all('PRAGMA foreign_key_check'), []);
  } finally { await database.close(); }
  console.log('Migration43: genuine schema42 upgrade, untouched economics, lossless FX backup and failed-migration rollback passed.');
} finally {
  await closeDb(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  await rm(directory, { recursive: true, force: true });
}
