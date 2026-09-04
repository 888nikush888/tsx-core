import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDatabase, withDatabaseTransaction } from '../src/db.js';
import { bindLegacyFillIdentity, backfillAccountFillIdentities, unresolvedFillIdentityCount } from '../src/trading_fill_identity_repository.js';
import { persistCorrelatedFill } from '../src/trading_evidence_repository.js';
import { recordFeeEvent } from '../src/trading_money_ledger.js';
import { loadRiskSources, riskHash } from '../src/trading_risk_sources.js';
import { protectionSourceDigest } from '../src/trading_protection_sources.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { legacyFillFixture, legacyFillColumns } from './fixtures/legacy_fill_identity.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'legacy-fill-identities-'));
const filename = path.join(directory, 'fixture.db');
try {
  await initDb(filename); await seedTradingFixtures();
  const value = await legacyFillFixture('original');
  const db = getDatabase();
  const original = await db.get(`SELECT ${legacyFillColumns} FROM trading_fills WHERE id=?`, [value.fillId]);
  const money = await db.all('SELECT * FROM trading_money_events ORDER BY id');
  const operation = await db.get('SELECT * FROM trading_operations WHERE id=?', [value.operationId]);
  assert.equal(operation.phase, 'resolved');
  assert.equal(await unresolvedFillIdentityCount(value.account), 1, 'A read-only final fence never silently backfills a live legacy row.');
  assert.equal((await db.get('SELECT identity_status FROM trading_fills WHERE id=?', [value.fillId])).identity_status, 'legacy_unresolved');
  async function rejectedMutation(table, id, column, changed) {
    const before = await db.get(`SELECT ${column} AS value FROM ${table} WHERE id=?`, [id]);
    await db.run(`UPDATE ${table} SET ${column}=? WHERE id=?`, [changed,id]);
    assert.equal(await bindLegacyFillIdentity(value.account, value.fillId), false, `${table}.${column} original contradiction cannot bind.`);
    assert.equal(await unresolvedFillIdentityCount(value.account), 1);
    await db.run(`UPDATE ${table} SET ${column}=? WHERE id=?`, [before.value,id]);
  }
  for (const [column, changed] of [['account_fingerprint', null], ['account_fingerprint', 'f'.repeat(64)],
    ['raw_json', JSON.stringify({ ...value.incoming.raw, info: { ...value.incoming.raw.info, category: 'option' } })],
    ['raw_json', JSON.stringify({ ...value.incoming.raw, info: {} })]]) {
    await rejectedMutation('trading_fills', value.fillId, column, changed);
  }
  for (const [column, changed] of [['request_hash', '0'.repeat(64)], ['logical_key', '1'.repeat(64)], ['credential_generation', null],
    ['phase', 'prepared'], ['phase', 'abandoned'], ['expected_orders_json', '[]'],
    ['evidence_json', JSON.stringify([{ clientOrderId: value.incoming.clientOrderId, exchangeOrderId: 'foreign', providerSymbol: value.incoming.providerSymbol }])]]) {
    await rejectedMutation('trading_operations', value.operationId, column, changed);
  }
  await assert.rejects(db.run('UPDATE trading_operations SET generation=0 WHERE id=?', [value.operationId]), /CHECK constraint/);
  for (const [column, changed] of [['price', '101'], ['trigger_price', '90'], ['quantity', '2'], ['order_type', 'market'], ['reduce_only', 1]]) {
    await rejectedMutation('trading_orders', value.orderId, column, changed);
  }
  const optionSymbol = 'BTC/USDT:USDT-260925-100000-C';
  await db.run('UPDATE trading_orders SET provider_symbol=? WHERE id=?', [optionSymbol,value.orderId]);
  await db.run('UPDATE trading_fills SET raw_json=?,accounting_json=? WHERE id=?',
    [JSON.stringify({ ...value.incoming.raw, symbol: optionSymbol }),JSON.stringify({ ...value.incoming.accounting, providerSymbol: optionSymbol }),value.fillId]);
  assert.equal(await bindLegacyFillIdentity(value.account, value.fillId), false, 'CCXT linear=true also occurs on options and cannot prove a linear perpetual namespace.');
  await db.run('UPDATE trading_orders SET provider_symbol=? WHERE id=?', [value.incoming.providerSymbol,value.orderId]);
  await db.run('UPDATE trading_fills SET raw_json=?,accounting_json=? WHERE id=?', [original.raw_json,original.accounting_json,value.fillId]);
  const columns = Object.keys(operation), ambiguous = { ...operation, id: `${operation.id}-other`, logical_key: '9'.repeat(64) };
  await db.run(`INSERT INTO trading_operations(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`, columns.map(key => ambiguous[key]));
  assert.equal(await bindLegacyFillIdentity(value.account, value.fillId), false, 'Do not cherry-pick one of two possibly dispatched originals.');
  await db.run('DELETE FROM trading_operations WHERE id=?', [ambiguous.id]);
  const riskBefore = riskHash(await loadRiskSources(value.account.id)), protectionBefore = await protectionSourceDigest(value.account.id);
  assert.equal(await bindLegacyFillIdentity({ ...value.account, credentialGeneration: 'e'.repeat(64) }, value.fillId), true,
    'A genuine historical credential generation remains a historical witness across same-account rotation.');
  assert.equal(await unresolvedFillIdentityCount(value.account), 0);
  assert.deepEqual(await db.get(`SELECT ${legacyFillColumns} FROM trading_fills WHERE id=?`, [value.fillId]), original);
  assert.notEqual(riskHash(await loadRiskSources(value.account.id)), riskBefore, 'Additive identity binding invalidates the old risk source hash.');
  assert.notEqual(await protectionSourceDigest(value.account.id), protectionBefore);
  assert.equal((await persistCorrelatedFill(value.account, value.incoming)).fillId, value.fillId);
  await recordFeeEvent({ ...value.fee, providerEventId: 'new-transport-label', source: 'new-transport' });
  assert.deepEqual(await db.all('SELECT * FROM trading_money_events ORDER BY id'), money);
  const riskBound = riskHash(await loadRiskSources(value.account.id));
  await db.run("UPDATE trading_fills SET identity_status='conflict' WHERE id=?", [value.fillId]);
  assert.notEqual(riskHash(await loadRiskSources(value.account.id)), riskBound);
  assert.equal(await unresolvedFillIdentityCount(value.account), 1);
  await db.run("UPDATE trading_fills SET identity_status='proven' WHERE id=?", [value.fillId]);
  for (const exchange of ['hyperliquid', 'krakenfutures']) {
    const native = await legacyFillFixture(exchange, exchange);
    assert.equal(await bindLegacyFillIdentity(native.account, native.fillId), true, `${exchange} genuine native originals can bind without changing local ID.`);
  }
  const recent = await legacyFillFixture('kraken-recent', 'krakenfutures');
  await db.run('UPDATE trading_fills SET raw_json=? WHERE id=?', [JSON.stringify({ ...recent.incoming.raw, info: { fill_id: 'recent-id', order_id: '1234' } }),recent.fillId]);
  assert.equal(await bindLegacyFillIdentity(recent.account, recent.fillId), false, 'Recent fill_id cannot be aliased to execution.uid from equal economics.');
  assert.equal((await persistCorrelatedFill(recent.account, recent.incoming)).fillId, undefined);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM trading_fills WHERE account_id=?', [recent.account.id])).n, 1);

  const fair = await legacyFillFixture('fair');
  await withDatabaseTransaction(async () => {
    for (let index = 0; index < 501; index += 1) await db.run(`INSERT INTO trading_fills(${legacyFillColumns})
      VALUES(?,?,?,?,'100','1','0.1','USDT',1,'{}',NULL,NULL,0)`, [`unproved-${index.toString().padStart(4,'0')}`,fair.orderId,fair.account.id,`unproved-${index}`]);
  });
  let reads = 0;
  const originalGet = db.get;
  db.get = function (...args) { reads += 1; return originalGet.apply(this, args); };
  try { await backfillAccountFillIdentities(fair.account); } finally { db.get = originalGet; }
  assert.ok(reads <= 500, `Actual per-row attempt/read count is bounded, observed ${reads}.`);
  assert.equal((await db.get('SELECT identity_status FROM trading_fills WHERE id=?', [fair.fillId])).identity_status, 'legacy_unresolved');
  await backfillAccountFillIdentities(fair.account);
  assert.equal((await db.get('SELECT identity_status FROM trading_fills WHERE id=?', [fair.fillId])).identity_status, 'proven', 'Fair rotation reaches later valid originals.');
  assert.equal(await unresolvedFillIdentityCount(fair.account), 501, 'An incomplete batch cannot turn account-wide finality green.');
  await closeDb(); await initDb(filename);
  assert.equal(await unresolvedFillIdentityCount(value.account), 0);
  assert.equal(await unresolvedFillIdentityCount(fair.account), 501);
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  console.log('Legacy identity: immutable originals, historical journal, negative namespace/ACK fences, risk hash and bounded fair backfill passed.');
} finally { await closeDb(); await rm(directory, { recursive: true, force: true }); }
