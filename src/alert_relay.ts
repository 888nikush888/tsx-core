import { timingSafeEqual } from 'crypto';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadEnv } from './env.js';

const MAX_ALERT_BODY_BYTES = 1024 * 1024;

interface AlertRelayOptions {
  incomingToken: string;
  webhookUrl: string;
  webhookToken: string;
  timeoutMs?: number;
  allowInsecureLoopback?: boolean;
}

function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
}

function validateOptions(options: AlertRelayOptions): void {
  for (const [name, value] of [
    ['ALERT_RELAY_TOKEN', options.incomingToken],
    ['ALERT_WEBHOOK_TOKEN', options.webhookToken]
  ]) {
    if (!value || value.length < 32 || /[\r\n]/.test(value)) {
      throw new Error(`${name} must contain at least 32 characters without line breaks.`);
    }
  }
  const url = new URL(options.webhookUrl);
  if (url.username || url.password || url.hash) throw new Error('ALERT_WEBHOOK_URL must not contain credentials or a fragment.');
  if (url.protocol !== 'https:' && !(options.allowInsecureLoopback && url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new Error('ALERT_WEBHOOK_URL must use HTTPS.');
  }
}

function authorized(header: string | undefined, expectedToken: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(expectedToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readBody(request: http.IncomingMessage): Promise<Buffer> {
  const declared = Number(request.headers['content-length'] || 0);
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_ALERT_BODY_BYTES) {
    throw Object.assign(new Error('Alert payload exceeds 1 MiB.'), { statusCode: 413 });
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_ALERT_BODY_BYTES) throw Object.assign(new Error('Alert payload exceeds 1 MiB.'), { statusCode: 413 });
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function validateAlertPayload(body: Buffer): { alertCount: number; status: string } {
  let payload: any;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Alert payload is not valid JSON.'), { statusCode: 400 });
  }
  if (!payload || !['firing', 'resolved'].includes(payload.status) || !Array.isArray(payload.alerts) || payload.alerts.length > 100) {
    throw Object.assign(new Error('Alert payload does not match the Alertmanager contract.'), { statusCode: 400 });
  }
  for (const alert of payload.alerts) {
    if (!alert?.labels || typeof alert.labels.alertname !== 'string' || typeof alert.labels.severity !== 'string') {
      throw Object.assign(new Error('Alert payload contains an alert without required labels.'), { statusCode: 400 });
    }
  }
  return { alertCount: payload.alerts.length, status: payload.status };
}

export function createAlertRelay(options: AlertRelayOptions): http.Server {
  validateOptions(options);
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw new Error('Alert webhook timeout must be between 1 and 60 seconds.');
  }
  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end('{"status":"alive"}');
      return;
    }
    if (request.method !== 'POST' || request.url !== '/alerts') {
      response.writeHead(404).end();
      return;
    }
    if (!authorized(request.headers.authorization, options.incomingToken)) {
      response.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end();
      return;
    }
    try {
      const body = await readBody(request);
      const summary = validateAlertPayload(body);
      const bodyText = body.toString('utf8');
      const delivered = await fetch(options.webhookUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.webhookToken}`,
          'Content-Type': 'application/json',
          'Content-Length': String(body.length),
          'X-Alert-Source': 'telegram-forwarder'
        },
        body: bodyText,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs)
      });
      await delivered.body?.cancel();
      if (delivered.status < 200 || delivered.status >= 300) {
        throw new Error(`Incident webhook returned HTTP ${delivered.status}.`);
      }
      console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'INFO',
        event: 'alert_delivered',
        alert_count: summary.alertCount,
        alert_status: summary.status
      }));
      response.writeHead(202).end();
    } catch (error: any) {
      const statusCode = Number(error.statusCode) || 502;
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'ERROR',
        event: 'alert_delivery_failed',
        error_code: String(error.name || 'Error')
      }));
      response.writeHead(statusCode).end();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

function startFromEnvironment(): void {
  loadEnv();
  const port = Number(process.env.ALERT_RELAY_PORT || 9095);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('ALERT_RELAY_PORT must be between 1 and 65535.');
  const server = createAlertRelay({
    incomingToken: process.env.ALERT_RELAY_TOKEN || '',
    webhookUrl: process.env.ALERT_WEBHOOK_URL || '',
    webhookToken: process.env.ALERT_WEBHOOK_TOKEN || ''
  });
  server.listen(port, '0.0.0.0', () => console.log(`[INFO] Alert relay listening on port ${port}.`));
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  startFromEnvironment();
}
