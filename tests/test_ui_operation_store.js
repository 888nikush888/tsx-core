import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UiOperationStore } from '../src/ui_operation_store.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-ui-jobs-'));
if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(directory).startsWith('tsx-ui-jobs-')) throw new Error('Unsafe cleanup path.');
try {
  const store = new UiOperationStore(directory, 'process-1');
  const request = { id: 'operator-job-test-1', kind: 'backup-drill', actorId: 'test:admin', scope: { artifactName: 'backup-2026-test' }, request: { name: 'backup-2026-test' } };
  const accepted = await Promise.all([store.accept(request), store.accept(request)]);
  assert.equal(accepted.filter(result => result.created).length, 1, 'The same operator job key accepts one operation only.');
  await assert.rejects(store.accept({ ...request, request: { name: 'different' } }), /another request/);
  let commands = 0;
  await store.run(request.id, async () => { commands += 1; return { runtimeDisabled: true, proof: 'fixture-only' }; });
  assert.equal(commands, 1);
  assert.equal((await store.get(request.id)).state, 'succeeded');
  assert.equal((await new UiOperationStore(directory, 'process-2').get(request.id)).state, 'succeeded', 'Completed job receipts survive a different process.');
  await store.accept({ ...request, id: 'operator-job-test-2' });
  await store.update('operator-job-test-2', { state: 'running', stage: 'Fixture interrupted before a conclusive result.' });
  const recovered = new UiOperationStore(directory, 'process-3');
  assert.equal((await recovered.get('operator-job-test-2')).state, 'unknown');
  assert.equal((await recovered.accept({ ...request, id: 'operator-job-test-2' })).created, false, 'A process restart never replays an uncertain operation.');
  await recovered.accept({ ...request, id: 'operator-job-test-3', kind: 'restart', request: { action: 'restart' } });
  await recovered.update('operator-job-test-3', { state: 'awaiting-restart', stage: 'Awaiting new process.' });
  assert.equal((await new UiOperationStore(directory, 'process-4').get('operator-job-test-3')).state, 'succeeded');
  await assert.rejects(store.get('../escaped-record'), /Invalid/);
  console.log('Durable operator jobs, deduplication and restart observations passed.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
