import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDatabase, saveSignal } from '../src/db.js';
import { listTradingAccounts, listTradingStrategies } from '../src/trading_repository.js';
import { prepareTradingOperation } from '../src/trading_recovery.js';
import { prepareProtectedOrderIdentityRequests } from '../src/trading_order_identity.js';
import { seedTradingFixtures } from './trading_fixtures.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'order-identity-requests-'));
const databasePath = path.join(directory, 'fixture.db');
const digest = value => createHash('sha256').update(value).digest('hex');
try {
  await initDb(databasePath);
  await seedTradingFixtures();
  const [paper] = await listTradingAccounts();
  const [strategy] = await listTradingStrategies();
  const account = { ...paper, exchange: 'krakenfutures', mode: 'testnet', externalAccountId: 'a'.repeat(64), credentialGeneration: 'b'.repeat(64) };
  await getDatabase().run("UPDATE trading_accounts SET exchange=?,mode=?,external_account_id=?,credential_generation=?,credential_ref='isolated-fixture' WHERE id=?",
    [account.exchange, account.mode, account.externalAccountId, account.credentialGeneration, account.id]);
  await saveSignal('identity-requests', '-identity', 1, '<signal/>', '<signal/>');
  async function fixture(id) {
    await getDatabase().run(`INSERT INTO trading_trade_intents(id,source_signal_id,root_source_signal_id,channel_id,strategy_version_id,
      account_id,exchange,mode,symbol,side,status,signal_json,created_at,updated_at)
      VALUES(?,'identity-requests','identity-requests','-identity',?,?,'krakenfutures','testnet','BTCUSDT','LONG','planned','{}',1,1)`, [id, strategy.id, account.id]);
    const request = { accountId: account.id, symbol: 'BTCUSDT', leverage: 1, timeoutSeconds: 12, quantity: '1',
      postOnly: false, targetIndex: null };
    const entry = { ...request, clientOrderId: `${id}-entry`, role: 'entry', side: 'buy', orderType: 'limit', price: '100', triggerPrice: null, reduceOnly: false };
    const protectiveStop = { ...request, clientOrderId: `${id}-stop`, role: 'stop_loss', side: 'sell', orderType: 'stop_market', price: null, triggerPrice: '90', reduceOnly: true };
    for (const leg of [entry, protectiveStop]) await getDatabase().run(`INSERT INTO trading_orders(id,intent_id,account_id,client_order_id,
      role,side,order_type,status,quantity,filled_quantity,reduce_only,request_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'created','1','0',?,?,1,1)`, [leg.clientOrderId, id, account.id, leg.clientOrderId, leg.role, leg.side,
      leg.orderType, Number(leg.reduceOnly), JSON.stringify(leg)]);
    return { entry, protectiveStop };
  }
  async function journal(id, request) {
    return prepareTradingOperation({ account, intentId: id, kind: 'protected_entry', clientOrderIds: [request.entry.clientOrderId, request.protectiveStop.clientOrderId], request });
  }
  const fresh = await fixture('fresh');
  const original = structuredClone(fresh);
  const tagged = await prepareProtectedOrderIdentityRequests(account, 'fresh', fresh.entry, fresh.protectiveStop);
  assert.deepEqual(fresh, original, 'Read-only preparation must not mutate caller requests.');
  assert.deepEqual(tagged.entry.providerBatchTag, { version: 1, tag: fresh.entry.clientOrderId });
  assert.deepEqual(tagged.protectiveStop.providerBatchTag, { version: 1, tag: fresh.protectiveStop.clientOrderId });
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS n FROM trading_operations')).n, 0, 'The helper never writes a journal from a final safety fence.');
  const operationId = await journal('fresh', tagged);
  const saved = await getDatabase().get('SELECT * FROM trading_operations WHERE id=?', [operationId]);
  await closeDb(); await initDb(databasePath);
  assert.deepEqual(await prepareProtectedOrderIdentityRequests(account, 'fresh', fresh.entry, fresh.protectiveStop), tagged);
  assert.deepEqual(await getDatabase().get('SELECT * FROM trading_operations WHERE id=?', [operationId]), saved);
  for (const patch of [{ account_fingerprint: 'c'.repeat(64) }, { credential_generation: 'c'.repeat(64) }, { request_hash: 'c'.repeat(64) }]) {
    const [column, value] = Object.entries(patch)[0];
    await getDatabase().run(`UPDATE trading_operations SET ${column}=? WHERE id=?`, [value, operationId]);
    await assert.rejects(prepareProtectedOrderIdentityRequests(account, 'fresh', fresh.entry, fresh.protectiveStop), /ORDER_IDENTITY_UNPROVEN/);
    await getDatabase().run(`UPDATE trading_operations SET ${column}=? WHERE id=?`, [saved[column], operationId]);
  }
  const altered = { ...tagged, entry: { ...tagged.entry, providerBatchTag: { version: 1, tag: 'foreign' } } };
  const alteredJson = JSON.stringify(altered);
  await getDatabase().run('UPDATE trading_operations SET request_json=?,request_hash=? WHERE id=?', [alteredJson, digest(alteredJson), operationId]);
  await assert.rejects(prepareProtectedOrderIdentityRequests(account, 'fresh', fresh.entry, fresh.protectiveStop), /ORDER_IDENTITY_UNPROVEN/);
  await getDatabase().run('UPDATE trading_operations SET request_json=?,request_hash=? WHERE id=?', [saved.request_json, saved.request_hash, operationId]);
  const legacy = await fixture('legacy');
  const legacyId = await journal('legacy', legacy);
  const legacyBefore = await getDatabase().get('SELECT * FROM trading_operations WHERE id=?', [legacyId]);
  assert.deepEqual(await prepareProtectedOrderIdentityRequests(account, 'legacy', legacy.entry, legacy.protectiveStop), legacy);
  assert.deepEqual(await getDatabase().get('SELECT * FROM trading_operations WHERE id=?', [legacyId]), legacyBefore);
  await assert.rejects(prepareProtectedOrderIdentityRequests(account, 'legacy', { ...legacy.entry, quantity: '2' }, legacy.protectiveStop), /ORDER_IDENTITY_UNPROVEN/);
  assert.deepEqual(await prepareProtectedOrderIdentityRequests({ ...account, exchange: 'bybit' }, 'legacy', legacy.entry, legacy.protectiveStop), legacy,
    'Non-Kraken providers acquire no batch tag.');
  console.log('Read-only original-bound Kraken batch request tags, legacy preservation, tampering and restart passed.');
} finally { await closeDb(); await rm(directory, { recursive: true, force: true }); }
