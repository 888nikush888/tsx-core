import http from 'http';
import type { OutboxStatus } from './db.js';

export interface OperationalMetrics {
  databaseHealthy: boolean;
  isRunning: boolean;
  connectionState: string;
  queuePaused: boolean;
  outbox: Record<OutboxStatus, number>;
  aiRequestsToday: number;
  aiUsedTokensToday: number;
  aiReservedTokensToday: number;
  lastForwardedAt: number | null;
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
      const ready = operational.databaseHealthy
        && operational.isRunning
        && operational.connectionState === 'connected'
        && !operational.queuePaused;
      sendJson(res, ready ? 200 : 503, {
        status: ready ? 'ready' : 'not_ready',
        checks: {
          database: operational.databaseHealthy,
          routing: operational.isRunning,
          connection: safeConnectionState(operational.connectionState),
          queuePaused: operational.queuePaused
        },
        unresolvedDeliveries: operational.outbox.failed + operational.outbox.unknown
      });
      return;
    }

    const queue = state.getQueueStateCallback();
    const forwarded = state.totalForwardedCountCallback();
    const connectionState = safeConnectionState(operational.connectionState);
    const lines = [
      ...metric('tg_forwarder_total_forwarded', 'Confirmed forwarded messages', 'counter', forwarded),
      ...metric('tg_forwarder_queue_running', 'Tasks currently executing', 'gauge', queue.running),
      ...metric('tg_forwarder_queue_queued', 'Tasks waiting for execution', 'gauge', queue.queued),
      ...metric('tg_forwarder_queue_max_concurrency', 'Configured task concurrency', 'gauge', queue.maxConcurrency),
      ...metric('tg_forwarder_routing_active', 'Whether routing is active', 'gauge', operational.isRunning ? 1 : 0),
      ...metric('tg_forwarder_database_healthy', 'Whether SQLite responds to a health query', 'gauge', operational.databaseHealthy ? 1 : 0),
      '# HELP tg_forwarder_connection_state Current Telegram connection state',
      '# TYPE tg_forwarder_connection_state gauge',
      ...['connected', 'connecting', 'disconnected', 'error', 'unknown'].map(current =>
        `tg_forwarder_connection_state{state="${current}"} ${current === connectionState ? 1 : 0}`
      ),
      ...metric('tg_forwarder_last_confirmed_delivery_timestamp_seconds', 'Unix time of the last confirmed delivery', 'gauge', operational.lastForwardedAt ? Math.floor(operational.lastForwardedAt / 1000) : 0),
      ...metric('tg_forwarder_ai_requests_today', 'AI provider requests reserved today (UTC)', 'gauge', operational.aiRequestsToday),
      ...metric('tg_forwarder_ai_used_tokens_today', 'AI tokens accounted today (UTC)', 'gauge', operational.aiUsedTokensToday),
      ...metric('tg_forwarder_ai_reserved_tokens_today', 'AI tokens reserved by unfinished calls today (UTC)', 'gauge', operational.aiReservedTokensToday),
      '# HELP tg_forwarder_outbox_tasks Durable outbox tasks by status',
      '# TYPE tg_forwarder_outbox_tasks gauge',
      ...Object.entries(operational.outbox).map(([status, count]) =>
        `tg_forwarder_outbox_tasks{status="${status}"} ${count}`
      ),
      ...metric('process_uptime_seconds', 'Process uptime in seconds', 'gauge', process.uptime()),
      ...metric('process_resident_memory_bytes', 'Resident memory size in bytes', 'gauge', process.memoryUsage().rss)
    ];
    res.writeHead(200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(`${lines.join('\n')}\n`);
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
