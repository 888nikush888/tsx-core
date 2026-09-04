import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { closeDb, getDatabase, initDb, listOutboxTasks, withDatabaseTransaction } from '../src/db.js';
import { acceptIncomingMessage, processIncomingWork, flushIncomingAlbums, nonSecretConfigSnapshot } from '../src/incoming_work_repository.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-ingress-'));
const databasePath = path.join(directory, 'test.db');
const message = (id, group = '0') => ({ id, chat_id: -1001, media_group_id: group,
  content: { _: 'messageText', text: { text: 'hello' } } });
const config = { sourceChannels: ['-1001'], filters: {}, forwardOptions: { forwardToTarget: true }, sourceAliases: {} };
assert.deepEqual(nonSecretConfigSnapshot({
  pathKey: 'business-path', apiHash: 'redact', BACKUP_ENCRYPTION_KEY: 'redact', privateKey: 'redact',
  nesting: [{ OPENROUTER_API_KEY: 'redact', encryptionKey: 'redact', botToken: 'redact', clientSecret: 'redact', allowance: 100 }],
}), { pathKey: 'business-path', nesting: [{ allowance: 100 }] });
try {
  await initDb(databasePath);
  const db = getDatabase();
  await assert.rejects(withDatabaseTransaction(async () => {
    await acceptIncomingMessage(message(1), config);
    throw new Error('injected pre-commit crash');
  }), /injected/);
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM incoming_messages')).n, 0);
  const work = await acceptIncomingMessage(message(1), config);
  assert.equal((await acceptIncomingMessage(message(1), config)).id, work.id);
  await closeDb();
  await initDb(databasePath);
  await processIncomingWork();
  await processIncomingWork();
  assert.equal((await listOutboxTasks()).length, 1);
  await acceptIncomingMessage(message(2, 'album'), config);
  await acceptIncomingMessage(message(2, 'album'), config);
  await acceptIncomingMessage(message(3, 'album'), config);
  await processIncomingWork();
  await flushIncomingAlbums(Date.now() + 5000);
  await flushIncomingAlbums(Date.now() + 5000);
  const tasks = await listOutboxTasks();
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks.find(task => task.type === 'mediaGroup').messageIds, [2, 3]);
  assert.equal((await getDatabase().get("SELECT COUNT(*) AS n FROM incoming_messages WHERE status = 'received'")).n, 0);
  await acceptIncomingMessage(message(4), { ...config, filters: { blockedKeywords: ['hello'] } });
  await processIncomingWork();
  assert.equal((await getDatabase().get('SELECT status FROM incoming_work WHERE message_id = 4')).status, 'filtered');
  await acceptIncomingMessage({ ...message(5), chat_id: -1002 }, config);
  await processIncomingWork();
  assert.equal((await getDatabase().get('SELECT status FROM incoming_work WHERE message_id = 5')).status, 'filtered', 'A revoked workflow-only source cannot fall through into legacy forwarding.');
  await closeDb();
  for (const phase of ['before', 'inside', 'after', 'fanout', 'album']) {
    const crashPath = path.join(directory, `${phase}.db`);
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'tests/fixtures/ingress_crash.js', crashPath, phase], { encoding: 'utf8' });
    assert.equal(child.status, 77, child.stderr);
    await initDb(crashPath);
    const count = (await getDatabase().get('SELECT COUNT(*) AS n FROM incoming_messages')).n;
    assert.equal(count, phase === 'album' ? 2 : ['before', 'inside'].includes(phase) ? 0 : 1);
    await acceptIncomingMessage(message(100), config);
    await processIncomingWork();
    await flushIncomingAlbums(Date.now() + 5000);
    assert.equal((await listOutboxTasks()).length, phase === 'album' ? 2 : 1);
    assert.equal((await getDatabase().all('PRAGMA foreign_key_check')).length, 0);
    await closeDb();
  }
  console.log('Atomic durable ingress and album dedupe passed.');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
