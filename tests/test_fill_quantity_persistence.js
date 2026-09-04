import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, pruneOperationalData, withDatabaseTransaction } from '../src/db.js';
import { persistCorrelatedFill } from '../src/trading_evidence_repository.js';
import { historyCheckpoints } from '../src/trading_history_repository.js';
import { getTradingAccount } from '../src/trading_repository.js';
import { cashlegAccount } from './fixtures/kraken_cashleg.js';
import { quantityFill, quantityRead, quantityHash } from './fixtures/fill_quantity.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-quantity-evidence-'));
const filename = path.join(directory, 'test.db');
async function originalRows() {
  return { fills: await getDatabase().all('SELECT * FROM trading_fills ORDER BY id'),
    money: await getDatabase().all('SELECT * FROM trading_money_events ORDER BY id') };
}
async function fixture(name, legacy = false, legacyQuantity = '1') {
  const context = await cashlegAccount(name), fill = quantityFill('4', '0.25', '1');
  await getDatabase().run(`INSERT INTO trading_orders(id,intent_id,account_id,client_order_id,exchange_order_id,provider_symbol,
    role,side,order_type,status,price,quantity,filled_quantity,reduce_only,request_json,created_at,updated_at)
    VALUES(?,?,?,'client','remote','BTC/USD:USD','entry','buy','limit','filled','100','1','1',0,'{}',?,?)`,
  [`order-${name}`, context.intentId, context.account.id, context.now, context.now]);
  if (legacy) {
    const old = structuredClone(fill); delete old.quantityNormalization;
    old.quantity = legacyQuantity;
    await persistCorrelatedFill(context.account, old);
  }
  return { ...context, fill, read: quantityRead(fill.quantityNormalization.normalizedAt) };
}
async function observations(accountId) {
  return getDatabase().all('SELECT * FROM trading_fill_quantity_evidence WHERE account_id=? ORDER BY id', [accountId]);
}
async function providerReadAndAccountBinding() {
  const context = await fixture('provider-read-quantity');
  const checkpoint = (await historyCheckpoints(context.account, context.account.createdAt)).find(row => row.source === 'fills');
  context.read.history = [{ baseRevision: checkpoint.revision, pages: 1,
    checkpoint: { ...checkpoint, revision: checkpoint.revision + 1, providerAccountUid: 'wrong-provider-account' } }];
  const before = await originalRows();
  await assert.rejects(persistCorrelatedFill(context.account, context.fill, context.read),
    /FILL_QUANTITY_READ_PROVIDER_BINDING_MISMATCH/);
  assert.deepEqual(await originalRows(), before, 'Contradictory first-read UID must roll back the fill and every money change.');
  assert.deepEqual(await observations(context.account.id), [], 'Failed first capture cannot leave a normalization observation.');
  for (const table of ['trading_fills', 'trading_fill_quantity_evidence', 'trading_money_events']) {
    assert.equal((await getDatabase().get(`SELECT COUNT(*) n FROM ${table} WHERE account_id=?`, [context.account.id])).n, 0);
  }
  context.read.history[0].checkpoint.providerAccountUid = context.fill.raw.info.accountUid;
  const stored = await persistCorrelatedFill(context.account, context.fill, context.read);
  assert.equal(stored.inserted, true, 'The matching original provider UID permits first capture.');
  const proof = await observations(context.account.id), original = await originalRows();
  assert.equal(proof.length, 1);
  assert.equal(proof[0].fill_id, stored.fillId);
  assert.equal(proof[0].provider_account_uid, context.fill.raw.info.accountUid);
  assert.deepEqual(JSON.parse(proof[0].acquisition_json), context.read);
  for (const patch of [{ mode: 'live' }, { externalAccountId: 'e'.repeat(64) }]) {
    await assert.rejects(persistCorrelatedFill({ ...context.account, ...patch }, context.fill, context.read),
      /FILL_ACCOUNT_IDENTITY_CHANGED/);
    assert.deepEqual(await originalRows(), original, 'Wrong mode/fingerprint cannot change an original fill or money event.');
    assert.deepEqual(await observations(context.account.id), proof, 'Wrong account binding cannot add or rewrite normalization evidence.');
  }
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
}
async function legacyDecimalSpellingRemainsOriginal() {
  const context = await fixture('legacy-spelling-quantity', true, '1.0');
  const original = await originalRows();
  const oldFill = original.fills.find(row => row.account_id === context.account.id);
  assert.equal(oldFill.quantity, '1.0');
  const result = await persistCorrelatedFill(context.account, context.fill, context.read);
  assert.equal(result.inserted, false, 'Equivalent decimal spelling must retain the original canonical fill.');
  assert.equal(result.fillId, oldFill.id);
  const rows = await observations(context.account.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].observation_kind, 'later_observation', 'Canonical spelling is a later calculation, never a fabricated initial proof.');
  assert.equal(JSON.parse(rows[0].normalization_json).outputQuantity, '1');
  assert.deepEqual(await originalRows(), original, 'The legacy quantity text 1.0 and all original economics remain unchanged.');
}
try {
  await initDb(filename);
  const fresh = await fixture('fresh-quantity');
  const first = await persistCorrelatedFill(fresh.account, fresh.fill, fresh.read);
  let rows = await observations(fresh.account.id);
  assert.equal(rows.length, 1, 'Actual normalization is durably captured with its first canonical fill.');
  assert.equal(rows[0].fill_id, first.fillId);
  assert.equal(rows[0].observation_kind, 'initial');
  assert.equal(rows[0].credential_generation, fresh.account.credentialGeneration);
  assert.equal(rows[0].account_fingerprint, fresh.account.externalAccountId);
  assert.deepEqual(JSON.parse(rows[0].normalization_json), fresh.fill.quantityNormalization);
  const original = await originalRows(), proof = rows[0];
  await persistCorrelatedFill(fresh.account, fresh.fill, fresh.read);
  const repeated = structuredClone(fresh.fill); repeated.quantityNormalization.normalizedAt++;
  await persistCorrelatedFill(fresh.account, repeated, quantityRead(repeated.quantityNormalization.normalizedAt));
  assert.deepEqual(await observations(fresh.account.id), [proof], 'Identical recipe/read repeats do not grow evidence or rewrite its first observation.');
  await closeDb(); await initDb(filename);
  assert.deepEqual(await observations(fresh.account.id), [proof]);
  assert.deepEqual(await originalRows(), original);
  await assert.rejects(getDatabase().run("UPDATE trading_fill_quantity_evidence SET normalization_json='{}' WHERE id=?", [proof.id]), /immutable/);
  await assert.rejects(getDatabase().run('DELETE FROM trading_fill_quantity_evidence WHERE id=?', [proof.id]), /retained/);
  await assert.rejects(getDatabase().run('DELETE FROM trading_fills WHERE id=?', [first.fillId]), /FOREIGN KEY/);
  await assert.rejects(persistCorrelatedFill(fresh.account, fresh.fill), /QUANTITY.*READ/);
  await assert.rejects(persistCorrelatedFill(fresh.account, fresh.fill, quantityRead(fresh.read.completedAt + 1000)), /QUANTITY.*READ/);
  const wrongAccount = { ...fresh.account, credentialGeneration: 'c'.repeat(64) };
  await assert.rejects(persistCorrelatedFill(wrongAccount, fresh.fill, fresh.read), /QUANTITY.*BINDING/);
  const changedOriginal = structuredClone(fresh.fill); changedOriginal.raw.info.providerEventId = 'different-original';
  changedOriginal.quantityNormalization.originalExecutionHash = quantityHash('kraken-normalization-original-v1', changedOriginal.raw);
  await assert.rejects(persistCorrelatedFill(fresh.account, changedOriginal, fresh.read), /QUANTITY.*ORIGINAL/);
  await getDatabase().run('UPDATE trading_accounts SET credential_generation=? WHERE id=?', ['c'.repeat(64), fresh.account.id]);
  await persistCorrelatedFill(await getTradingAccount(fresh.account.id), fresh.fill, fresh.read);
  rows = await observations(fresh.account.id);
  assert.equal(rows.length, 2, 'A separately validated current credential generation retains its own observation, without an economic conflict.');
  assert.deepEqual(await originalRows(), original);
  const old = await fixture('legacy-quantity', true), beforeLegacy = await originalRows();
  await persistCorrelatedFill(old.account, old.fill, old.read);
  assert.equal((await observations(old.account.id))[0].observation_kind, 'later_observation', 'A later normalization cannot pretend to be the original normalization.');
  assert.deepEqual(await originalRows(), beforeLegacy);
  const rollback = await fixture('rollback-quantity');
  await getDatabase().exec("CREATE TRIGGER fail_quantity BEFORE INSERT ON trading_fill_quantity_evidence WHEN NEW.account_id='rollback-quantity' BEGIN SELECT RAISE(ABORT,'simulated quantity failure'); END;");
  await assert.rejects(persistCorrelatedFill(rollback.account, rollback.fill, rollback.read), /simulated quantity failure/);
  assert.equal((await getDatabase().get('SELECT COUNT(*) n FROM trading_fills WHERE account_id=?', [rollback.account.id])).n, 0, 'Failed observation rolls back the first fill and accounting atomically.');
  await getDatabase().exec('DROP TRIGGER fail_quantity');
  await assert.rejects(withDatabaseTransaction(async () => {
    await persistCorrelatedFill(rollback.account, rollback.fill, rollback.read); throw new Error('outer ingestion crash');
  }), /outer ingestion crash/);
  assert.equal((await observations(rollback.account.id)).length, 0);
  await providerReadAndAccountBinding();
  await legacyDecimalSpellingRemainsOriginal();
  const retained = await observations(fresh.account.id);
  await getDatabase().run("UPDATE trading_trade_intents SET status='completed' WHERE account_id=?", [fresh.account.id]);
  await pruneOperationalData(90, 100, Date.now() + 92 * 86400000);
  assert.deepEqual(await observations(fresh.account.id), retained);
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  console.log('Fill quantity persistence: atomic first capture, immutable originals, dedupe/restart, generation/read binding, late observations, rollback and retention passed.');
} finally {
  await closeDb();
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  await rm(directory, { recursive: true, force: true });
}
