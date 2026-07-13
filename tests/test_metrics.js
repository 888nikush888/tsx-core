import assert from 'assert';
import { once } from 'events';
import { startMetricsServer, stopMetricsServer } from '../src/metrics.js';
import { MetricsTracker } from '../src/metrics_tracker.js';

const EMPTY_OUTBOX = { pending: 0, preparing: 0, sending: 0, completed: 4, failed: 1, unknown: 2 };

async function runTests() {
  let operational = {
    databaseHealthy: true,
    isRunning: false,
    connectionState: 'disconnected',
    queuePaused: false,
    outbox: { ...EMPTY_OUTBOX },
    aiRequestsToday: 3,
    aiUsedTokensToday: 120,
    aiReservedTokensToday: 40,
    lastForwardedAt: 1_700_000_000_000,
    backupHealthy: true,
    backupLastSuccessAt: 1_700_000_100_000
  };
  const server = startMetricsServer(0, {
    totalForwardedCountCallback: () => 7,
    getQueueStateCallback: () => ({ running: 1, queued: 2, maxConcurrency: 3 }),
    getOperationalMetricsCallback: async () => operational
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  assert.strictEqual(address.address, '127.0.0.1', 'Metrics must bind to loopback by default');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let response = await fetch(`${baseUrl}/healthz`);
  assert.strictEqual(response.status, 200);
  assert.strictEqual((await response.json()).status, 'alive');

  response = await fetch(`${baseUrl}/readyz`);
  assert.strictEqual(response.status, 503, 'Disconnected routing must not report ready');
  operational = { ...operational, isRunning: true, connectionState: 'connected' };
  response = await fetch(`${baseUrl}/readyz`);
  assert.strictEqual(response.status, 200);
  const readiness = await response.json();
  assert.strictEqual(readiness.unresolvedDeliveries, 3);

  response = await fetch(`${baseUrl}/metrics`);
  assert.strictEqual(response.status, 200);
  const metrics = await response.text();
  assert.match(metrics, /tg_forwarder_total_forwarded 7/);
  assert.match(metrics, /tg_forwarder_connection_state\{state="connected"\} 1/);
  assert.match(metrics, /tg_forwarder_outbox_tasks\{status="unknown"\} 2/);
  assert.match(metrics, /tg_forwarder_ai_reserved_tokens_today 40/);
  assert.match(metrics, /tg_forwarder_last_confirmed_delivery_timestamp_seconds 1700000000/);
  assert.match(metrics, /tg_forwarder_backup_healthy 1/);
  assert.match(metrics, /tg_forwarder_backup_last_success_timestamp_seconds 1700000100/);

  response = await fetch(`${baseUrl}/metrics`, { method: 'POST' });
  assert.strictEqual(response.status, 405);
  await stopMetricsServer();

  let forwarded = 0;
  const tracker = new MetricsTracker({
    totalForwardedCountCallback: () => forwarded,
    getQueueStateCallback: () => ({ running: 1, queued: 2, maxConcurrency: 3, paused: false }),
    intervalMs: 10,
    maxPoints: 3
  });
  tracker.start();
  forwarded = 2;
  await new Promise(resolve => setTimeout(resolve, 35));
  tracker.stop();
  const history = tracker.getHistory();
  assert.strictEqual(history.length, 3, 'History must enforce its configured memory bound');
  assert.ok(history.some(point => point.processedDelta === 2));
  assert.ok(history.every(point => point.cpuUsage >= 0 && point.memoryUsage > 0));
  assert.ok(history.every(point => !('internetSpeed' in point)), 'Fabricated bandwidth must not be emitted');

  console.log('ALL HONEST OBSERVABILITY TESTS PASSED!');
}

runTests().catch(async error => {
  await stopMetricsServer().catch(() => {});
  console.error(error);
  process.exitCode = 1;
});
