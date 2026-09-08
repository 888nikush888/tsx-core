import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UiOperationStore } from '../src/ui_operation_store.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-ui-jobs-'));
if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(directory).startsWith('tsx-ui-jobs-')) throw new Error('Unsafe cleanup path.');
async function tiedJobPagesSurviveReload() {
  const tiedDirectory = path.join(directory, 'tied-pages');
  const store = new UiOperationStore(tiedDirectory, 'tied-process-1');
  const timestamp = Date.now() - 1000;
  const originalNow = Date.now;
  try {
    Date.now = () => timestamp;
    for (const id of ['job-paging-tie-a1', 'job-paging-tie-z2', 'job-paging-tie-A3']) {
      await store.accept({ id, kind: 'backup-drill', actorId: 'test:admin', scope: {}, request: { id } });
      await store.run(id, () => Promise.resolve(({ proof: 'local-fixture' })));
    }
  } finally { Date.now = originalNow; }
  const reloaded = new UiOperationStore(tiedDirectory, 'tied-process-2');
  const first = await reloaded.page(new URLSearchParams({ limit: '2', state: 'succeeded' }));
  assert.deepEqual(first.jobs.map(job => job.id), ['job-paging-tie-z2', 'job-paging-tie-a1']);
  assert.ok(first.jobs.every(job => job.acceptedAt === timestamp));
  assert.equal(first.hasMore, true);
  const second = await reloaded.page(new URLSearchParams({ limit: '2', state: 'succeeded', cursor: first.nextCursor }));
  assert.deepEqual(second.jobs.map(job => job.id), ['job-paging-tie-A3']);
  assert.equal(second.observedAt, first.observedAt);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.jobs, ...second.jobs].map(job => job.id)).size, 3,
    'Equal timestamps must not skip or duplicate durable jobs across cursor pages and process reloads.');
}
async function failedJobReceiptsSurviveReload() {
  const failedDirectory = path.join(directory, 'failed-receipts');
  const store = new UiOperationStore(failedDirectory, 'failure-process-1');
  const counts = { coercions: 0, commands: 0 };
  const opaqueFailure = { privateFixture: 'must-never-be-serialized', [Symbol.toPrimitive]() { counts.coercions += 1; return 'unsafe'; } };
  const cases = [
    ['operator-failure-error', new Error('Fixture backup could not be verified.'), 'Fixture backup could not be verified.'],
    ['operator-failure-object', opaqueFailure, 'A non-Error value was thrown; inspect the operation receipt for context.'],
  ];
  for (const [id, failure, expectedError] of cases) {
    const request = { id, kind: 'backup-drill', actorId: 'test:admin', scope: {}, request: { id } };
    assert.equal((await store.accept(request)).created, true);
    await store.run(id, () => { counts.commands += 1; return Promise.reject(failure); });
    const reloaded = new UiOperationStore(failedDirectory, `reloaded-${id}`);
    const receipt = await reloaded.get(id);
    assert.equal(receipt.state, 'failed');
    assert.equal(receipt.error, expectedError);
    assert.equal(receipt.result, null);
    assert.match(receipt.stage, /partial effects must be reviewed/);
    assert.equal(JSON.stringify(receipt).includes(opaqueFailure.privateFixture), false);
    const replay = await reloaded.accept(request);
    assert.equal(replay.created, false, 'A failed command remains bound to its original key after restart.');
    assert.deepEqual(replay.job, receipt);
    await assert.rejects(reloaded.accept({ ...request, actorId: 'test:other' }), /another request/);
  }
  assert.equal(counts.coercions, 0, 'Persisting a failure never invokes arbitrary object conversion.');
  assert.equal(counts.commands, cases.length);
}
try {
  await tiedJobPagesSurviveReload();
  await failedJobReceiptsSurviveReload();
  const store = new UiOperationStore(directory, 'process-1');
  const request = { id: 'operator-job-test-1', kind: 'backup-drill', actorId: 'test:admin', scope: { artifactName: 'backup-2026-test' }, request: { name: 'backup-2026-test' } };
  const accepted = await Promise.all([store.accept(request), store.accept(request)]);
  assert.equal(accepted.filter(result => result.created).length, 1, 'The same operator job key accepts one operation only.');
  await assert.rejects(store.accept({ ...request, request: { name: 'different' } }), /another request/);
  let commands = 0;
  await store.run(request.id, () => { commands += 1; return Promise.resolve({ runtimeDisabled: true, proof: 'fixture-only' }); });
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
