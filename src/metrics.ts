import http from 'node:http';
import type { OutboxStatus } from './db.js';
import type { DeliverySloSnapshot } from './slo_tracker.js';

export interface OperationalMetrics {
  databaseHealthy: boolean;
  isRunning: boolean;
  connectionState: string;
  queuePaused: boolean;
  outbox: Record<OutboxStatus, number>;
  oldestPendingOutboxAgeSeconds: number;
  aiRequestsToday: number;
  aiUsedTokensToday: number;
  aiReservedTokensToday: number;
  lastForwardedAt: number | null;
  backupHealthy: boolean;
  backupLastSuccessAt: number | null;
  backupOffsiteHealthy: boolean;
  backupOffsiteRequired: boolean;
  backupOffsiteLastSuccessAt: number | null;
  backupConfigurationCoherentAt?: number | null;
  backupRestoreEligibleAt?: number | null;
  backupRestoreEligibilityCheckedAt?: number | null;
  backupRestoreDrillAt?: number | null;
  retentionHealthy: boolean;
  retentionLastSuccessAt: number | null;
  retentionDeletedTotal: number;
  retentionBacklog: boolean;
  databaseAllocatedBytes: number;
  databaseReusableBytes: number;
  diskAvailableBytes: number;
  diskCapacityHealthy: boolean;
  deliverySlo: DeliverySloSnapshot;
  auditHealthy: boolean;
  auditRemoteRequired: boolean;
  auditLastRemoteSuccessAt: number | null;
  clockHealthy: boolean;
  clockDriftMilliseconds: number;
  clockMaxDriftMilliseconds: number;
  clockCheckedAt: number;
  tradingHealthy: boolean;
  tradingExecutionEnabled: boolean;
  tradingLiveEnabled: boolean;
  tradingKillSwitchActive: boolean;
  tradingEnabledRoutes: number;
  tradingOpenPositions: number;
  tradingPendingIntents: number;
  tradingUnknownOrders: number;
  tradingUnprotectedPositions: number;
  tradingUnacknowledgedCriticalRiskEvents: number;
  tradingIntentCount: number;
  tradingFillCount: number;
  tradingLatestReconciliationAt: number | null;
}

interface MetricsState {
  totalForwardedCountCallback: () => number;
  getQueueStateCallback: () => { running: number; queued: number; maxConcurrency: number };
  getOperationalMetricsCallback: () => Promise<OperationalMetrics>;
}

let server: http.Server | null = null;
const startedAt = Date.now();

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(payload));
}

function metric(name: string, help: string, type: 'counter' | 'gauge', value: number, labels = ''): string[] {
  return [
    `# HELP ${name} ${help}`,
    `# TYPE ${name} ${type}`,
    `${name}${labels} ${Number.isFinite(value) ? value : 0}`
  ];
}

function safeConnectionState(value: string): string {
  const normalized = String(value || 'unknown').toLowerCase();
  return ['connected', 'connecting', 'disconnected', 'error'].includes(normalized) ? normalized : 'unknown';
}

function asFlag(value: boolean): number {
  return value ? 1 : 0;
}

function timestampSeconds(value: number | null): number {
  return value ? Math.floor(value / 1000) : 0;
}

function isOperationallyReady(operational: OperationalMetrics): boolean {
  return [
    operational.databaseHealthy,
    operational.isRunning,
    operational.connectionState === 'connected',
    !operational.queuePaused,
    operational.backupHealthy,
    operational.retentionHealthy,
    operational.diskCapacityHealthy,
    operational.auditHealthy,
    operational.clockHealthy,
    operational.tradingHealthy,
    operational.oldestPendingOutboxAgeSeconds < 300
  ].every(Boolean);
}

function readinessChecks(operational: OperationalMetrics): Record<string, boolean | string | number> {
  return {
    database: operational.databaseHealthy,
    routing: operational.isRunning,
    connection: safeConnectionState(operational.connectionState),
    queuePaused: operational.queuePaused,
    backup: operational.backupHealthy,
    backupOffsite: operational.backupOffsiteHealthy,
    backupOffsiteRequired: operational.backupOffsiteRequired,
    retention: operational.retentionHealthy,
    diskCapacity: operational.diskCapacityHealthy,
    audit: operational.auditHealthy,
    auditRemoteRequired: operational.auditRemoteRequired,
    clock: operational.clockHealthy,
    clockDriftMilliseconds: operational.clockDriftMilliseconds,
    clockMaxDriftMilliseconds: operational.clockMaxDriftMilliseconds,
    clockCheckedAt: operational.clockCheckedAt,
    trading: operational.tradingHealthy,
    tradingKillSwitchActive: operational.tradingKillSwitchActive,
    tradingUnknownOrders: operational.tradingUnknownOrders,
    tradingUnprotectedPositions: operational.tradingUnprotectedPositions,
    tradingLatestReconciliationAt: operational.tradingLatestReconciliationAt,
    oldestPendingOutboxAgeSeconds: operational.oldestPendingOutboxAgeSeconds
  };
}

function prometheusMetrics(operational: OperationalMetrics, state: MetricsState): string {
  const queue = state.getQueueStateCallback();
  const forwarded = state.totalForwardedCountCallback();
  const connectionState = safeConnectionState(operational.connectionState);
  const delivery = operational.deliverySlo;
  const lines = [
    ...metric('tg_forwarder_total_forwarded', 'Confirmed forwarded messages', 'counter', forwarded),
    ...metric('tg_forwarder_queue_running', 'Tasks currently executing', 'gauge', queue.running),
    ...metric('tg_forwarder_queue_queued', 'Tasks waiting for execution', 'gauge', queue.queued),
    ...metric('tg_forwarder_queue_max_concurrency', 'Configured task concurrency', 'gauge', queue.maxConcurrency),
    ...metric('tg_forwarder_routing_active', 'Whether routing is active', 'gauge', asFlag(operational.isRunning)),
    ...metric('tg_forwarder_database_healthy', 'Whether SQLite responds to a health query', 'gauge', asFlag(operational.databaseHealthy)),
    '# HELP tg_forwarder_connection_state Current Telegram connection state',
    '# TYPE tg_forwarder_connection_state gauge',
    ...['connected', 'connecting', 'disconnected', 'error', 'unknown'].map(current =>
      `tg_forwarder_connection_state{state="${current}"} ${current === connectionState ? 1 : 0}`
    ),
    ...metric('tg_forwarder_last_confirmed_delivery_timestamp_seconds', 'Unix time of the last confirmed delivery', 'gauge', timestampSeconds(operational.lastForwardedAt)),
    ...metric('tg_forwarder_backup_healthy', 'Whether local snapshot verification and required replication are current; not a restore-eligibility or drill guarantee', 'gauge', asFlag(operational.backupHealthy)),
    ...metric('tg_forwarder_backup_last_success_timestamp_seconds', 'Unix time of the last local artifact integrity verification', 'gauge', timestampSeconds(operational.backupLastSuccessAt)),
    ...metric('tg_forwarder_backup_offsite_healthy', 'Whether encrypted off-site replication was downloaded, decrypted and integrity-verified', 'gauge', asFlag(operational.backupOffsiteHealthy)),
    ...metric('tg_forwarder_backup_offsite_required', 'Whether off-site replication is a readiness requirement', 'gauge', asFlag(operational.backupOffsiteRequired)),
    ...metric('tg_forwarder_backup_offsite_last_success_timestamp_seconds', 'Unix time of the last downloaded and integrity-verified off-site artifact', 'gauge', timestampSeconds(operational.backupOffsiteLastSuccessAt)),
    ...metric('tg_forwarder_backup_configuration_coherent_timestamp_seconds', 'Unix time of the last verified shared configuration generation', 'gauge', timestampSeconds(operational.backupConfigurationCoherentAt)),
    ...metric('tg_forwarder_backup_restore_eligible_timestamp_seconds', 'Unix time of the last artifact-local eligible proof; not current exchange flatness', 'gauge', timestampSeconds(operational.backupRestoreEligibleAt)),
    ...metric('tg_forwarder_backup_restore_eligibility_checked_timestamp_seconds', 'Unix time of the latest artifact-local eligibility check, including blocked or unknown', 'gauge', timestampSeconds(operational.backupRestoreEligibilityCheckedAt)),
    ...metric('tg_forwarder_backup_restore_drill_timestamp_seconds', 'Unix time of the last actually completed isolated restore drill', 'gauge', timestampSeconds(operational.backupRestoreDrillAt)),
    ...metric('tg_forwarder_retention_healthy', 'Whether operational data retention is current and has no backlog', 'gauge', asFlag(operational.retentionHealthy)),
    ...metric('tg_forwarder_retention_last_success_timestamp_seconds', 'Unix time of the last successful retention run', 'gauge', timestampSeconds(operational.retentionLastSuccessAt)),
    ...metric('tg_forwarder_retention_deleted_rows_total', 'Operational rows deleted by retention since process start', 'counter', operational.retentionDeletedTotal),
    ...metric('tg_forwarder_retention_backlog', 'Whether retention exceeded the bounded cleanup work per run', 'gauge', asFlag(operational.retentionBacklog)),
    ...metric('tg_forwarder_database_allocated_bytes', 'SQLite allocated database bytes', 'gauge', operational.databaseAllocatedBytes),
    ...metric('tg_forwarder_database_reusable_bytes', 'SQLite bytes currently reusable from the freelist', 'gauge', operational.databaseReusableBytes),
    ...metric('tg_forwarder_disk_available_bytes', 'Available bytes on the operational data filesystem', 'gauge', operational.diskAvailableBytes),
    ...metric('tg_forwarder_disk_capacity_healthy', 'Whether available disk remains above the configured minimum', 'gauge', asFlag(operational.diskCapacityHealthy)),
    ...metric('tg_forwarder_audit_healthy', 'Whether the tamper-evident audit trail and required remote sink are healthy', 'gauge', asFlag(operational.auditHealthy)),
    ...metric('tg_forwarder_audit_remote_required', 'Whether remote audit delivery is required', 'gauge', asFlag(operational.auditRemoteRequired)),
    ...metric('tg_forwarder_audit_last_remote_success_timestamp_seconds', 'Unix time of the last successful remote audit delivery', 'gauge', timestampSeconds(operational.auditLastRemoteSuccessAt)),
    ...metric('tg_forwarder_clock_healthy', 'Whether wall-clock progress agrees with the monotonic process clock', 'gauge', asFlag(operational.clockHealthy)),
    ...metric('tg_forwarder_clock_drift_milliseconds', 'Observed wall-clock drift relative to the monotonic process clock', 'gauge', operational.clockDriftMilliseconds),
    ...metric('tg_forwarder_clock_max_drift_milliseconds', 'Configured maximum safe wall-clock drift', 'gauge', operational.clockMaxDriftMilliseconds),
    ...metric('tg_forwarder_clock_last_check_timestamp_seconds', 'Unix time of the latest clock-drift check', 'gauge', timestampSeconds(operational.clockCheckedAt)),
    ...metric('tg_forwarder_trading_healthy', 'Whether managed trading is reconciled and has no unresolved safety state', 'gauge', asFlag(operational.tradingHealthy)),
    ...metric('tg_forwarder_trading_execution_enabled', 'Whether automatic strategy execution is enabled', 'gauge', asFlag(operational.tradingExecutionEnabled)),
    ...metric('tg_forwarder_trading_live_enabled', 'Whether the one-time live trading gate is enabled', 'gauge', asFlag(operational.tradingLiveEnabled)),
    ...metric('tg_forwarder_trading_kill_switch_active', 'Whether the trading kill switch blocks new entries', 'gauge', asFlag(operational.tradingKillSwitchActive)),
    ...metric('tg_forwarder_trading_enabled_routes', 'Enabled channel-to-strategy routes', 'gauge', operational.tradingEnabledRoutes),
    ...metric('tg_forwarder_trading_open_positions', 'Managed non-zero positions', 'gauge', operational.tradingOpenPositions),
    ...metric('tg_forwarder_trading_pending_intents', 'Trading intents requiring processing or monitoring', 'gauge', operational.tradingPendingIntents),
    ...metric('tg_forwarder_trading_unknown_orders', 'Orders with an unknown exchange outcome', 'gauge', operational.tradingUnknownOrders),
    ...metric('tg_forwarder_trading_unprotected_positions', 'Managed exposure or entry commitments without a current authoritative protection proof', 'gauge', operational.tradingUnprotectedPositions),
    ...metric('tg_forwarder_trading_unacknowledged_critical_risk_events', 'Unacknowledged critical trading risk events', 'gauge', operational.tradingUnacknowledgedCriticalRiskEvents),
    ...metric('tg_forwarder_trading_intents_total', 'Persisted trading intents', 'counter', operational.tradingIntentCount),
    ...metric('tg_forwarder_trading_fills_total', 'Persisted exchange fills', 'counter', operational.tradingFillCount),
    ...metric('tg_forwarder_trading_last_reconciliation_timestamp_seconds', 'Unix time of the latest successful exchange reconciliation', 'gauge', timestampSeconds(operational.tradingLatestReconciliationAt)),
    ...metric('tg_forwarder_readiness', 'Whether all operational readiness checks currently pass', 'gauge', asFlag(isOperationallyReady(operational))),
    ...metric('tg_forwarder_outbox_oldest_pending_age_seconds', 'Age in seconds of the oldest pending, preparing or sending outbox task', 'gauge', operational.oldestPendingOutboxAgeSeconds),
    ...metric('tg_forwarder_ai_requests_today', 'AI provider requests reserved today (UTC)', 'gauge', operational.aiRequestsToday),
    ...metric('tg_forwarder_ai_used_tokens_today', 'AI tokens accounted today (UTC)', 'gauge', operational.aiUsedTokensToday),
    ...metric('tg_forwarder_ai_reserved_tokens_today', 'AI tokens reserved by unfinished calls today (UTC)', 'gauge', operational.aiReservedTokensToday),
    ...metric('tg_forwarder_delivery_accepted_total', 'Filtered messages accepted into the durable outbox', 'counter', delivery.accepted),
    ...metric('tg_forwarder_delivery_attempts_total', 'Durable tasks that reached the Telegram send boundary', 'counter', delivery.attempts),
    ...metric('tg_forwarder_delivery_confirmed_total', 'Telegram delivery tasks with a confirmed outcome', 'counter', delivery.confirmed),
    ...metric('tg_forwarder_delivery_failed_total', 'Telegram delivery attempts with a retryable failed outcome', 'counter', delivery.failed),
    ...metric('tg_forwarder_delivery_unknown_total', 'Telegram delivery attempts with an unknown outcome', 'counter', delivery.unknown),
    '# HELP tg_forwarder_delivery_latency_seconds Accepted-to-confirmed Telegram delivery latency',
    '# TYPE tg_forwarder_delivery_latency_seconds histogram',
    ...delivery.latencyBuckets.map(bucket => `tg_forwarder_delivery_latency_seconds_bucket{le="${bucket.le}"} ${bucket.count}`),
    `tg_forwarder_delivery_latency_seconds_bucket{le="+Inf"} ${delivery.latencyCount}`,
    `tg_forwarder_delivery_latency_seconds_sum ${delivery.latencySumSeconds}`,
    `tg_forwarder_delivery_latency_seconds_count ${delivery.latencyCount}`,
    '# HELP tg_forwarder_outbox_tasks Durable outbox tasks by status',
    '# TYPE tg_forwarder_outbox_tasks gauge',
    ...Object.entries(operational.outbox).map(([status, count]) =>
      `tg_forwarder_outbox_tasks{status="${status}"} ${count}`
    ),
    ...metric('process_uptime_seconds', 'Process uptime in seconds', 'gauge', process.uptime()),
    ...metric('process_resident_memory_bytes', 'Resident memory size in bytes', 'gauge', process.memoryUsage().rss)
  ];
  return `${lines.join('\n')}\n`;
}

export function startMetricsServer(
  port: number,
  state: MetricsState,
  host = process.env.METRICS_HOST?.trim() || '127.0.0.1'
): http.Server {
  if (server) throw new Error('Metrics server is already running.');
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error('Metrics port must be between 0 and 65535.');

  server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' });
      res.end('Method Not Allowed');
      return;
    }

    if (url === '/healthz') {
      sendJson(res, 200, {
        status: 'alive',
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        timestamp: new Date().toISOString()
      });
      return;
    }

    if (url !== '/readyz' && url !== '/metrics') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    let operational: OperationalMetrics;
    try {
      operational = await state.getOperationalMetricsCallback();
    } catch (error: any) {
      sendJson(res, 503, { status: 'unavailable', error: error.message });
      return;
    }

    if (url === '/readyz') {
      const ready = isOperationallyReady(operational);
      sendJson(res, ready ? 200 : 503, {
        status: ready ? 'ready' : 'not_ready',
        checks: readinessChecks(operational),
        unresolvedDeliveries: operational.outbox.failed + operational.outbox.unknown
      });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(prometheusMetrics(operational, state));
  });

  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.listen(port, host, () => {
    const address = server?.address();
    const listeningPort = typeof address === 'object' && address ? address.port : port;
    console.log(`[INFO] Metrics server listening on http://${host}:${listeningPort}`);
  });
  return server;
}

export function stopMetricsServer(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const activeServer = server;
    server = null;
    if (!activeServer) {
      resolve();
      return;
    }
    activeServer.close(error => error ? reject(error) : resolve());
  });
}
