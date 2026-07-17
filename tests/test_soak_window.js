import assert from 'node:assert/strict';
import { evaluateSoakWindow, soakQueries } from '../scripts/check_soak_window.js';

const passing = {
  scrapeCount: 172_800,
  attempts: 200,
  availability: 0.999,
  deliverySuccess: 0.998,
  p95LatencySeconds: 30,
  unknownDeliveries: 0,
  backupHealth: 1,
  retentionHealth: 1,
  diskHealth: 1,
  auditHealth: 1,
  tradingHealth: 1,
  tradingIntents: 120,
  tradingUnknownOrders: 0,
  tradingUnprotectedPositions: 0,
  tradingKillSwitch: 0,
  maxResidentMemoryBytes: 500_000_000,
  maxQueuedTasks: 10,
  maxOldestPendingAgeSeconds: 30
};
assert.equal(evaluateSoakWindow(passing).passed, true);
const failed = evaluateSoakWindow({ ...passing, unknownDeliveries: 1, attempts: 99 });
assert.equal(failed.passed, false);
assert.deepEqual(failed.checks.filter(check => !check.passed).map(check => check.name), [
  'delivery sample size',
  'unknown delivery maximum'
]);
const queries = soakQueries();
assert.ok(Object.values(queries).every(query => query.includes('[30d]')));
assert.match(queries.deliverySuccess, /delivery_confirmed_total/);
assert.match(queries.p95LatencySeconds, /histogram_quantile\(0\.95/);
assert.match(queries.availability, /tg_forwarder_readiness/);
assert.match(queries.tradingIntents, /tg_forwarder_trading_intents_total/);

console.log('30-day soak evaluation tests passed.');
