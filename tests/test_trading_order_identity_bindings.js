import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDatabase, saveSignal } from '../src/db.js';
import { listTradingAccounts, listTradingStrategies } from '../src/trading_repository.js';
import { prepareTradingOperation, transitionTradingOperation } from '../src/trading_recovery.js';
import { prepareProtectedOrderIdentityRequests } from '../src/trading_order_identity.js';
import { correlateNativeOrderEvidence } from '../src/trading_order_identity_bindings.js';
import { persistTradingOrderResult } from '../src/trading_order_repository.js';
import { protectionSourceDigest } from '../src/trading_protection_sources.js';
import { seedTradingFixtures } from './trading_fixtures.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'order-native-binding-'));
const databasePath = path.join(directory, 'fixture.db');
try {
  await initDb(databasePath);
  await seedTradingFixtures();
  const [paper] = await listTradingAccounts();
  const [strategy] = await listTradingStrategies();
  await saveSignal('native-identity', '-native', 1, '<signal/>', '<signal/>');
  async function accountFixture(exchange, fingerprint) {
    const account = { ...paper, id: exchange, exchange, mode: 'testnet', externalAccountId: fingerprint, credentialGeneration: 'b'.repeat(64) };
    await getDatabase().run(`INSERT INTO trading_accounts(id,name,exchange,mode,status,credential_ref,enabled,external_account_id,
      credential_generation,created_at,updated_at) VALUES(?,?,?,'testnet','ready','isolated-fixture',1,?,?,1,1)`,
    [account.id, exchange, exchange, account.externalAccountId, account.credentialGeneration]);
    return account;
  }
  async function fixture(account, id, clientId = `${id}-stop`, phase = 'dispatching') {
    await getDatabase().run(`INSERT INTO trading_trade_intents(id,source_signal_id,root_source_signal_id,channel_id,strategy_version_id,
      account_id,exchange,mode,symbol,side,status,signal_json,created_at,updated_at)
      VALUES(?,'native-identity','native-identity','-native',?,?,?,'testnet','BTCUSDT','LONG','submitting','{}',1,1)`, [id, strategy.id, account.id, account.exchange]);
    const request = { accountId: account.id, symbol: 'BTCUSDT', leverage: 1, timeoutSeconds: 12, quantity: '1', postOnly: false, targetIndex: null };
    const entry = { ...request, clientOrderId: `${id}-entry`, role: 'entry', side: 'buy', orderType: 'limit', price: '100', triggerPrice: null, reduceOnly: false };
    const protectiveStop = { ...request, clientOrderId: clientId, role: 'stop_loss', side: 'sell', orderType: 'stop_market', price: null, triggerPrice: '90', reduceOnly: true };
    for (const leg of [entry, protectiveStop]) await getDatabase().run(`INSERT INTO trading_orders(id,intent_id,account_id,client_order_id,
      role,side,order_type,status,quantity,filled_quantity,reduce_only,trigger_price,price,request_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'submitting','1','0',?,?,?,?,1,1)`, [leg.clientOrderId, id, account.id, leg.clientOrderId,
      leg.role, leg.side, leg.orderType, Number(leg.reduceOnly), leg.triggerPrice, leg.price, JSON.stringify(leg)]);
    const prepared = await prepareProtectedOrderIdentityRequests(account, id, entry, protectiveStop);
    const operationId = await prepareTradingOperation({ account, intentId: id, kind: 'protected_entry',
      clientOrderIds: [entry.clientOrderId, protectiveStop.clientOrderId], request: prepared });
    if (phase !== 'prepared') await transitionTradingOperation(operationId, 'prepared', 'dispatching');
    return { ...prepared, operationId, intentId: id };
  }
  const kraken = await accountFixture('krakenfutures', 'a'.repeat(64));
  const batch = await fixture(kraken, 'batch');
  const ack = { clientOrderId: batch.protectiveStop.clientOrderId, exchangeOrderId: 'remote-stop', providerSymbol: 'BTC/USD:USD',
    status: 'open', filledQuantity: '0', averagePrice: null, error: null,
    raw: { id: 'remote-stop', clientOrderId: null, info: { order_tag: batch.protectiveStop.clientOrderId, order_id: 'remote-stop' } },
    identityEvidence: { version: 1, profile: 'kraken_batch_tag_v1', tag: batch.protectiveStop.clientOrderId,
      clientOrderId: batch.protectiveStop.clientOrderId, exchangeOrderId: 'remote-stop', providerSymbol: 'BTC/USD:USD' } };
  const before = await protectionSourceDigest(kraken.id);
  await persistTradingOrderResult(batch.intentId, ack.clientOrderId, ack);
  const binding = await getDatabase().get('SELECT * FROM trading_order_identity_bindings WHERE order_id=?', [ack.clientOrderId]);
  assert.equal(binding.operation_id, batch.operationId);
  assert.equal(JSON.parse((await getDatabase().get('SELECT response_json FROM trading_orders WHERE id=?', [ack.clientOrderId])).response_json).clientOrderId, null);
  assert.notEqual(await protectionSourceDigest(kraken.id), before);
  await persistTradingOrderResult(batch.intentId, ack.clientOrderId, ack);
  assert.deepEqual(await getDatabase().get('SELECT * FROM trading_order_identity_bindings WHERE order_id=?', [ack.clientOrderId]), binding);
  const operation = await getDatabase().get('SELECT * FROM trading_operations WHERE id=?', [batch.operationId]);
  await getDatabase().run('UPDATE trading_operations SET request_hash=? WHERE id=?', ['f'.repeat(64), batch.operationId]);
  await assert.rejects(persistTradingOrderResult(batch.intentId, ack.clientOrderId, ack), /original operation changed/);
  await getDatabase().run('UPDATE trading_operations SET request_hash=? WHERE id=?', [operation.request_hash, batch.operationId]);
  for (const [column, changed] of [['expected_orders_json', JSON.stringify([{ client_order_id: ack.clientOrderId }])],
    ['logical_key', 'c'.repeat(64)], ['generation', operation.generation + 1]]) {
    await getDatabase().run(`UPDATE trading_operations SET ${column}=? WHERE id=?`, [changed,batch.operationId]);
    await assert.rejects(persistTradingOrderResult(batch.intentId, ack.clientOrderId, ack), /Original expected leg|original operation changed/);
    await getDatabase().run(`UPDATE trading_operations SET ${column}=? WHERE id=?`, [operation[column],batch.operationId]);
  }
  await getDatabase().run('UPDATE trading_accounts SET credential_generation=? WHERE id=?', ['e'.repeat(64), kraken.id]);
  await persistTradingOrderResult(batch.intentId, ack.clientOrderId, ack);
  assert.deepEqual(await getDatabase().get('SELECT * FROM trading_order_identity_bindings WHERE order_id=?', [ack.clientOrderId]), binding,
    'Verified same-account credential rotation does not rewrite historical binding generation.');
  await getDatabase().run('UPDATE trading_accounts SET credential_generation=? WHERE id=?', [kraken.credentialGeneration, kraken.id]);
  const trigger = await getDatabase().get("SELECT sql FROM sqlite_master WHERE name='trading_order_identity_immutable'");
  await getDatabase().exec('DROP TRIGGER trading_order_identity_immutable');
  await getDatabase().run('UPDATE trading_order_identity_bindings SET evidence_hash=? WHERE order_id=?', ['0'.repeat(64), ack.clientOrderId]);
  await assert.rejects(persistTradingOrderResult(batch.intentId, ack.clientOrderId, ack), /evidence hash changed/);
  await getDatabase().run('UPDATE trading_order_identity_bindings SET evidence_hash=? WHERE order_id=?', [binding.evidence_hash, ack.clientOrderId]);
  await getDatabase().exec(trigger.sql);
  const digest = await protectionSourceDigest(kraken.id);
  await getDatabase().run('DELETE FROM trading_order_identity_bindings WHERE order_id=?', [ack.clientOrderId]);
  assert.notEqual(await protectionSourceDigest(kraken.id), digest, 'A lost original binding invalidates the source receipt even if order bytes did not change.');
  await persistTradingOrderResult(batch.intentId, ack.clientOrderId, ack);
  await closeDb();
  await initDb(databasePath);
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS n FROM trading_order_identity_bindings')).n, 1);

  const user = `0x${'c'.repeat(40)}`;
  const cloid = `0x${'d'.repeat(32)}`;
  const hl = await accountFixture('hyperliquid', createHmac('sha256', user).update('external-account-id:v1:hyperliquid:testnet').digest('hex'));
  const lookup = await fixture(hl, 'lookup', cloid);
  const now = Date.now();
  const remote = { ...ack, clientOrderId: null, exchangeOrderId: '1234', symbol: 'BTCUSDT', providerSymbol: 'BTC/USDC:USDC',
    role: 'stop_loss', side: 'sell', quantity: '1', price: null, triggerPrice: '90', reduceOnly: true,
    raw: { id: '1234', clientOrderId: null, symbol: 'BTC/USDC:USDC', info: { order: { oid: 1234, coin: 'BTC', cloid: null } } },
    identityEvidence: { version: 1, profile: 'hyperliquid_cloid_lookup_v1', clientOrderId: cloid, exchangeOrderId: '1234',
      providerSymbol: 'BTC/USDC:USDC', providerMarketId: 'BTC', user, startedAt: now - 1, completedAt: now } };
  for (const changed of [{ quantity: '2' }, { identityEvidence: { ...remote.identityEvidence, user: `0x${'e'.repeat(40)}` } }]) {
    await assert.rejects(correlateNativeOrderEvidence(hl, [{ ...remote, ...changed }]));
    assert.equal((await getDatabase().get('SELECT exchange_order_id FROM trading_orders WHERE id=?', [cloid])).exchange_order_id, null);
  }
  await getDatabase().run("UPDATE trading_operations SET request_hash=? WHERE id=?", ['0'.repeat(64), lookup.operationId]);
  await assert.rejects(correlateNativeOrderEvidence(hl, [remote]), /Original journal/);
  const { createHash } = await import('node:crypto');
  const original = await getDatabase().get('SELECT request_json FROM trading_operations WHERE id=?', [lookup.operationId]);
  await getDatabase().run('UPDATE trading_operations SET request_hash=? WHERE id=?', [createHash('sha256').update(original.request_json).digest('hex'), lookup.operationId]);
  const [matched] = await correlateNativeOrderEvidence(hl, [remote]);
  assert.equal(matched.clientOrderId, cloid);
  assert.equal(matched.raw.clientOrderId, null);
  assert.equal((await getDatabase().get('SELECT exchange_order_id FROM trading_orders WHERE id=?', [cloid])).exchange_order_id, '1234');
  const bybitParentOnly = { ...remote, identityEvidence: undefined, raw: { info: { parentOrderLinkId: lookup.entry.clientOrderId } } };
  assert.equal((await correlateNativeOrderEvidence(hl, [bybitParentOnly]))[0].clientOrderId, null, 'Parent similarity alone never adopts an attached order.');
  await getDatabase().run("UPDATE trading_orders SET status='filled' WHERE id=?", [cloid]);
  await assert.rejects(correlateNativeOrderEvidence(hl, [{ ...remote, exchangeOrderId: '9999' }]), /scope changed|contradicts/);
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  console.log('Native order tags and cloid: journal/account binding, originals, source fence and restart passed.');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
