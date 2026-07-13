import assert from 'assert';
import { ConcurrencyQueue } from '../src/queue.js';

async function runTests() {
  console.log("=== Running ConcurrencyQueue Unit Tests ===");

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
  console.log("   -> OK");

  // 4. Queue Task-Timeout test
  console.log("4. Testing queue task-timeout...");
  const timeoutQueue = new ConcurrencyQueue(2, 50); // 50ms timeout
  let jobStarted = false;
  let jobCompleted = false;

  const slowJob = async () => {
    jobStarted = true;
    await new Promise(r => setTimeout(r, 150)); // 150ms > 50ms timeout
    jobCompleted = true;
    return "done";
  };

  const fastJob = async () => "fast";

  // The slow job should reject with a timeout error
  await assert.rejects(
    async () => {
      await timeoutQueue.add(slowJob);
    },
    /Task timed out after 50ms/
  );

  assert.strictEqual(jobStarted, true, "Job should have started");
  assert.strictEqual(jobCompleted, false, "Job should not have completed yet at timeout rejection");

  // The next job in the queue should execute fine after the timeout
  const fastResult = await timeoutQueue.add(fastJob);
  assert.strictEqual(fastResult, "fast", "Subsequent jobs should resolve correctly");

  // Let's wait to ensure the slow job eventually finishes without double resolving or throwing
  await new Promise(r => setTimeout(r, 150));
  assert.strictEqual(jobCompleted, true, "Slow job should eventually complete in the background");
  console.log("   -> OK");

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

  console.log("\nALL CONCURRENCY QUEUE UNIT TESTS PASSED!");
}

runTests().catch(err => {
  console.error("ConcurrencyQueue test execution failed:", err);
  process.exit(1);
});
