import assert from 'assert';
import { ConcurrencyQueue, QueueCapacityError } from '../src/queue.js';

async function testConcurrencyLimits() {
  // 1. Concurrency limit test (default = 2)
  console.log("1. Testing default maxConcurrency of 2...");
  const queue = new ConcurrencyQueue(2);
  let activeJobs = 0;
  let maxActiveJobs = 0;
  const completedJobs = [];

  const makeJob = (id, delay) => {
    return async () => {
      activeJobs++;
      if (activeJobs > maxActiveJobs) {
        maxActiveJobs = activeJobs;
      }
      await new Promise(r => setTimeout(r, delay));
      activeJobs--;
      completedJobs.push(id);
      return id;
    };
  };

  const results = await Promise.all([
    queue.add(makeJob(1, 50)),
    queue.add(makeJob(2, 20)),
    queue.add(makeJob(3, 50)),
    queue.add(makeJob(4, 10)),
  ]);

  assert.strictEqual(maxActiveJobs <= 2, true, `Expected max active jobs <= 2, got ${maxActiveJobs}`);
  assert.strictEqual(activeJobs, 0, `Expected active jobs to return to 0, got ${activeJobs}`);
  assert.deepStrictEqual(results, [1, 2, 3, 4], "Expected job results to match in order of resolution");
  console.log("   -> OK");

  // 2. Custom concurrency limit (e.g. 1)
  console.log("2. Testing custom maxConcurrency of 1...");
  const singleQueue = new ConcurrencyQueue(1);
  let activeJobs1 = 0;
  let maxActiveJobs1 = 0;

  const makeJob1 = (delay) => {
    return async () => {
      activeJobs1++;
      if (activeJobs1 > maxActiveJobs1) {
        maxActiveJobs1 = activeJobs1;
      }
      await new Promise(r => setTimeout(r, delay));
      activeJobs1--;
    };
  };

  await Promise.all([
    singleQueue.add(makeJob1(20)),
    singleQueue.add(makeJob1(20)),
    singleQueue.add(makeJob1(20)),
  ]);

  assert.strictEqual(maxActiveJobs1, 1, `Expected max active jobs to be exactly 1, got ${maxActiveJobs1}`);
  console.log("   -> OK");
}

async function testErrorsAndTimeouts() {
  // 3. Error handling in jobs
  console.log("3. Testing queue handles throwing jobs correctly...");
  const errorQueue = new ConcurrencyQueue(2);
  
  const successfulJob = async () => "success";
  const throwingJob = async () => {
    throw new Error("Job failed");
  };

  const res1 = await errorQueue.add(successfulJob);
  assert.strictEqual(res1, "success");

  await assert.rejects(
    async () => {
      await errorQueue.add(throwingJob);
    },
    /Job failed/
  );

  // Subsequent jobs should still run fine
  const res2 = await errorQueue.add(successfulJob);
  assert.strictEqual(res2, "success");

  await assert.rejects(
    errorQueue.add(() => { throw new Error('Synchronous job failure'); }),
    /Synchronous job failure/
  );
  assert.strictEqual(errorQueue.running, 0, 'Synchronous failures must release their worker slot');
  console.log("   -> OK");

  // 4. Queue Task-Timeout test
  console.log("4. Testing queue task-timeout...");
  const timeoutQueue = new ConcurrencyQueue(1, 50); // 50ms timeout
  let jobStarted = false;
  let jobCompleted = false;
  let fastJobStarted = false;
  let activeTimedJobs = 0;
  let maxActiveTimedJobs = 0;

  const slowJob = async () => {
    jobStarted = true;
    activeTimedJobs++;
    maxActiveTimedJobs = Math.max(maxActiveTimedJobs, activeTimedJobs);
    await new Promise(r => setTimeout(r, 150)); // 150ms > 50ms timeout
    jobCompleted = true;
    activeTimedJobs--;
    return "done";
  };

  const fastJob = async () => {
    fastJobStarted = true;
    activeTimedJobs++;
    maxActiveTimedJobs = Math.max(maxActiveTimedJobs, activeTimedJobs);
    activeTimedJobs--;
    return "fast";
  };

  const slowPromise = timeoutQueue.add(slowJob);
  const fastPromise = timeoutQueue.add(fastJob);

  // The slow job should reject for the caller, but retain its physical worker slot.
  await assert.rejects(
    slowPromise,
    /Task timed out after 50ms/
  );

  assert.strictEqual(jobStarted, true, "Job should have started");
  assert.strictEqual(jobCompleted, false, "Job should not have completed yet at timeout rejection");
  assert.strictEqual(fastJobStarted, false, 'Timed-out physical work must retain its concurrency slot');
  assert.strictEqual(timeoutQueue.running, 1, 'Queue must count the timed-out task until it physically settles');

  // The next job starts only after the timed-out task has physically settled.
  const fastResult = await fastPromise;
  assert.strictEqual(fastResult, "fast", "Subsequent jobs should resolve correctly");
  assert.strictEqual(jobCompleted, true, "Slow job should eventually complete in the background");
  assert.strictEqual(maxActiveTimedJobs, 1, 'Physical concurrency must remain within the configured limit');
  assert.strictEqual(timeoutQueue.running, 0);
  console.log("   -> OK");
}

async function testPauseAndAbortPropagation() {
  // 5. Queue Pause/Resume test
  console.log("5. Testing queue pause and resume...");
  const pauseQueue = new ConcurrencyQueue(2);
  pauseQueue.pause();
  
  let jobRunCount = 0;
  const dummyJob = async () => {
    jobRunCount++;
    return "done";
  };

  const p1 = pauseQueue.add(dummyJob);
  const p2 = pauseQueue.add(dummyJob);

  // Since it is paused, jobRunCount should still be 0 after some time
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(jobRunCount, 0, "Jobs should not run while queue is paused");

  // Resume the queue
  pauseQueue.resume();

  // Wait for jobs to resolve
  const r1 = await p1;
  const r2 = await p2;
  assert.strictEqual(r1, "done");
  assert.strictEqual(r2, "done");
  assert.strictEqual(jobRunCount, 2, "Jobs should have executed after resume");
  console.log("   -> OK");

  // 6. AbortSignal timeout propagation
  console.log("6. Testing AbortSignal timeout propagation...");
  const abortQueue = new ConcurrencyQueue(1, 30); // 30ms timeout
  let abortedSignalCaught = false;

  const abortableJob = async (signal) => {
    if (signal) {
      signal.addEventListener('abort', () => {
        abortedSignalCaught = true;
      });
    }
    await new Promise(r => setTimeout(r, 80));
    return "done";
  };

  await assert.rejects(
    async () => {
      await abortQueue.add(abortableJob);
    },
    /Task timed out after 30ms/
  );

  assert.strictEqual(abortedSignalCaught, true, "AbortSignal listener should have fired on timeout");
  console.log("   -> OK");
}

async function testRuntimeSettingsAndDrain() {
  // 7. Applying a higher concurrency starts waiting work immediately
  console.log("7. Testing live queue settings update...");
  const configurableQueue = new ConcurrencyQueue(1);
  let concurrentJobs = 0;
  let observedConcurrency = 0;
  const configurableJob = async () => {
    concurrentJobs++;
    observedConcurrency = Math.max(observedConcurrency, concurrentJobs);
    await new Promise(r => setTimeout(r, 50));
    concurrentJobs--;
  };
  const job1 = configurableQueue.add(configurableJob);
  const job2 = configurableQueue.add(configurableJob);
  await new Promise(r => setTimeout(r, 10));
  configurableQueue.updateSettings(2, 1000);
  await Promise.all([job1, job2]);
  assert.strictEqual(observedConcurrency, 2, "Expected waiting work to start after increasing concurrency");
  assert.strictEqual(configurableQueue.maxConcurrency, 2);
  console.log("   -> OK");

  // 8. Graceful shutdown primitives retain physical-work truth
  console.log("8. Testing queue abort and drain timeout...");
  const drainQueue = new ConcurrencyQueue(1, 0);
  let abortObserved = false;
  const active = drainQueue.add(async signal => {
    signal.addEventListener('abort', () => { abortObserved = true; }, { once: true });
    await new Promise(resolve => setTimeout(resolve, 80));
    return 'settled';
  });
  const pending = drainQueue.add(async () => 'must-not-run');
  await new Promise(resolve => setTimeout(resolve, 10));
  drainQueue.pause();
  drainQueue.clear();
  await assert.rejects(pending, /Queue was cleared/);
  drainQueue.abortRunning('process shutdown');
  assert.strictEqual(abortObserved, true);
  assert.strictEqual(await drainQueue.waitForIdle(10), false, 'Drain must report its deadline honestly');
  assert.strictEqual(await drainQueue.waitForIdle(200), true);
  assert.strictEqual(await active, 'settled');
  assert.strictEqual(drainQueue.running, 0);
  console.log("   -> OK");

  // 9. A bounded queue rejects only transient in-memory work; durable callers can retry later.
  console.log("9. Testing bounded pending queue capacity...");
  const boundedQueue = new ConcurrencyQueue(1, 0, 1);
  let unblock;
  const running = boundedQueue.add(() => new Promise(resolve => { unblock = resolve; }));
  const waiting = boundedQueue.add(async () => 'queued');
  await assert.rejects(
    boundedQueue.add(async () => 'must-not-enter-memory'),
    error => error instanceof QueueCapacityError && /capacity of 1/.test(error.message)
  );
  assert.strictEqual(boundedQueue.availableCapacity, 0);
  unblock('running');
  assert.strictEqual(await running, 'running');
  assert.strictEqual(await waiting, 'queued');
  console.log("   -> OK");

  console.log("\nALL CONCURRENCY QUEUE UNIT TESTS PASSED!");
}

async function runTests() {
  console.log("=== Running ConcurrencyQueue Unit Tests ===");
  await testConcurrencyLimits();
  await testErrorsAndTimeouts();
  await testPauseAndAbortPropagation();
  await testRuntimeSettingsAndDrain();
}

await runTests().catch(err => {
  console.error("ConcurrencyQueue test execution failed:", err);
  process.exit(1);
});
