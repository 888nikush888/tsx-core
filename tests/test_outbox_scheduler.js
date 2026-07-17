import assert from 'assert';
import { ConcurrencyQueue } from '../src/queue.js';
import { DurableOutboxScheduler } from '../src/outbox_scheduler.js';

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for durable scheduler progress.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function testLargeBacklogIsPumpedWithinMemoryBound() {
  console.log('1. Testing a backlog larger than the former 1,000-task startup limit...');
  const pending = new Set(Array.from({ length: 1_205 }, (_, index) => `task-${String(index).padStart(4, '0')}`));
  const queue = new ConcurrencyQueue(4, 0, 12);
  const completed = [];
  let maxQueued = 0;
  let maxScheduled = 0;
  const errors = [];
  const scheduler = new DurableOutboxScheduler({
    queue,
    listPending: async (excluded, limit) => [...pending]
      .filter(id => !excluded.includes(id))
      .sort()
      .slice(0, limit)
      .map(id => ({ id })),
    execute: async id => {
      maxQueued = Math.max(maxQueued, queue.queue.length);
      maxScheduled = Math.max(maxScheduled, scheduler.scheduledCount);
      pending.delete(id);
      completed.push(id);
    },
    logError: message => errors.push(message),
    batchSize: 25
  });

  await scheduler.resume();
  await waitFor(() => completed.length === 1_205);
  assert.strictEqual(new Set(completed).size, 1_205, 'Every durable task must execute exactly once.');
  assert.strictEqual(pending.size, 0, 'No durable task may remain stranded beyond the old 1,000-task window.');
  assert.ok(maxQueued <= 12, `In-memory queue exceeded configured cap: ${maxQueued}`);
  assert.ok(maxScheduled <= 20, `Scheduled window exceeded bounded queue + workers: ${maxScheduled}`);
  assert.deepStrictEqual(errors, []);
  console.log('   -> OK');
}

async function testPausedQueueDoesNotLoseDurableWork() {
  console.log('2. Testing pause/resume backpressure without dropping durable work...');
  const pending = new Set(['one', 'two', 'three']);
  const queue = new ConcurrencyQueue(1, 0, 1);
  queue.pause();
  const completed = [];
  const scheduler = new DurableOutboxScheduler({
    queue,
    listPending: async (excluded, limit) => [...pending].filter(id => !excluded.includes(id)).slice(0, limit).map(id => ({ id })),
    execute: async id => {
      pending.delete(id);
      completed.push(id);
    },
    logError: message => { throw new Error(message); }
  });

  await scheduler.resume();
  assert.strictEqual(completed.length, 0);
  assert.strictEqual(pending.size, 3);
  queue.resume();
  scheduler.requestPump();
  await waitFor(() => completed.length === 3);
  assert.deepStrictEqual(completed.sort(), ['one', 'three', 'two']);
  assert.strictEqual(pending.size, 0);
  console.log('   -> OK');
}

await testLargeBacklogIsPumpedWithinMemoryBound();
await testPausedQueueDoesNotLoseDurableWork();
console.log('ALL DURABLE OUTBOX SCHEDULER TESTS PASSED!');
