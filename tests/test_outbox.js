import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { ConcurrencyQueue } from '../src/queue.js';
import { DurableOutboxScheduler } from '../src/outbox_scheduler.js';
import assert from 'assert';
import { mkdtemp, readdir, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { acquireProcessLock } from '../src/process_lock.js';
import { beginMcpOfflineMaintenance } from '../src/mcp_maintenance.js';
import { restorePreMigrationSnapshot } from '../src/migration_recovery.js';
import {
  acknowledgeOutboxTask,
  withDatabaseTransaction,
  claimOutboxTask,
  closeDb,
  completeOutboxTask,
  enqueueOutboxTask,
  failOutboxTask,
  getIncomingMessages,
  getDatabase,
  requireOutboxMessageIds,
  OutboxMessageIdsError,
  getAiUsage,
  getLastForwardedAt,
  getMediaGroupBuffers,
  getOutboxStatusCounts,
  getOutboxTask,
  getTotalForwardedCount,
  incrementForwardedCount,
  initDb,
  getSchemaVersion,
  LATEST_SCHEMA_VERSION,
  isDatabaseHealthy,
  listPendingOutboxTasksForScheduling,
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

async function prepareLegacyDatabase(testDir, dbPath) {
    const futurePath = path.join(testDir, 'future.db');
    const futureDb = await open({ filename: futurePath, driver: sqlite3.Database });
    await futureDb.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
      INSERT INTO schema_migrations VALUES (999, 'future', '${'f'.repeat(64)}', 1);
    `);
    await futureDb.close();
    await assert.rejects(initDb(futurePath), /schema is newer than this binary/);

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
             ('-1001', 7, 'sender', 'duplicate', 'text', 'received', 2),
             (NULL, NULL, 'legacy', 'unidentified-1', 'text', 'received', 3),
             (NULL, NULL, 'legacy', 'unidentified-2', 'text', 'received', 4);
    `);
    await legacyDb.close();

    await initDb(dbPath);
    assert.strictEqual(await getSchemaVersion(), LATEST_SCHEMA_VERSION);
}

async function testOutboxLifecycle() {
    assert.strictEqual(await isDatabaseHealthy(), true);
    assert.strictEqual(await getTotalForwardedCount(), 0);
    assert.strictEqual(await getLastForwardedAt(), null);
    await incrementForwardedCount(0, 1_700_000_000_000);
    assert.strictEqual(await getTotalForwardedCount(), 0);
    await assert.rejects(incrementForwardedCount(1, 0), /positive timestamp/);
    await incrementForwardedCount(2, 1_700_000_000_000);
    assert.strictEqual(await getTotalForwardedCount(), 2);
    assert.strictEqual(await getLastForwardedAt(), 1_700_000_000_000);

    const legacyTask = await getOutboxTask('legacy-task');
    assert.strictEqual(legacyTask.status, 'needs_review', 'Unproven legacy rows must never replay automatically');
    assert.equal(await claimOutboxTask('legacy-task'), null);
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

    await enqueueOutboxTask({ ...task('schedule-a', 21), addedAt: 100 });
    await enqueueOutboxTask({ ...task('schedule-b', 22), addedAt: 101 });
    await enqueueOutboxTask({ ...task('schedule-c', 23), addedAt: 102 });
    const schedulable = await listPendingOutboxTasksForScheduling(['schedule-a'], 2);
    assert.deepStrictEqual(
      schedulable.map(item => item.id),
      ['schedule-b', 'schedule-c'],
      'Scheduler paging must skip tasks already represented in the bounded in-memory window.'
    );
}

async function testAuxiliaryPersistence() {
    const incomingAfterMigration = await getIncomingMessages(100);
    assert.strictEqual(incomingAfterMigration.filter(message => message.chat_id === '-1001' && message.message_id === 7).length, 1, 'Migration must deduplicate inbox rows');
    assert.strictEqual(incomingAfterMigration.filter(message => message.chat_id === null && message.message_id === null).length, 2, 'Migration must not collapse legacy rows without a delivery identity');
    assert.strictEqual(await saveIncomingMessage('-1001', 8, 'sender', 'new', 'text', 'received'), true);
    assert.strictEqual(await saveIncomingMessage('-1001', 8, 'sender', 'duplicate', 'text', 'received'), false, 'Inbox uniqueness must block duplicate updates');

    await saveMediaGroupBuffer('group-1', '-1001', [{ id: 21 }, { id: 22 }]);
    const buffers = await getMediaGroupBuffers();
    assert.deepStrictEqual(buffers['group-1'].messages.map(message => message.id), [21, 22]);
    await removeMediaGroupBuffer('group-1');
    assert.strictEqual((await getMediaGroupBuffers())['group-1'], undefined);

    const usageDay = '2030-01-02';
    const firstReservation = await reserveAiUsage(usageDay, 600, 2, 1000);
    assert.ok(firstReservation.id);
    assert.strictEqual(await reserveAiUsage(usageDay, 500, 2, 1000), false, 'Token reservations must fail closed at the daily limit');
    await commitAiUsage(firstReservation.id, 600, 450);
    assert.deepStrictEqual(await getAiUsage(usageDay), {
      requestCount: 1,
      usedTokens: 450,
      reservedTokens: 0
    });
    const secondReservation = await reserveAiUsage(usageDay, 500, 2, 1000);
    assert.ok(secondReservation.id);
    assert.strictEqual(await reserveAiUsage(usageDay, 1, 2, 1000), false, 'Request count must fail closed at the daily limit');
    await commitAiUsage(secondReservation.id, 500, 500);
    assert.deepStrictEqual(await getAiUsage(usageDay), {
      requestCount: 2,
      usedTokens: 950,
      reservedTokens: 0
    });
}

async function testSignalProvenance(dbPath) {
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

    await saveSignal('empty-provenance-signal', '-1001', 100, '<signal/>', '<signal/>', {
      templateName: '',
      schemaName: '',
      promptSha256: '',
      model: '',
      providerRequestId: '',
      promptTokens: null,
      completionTokens: null,
      parserVersion: ''
    });
    const emptyProvenance = await inspectionDb.get(
      'SELECT template_name, schema_name, prompt_sha256, model, provider_request_id, prompt_tokens, completion_tokens, parser_version FROM signals WHERE id = ?',
      ['empty-provenance-signal']
    );
    assert.deepStrictEqual(emptyProvenance, {
      template_name: null,
      schema_name: null,
      prompt_sha256: null,
      model: null,
      provider_request_id: null,
      prompt_tokens: null,
      completion_tokens: null,
      parser_version: null
    });
    await inspectionDb.close();
}

async function testPersistedMessageIdBoundary() {
  const database = getDatabase();
  const malformed = [null, '12', {}, { length: 2 }, [], [1, '2'], [1, null], [1, 1.5], [9007199254740992]];
  for (const [index, value] of malformed.entries()) {
    const id = `shape-media-${index}`;
    await enqueueOutboxTask({ id, type: 'mediaGroup', chatId: '-1001', mediaGroupId: id,
      messageIds: [1, 2], addedAt: Date.now(), config: { preserved: true } });
    await database.run('UPDATE pending_tasks SET message_ids = ? WHERE id = ?', [JSON.stringify(value), id]);
    const listed = (await listOutboxTasks()).find(row => row.id === id);
    assert.deepStrictEqual(listed.messageIds, value, 'Valid JSON with wrong shape stays visible for inspection.');
    assert.deepStrictEqual(listed.config, { preserved: true }, 'Unrelated JSON stays opaque and unchanged.');
    const claimed = await claimOutboxTask(id);
    assert.strictEqual(claimed.status, 'preparing');
    let failure = null;
    try { requireOutboxMessageIds(claimed); } catch (error) { failure = error; }
    assert(failure instanceof OutboxMessageIdsError);
    assert.strictEqual(await failOutboxTask(id, failure), 'needs_review');
    assert.strictEqual((await getOutboxTask(id)).status, 'needs_review');
    assert(!(await listPendingOutboxTasksForScheduling()).some(row => row.id === id),
      'Malformed historical metadata must not enter automatic retry scheduling.');
  }
  const accepted = [0, -1, 2, 2, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER];
  await enqueueOutboxTask({ id: 'shape-valid', type: 'mediaGroup', chatId: '-1001', mediaGroupId: 'shape-valid',
    messageIds: accepted, addedAt: Date.now() });
  const valid = await claimOutboxTask('shape-valid');
  assert.deepStrictEqual(requireOutboxMessageIds(valid), accepted, 'Order, duplicates and existing signed-safe domain survive.');
  await markOutboxSending(valid.id);
  assert.strictEqual(await failOutboxTask(valid.id, new OutboxMessageIdsError(valid.id)), 'unknown',
    'Sending always remains unknown; a metadata error must not downgrade possible provider side effects.');
  await database.run("DELETE FROM pending_tasks WHERE id LIKE 'shape-media-%' OR id = 'shape-valid'");
}

function createOutboxExecutionHarness() {
  const source = readFileSync(new URL('../src/forwarder.ts', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('forwarder.ts', source, ts.ScriptTarget.Latest, true);
  const names = ['executePersistedOutboxTask', 'executeScheduledOutboxTask'];
  const functions = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  assert.strictEqual(functions.length, 2, 'Exercise the actual persisted/scheduled execution bodies.');
  const sending = [], provider = [], scheduled = [], schedulerErrors = [];
  const executable = ts.transpileModule(functions.map(node => node.getText(parsed)).join('\n'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const execute = vm.runInNewContext(`${executable}\nexecuteScheduledOutboxTask`, {
    Error, claimOutboxTask, completeOutboxTask, failOutboxTask, requireOutboxMessageIds,
    mergeConfigDefaults: value => value,
    markOutboxSending: async id => { sending.push(id); await markOutboxSending(id); },
    addLog: () => {}, unknownErrorMessage: error => error.message, forwarderErrorCode: () => undefined,
    deliverySlo: { recordAttempt() {}, recordConfirmed() {}, recordFailure() {} },
    forwardMediaGroup: async (_id, _config, _group, context) => {
      await context.markSending(); provider.push(context.taskId); return { delivered: true };
    },
  });
  return { execute, sending, provider, scheduled, schedulerErrors };
}

async function testMalformedMessageIdsSchedulerBoundary() {
  const database = getDatabase();
  const { execute, sending, provider, scheduled, schedulerErrors } = createOutboxExecutionHarness();
  for (const id of ['schedule-shape-bad', 'schedule-shape-good']) {
    await enqueueOutboxTask({ id, type: 'mediaGroup', chatId: '-1001', mediaGroupId: id,
      messageIds: [1, 2], ingressWorkId: 'pinned-boundary-fixture', addedAt: Date.now(),
      config: { durableIngress: { albumMessages: [{ id: 1 }, { id: 2 }] } } });
  }
  await database.run('UPDATE pending_tasks SET message_ids = ? WHERE id = ?',
    [JSON.stringify({ length: 2 }), 'schedule-shape-bad']);
  assert((await listOutboxTasks()).some(row => row.id === 'schedule-shape-good'), 'Another task stays listable.');
  const queue = new ConcurrencyQueue(1, 0, 2);
  const scheduler = new DurableOutboxScheduler({ queue,
    listPending: async (excluded, limit) => (await listPendingOutboxTasksForScheduling(excluded, 1000))
      .filter(row => row.id.startsWith('schedule-shape-')).slice(0, limit),
    execute: (id, signal) => { scheduled.push(id); return execute(id, null, signal); },
    logError: message => schedulerErrors.push(message),
  });
  await scheduler.resume();
  const deadline = Date.now() + 5000;
  while ((await getOutboxTask('schedule-shape-good')).status !== 'completed') {
    assert(Date.now() < deadline, 'The next valid durable task must complete.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert(await queue.waitForIdle(5000), 'Both real scheduler tasks must settle.');
  assert.strictEqual((await getOutboxTask('schedule-shape-bad')).status, 'needs_review');
  assert.strictEqual((await getOutboxTask('schedule-shape-good')).status, 'completed');
  assert.deepStrictEqual(sending, ['schedule-shape-good'], 'Malformed metadata must never reach sending.');
  assert.deepStrictEqual(provider, ['schedule-shape-good'], 'Only the valid task reaches the provider seam.');
  assert.strictEqual(scheduled.filter(id => id === 'schedule-shape-bad').length, 1, 'No automatic malformed retry.');
  assert.strictEqual(schedulerErrors.length, 1);
  assert.match(schedulerErrors[0], /schedule-shape-bad.*malformed messageIds/);
  await database.run("DELETE FROM pending_tasks WHERE id LIKE 'schedule-shape-%'");
}

async function testPersistedJsonSyntaxBoundary() {
  const database = getDatabase();
  const raw = '{"private-payload-secret":';
  for (const field of ['message_ids', 'config_json', 'result_json']) {
    const id = `syntax-field-${field}`;
    await enqueueOutboxTask(task(id, 811));
    await database.run(`UPDATE pending_tasks SET ${field} = ? WHERE id = ?`, [raw, id]);
    assert.strictEqual(await claimOutboxTask(id), null, 'Decode before claiming or clearing result evidence.');
    const viewed = await getOutboxTask(id);
    assert.strictEqual(viewed.status, 'needs_review');
    assert.strictEqual(viewed.attempts, 0);
    assert.deepStrictEqual(viewed.payloadErrors, [field]);
    assert(!viewed.lastError.includes('private-payload-secret'));
    assert((await listOutboxTasks(undefined, 1000)).some(item => item.id === id));
    assert.strictEqual((await database.get(`SELECT ${field} AS raw FROM pending_tasks WHERE id = ?`, [id])).raw, raw);
    assert.strictEqual(await requeueOutboxTask(id), false);
  }
  for (const field of ['message_ids', 'config_json', 'result_json']) {
  for (const status of ['pending', 'preparing', 'failed', 'sending', 'unknown', 'completed', 'needs_review']) {
    const id = `syntax-state-${field}-${status}`;
    await enqueueOutboxTask(task(id, 812));
    await database.run(`UPDATE pending_tasks SET status = ?, ${field} = ?, completed_at = 123 WHERE id = ?`, [status, raw, id]);
    const viewed = await getOutboxTask(id);
    assert.strictEqual(viewed.status, status === 'sending' || status === 'unknown' ? 'unknown'
      : status === 'completed' ? 'completed' : 'needs_review');
    assert.strictEqual(await claimOutboxTask(id), null);
    assert.strictEqual(await requeueOutboxTask(id), false);
    const retained = await database.get(`SELECT ${field} AS raw, completed_at FROM pending_tasks WHERE id = ?`, [id]);
    assert.strictEqual(retained.raw, raw);
    assert.strictEqual(retained.completed_at, 123);
    if (status === 'unknown' && field === 'config_json') {
      assert.strictEqual(await acknowledgeOutboxTask(id, 'Operator verified delivery'), true);
      const acknowledged = await database.get('SELECT status, config_json, result_json FROM pending_tasks WHERE id = ?', [id]);
      assert.strictEqual(acknowledged.status, 'completed');
      assert.strictEqual(acknowledged.config_json, raw);
      assert.deepStrictEqual(JSON.parse(acknowledged.result_json), { acknowledged: true, reason: 'Operator verified delivery' });
    }
  }
  }
  for (const status of ['failed', 'unknown', 'needs_review']) {
    const id = `syntax-retry-${status}`;
    await enqueueOutboxTask(task(id, 815));
    await database.run('UPDATE pending_tasks SET status = ?, config_json = ? WHERE id = ?', [status, raw, id]);
    const quarantined = await getOutboxTask(id);
    await database.run('UPDATE pending_tasks SET config_json = ? WHERE id = ?', ['{}', id]);
    assert.strictEqual(await requeueOutboxTask(id), quarantined.status === 'unknown', 'Repair does not widen retry eligibility.');
  }
  for (const status of ['sending', 'completed']) {
    const id = `syntax-repaired-${status}`;
    await enqueueOutboxTask(task(id, 813));
    await database.run('UPDATE pending_tasks SET config_json = ? WHERE id = ?', [raw, id]);
    let release = null, started = null;
    const held = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { started = resolve; });
    const repair = withDatabaseTransaction(async db => {
      await db.run('UPDATE pending_tasks SET config_json = ?, status = ? WHERE id = ?', ['{"repaired":true}', status, id]);
      started();
      await held;
    });
    await entered;
    const read = getOutboxTask(id);
    release();
    await repair;
    const viewed = await read;
    assert.strictEqual(viewed.status, status, 'Queued read must review the current committed status and repaired bytes.');
    assert.strictEqual(viewed.payloadErrors, undefined);
    assert.deepStrictEqual(viewed.config, { repaired: true });
  }
  const deep = '['.repeat(1500) + '0' + ']'.repeat(1500);
  await enqueueOutboxTask(task('syntax-native-depth', 814));
  await database.run('UPDATE pending_tasks SET config_json = ? WHERE id = ?', [deep, 'syntax-native-depth']);
  assert.strictEqual((await claimOutboxTask('syntax-native-depth')).status, 'preparing', 'Native accepted JSON must not inherit SQLite depth rejection.');
  for (const rawValue of [null, '', 'null', '0', 'false', '[]', '{}']) {
    await database.run("UPDATE pending_tasks SET config_json = ?, status = 'pending' WHERE id = 'syntax-native-depth'", [rawValue]);
    assert.strictEqual((await claimOutboxTask('syntax-native-depth')).payloadErrors, undefined);
  }
  await database.run("DELETE FROM pending_tasks WHERE id LIKE 'syntax-%'");
}

async function testMalformedJsonSyntaxSchedulerBoundary() {
  const database = getDatabase();
  const { execute, sending, provider, scheduled, schedulerErrors } = createOutboxExecutionHarness();
  for (const id of ['schedule-syntax-bad', 'schedule-syntax-bad2', 'schedule-syntax-bad3', 'schedule-syntax-good']) {
    await enqueueOutboxTask({ id, type: 'mediaGroup', chatId: '-1001', mediaGroupId: id,
      messageIds: [1, 2], ingressWorkId: 'pinned-boundary-fixture', addedAt: Date.now(),
      config: { durableIngress: { albumMessages: [{ id: 1 }, { id: 2 }] } } });
  }
  await database.run("UPDATE pending_tasks SET config_json = ? WHERE id LIKE 'schedule-syntax-bad%'",
    ['{private-secret']);
  const otherIds = (await database.all("SELECT id FROM pending_tasks WHERE id NOT LIKE 'schedule-syntax-%'")).map(row => row.id);
  await database.run("UPDATE pending_tasks SET added_at = CASE WHEN id LIKE 'schedule-syntax-bad%' THEN 1 ELSE 2 END WHERE id LIKE 'schedule-syntax-%'");
  const queue = new ConcurrencyQueue(1, 0, 2);
  const scheduler = new DurableOutboxScheduler({ queue,
    listPending: async excluded => listPendingOutboxTasksForScheduling([...otherIds, ...excluded], 1),
    execute: (id, signal) => { scheduled.push(id); return execute(id, null, signal); },
    logError: message => schedulerErrors.push(message),
  });
  await scheduler.resume();
  const deadline = Date.now() + 5000;
  while ((await getOutboxTask('schedule-syntax-good')).status !== 'completed') {
    assert(Date.now() < deadline, 'The next valid durable task must complete.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert(await queue.waitForIdle(5000), 'Both real scheduler tasks must settle.');
  assert.strictEqual((await getOutboxTask('schedule-syntax-bad')).status, 'needs_review');
  assert.strictEqual((await getOutboxTask('schedule-syntax-good')).status, 'completed');
  assert.deepStrictEqual(sending, ['schedule-syntax-good'], 'Malformed metadata must never reach sending.');
  assert.deepStrictEqual(provider, ['schedule-syntax-good'], 'Only the valid task reaches the provider seam.');
  assert.strictEqual(scheduled.filter(id => id === 'schedule-syntax-bad').length, 0, 'No automatic malformed retry.');
  assert.deepStrictEqual(schedulerErrors, []);
  assert((await listOutboxTasks(undefined, 1000)).some(row => row.id === 'schedule-syntax-bad'), 'Quarantined row remains inspectable.');
  await database.run("DELETE FROM pending_tasks WHERE id LIKE 'schedule-syntax-%'");
}

async function testMigrationRecovery(testDir, dbPath) {
    await closeDb();
    const migrationBackupDirectory = path.join(testDir, '.migration-backups');
    const migrationSnapshots = (await readdir(migrationBackupDirectory))
      .filter(name => name.startsWith('pre-migration-v0-to-v') && name.endsWith('.db'));
    assert.strictEqual(migrationSnapshots.length, 1, 'Legacy upgrade must create one verified pre-migration snapshot');
    const migrationSnapshot = path.join(migrationBackupDirectory, migrationSnapshots[0]);
    await assert.rejects(
      restorePreMigrationSnapshot(migrationSnapshot, dbPath, testDir),
      /genuine.*lease/i
    );

    const tamperDb = await open({ filename: dbPath, driver: sqlite3.Database });
    await tamperDb.run("UPDATE schema_migrations SET checksum = ? WHERE version = 1", ['0'.repeat(64)]);
    await tamperDb.close();
    await assert.rejects(initDb(dbPath), /checksum or name does not match/);
    const owner = await acquireProcessLock(path.join(testDir, '.process_active'));
    const maintenanceLease = await beginMcpOfflineMaintenance('isolated outbox migration recovery', dbPath, owner);
    let restored = null;
    try {
      await maintenanceLease.waitForQuiescence();
      restored = await restorePreMigrationSnapshot(migrationSnapshot, dbPath, testDir, { maintenanceLease });
    } finally { await maintenanceLease.release(); await owner.release(); }
    assert.ok(restored.previousDatabase, 'Tampered database must be preserved for forensic rollback');
    const restoredLegacyDb = await open({ filename: dbPath, driver: sqlite3.Database });
    const restoredLegacyTask = await restoredLegacyDb.get("SELECT id FROM pending_tasks WHERE id = 'legacy-task'");
    await restoredLegacyDb.close();
    assert.strictEqual(restoredLegacyTask.id, 'legacy-task');
    await initDb(dbPath);
    assert.strictEqual(await getSchemaVersion(), LATEST_SCHEMA_VERSION, 'Restored legacy snapshot must migrate reproducibly');
}

async function runTests() {
  const testDir = await mkdtemp(path.join(os.tmpdir(), 'forwarder-outbox-test-'));
  const dbPath = path.join(testDir, 'legacy.db');
  try {
    await prepareLegacyDatabase(testDir, dbPath);
    await testOutboxLifecycle();
    await testAuxiliaryPersistence();
    await testSignalProvenance(dbPath);
    await testPersistedMessageIdBoundary();
    await testMalformedMessageIdsSchedulerBoundary();
    await testPersistedJsonSyntaxBoundary();
    await testMalformedJsonSyntaxSchedulerBoundary();
    await testMigrationRecovery(testDir, dbPath);
    console.log('ALL DURABLE OUTBOX TESTS PASSED!');
  } finally {
    await closeDb();
    await rm(testDir, { recursive: true, force: true });
  }
}

await runTests().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
