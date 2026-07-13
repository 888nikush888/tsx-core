import assert from 'node:assert/strict';
import { invokeWithFloodWaitRetry } from '../src/tdlib_retry.js';

let attempts = 0;
const logs = [];
const result = await invokeWithFloodWaitRetry({
  async invoke() {
    attempts += 1;
    if (attempts === 1) throw new Error('FLOOD_WAIT_0');
    return { ok: true };
  }
}, { _: 'test' }, { logger: message => logs.push(message) });
assert.deepEqual(result, { ok: true });
assert.equal(attempts, 2);
assert.equal(logs.length, 1);

let unsafeCalls = 0;
await assert.rejects(
  invokeWithFloodWaitRetry({
    async invoke() {
      unsafeCalls += 1;
      throw new Error('FLOOD_WAIT_61');
    }
  }, {}, { maxFloodWaitSeconds: 60 }),
  /exceeds the configured 60s safety limit/
);
assert.equal(unsafeCalls, 1, 'An excessive FLOOD_WAIT must not be retried');

const controller = new AbortController();
let abortCalls = 0;
const pending = invokeWithFloodWaitRetry({
  async invoke() {
    abortCalls += 1;
    throw new Error('FLOOD_WAIT_30');
  }
}, {}, { signal: controller.signal });
setTimeout(() => controller.abort(new Error('operator shutdown')), 10);
await assert.rejects(pending, /operator shutdown/);
assert.equal(abortCalls, 1, 'Abort during backoff must prevent another provider call');

await assert.rejects(
  invokeWithFloodWaitRetry({ async invoke() { throw new Error('FLOOD_WAIT_0'); } }, {}, { maxAttempts: 2 }),
  /failed after 2 rate-limit attempts/
);

console.log('ALL BOUNDED TDLIB RETRY TESTS PASSED!');
