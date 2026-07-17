import assert from 'assert';
import { once } from 'events';
import { startMetricsServer, stopMetricsServer } from '../src/metrics.js';
import { MetricsTracker } from '../src/metrics_tracker.js';

const EMPTY_OUTBOX = { pending: 0, preparing: 0, sending: 0, completed: 4, failed: 1, unknown: 2 };
const HEALTHY_OPERATIONAL_METRICS = {
  databaseHealthy: true,
  isRunning: false,
  connectionState: 'disconnected',
  queuePaused: false,
  outbox: { ...EMPTY_OUTBOX },
  oldestPendingOutboxAgeSeconds: 15,
  aiRequestsToday: 3,
  aiUsedTokensToday: 120,
  aiReservedTokensToday: 40,
  lastForwardedAt: 1_700_000_000_000,
  backupHealthy: true,
  backupLastSuccessAt: 1_700_000_100_000,
  backupOffsiteHealthy: true,
  backupOffsiteRequired: true,
  backupOffsiteLastSuccessAt: 1_700_000_150_000,
  retentionHealthy: true,
  retentionLastSuccessAt: 1_700_000_200_000,
  retentionDeletedTotal: 12,
  retentionBacklog: false,
  databaseAllocatedBytes: 8192,
  databaseReusableBytes: 4096,
  diskAvailableBytes: 2_000_000_000,
  diskCapacityHealthy: true,
  auditHealthy: true,
  auditRemoteRequired: true,
  auditLastRemoteSuccessAt: 1_700_000_250_000,
  tradingHealthy: true,
  tradingExecutionEnabled: true,
  tradingLiveEnabled: false,
  tradingKillSwitchActive: false,
  tradingEnabledRoutes: 2,
  tradingOpenPositions: 1,
  tradingPendingIntents: 1,
  tradingUnknownOrders: 0,
  tradingUnprotectedPositions: 0,
  tradingUnacknowledgedCriticalRiskEvents: 0,
  tradingIntentCount: 120,
  tradingFillCount: 240,
  tradingLatestReconciliationAt: 1_700_000_260_000,
  deliverySlo: {
    accepted: 11,
    attempts: 10,
    confirmed: 9,
    failed: 1,
    unknown: 0,
    latencyCount: 9,
    latencySumSeconds: 42,
    latencyBuckets: [
      { le: 1, count: 2 },
      { le: 5, count: 8 },
      { le: 60, count: 9 }
    ]
  }
};

async function runTests() {
  let operational = { ...HEALTHY_OPERATIONAL_METRICS };
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
  assert.match(metrics, /tg_forwarder_readiness 1/);
  assert.match(metrics, /tg_forwarder_outbox_oldest_pending_age_seconds 15/);
  assert.match(metrics, /tg_forwarder_ai_reserved_tokens_today 40/);
  assert.match(metrics, /tg_forwarder_last_confirmed_delivery_timestamp_seconds 1700000000/);
  assert.match(metrics, /tg_forwarder_backup_healthy 1/);
  assert.match(metrics, /tg_forwarder_backup_last_success_timestamp_seconds 1700000100/);
  assert.match(metrics, /tg_forwarder_backup_offsite_healthy 1/);
  assert.match(metrics, /tg_forwarder_backup_offsite_required 1/);
  assert.match(metrics, /tg_forwarder_backup_offsite_last_success_timestamp_seconds 1700000150/);
  assert.match(metrics, /tg_forwarder_retention_healthy 1/);
  assert.match(metrics, /tg_forwarder_retention_deleted_rows_total 12/);
  assert.match(metrics, /tg_forwarder_database_allocated_bytes 8192/);
  assert.match(metrics, /tg_forwarder_disk_capacity_healthy 1/);
  assert.match(metrics, /tg_forwarder_audit_healthy 1/);
  assert.match(metrics, /tg_forwarder_audit_last_remote_success_timestamp_seconds 1700000250/);
  assert.match(metrics, /tg_forwarder_trading_healthy 1/);
  assert.match(metrics, /tg_forwarder_trading_enabled_routes 2/);
  assert.match(metrics, /tg_forwarder_trading_open_positions 1/);
  assert.match(metrics, /tg_forwarder_trading_intents_total 120/);
  assert.match(metrics, /tg_forwarder_trading_fills_total 240/);
  assert.match(metrics, /tg_forwarder_trading_last_reconciliation_timestamp_seconds 1700000260/);
  assert.match(metrics, /tg_forwarder_delivery_attempts_total 10/);
  assert.match(metrics, /tg_forwarder_delivery_confirmed_total 9/);
  assert.match(metrics, /tg_forwarder_delivery_latency_seconds_bucket\{le="5"\} 8/);
  assert.match(metrics, /tg_forwarder_delivery_latency_seconds_count 9/);

  operational = { ...operational, diskCapacityHealthy: false };
  response = await fetch(`${baseUrl}/readyz`);
  assert.strictEqual(response.status, 503, 'Low disk capacity must fail readiness');

  operational = { ...operational, diskCapacityHealthy: true, auditHealthy: false };
  response = await fetch(`${baseUrl}/readyz`);
  assert.strictEqual(response.status, 503, 'Audit delivery failure must fail readiness');

  operational = { ...operational, auditHealthy: true, tradingHealthy: false, tradingUnknownOrders: 1 };
  response = await fetch(`${baseUrl}/readyz`);
  assert.strictEqual(response.status, 503, 'Unknown trading outcomes must fail readiness');

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
  const sampleDeadline = Date.now() + 1_000;
  while (tracker.getHistory().length < 3 && Date.now() < sampleDeadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  tracker.stop();
  const history = tracker.getHistory();
  assert.strictEqual(history.length, 3, 'History must enforce its configured memory bound');
  assert.ok(history.some(point => point.processedDelta === 2));
  assert.ok(history.every(point => point.cpuUsage >= 0 && point.memoryUsage > 0));
  assert.ok(history.every(point => !('internetSpeed' in point)), 'Fabricated bandwidth must not be emitted');

  console.log('ALL HONEST OBSERVABILITY TESTS PASSED!');
}

await runTests().catch(async error => {
  await stopMetricsServer().catch(() => {});
  console.error(error);
  process.exitCode = 1;
});
