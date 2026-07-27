import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import {
  beginDatabaseMaintenance,
  closeDb,
  getDatabase,
  getDatabaseStorageStats,
  initDb,
  pruneOperationalData,
  saveSignal,
  withDatabaseTransaction
} from '../src/db.js';
import { ensureTradingDefaults } from '../src/trading_repository.js';
import {
  OperationalDataRetention,
  retentionPolicyFromEnvironment
} from '../src/retention.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2030, 5, 1);
const OLD = NOW - 91 * DAY_MS;
const RECENT = NOW - DAY_MS;

async function assertSerializedTransactionOwnership() {
  let markTransactionStarted;
  let releaseTransaction;
  const transactionStarted = new Promise(resolve => { markTransactionStarted = resolve; });
  const transactionBarrier = new Promise(resolve => { releaseTransaction = resolve; });
  const rolledBack = withDatabaseTransaction(async database => {
    await database.run(
      `INSERT INTO signals (id, chat_id, message_id, xml_content, normalized_content, created_at)
       VALUES ('transaction-owned', '-1001', 900, '<signal/>', '<signal/>', ?)`,
      [NOW],
    );
    markTransactionStarted();
    await transactionBarrier;
    throw new Error('forced transaction rollback');
  });
  await transactionStarted;
  let concurrentWriteCompleted = false;
  const concurrentWrite = saveSignal(
    'concurrent-survivor', '-1001', 901, '<signal/>', '<signal/>'
  ).then(() => { concurrentWriteCompleted = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(concurrentWriteCompleted, false, 'A foreign write must wait for the active transaction owner.');
  releaseTransaction();
  await assert.rejects(rolledBack, /forced transaction rollback/);
  await concurrentWrite;
  assert.equal(
    await getDatabase().get('SELECT id FROM signals WHERE id = ?', ['transaction-owned']),
    undefined,
    'The owner transaction must roll back its own write.',
  );
  assert.equal(
    (await getDatabase().get('SELECT id FROM signals WHERE id = ?', ['concurrent-survivor']))?.id,
    'concurrent-survivor',
    'A queued foreign write must commit after the rollback instead of joining it.',
  );
  await getDatabase().run('DELETE FROM signals WHERE id = ?', ['concurrent-survivor']);

  const capturedDatabaseHandle = getDatabase();
  const maintenance = await beginDatabaseMaintenance('transaction regression test');
  assert.throws(() => getDatabase(), /maintenance is active/);
  await assert.rejects(capturedDatabaseHandle.get('SELECT 1'), /maintenance is active/);
  maintenance.release();
  assert.ok(getDatabase(), 'Releasing maintenance must restore database availability.');
}

async function seedRetentionRows(dbPath) {
  const database = await open({ filename: dbPath, driver: sqlite3.Database });
  await database.run(
    `INSERT INTO pending_tasks (id, type, chat_id, message_id, added_at, status, updated_at, completed_at)
     VALUES
       ('completed-old', 'single', '-1001', 1, ?, 'completed', ?, ?),
       ('completed-recent', 'single', '-1001', 2, ?, 'completed', ?, ?),
       ('failed-old', 'single', '-1001', 3, ?, 'failed', ?, NULL),
       ('unknown-old', 'single', '-1001', 4, ?, 'unknown', ?, NULL)`,
    [OLD, OLD, OLD, RECENT, RECENT, RECENT, OLD, OLD, OLD, OLD]
  );
  await database.run(
    `INSERT INTO incoming_messages (chat_id, message_id, sender, text, type, status, created_at)
     VALUES
       ('-1001', 10, 'sender', 'processed old', 'text', 'processed', ?),
       ('-1001', 11, 'sender', 'filtered old', 'text', 'filtered', ?),
       ('-1001', 12, 'sender', 'failed old', 'text', 'failed', ?),
       ('-1001', 13, 'sender', 'processed recent', 'text', 'processed', ?)`,
    [OLD, OLD, OLD, RECENT]
  );
  await database.run(
    `INSERT INTO signals (id, chat_id, message_id, xml_content, normalized_content, created_at)
     VALUES
       ('signal-old-delete', '-1001', 20, '<signal/>', '<signal/>', ?),
       ('signal-old-protected', '-1001', 3, '<signal/>', '<signal/>', ?),
       ('signal-recent', '-1001', 21, '<signal/>', '<signal/>', ?)`,
    [OLD, OLD, RECENT]
  );
  await database.run(
    `INSERT INTO ai_usage_daily (usage_day, request_count, used_tokens, reserved_tokens, updated_at)
     VALUES ('2029-01-01', 1, 10, 0, ?), ('2030-05-31', 1, 10, 0, ?)`,
    [OLD, RECENT]
  );
  await database.close();
}

async function seedTradingRetentionRows(database, strategyId) {
  await database.run(
    `INSERT INTO signals (id, chat_id, message_id, xml_content, normalized_content, created_at)
     VALUES ('signal-trading-old', '-1001', 30, '<signal/>', '<signal/>', ?),
            ('signal-trading-unknown', '-1001', 31, '<signal/>', '<signal/>', ?),
            ('signal-trading-critical', '-1001', 32, '<signal/>', '<signal/>', ?)`,
    [OLD, OLD, OLD]
  );
  for (const [id, source, status] of [
    ['intent-old', 'signal-trading-old', 'completed'],
    ['intent-unknown', 'signal-trading-unknown', 'unknown'],
    ['intent-critical', 'signal-trading-critical', 'completed']
  ]) {
    await database.run(
      `INSERT INTO trading_trade_intents (
         id, source_signal_id, channel_id, strategy_version_id, account_id, exchange, mode,
         symbol, side, status, signal_json, created_at, updated_at
       ) VALUES (?, ?, '-1001', ?, 'paper-default', 'paper', 'paper', 'BTCUSDT', 'LONG', ?, '{}', ?, ?)`,
      [id, source, strategyId, status, OLD, OLD]
    );
  }
  await database.run(
    `INSERT INTO trading_risk_events (id, severity, code, account_id, intent_id, details_json, created_at)
     VALUES ('risk-old', 'info', 'TEST', 'paper-default', 'intent-old', '{}', ?),
            ('risk-critical', 'critical', 'TEST_CRITICAL', 'paper-default', 'intent-critical', '{}', ?)`,
    [OLD, OLD]
  );
  await database.run(
    `INSERT INTO trading_reconciliation_runs (id, account_id, status, started_at, completed_at)
     VALUES ('reconcile-old', 'paper-default', 'succeeded', ?, ?)`, [OLD, OLD]
  );
  await database.run(
    `INSERT INTO trading_paper_orders (
       exchange_order_id, account_id, client_order_id, symbol, role, side, order_type, status,
       quantity, filled_quantity, reduce_only, leverage, created_at, updated_at
     ) VALUES ('paper-old', 'paper-default', 'paper-client-old', 'BTCUSDT', 'entry', 'buy', 'limit',
               'filled', '1', '1', 0, 1, ?, ?)`, [OLD, OLD]
  );
}

async function runTests() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forwarder-retention-'));
  const dbPath = path.join(root, 'retention.db');
  try {
    await initDb(dbPath);
    await ensureTradingDefaults(OLD);
    await assertSerializedTransactionOwnership();
    await seedRetentionRows(dbPath);
    const database = getDatabase();
    const strategy = await database.get('SELECT id FROM trading_strategy_versions LIMIT 1');
    await seedTradingRetentionRows(database, strategy.id);

    const result = await pruneOperationalData(90, 100, NOW);
    assert.deepEqual(result, {
      completedOutbox: 1,
      incomingMessages: 2,
      signals: 2,
      aiUsageDays: 1,
      tradingIntents: 1,
      tradingReconciliations: 1,
      paperOrders: 1
    });

    const inspection = await open({ filename: dbPath, driver: sqlite3.Database });
    assert.deepEqual(
      (await inspection.all('SELECT id FROM pending_tasks ORDER BY id')).map(row => row.id),
      ['completed-recent', 'failed-old', 'unknown-old']
    );
    assert.deepEqual(
      (await inspection.all('SELECT message_id FROM incoming_messages ORDER BY message_id')).map(row => row.message_id),
      [12, 13]
    );
    assert.deepEqual(
      (await inspection.all('SELECT id FROM signals ORDER BY id')).map(row => row.id),
      ['signal-old-protected', 'signal-recent', 'signal-trading-critical', 'signal-trading-unknown']
    );
    assert.deepEqual(
      (await inspection.all('SELECT id FROM trading_trade_intents ORDER BY id')).map(row => row.id),
      ['intent-critical', 'intent-unknown'],
      'Unknown outcomes and unacknowledged critical trading evidence must never be pruned automatically.'
    );
    await inspection.close();

    const storage = await getDatabaseStorageStats();
    assert.ok(storage.allocatedBytes > 0);
    assert.ok(storage.reusableBytes >= 0);

    const policy = retentionPolicyFromEnvironment({
      DATA_RETENTION_DAYS: '90',
      DATA_RETENTION_INTERVAL_MS: '300000',
      DATA_RETENTION_BATCH_SIZE: '100',
      DATA_MIN_FREE_BYTES: '67108864'
    });
    const messages = [];
    const scheduler = new OperationalDataRetention(policy, message => messages.push(message), () => NOW);
    await scheduler.start();
    await assert.rejects(() => scheduler.start(), /already running/);
    assert.equal(scheduler.getStatus().healthy, true);
    assert.ok(messages.some(message => message.includes('Operational retention deleted')));
    await scheduler.stop();

    assert.throws(
      () => retentionPolicyFromEnvironment({ DATA_RETENTION_DAYS: '0' }),
      /DATA_RETENTION_DAYS/
    );
    console.log('ALL OPERATIONAL DATA RETENTION TESTS PASSED!');
  } finally {
    await closeDb();
    await rm(root, { recursive: true, force: true });
  }
}

await runTests().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
