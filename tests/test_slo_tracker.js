import assert from 'node:assert/strict';
import { DeliverySloTracker } from '../src/slo_tracker.js';

const tracker = new DeliverySloTracker();
tracker.recordAccepted();
tracker.recordAccepted();
tracker.recordAttempt();
tracker.recordConfirmed(4_500);
tracker.recordAttempt();
tracker.recordFailure('failed');
tracker.recordFailure('unknown');

const snapshot = tracker.snapshot();
assert.equal(snapshot.accepted, 2);
assert.equal(snapshot.attempts, 2);
assert.equal(snapshot.confirmed, 1);
assert.equal(snapshot.failed, 1);
assert.equal(snapshot.unknown, 1);
assert.equal(snapshot.latencyCount, 1);
assert.equal(snapshot.latencySumSeconds, 4.5);
assert.equal(snapshot.latencyBuckets.find(bucket => bucket.le === 1).count, 0);
assert.equal(snapshot.latencyBuckets.find(bucket => bucket.le === 5).count, 1);
snapshot.latencyBuckets[0].count = 999;
assert.equal(tracker.snapshot().latencyBuckets[0].count, 0, 'Snapshots must not mutate tracker state');
assert.throws(() => tracker.recordConfirmed(-1), /finite non-negative/);
assert.throws(() => tracker.recordConfirmed(Number.NaN), /finite non-negative/);

console.log('Delivery SLO tracker tests passed.');
