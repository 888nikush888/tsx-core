import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDatabase, listOutboxTasks } from '../src/db.js';
import { acceptIncomingMessage, processIncomingWork, pinnedWorkflowParserSelection } from '../src/incoming_work_repository.js';
import { readIngressMessage } from '../src/ingress_contracts.js';

const message = { id: 1, chat_id: -1001, content: { _: 'messageText', text: { text: 'hello', entities: [{ _: 'fixture' }] } },
  unconsumedPayload: { nested: ['retained'] } };
assert.deepEqual(readIngressMessage(JSON.stringify(message)), message, 'Validation must preserve unconsumed source payload.');
assert.throws(() => pinnedWorkflowParserSelection({}, { schemaId: 'missing' }), /Pinned parser resources are missing/);
const config = { sourceChannels: ['-1001'], sourceAliases: {}, filters: {}, forwardOptions: {} };
const directory = await mkdtemp(path.join(os.tmpdir(), 'ingress-contract-'));
try {
  await initDb(path.join(directory, 'test.db'));
  for (const invalid of [{ ...message, id: 1.5 }, { ...message, chat_id: {} },
    { ...message, media_group_id: {} }, { ...message, content: { text: { text: {} } } }]) {
    await assert.rejects(acceptIncomingMessage(invalid, config), /Incoming message/);
  }
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS count FROM incoming_work')).count, 0);
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS count FROM incoming_messages')).count, 0);
  const damaged = await acceptIncomingMessage(message, config);
  await getDatabase().run('UPDATE incoming_work SET message_json = ? WHERE id = ?',
    [JSON.stringify({ ...message, content: { caption: { text: {} } } }), damaged.id]);
  await acceptIncomingMessage({ ...message, id: 2 }, config);
  await processIncomingWork();
  await processIncomingWork();
  assert.equal((await getDatabase().get('SELECT status FROM incoming_work WHERE id = ?', [damaged.id])).status, 'needs_review');
  const tasks = await listOutboxTasks();
  assert.equal(tasks.length, 1, 'Malformed persisted content must not block unrelated work or create replay effects.');
  assert.equal(tasks[0].messageId, 2);
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
console.log('Ingress contract guards preserve full payload and isolate malformed durable work.');
