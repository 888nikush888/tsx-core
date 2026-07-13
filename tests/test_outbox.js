import assert from 'assert';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import {
  acknowledgeOutboxTask,
  claimOutboxTask,
  closeDb,
  completeOutboxTask,
  enqueueOutboxTask,
  failOutboxTask,
  getIncomingMessages,
  getAiUsage,
  getLastForwardedAt,
  getMediaGroupBuffers,
  getOutboxStatusCounts,
  getOutboxTask,
  getTotalForwardedCount,
  incrementForwardedCount,
  initDb,
  isDatabaseHealthy,
  listOutboxTasks,
  markOutboxSending,
  recoverInterruptedOutboxTasks,
  removeMediaGroupBuffer,
  reserveAiUsage,
  commitAiUsage,
  requeueOutboxTask,
  saveIncomingMessage,
  saveMediaGroupBuffer,
  saveSignal
} from '../src/db.js';

function task(id, messageId) {
  return {
    id,
    type: 'single',
    chatId: '-1001',
    messageId,
    addedAt: Date.now(),
    config: { targetChannel: '@target' }
  };
}

async function runTests() {
  const testDir = await mkdtemp(path.join(os.tmpdir(), 'forwarder-outbox-test-'));
  const dbPath = path.join(testDir, 'legacy.db');

  try {
    const legacyDb = await open({ filename: dbPath, driver: sqlite3.Database });
    await legacyDb.exec(`
      CREATE TABLE pending_tasks (
        id TEXT PRIMARY KEY,
        type TEXT,
        chat_id TEXT,
        message_id INTEGER,
        message_ids TEXT,
        media_group_id TEXT,
        added_at INTEGER
      );
      INSERT INTO pending_tasks (id, type, chat_id, message_id, added_at)
      VALUES ('legacy-task', 'single', '-1001', 1, 1000);

      CREATE TABLE incoming_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT,
        message_id INTEGER,
        sender TEXT,
        text TEXT,
        type TEXT,
        status TEXT,
        created_at INTEGER
      );
      INSERT INTO incoming_messages (chat_id, message_id, sender, text, type, status, created_at)
      VALUES ('-1001', 7, 'sender', 'first', 'text', 'received', 1),
             ('-1001', 7, 'sender', 'duplicate', 'text', 'received', 2);
    `);
    await legacyDb.close();

    await initDb(dbPath);

    assert.strictEqual(await isDatabaseHealthy(), true);
    await incrementForwardedCount(2, 1_700_000_000_000);
    assert.strictEqual(await getTotalForwardedCount(), 2);
    assert.strictEqual(await getLastForwardedAt(), 1_700_000_000_000);

    const legacyTask = await getOutboxTask('legacy-task');
    assert.strictEqual(legacyTask.status, 'pending', 'Legacy rows must migrate to pending');
    assert.strictEqual(legacyTask.attempts, 0);
    assert.strictEqual(legacyTask.updatedAt, 1000);

    assert.strictEqual(await enqueueOutboxTask(task('task-1', 11)), true);
    assert.strictEqual(await enqueueOutboxTask(task('task-1', 11)), false, 'Outbox ids must be idempotent');

    let claimed = await claimOutboxTask('task-1');
    assert.strictEqual(claimed.status, 'preparing');
    assert.strictEqual(claimed.attempts, 1);
    assert.strictEqual(await claimOutboxTask('task-1'), null, 'A claimed task cannot be claimed twice');

    await markOutboxSending('task-1');
    assert.strictEqual(await failOutboxTask('task-1', new Error('response lost')), 'unknown');
    assert.strictEqual((await getOutboxTask('task-1')).status, 'unknown');

    assert.strictEqual(await requeueOutboxTask('task-1'), true);
    claimed = await claimOutboxTask('task-1');
    assert.strictEqual(claimed.attempts, 2);
    await completeOutboxTask('task-1', { destinationMessageIds: ['99'] });
    const completed = await getOutboxTask('task-1');
    assert.strictEqual(completed.status, 'completed');
    assert.deepStrictEqual(completed.result.destinationMessageIds, ['99']);

    await enqueueOutboxTask(task('task-failed', 12));
    await claimOutboxTask('task-failed');
    assert.strictEqual(await failOutboxTask('task-failed', new Error('prepare failed')), 'failed');

    await enqueueOutboxTask(task('task-preparing-crash', 13));
    await claimOutboxTask('task-preparing-crash');
    await enqueueOutboxTask(task('task-sending-crash', 14));
    await claimOutboxTask('task-sending-crash');
    await markOutboxSending('task-sending-crash');
    const recovery = await recoverInterruptedOutboxTasks();
    assert.deepStrictEqual(recovery, { requeued: 1, unknown: 1 });
    assert.strictEqual((await getOutboxTask('task-preparing-crash')).status, 'pending');
    assert.strictEqual((await getOutboxTask('task-sending-crash')).status, 'unknown');
    assert.strictEqual(await acknowledgeOutboxTask('task-sending-crash', 'Confirmed manually in target channel'), true);
    assert.strictEqual((await getOutboxTask('task-sending-crash')).status, 'completed');

    const unresolved = await listOutboxTasks(['failed', 'unknown']);
    assert.deepStrictEqual(unresolved.map(item => item.id), ['task-failed']);
    const statusCounts = await getOutboxStatusCounts();
    assert.strictEqual(statusCounts.failed, 1);
    assert.strictEqual(statusCounts.unknown, 0);
    assert.ok(statusCounts.completed >= 2);

    const incomingAfterMigration = await getIncomingMessages(100);
    assert.strictEqual(incomingAfterMigration.filter(message => message.chat_id === '-1001' && message.message_id === 7).length, 1, 'Migration must deduplicate inbox rows');
    assert.strictEqual(await saveIncomingMessage('-1001', 8, 'sender', 'new', 'text', 'received'), true);
    assert.strictEqual(await saveIncomingMessage('-1001', 8, 'sender', 'duplicate', 'text', 'received'), false, 'Inbox uniqueness must block duplicate updates');

    await saveMediaGroupBuffer('group-1', '-1001', [{ id: 21 }, { id: 22 }]);
    const buffers = await getMediaGroupBuffers();
    assert.deepStrictEqual(buffers['group-1'].messages.map(message => message.id), [21, 22]);
    await removeMediaGroupBuffer('group-1');
    assert.strictEqual((await getMediaGroupBuffers())['group-1'], undefined);

    const usageDay = '2030-01-02';
    assert.strictEqual(await reserveAiUsage(usageDay, 600, 2, 1000), true);
    assert.strictEqual(await reserveAiUsage(usageDay, 500, 2, 1000), false, 'Token reservations must fail closed at the daily limit');
    await commitAiUsage(usageDay, 600, 450);
    assert.deepStrictEqual(await getAiUsage(usageDay), {
      requestCount: 1,
      usedTokens: 450,
      reservedTokens: 0
    });
    assert.strictEqual(await reserveAiUsage(usageDay, 500, 2, 1000), true);
    assert.strictEqual(await reserveAiUsage(usageDay, 1, 2, 1000), false, 'Request count must fail closed at the daily limit');
    await commitAiUsage(usageDay, 500, 500);
    assert.deepStrictEqual(await getAiUsage(usageDay), {
      requestCount: 2,
      usedTokens: 950,
      reservedTokens: 0
    });

    await saveSignal('provenance-signal', '-1001', 99, '<signal/>', '<signal/>', {
      templateName: 'loma',
      schemaName: 'loma',
      promptSha256: 'a'.repeat(64),
      model: 'test/model',
      providerRequestId: 'req-99',
      promptTokens: 12,
      completionTokens: 34,
      parserVersion: '2.0.0'
    });
    const inspectionDb = await open({ filename: dbPath, driver: sqlite3.Database });
    const provenance = await inspectionDb.get(
      'SELECT template_name, schema_name, prompt_sha256, model, provider_request_id, prompt_tokens, completion_tokens, parser_version FROM signals WHERE id = ?',
      ['provenance-signal']
    );
    await inspectionDb.close();
    assert.deepStrictEqual(provenance, {
      template_name: 'loma',
      schema_name: 'loma',
      prompt_sha256: 'a'.repeat(64),
      model: 'test/model',
      provider_request_id: 'req-99',
      prompt_tokens: 12,
      completion_tokens: 34,
      parser_version: '2.0.0'
    });

    console.log('ALL DURABLE OUTBOX TESTS PASSED!');
  } finally {
    await closeDb();
    await rm(testDir, { recursive: true, force: true });
  }
}

runTests().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
