import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDatabase, saveSignal } from '../src/db.js';
import { listTradingAccounts, listTradingStrategies } from '../src/trading_repository.js';
import { economicEvidence, persistCorrelatedFill, recordRemoteEvidence, resolveManagedHistoricalEvidence, unresolvedEvidenceCount } from '../src/trading_evidence_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'trading-evidence-'));
const databasePath = path.join(directory, 'test.db');
try {
  await initDb(databasePath);
  await seedTradingFixtures();
  const [account] = await listTradingAccounts();
  const [strategy] = await listTradingStrategies();
  await saveSignal('evidence-signal', '-evidence', 1, '<signal/>', '<signal/>');
  await getDatabase().run(
    `INSERT INTO trading_trade_intents (id, source_signal_id, root_source_signal_id, channel_id, strategy_version_id, account_id, exchange, mode,
     symbol, side, status, signal_json, created_at, updated_at)
     VALUES ('evidence-intent', 'evidence-signal', 'evidence-signal', '-evidence', ?, ?, 'paper', 'paper', 'BTCUSDT', 'LONG', 'submitting', '{}', 1, 1)`,
    [strategy.id, account.id],
  );
  await getDatabase().run(
    `INSERT INTO trading_orders (id, intent_id, account_id, client_order_id, exchange_order_id, provider_symbol, role, side,
     order_type, status, quantity, filled_quantity, reduce_only, request_json, created_at, updated_at)
     VALUES ('evidence-order', 'evidence-intent', ?, 'client', 'remote', 'BTCUSDT', 'entry', 'buy', 'limit', 'partially_filled', '1', '0.8', 0, '{}', 1, 1)`, [account.id],
  );
  const fill = { exchangeFillId: 'fill-a', clientOrderId: 'client', exchangeOrderId: 'remote', symbol: 'BTCUSDT', providerSymbol: 'BTCUSDT',
    price: '100', quantity: '0.4', fee: '0', feeAsset: 'USDT', filledAt: 123, raw: {} };
  assert.equal((await persistCorrelatedFill(account, { ...fill, clientOrderId: null })).inserted, false);
  assert.equal(await unresolvedEvidenceCount(account.id), 1);
  assert.equal((await persistCorrelatedFill(account, fill)).inserted, true, 'A later exact proven local order mapping may resolve the fill.');
  assert.equal(await unresolvedEvidenceCount(account.id), 0);
  assert.equal((await persistCorrelatedFill(account, { ...fill, fee: '0.0' })).inserted, false, 'Equivalent formatting is not changed economics.');
  assert.equal((await persistCorrelatedFill(account, { ...fill, exchangeFillId: 'fill-b' })).inserted, true);
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS count FROM trading_fills')).count, 2, 'Different real IDs must not collapse despite equal timestamp and economics.');
  assert.equal((await persistCorrelatedFill(account, { ...fill, quantity: '0.5' })).inserted, false);
  assert.equal((await getDatabase().get("SELECT quantity FROM trading_fills WHERE exchange_fill_id = 'fill-a'")).quantity, '0.4');
  assert.equal((await getDatabase().get("SELECT COUNT(*) AS count FROM trading_remote_evidence WHERE classification = 'conflict'")).count, 3,
    'Keep the original unmapped observation, its mapped version, and the changed economic evidence.');
  await persistCorrelatedFill(account, fill);
  assert.equal(await unresolvedEvidenceCount(account.id), 3, 'A later old version of a conflicting fill cannot erase the conflict.');
  const noIdentity = { kind: 'fill', source: 'fetchMyTrades', reason: 'missing_fill_id', providerId: null, providerSymbol: 'BTCUSDT',
    evidence: { price: '100', quantity: '0.1', cost: '10', filledAt: 123, apiKey: 'DO_NOT_SAVE', headers: 'DO_NOT_SAVE' } };
  await recordRemoteEvidence(account, noIdentity);
  await recordRemoteEvidence(account, noIdentity);
  const anonymous = await getDatabase().get('SELECT * FROM trading_remote_evidence WHERE provider_id IS NULL');
  assert.equal(anonymous.occurrence_count, 2);
  assert.equal(anonymous.classification, 'unresolved', 'Repeated anonymous observations are not proof of exactly one execution.');
  assert.doesNotMatch(anonymous.payload_json, /DO_NOT_SAVE|apiKey|headers/);
  assert.throws(() => economicEvidence({ quantity: '1'.repeat(257) }), /boundary/);
  const historical = { kind: 'order', source: 'fetchOrders', reason: 'historical_order_event', providerId: 'history-a', providerSymbol: 'BTCUSDT',
    evidence: { providerEventId: 'history-a', providerTimestamp: 123, eventType: 'OrderPlaced', eventOrderField: 'order',
      exchangeOrderId: 'remote', clientOrderId: null, providerSymbol: 'BTCUSDT', side: 'Buy', reduceOnly: false,
      providerReportedQuantity: '0.2', filledQuantity: '0.8' } };
  await recordRemoteEvidence(account, historical);
  const beforeOrder = await getDatabase().get("SELECT * FROM trading_orders WHERE id = 'evidence-order'");
  await resolveManagedHistoricalEvidence(account.id);
  assert.equal((await getDatabase().get("SELECT classification FROM trading_remote_evidence WHERE provider_id = 'history-a'")).classification, 'managed');
  assert.deepEqual(await getDatabase().get("SELECT * FROM trading_orders WHERE id = 'evidence-order'"), beforeOrder, 'History classification cannot regress or resize the current order.');
  for (const [id, changed] of [['history-foreign-side', { side: 'Sell' }], ['history-foreign-client', { clientOrderId: 'foreign' }],
    ['history-more-filled', { filledQuantity: '0.9' }], ['history-missing-filled', { filledQuantity: null }]]) {
    await recordRemoteEvidence(account, { ...historical, providerId: id, evidence: { ...historical.evidence, providerEventId: id, ...changed } });
  }
  await resolveManagedHistoricalEvidence(account.id);
  assert.equal((await getDatabase().get("SELECT COUNT(*) AS count FROM trading_remote_evidence WHERE provider_id LIKE 'history-%' AND classification = 'unresolved'")).count, 4);
  await getDatabase().run("UPDATE trading_orders SET filled_quantity = '0.9' WHERE id = 'evidence-order'");
  await persistCorrelatedFill(account, { ...fill, exchangeFillId: 'fill-c', quantity: '0.1' });
  await resolveManagedHistoricalEvidence(account.id);
  assert.equal((await getDatabase().get("SELECT classification FROM trading_remote_evidence WHERE provider_id = 'history-more-filled'")).classification, 'managed', 'Durable historical evidence resolves only after matching actual fills arrive.');
  const retained = await getDatabase().all('SELECT * FROM trading_remote_evidence ORDER BY id');
  await closeDb();
  await initDb(databasePath);
  assert.deepEqual(await getDatabase().all('SELECT * FROM trading_remote_evidence ORDER BY id'), retained);
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  console.log('Durable remote evidence, exact fill dedupe, conflict and restart tests passed.');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
