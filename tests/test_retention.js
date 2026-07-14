import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import {
  closeDb,
  getDatabaseStorageStats,
  initDb,
  pruneOperationalData
} from '../src/db.js';
import {
  OperationalDataRetention,
  retentionPolicyFromEnvironment
} from '../src/retention.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2030, 5, 1);
const OLD = NOW - 91 * DAY_MS;
const RECENT = NOW - DAY_MS;

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

async function runTests() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forwarder-retention-'));
  const dbPath = path.join(root, 'retention.db');
  try {
    await initDb(dbPath);
    await seedRetentionRows(dbPath);

    const result = await pruneOperationalData(90, 100, NOW);
    assert.deepEqual(result, {
      completedOutbox: 1,
      incomingMessages: 2,
      signals: 1,
      aiUsageDays: 1
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
      ['signal-old-protected', 'signal-recent']
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
    await scheduler.runNow();
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
