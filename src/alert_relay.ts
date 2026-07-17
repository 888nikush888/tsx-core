import { timingSafeEqual } from 'crypto';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFile } from 'node:fs/promises';
import { loadEnv } from './env.js';
import { validateRuntimeSettings } from './runtime_settings.js';

const MAX_ALERT_BODY_BYTES = 1024 * 1024;

interface AlertRelayOptions {
  incomingToken: string;
  webhookUrl: string;
  webhookToken: string;
  timeoutMs?: number;
  allowInsecureLoopback?: boolean;
}

interface AlertSummary {
  alertCount: number;
  status: 'firing' | 'resolved';
}

function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
}

function validateToken(name: string, value: string): void {
  if (!value || value.length < 32 || /[\r\n]/.test(value)) {
    throw new Error(`${name} must contain at least 32 characters without line breaks.`);
  }
}

function validateWebhookUrl(value: string, allowInsecureLoopback = false): void {
  const url = new URL(value);
  if (url.username || url.password || url.hash) throw new Error('ALERT_WEBHOOK_URL must not contain credentials or a fragment.');
  const permitsLoopbackHttp = allowInsecureLoopback && url.protocol === 'http:' && isLoopback(url.hostname);
  if (url.protocol !== 'https:' && !permitsLoopbackHttp) {
    throw new Error('ALERT_WEBHOOK_URL must use HTTPS.');
  }
}

function validateOptions(options: AlertRelayOptions): void {
  validateToken('ALERT_RELAY_TOKEN', options.incomingToken);
  validateToken('ALERT_WEBHOOK_TOKEN', options.webhookToken);
  validateWebhookUrl(options.webhookUrl, options.allowInsecureLoopback);
}

function validateTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw new Error('Alert webhook timeout must be between 1 and 60 seconds.');
  }
}

function requestError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
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

function parseAlertPayload(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw requestError('Alert payload is not valid JSON.', 400);
  }
}

function validAlertEnvelope(payload: any): payload is { status: 'firing' | 'resolved'; alerts: unknown[] } {
  return Boolean(payload)
    && (payload.status === 'firing' || payload.status === 'resolved')
    && Array.isArray(payload.alerts)
    && payload.alerts.length <= 100;
}

function validAlertLabels(alert: any): boolean {
  return Boolean(alert?.labels)
    && typeof alert.labels.alertname === 'string'
    && typeof alert.labels.severity === 'string';
}

function validateAlertPayload(body: Buffer): AlertSummary {
  const payload = parseAlertPayload(body);
  if (!validAlertEnvelope(payload)) throw requestError('Alert payload does not match the Alertmanager contract.', 400);
  if (!payload.alerts.every(validAlertLabels)) {
    throw requestError('Alert payload contains an alert without required labels.', 400);
  }
  return { alertCount: payload.alerts.length, status: payload.status };
}

function writeJsonLog(level: 'INFO' | 'ERROR', event: string, fields: Record<string, unknown>): void {
  const entry = JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields });
  if (level === 'ERROR') console.error(entry);
  else console.log(entry);
}

async function deliverAlert(options: AlertRelayOptions, timeoutMs: number, body: Buffer): Promise<AlertSummary> {
  const summary = validateAlertPayload(body);
  const delivered = await fetch(options.webhookUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.webhookToken}`,
      'Content-Type': 'application/json',
      'Content-Length': String(body.length),
      'X-Alert-Source': 'telegram-forwarder'
    },
    body: body.toString('utf8'),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs)
  });
  await delivered.body?.cancel();
  if (delivered.status < 200 || delivered.status >= 300) {
    throw new Error(`Incident webhook returned HTTP ${delivered.status}.`);
  }
  return summary;
}

async function handleAlertRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: AlertRelayOptions,
  timeoutMs: number
): Promise<void> {
  if (request.method === 'GET' && request.url === '/healthz') {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end('{"status":"alive"}');
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
    const summary = await deliverAlert(options, timeoutMs, await readBody(request));
    writeJsonLog('INFO', 'alert_delivered', { alert_count: summary.alertCount, alert_status: summary.status });
    response.writeHead(202).end();
  } catch (error: any) {
    writeJsonLog('ERROR', 'alert_delivery_failed', { error_code: String(error.name || 'Error') });
    response.writeHead(Number(error.statusCode) || 502).end();
  }
}

export function createAlertRelay(options: AlertRelayOptions): http.Server {
  validateOptions(options);
  const timeoutMs = options.timeoutMs ?? 10_000;
  validateTimeout(timeoutMs);
  const server = http.createServer((request, response) => void handleAlertRequest(request, response, options, timeoutMs));
  server.requestTimeout = 15_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

export async function applyManagedRuntimeSettings(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (env.ALERT_WEBHOOK_URL?.trim()) return;
  const settingsPath = env.RUNTIME_SETTINGS_PATH?.trim();
  if (!settingsPath) return;
  const settings = validateRuntimeSettings(JSON.parse(await readFile(path.resolve(settingsPath), 'utf8')));
  if (settings.alertWebhookUrl) env.ALERT_WEBHOOK_URL = settings.alertWebhookUrl;
  env.ALERT_WEBHOOK_TIMEOUT_MS = String(settings.alertWebhookTimeoutMs);
}

async function startFromEnvironment(): Promise<void> {
  loadEnv();
  await applyManagedRuntimeSettings(process.env);
  const port = Number(process.env.ALERT_RELAY_PORT || 9095);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('ALERT_RELAY_PORT must be between 1 and 65535.');
  const server = createAlertRelay({
    incomingToken: process.env.ALERT_RELAY_TOKEN || '',
    webhookUrl: process.env.ALERT_WEBHOOK_URL || '',
    webhookToken: process.env.ALERT_WEBHOOK_TOKEN || '',
    timeoutMs: Number(process.env.ALERT_WEBHOOK_TIMEOUT_MS || 10_000)
  });
  server.listen(port, '0.0.0.0', () => console.log(`[INFO] Alert relay listening on port ${port}.`));
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  startFromEnvironment().catch((error) => {
    console.error(`[FATAL] Alert relay startup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
