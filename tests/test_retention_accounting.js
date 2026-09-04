import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, pruneOperationalData } from '../src/db.js';
import { seedTradingFixtures } from './trading_fixtures.js';

const NOW = Date.UTC(2030, 5, 1);
const OLD = NOW - 91 * 86400000;

async function intent(database, strategyId, id) {
  await database.run(`INSERT INTO signals (id, chat_id, message_id, xml_content, normalized_content, created_at)
    VALUES (?, '-1001', ?, '<signal/>', '<signal/>', ?)`, [`signal-${id}`, id, OLD]);
  await database.run(`INSERT INTO trading_trade_intents (id, source_signal_id, root_source_signal_id, channel_id,
    strategy_version_id, account_id, exchange, mode, symbol, side, status, signal_json, created_at, updated_at)
    VALUES (?, ?, ?, '-1001', ?, 'paper-default', 'paper', 'paper', 'BTCUSDT', 'LONG', 'completed', '{}', ?, ?)`,
  [id, `signal-${id}`, `signal-${id}`, strategyId, OLD, OLD]);
}

async function order(database, id, filled = '0') {
  await database.run(`INSERT INTO trading_orders (id, intent_id, account_id, client_order_id, exchange_order_id,
    role, side, order_type, status, quantity, filled_quantity, reduce_only, request_json, created_at, updated_at)
    VALUES (?, ?, 'paper-default', ?, ?, 'entry', 'buy', 'limit', 'filled', '1', ?, 0, '{}', ?, ?)`,
  [`order-${id}`, id, `client-${id}`, `paper-${id}`, filled, OLD, OLD]);
}

async function seedAccountingEvidence(database, strategyId) {
  const protectedIds = ['pending', 'complete', 'unresolved', 'evidence', 'money', 'legacy-fill', 'filled-order', 'risk-contract'];
  for (const id of [...protectedIds, 'deletable']) await intent(database, strategyId, id);
  await database.run("INSERT INTO trading_accounting_pending (intent_id, account_id) VALUES ('pending', 'paper-default')");
  for (const status of ['complete', 'unresolved']) {
    await database.run(`INSERT INTO trading_accounting_projections
      (intent_id, account_id, evidence_hash, status, updated_at) VALUES (?, 'paper-default', ?, ?, ?)`, [status, 'a'.repeat(64), status, OLD]);
  }
  await database.run(`INSERT INTO trading_accounting_projection_evidence
    (id, intent_id, account_id, evidence_json, status, created_at)
    VALUES ('evidence-old', 'evidence', 'paper-default', '{"source":"fixture"}', 'unresolved', ?)`, OLD);
  await database.run(`INSERT INTO trading_money_events (id, account_id, account_fingerprint, provider_event_id,
    kind, source, basis, occurred_at, amount, asset, intent_id, content_json, recorded_at)
    VALUES ('money-old', 'paper-default', 'fixture-binding', 'provider-money-old', 'fee', 'fixture', 'fill', ?, '-1', NULL, 'money', '{}', ?)`, [OLD, OLD]);
  await order(database, 'legacy-fill');
  await database.run(`INSERT INTO trading_fills (id, order_id, account_id, exchange_fill_id, price, quantity, fee, fee_asset, filled_at, raw_json)
    VALUES ('legacy-fill-old', 'order-legacy-fill', 'paper-default', 'remote-legacy-fill', '100', '1', '1', NULL, ?, '{}')`, OLD);
  // Characterize a legacy fill whose pending projection was never durably available.
  await database.run("DELETE FROM trading_accounting_pending WHERE intent_id = 'legacy-fill'");
  await order(database, 'filled-order', '1');
  await database.run(`INSERT INTO trading_risk_contracts (intent_id, account_id, account_fingerprint, credential_generation, metadata_json, observed_at)
    VALUES ('risk-contract', 'paper-default', 'paper:paper-default', NULL, '{"source":"original-risk-contract"}', ?)`, [OLD]);
  return protectedIds;
}

async function paperOrder(database, id, filled) {
  await database.run(`INSERT INTO trading_paper_orders (exchange_order_id, account_id, client_order_id,
    symbol, role, side, order_type, status, quantity, filled_quantity, reduce_only, leverage, created_at, updated_at)
    VALUES (?, 'paper-default', ?, 'BTCUSDT', 'entry', 'buy', 'limit', 'cancelled', '1', ?, 0, 1, ?, ?)`,
  [id, `client-${id}`, filled, OLD, OLD]);
}

async function seedPaperEvidence(database) {
  await paperOrder(database, 'paper-with-fill', '0');
  await paperOrder(database, 'paper-filled-unindexed', '1');
  await paperOrder(database, 'paper-legacy-fill', '0');
  await paperOrder(database, 'paper-empty', '0');
  await database.run(`INSERT INTO trading_paper_fills (exchange_fill_id, exchange_order_id, account_id,
    client_order_id, price, quantity, fee, fee_asset, filled_at, raw_json)
    VALUES ('original-paper-fill', 'paper-with-fill', 'paper-default', 'client-paper-with-fill', '100', '1', '0', NULL, ?, '{}')`, OLD);
}

const directory = await mkdtemp(path.join(os.tmpdir(), 'accounting-retention-fixture-'));
try {
  await initDb(path.join(directory, 'retention.db'));
  await seedTradingFixtures(OLD);
  const database = getDatabase();
  const strategy = await database.get('SELECT id FROM trading_strategy_versions LIMIT 1');
  const protectedIds = await seedAccountingEvidence(database, strategy.id);
  await seedPaperEvidence(database);
  const evidence = async () => ({
    pending: await database.all('SELECT * FROM trading_accounting_pending ORDER BY intent_id'),
    projections: await database.all('SELECT * FROM trading_accounting_projections ORDER BY intent_id'),
    provenance: await database.all('SELECT * FROM trading_accounting_projection_evidence ORDER BY id'),
    events: await database.all('SELECT * FROM trading_money_events ORDER BY id'),
    fills: await database.all('SELECT * FROM trading_fills ORDER BY id'),
    paperFills: await database.all('SELECT * FROM trading_paper_fills ORDER BY exchange_fill_id'),
    riskContracts: await database.all('SELECT * FROM trading_risk_contracts ORDER BY intent_id'),
  });
  const before = await evidence();
  let result;
  await assert.doesNotReject(async () => { result = await pruneOperationalData(90, 100, NOW); },
    'Operational retention must exclude immutable accounting evidence before reaching the intent FK-RESTRICT boundary.');
  assert.equal(result.tradingIntents, 1, 'Only a terminal intent without any accounting or fill evidence may be pruned.');
  assert.equal(result.paperOrders, 1, 'Paper provenance and still-referenced orders must remain available for replay.');
  assert.deepEqual((await database.all('SELECT id FROM trading_trade_intents ORDER BY id')).map(row => row.id), protectedIds.sort());
  for (const id of protectedIds) assert.ok(await database.get('SELECT id FROM signals WHERE id = ?', `signal-${id}`));
  assert.deepEqual(await evidence(), before, 'No accounting evidence or legacy fill may change during operational retention.');
  assert.deepEqual((await database.all('SELECT exchange_order_id FROM trading_paper_orders ORDER BY exchange_order_id')).map(row => row.exchange_order_id),
    ['paper-filled-unindexed', 'paper-legacy-fill', 'paper-with-fill']);
  assert.equal((await pruneOperationalData(90, 100, NOW)).tradingIntents, 0);
  assert.deepEqual(await evidence(), before, 'A repeated retention pass must preserve the same complete and unresolved evidence.');
  assert.deepEqual(await database.all('PRAGMA foreign_key_check'), []);
} finally { await closeDb(); await rm(directory, { recursive: true, force: true }); }

console.log('Retention: immutable money/projection evidence, unvalued legacy fills and original paper provenance retained.');
