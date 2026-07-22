import assert from 'node:assert/strict';
import {
  ClockDriftError,
  ClockGuard,
  DEFAULT_MAX_CLOCK_DRIFT_MS,
  clockDriftLimitFromEnvironment,
} from '../src/clock_guard.js';

let wall = 1_000;
let monotonic = 100;
const guard = new ClockGuard(100, () => wall, () => monotonic);

wall += 1_000;
monotonic += 1_000;
assert.deepEqual(guard.sample(), {
  healthy: true,
  driftMilliseconds: 0,
  maxDriftMilliseconds: 100,
  checkedAt: 2_000,
  reason: null,
});

wall += 250;
monotonic += 100;
const unsafe = guard.sample();
assert.equal(unsafe.healthy, false);
assert.equal(unsafe.driftMilliseconds, 150);
assert.match(unsafe.reason, /changed by 150ms.*limit is 100ms/);
assert.throws(() => guard.assertHealthy(), ClockDriftError);

wall += 1_000;
monotonic += 1_150;
const stillUnsafe = guard.sample();
assert.equal(stillUnsafe.healthy, false, 'A later clock correction must not silently re-enable side effects.');
assert.equal(stillUnsafe.driftMilliseconds, unsafe.driftMilliseconds);
assert.equal(stillUnsafe.reason, unsafe.reason);

assert.equal(clockDriftLimitFromEnvironment({}), DEFAULT_MAX_CLOCK_DRIFT_MS);
assert.equal(clockDriftLimitFromEnvironment({ CLOCK_MAX_DRIFT_MS: '500' }), 500);
for (const invalid of ['99', '5001', '1.5', 'invalid']) {
  assert.throws(
    () => clockDriftLimitFromEnvironment({ CLOCK_MAX_DRIFT_MS: invalid }),
    /integer between 100 and 5000/,
  );
}
assert.throws(() => new ClockGuard(99), /between 100 and 5000/);
assert.throws(() => new ClockGuard(100, () => Number.NaN), /finite millisecond values/);

console.log('Clock drift safety tests passed.');
