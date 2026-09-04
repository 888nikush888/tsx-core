import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { initDb, closeDb, getDatabase, saveSignal, withDatabaseDispatchFence, withDatabaseTransaction } from '../src/db.js';
import { listTradingAccounts, listTradingStrategies } from '../src/trading_repository.js';
import { currentDispatchIdentity, runJournaledExchangeWrite } from '../src/trading_recovery.js';
import { seedTradingFixtures } from './trading_fixtures.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-dispatch-fence-'));
const filename = path.join(directory, 'test.db');
let reader;
async function fixture(account, id) {
  await getDatabase().run(`INSERT INTO trading_orders (id, intent_id, account_id, client_order_id, role, side, order_type, status,
    quantity, filled_quantity, reduce_only, request_json, created_at, updated_at)
    VALUES (?, 'fence-intent', ?, ?, 'entry', 'buy', 'limit', 'created', '1', '0', 0, '{}', 1, 1)`, [id, account.id, id]);
  const result = { clientOrderId: id, exchangeOrderId: `remote-${id}`, status: 'open', filledQuantity: '0', averagePrice: null, error: null, raw: {} };
  return { account, intentId: 'fence-intent', kind: 'submit', clientOrderIds: [id], request: { id }, beforeDispatch: async () => {},
    beforeSend: async () => {}, guard: () => {}, send: async () => result, persist: async () => [result] };
}
const phase = async input => (await getDatabase().get('SELECT phase FROM trading_operations WHERE request_json = ?', [JSON.stringify(input.request)])).phase;
async function failureMatrix(account) {
  for (const [id, expectedPhase, patch] of [
    ['source-changed', 'abandoned', { beforeSend: async () => { throw new Error('sources changed'); } }],
    ['sync-fence', 'abandoned', { guard: () => { throw new Error('epoch changed'); } }],
    ['sync-send', 'unresolved', { send: () => { throw new Error('synchronous adapter failure'); } }],
    ['reject-send', 'unresolved', { send: async () => { throw new Error('asynchronous adapter failure'); } }],
  ]) {
    const input = { ...await fixture(account, id), ...patch };
    await assert.rejects(runJournaledExchangeWrite(input));
    assert.equal(await phase(input), expectedPhase, id);
  }
}
async function changedDispatchRequest(account) {
  const mutations = [
    ['batch-tag', input => { input.request.providerBatchTag = { version: 1, tag: 'other-request' }; }],
    ['nested-quantity', input => { input.request.original.quantity = '2'; }],
    ['account', input => { input.account.id = 'different-account'; }],
    ['exchange', input => { input.account.exchange = 'different-exchange'; }],
    ['mode', input => { input.account.mode = 'live'; }],
    ['fingerprint', input => { input.account.externalAccountId = 'different-fingerprint'; }],
    ['generation', input => { input.account.credentialGeneration = 'different-generation'; }],
    ['credential-ref', input => { input.account.credentialRef = 'different-local-reference'; }],
    ['leg-id', input => { input.clientOrderIds[0] = 'other-leg'; }],
    ['intent', input => { input.intentId = 'other-intent'; }],
    ['kind', input => { input.kind = 'cancel'; }],
  ];
  for (const boundary of ['beforeDispatch', 'beforeSend', 'guard', 'guard-without-beforeSend']) {
    for (const [name, mutate] of mutations) await rejectedDispatchMutation(account, boundary, name, mutate);
  }
}
async function rejectedDispatchMutation(account, boundary, name, mutate) {
    const input = await fixture({ ...account }, `changed-request-${boundary}-${name}`);
    input.request.original = { quantity: '1' };
    const original = JSON.stringify(input.request);
    let sends = 0;
    if (boundary === 'guard-without-beforeSend') delete input.beforeSend;
    input[boundary === 'guard-without-beforeSend' ? 'guard' : boundary] = () => mutate(input);
    const send = input.send;
    input.send = () => { sends += 1; return send(); };
    await assert.rejects(runJournaledExchangeWrite(input), /JOURNALED_REQUEST_CHANGED/,
      'The actual outbound request must still be the one committed before dispatch, including any provider batch tag.');
    assert.equal(sends, 0);
    const operation = await getDatabase().get('SELECT * FROM trading_operations WHERE request_json = ?', [original]);
    assert.equal(operation.phase, 'abandoned', 'A rejected local request change is not an executed exchange write.');
    assert.equal(operation.request_json, original);
    assert.equal(operation.account_id, account.id);
    assert.equal(operation.account_fingerprint, account.externalAccountId);
    assert.equal(operation.credential_generation, account.credentialGeneration);
    assert.equal(operation.intent_id, 'fence-intent');
    assert.equal(operation.kind, 'submit');
    assert.equal(JSON.parse(operation.expected_orders_json)[0].client_order_id, JSON.parse(original).id);
}
async function ownerIsolation() {
  let releaseNetwork;
  const network = new Promise(resolve => { releaseNetwork = resolve; });
  let wrote = false;
  const { pending } = await withDatabaseDispatchFence(async () => {}, async () => {
    await network;
    await getDatabase().run("UPDATE trading_accounts SET updated_at = updated_at WHERE id = 'paper-default'");
    wrote = true;
  });
  await withDatabaseTransaction(async () => {
    releaseNetwork();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(wrote, false, 'Adapter continuation must queue normally, not inherit a released DB owner.');
  });
  await pending;
  assert.equal(wrote, true);
  let starts = 0;
  await assert.rejects(withDatabaseTransaction(() => withDatabaseDispatchFence(async () => {}, async () => { starts += 1; })), /inherit/);
  assert.equal(starts, 0);
}
async function commitFailure(account) {
  const input = await fixture(account, 'commit-failure');
  const db = getDatabase();
  const original = db.exec;
  let started = false;
  let rejected;
  input.send = () => { started = true; return new Promise((_resolve, reject) => { rejected = reject; }); };
  db.exec = async sql => {
    if (sql === 'COMMIT' && started) { started = false; throw new Error('fixture read-fence commit failure'); }
    return original(sql);
  };
  try { await assert.rejects(runJournaledExchangeWrite(input), /commit failure/); }
  finally { db.exec = original; }
  assert.equal(await phase(input), 'unresolved', 'A started send cannot become abandoned after lock/commit failure.');
  rejected(new Error('late network rejection'));
  await new Promise(resolve => setImmediate(resolve));
}
try {
  await initDb(filename); await seedTradingFixtures();
  const [account] = await listTradingAccounts(); const [strategy] = await listTradingStrategies();
  await saveSignal('fence-signal', '-fence', 1, '<signal/>', '<signal/>');
  await getDatabase().run(`INSERT INTO trading_trade_intents (id, source_signal_id, root_source_signal_id, channel_id, strategy_version_id,
    account_id, exchange, mode, symbol, side, status, signal_json, created_at, updated_at)
    VALUES ('fence-intent', 'fence-signal', 'fence-signal', '-fence', ?, ?, 'paper', 'paper', 'BTCUSDT', 'LONG', 'submitting', '{}', 1, 1)`, [strategy.id, account.id]);
  reader = await open({ filename, driver: sqlite3.Database });
  const normal = await fixture(account, 'durable');
  let capturedWitness;
  normal.beforeSend = async witness => {
    capturedWitness = witness;
    const row = await reader.get('SELECT id, phase, request_hash FROM trading_operations WHERE request_json = ?', [JSON.stringify(normal.request)]);
    assert.equal(row.phase, 'dispatching', 'Independent SQLite reader must see committed dispatching before any send.');
    assert.deepEqual(currentDispatchIdentity(witness), { operationId: row.id, accountId: account.id, intentId: normal.intentId,
      requestHash: row.request_hash, accountFingerprint: account.externalAccountId, credentialGeneration: account.credentialGeneration });
    assert.equal(Object.isFrozen(witness), true);
    assert.equal(Object.isFrozen(currentDispatchIdentity(witness)), true);
    assert.equal(currentDispatchIdentity(structuredClone(witness)), null);
    assert.equal(currentDispatchIdentity(row.id), null, 'Serialized identity is not a live writer capability.');
  };
  const send = normal.send;
  normal.send = () => {
    assert.equal(currentDispatchIdentity(capturedWitness), null, 'Capability is revoked before even synchronous dispatch begins.');
    return send();
  };
  await runJournaledExchangeWrite(normal);
  assert.equal(currentDispatchIdentity(capturedWitness), null);
  const rejected = await fixture(account, 'witness-revoked-on-rejection');
  rejected.beforeSend = async witness => { capturedWitness = witness; throw new Error('reject before send'); };
  await assert.rejects(runJournaledExchangeWrite(rejected), /reject before send/);
  assert.equal(currentDispatchIdentity(capturedWitness), null, 'Failed verification also revokes its capability.');
  await failureMatrix(account);
  await changedDispatchRequest(account);
  await ownerIsolation();
  await commitFailure(account);
  console.log('Durable dispatch fence, read-only recheck, nested-owner isolation and all send failure states passed.');
} finally { if (reader) await reader.close(); await closeDb(); await rm(directory, { recursive: true, force: true }); }
