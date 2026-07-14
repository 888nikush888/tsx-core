import http from 'http';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { writeConfigSync } from './config.js';
import { addLog, getLogHistory } from './ui.js';
import { getIncomingMessages, getProcessedSignals, clearDb, deleteIncomingMessage, deleteProcessedSignal } from './db.js';
import type { EnterpriseAuditTrail } from './audit_trail.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface WebServerState {
  config: any;
  state: any;
  getQueueState: () => { running: number; queued: number; maxConcurrency: number; paused: boolean };
  startForwarding: (config: any) => Promise<void>;
  stopForwarding: () => Promise<any>;
  reloadConfig: () => void;
  applyRuntimeConfig: (config: any) => void;
  getMetricsHistory?: () => any[];
  getOutboxTasks?: (statuses?: string[]) => Promise<any[]>;
  retryOutboxTask?: (id: string) => Promise<boolean>;
  acknowledgeOutboxTask?: (id: string, reason: string) => Promise<boolean>;
  auditTrail?: Pick<EnterpriseAuditTrail, 'record'>;
}

let server: http.Server | null = null;

type DashboardRole = 'viewer' | 'admin';

interface AuthenticatedActor {
  role: DashboardRole;
  id: string;
}

class HttpError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function safeTokenEquals(candidate: string, expected: string): boolean {
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return candidateBuffer.length === expectedBuffer.length && timingSafeEqual(candidateBuffer, expectedBuffer);
}

function configuredToken(name: 'DASHBOARD_ADMIN_TOKEN' | 'DASHBOARD_VIEWER_TOKEN'): string | null {
  const value = process.env[name]?.trim() || '';
  if (/^(replace_|change-?me|example|placeholder)/i.test(value)) return null;
  return value.length >= 32 ? value : null;
}

function isAuthenticationConfigured(): boolean {
  const adminToken = configuredToken('DASHBOARD_ADMIN_TOKEN');
  const viewerToken = configuredToken('DASHBOARD_VIEWER_TOKEN');
  return !!adminToken && (!viewerToken || !safeTokenEquals(adminToken, viewerToken));
}

function authenticate(req: http.IncomingMessage): AuthenticatedActor | null {
  const authorization = req.headers.authorization || '';
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match) return null;
  const token = match[1]!;
  const adminToken = configuredToken('DASHBOARD_ADMIN_TOKEN');
  const id = `token:${createHash('sha256').update(token).digest('hex').slice(0, 16)}`;
  if (adminToken && safeTokenEquals(token, adminToken)) return { role: 'admin', id };
  const viewerToken = configuredToken('DASHBOARD_VIEWER_TOKEN');
  if (viewerToken && safeTokenEquals(token, viewerToken)) return { role: 'viewer', id };
  return null;
}

function recordAuditCompletion(
  auditTrail: WebServerState['auditTrail'],
  actor: AuthenticatedActor,
  requestId: string,
  method: string,
  url: string,
  statusCode: number
): void {
  addLog(`[AUDIT] request_id=${requestId} actor_role=${actor.role} method=${method} path=${url} status=${statusCode}`);
  void auditTrail?.record({
    phase: 'completed',
    action: 'dashboard.mutation',
    requestId,
    actorId: actor.id,
    actorRole: actor.role,
    method,
    path: url,
    statusCode
  }).catch(error => addLog(`[CRITICAL] Audit outcome delivery failed: ${error.message}`, {
    request_id: requestId,
    event: 'audit_delivery_failed'
  }));
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  const configuredOrigin = process.env.DASHBOARD_ALLOWED_ORIGIN?.trim();
  if (configuredOrigin && origin === configuredOrigin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function setSecurityHeaders(res: http.ServerResponse, origin?: string): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
}

async function readJsonBody(req: http.IncomingMessage, maxBytes = 256 * 1024): Promise<any> {
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new HttpError(413, `Request body exceeds ${maxBytes} bytes.`);
  }

  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    receivedBytes += buffer.length;
    if (receivedBytes > maxBytes) {
      throw new HttpError(413, `Request body exceeds ${maxBytes} bytes.`);
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON.');
  }
}

function publicConfig(config: any): any {
  const forbidden = new Set([
    'apiHash', 'openRouterApiKey', 'OPENROUTER_API_KEY', 'TELEGRAM_API_HASH',
    'DASHBOARD_ADMIN_TOKEN', 'DASHBOARD_VIEWER_TOKEN', 'BACKUP_OFFSITE_TOKEN',
    'BACKUP_ENCRYPTION_KEY', 'ALERT_RELAY_TOKEN', 'ALERT_WEBHOOK_TOKEN',
    'PROMETHEUS_TOKEN', 'AUDIT_WEBHOOK_TOKEN'
  ]);
  return JSON.parse(JSON.stringify(config || {}, (key, value) => forbidden.has(key) ? undefined : value));
}

function containsSecretConfig(input: any): boolean {
  if (!input || typeof input !== 'object') return false;
  const forbidden = new Set([
    'apiHash', 'openRouterApiKey', 'OPENROUTER_API_KEY', 'TELEGRAM_API_HASH',
    'DASHBOARD_ADMIN_TOKEN', 'DASHBOARD_VIEWER_TOKEN', 'BACKUP_OFFSITE_TOKEN',
    'BACKUP_ENCRYPTION_KEY', 'ALERT_RELAY_TOKEN', 'ALERT_WEBHOOK_TOKEN',
    'PROMETHEUS_TOKEN', 'AUDIT_WEBHOOK_TOKEN'
  ]);
  return Object.entries(input).some(([key, value]) => forbidden.has(key) || containsSecretConfig(value));
}

function requireMutationHeaders(req: http.IncomingMessage): void {
  if (req.headers['x-requested-with'] !== 'forwarder-dashboard') {
    throw new HttpError(400, 'Missing X-Requested-With header.');
  }
}

async function authorizeMutationAudit(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  auditTrail: WebServerState['auditTrail'],
  actor: AuthenticatedActor,
  requestId: string,
  method: string,
  url: string
): Promise<boolean> {
  try {
    requireMutationHeaders(req);
  } catch (error) {
    const httpError = error as HttpError;
    sendJson(res, httpError.statusCode, { error: httpError.message, requestId });
    return false;
  }
  try {
    await auditTrail?.record({
      phase: 'authorized',
      action: 'dashboard.mutation',
      requestId,
      actorId: actor.id,
      actorRole: actor.role,
      method,
      path: url
    });
    return true;
  } catch (error: any) {
    addLog(`[CRITICAL] Audit precondition failed; dashboard mutation blocked: ${error.message}`, {
      request_id: requestId,
      event: 'audit_precondition_failed'
    });
    sendJson(res, 503, { error: 'Audit trail unavailable; mutation blocked.', requestId });
    return false;
  }
}

export function startWebServer(
  port: number,
  appState: WebServerState,
  host = process.env.WEB_HOST?.trim() || '127.0.0.1'
): http.Server {
  server = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);
    const rawUrl = req.url || '/';
    const parsedUrl = new URL(rawUrl, `http://${req.headers.host || 'localhost'}`);
    const url = parsedUrl.pathname;
    const method = req.method || 'GET';
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    setSecurityHeaders(res, origin);

    if (!isAllowedOrigin(origin)) {
      sendJson(res, 403, { error: 'Origin is not allowed.', requestId });
      return;
    }

    if (method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Requested-With, X-Destructive-Confirmation');
      res.writeHead(204);
      res.end();
      return;
    }

    let actor: AuthenticatedActor | null = null;
    if (url.startsWith('/api/')) {
      if (!isAuthenticationConfigured()) {
        sendJson(res, 503, { error: 'Dashboard authentication is not configured.', requestId });
        return;
      }
      actor = authenticate(req);
      if (!actor) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="forwarder-dashboard"');
        sendJson(res, 401, { error: 'Valid dashboard bearer token required.', requestId });
        return;
      }
      res.setHeader('X-Authenticated-Role', actor.role);
      if (method !== 'GET') {
        res.once('finish', () => {
          recordAuditCompletion(appState.auditTrail, actor!, requestId, method, url, res.statusCode);
        });
      }
      if (method !== 'GET' && actor.role !== 'admin') {
        sendJson(res, 403, { error: 'Administrator role required.', requestId });
        return;
      }
      if (method !== 'GET' && !await authorizeMutationAudit(req, res, appState.auditTrail, actor, requestId, method, url)) {
        return;
      }
    }

    // GET /api/status
    if (url === '/api/status' && method === 'GET') {
      const queue = appState.getQueueState();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        isRunning: appState.state.isRunning,
        connectionState: appState.state.connectionState || 'disconnected',
        totalForwardedCount: appState.state.totalForwardedCount || 0,
        processedSinceRestart: appState.state.processedSinceRestart || 0,
        forwardingEnabled: appState.config.forwardOptions?.forwardToTarget ?? true,
        forwardXmlToTarget: appState.config.xmlParsing?.forwardXmlToTarget ?? false,
        startTime: appState.state.startupTime
          ? new Date(appState.state.startupTime * 1000).toISOString()
          : null,
        queue,
        resolvedSources: Array.from(appState.state.resolvedSourceChatIds || []),
        openRouterModel: process.env.OPENROUTER_MODEL || appState.config.xmlParsing?.primaryModel || 'google/gemini-flash-1.5',
        openRouterFallbackModel: process.env.OPENROUTER_FALLBACK_MODEL || appState.config.xmlParsing?.fallbackModel || 'anthropic/claude-3-haiku',
        openRouterApiKeyConfigured: !!process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY !== 'your_openrouter_api_key_here',
        config: {
          sourceChannels: appState.config.sourceChannels,
          targetChannel: appState.config.targetChannel,
        }
      }));
      return;
    }

    // GET /api/logs
    if (url === '/api/logs' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ logs: getLogHistory() }));
      return;
    }

    // GET /api/metrics-history
    if (url === '/api/metrics-history' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ history: appState.getMetricsHistory ? appState.getMetricsHistory() : [] }));
      return;
    }

    // GET /api/incoming-messages
    if (url === '/api/incoming-messages' && method === 'GET') {
      try {
        const messages = await getIncomingMessages(100);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ messages }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // GET /api/processed-signals
    if (url === '/api/processed-signals' && method === 'GET') {
      try {
        const signals = await getProcessedSignals(100);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ signals }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // GET /api/outbox?status=failed,unknown
    if (url === '/api/outbox' && method === 'GET') {
      if (!appState.getOutboxTasks) {
        sendJson(res, 503, { error: 'Outbox inspection is unavailable.', requestId });
        return;
      }
      const allowedStatuses = new Set(['pending', 'preparing', 'sending', 'completed', 'failed', 'unknown']);
      const requestedStatuses = (parsedUrl.searchParams.get('status') || '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);
      if (requestedStatuses.some(status => !allowedStatuses.has(status))) {
        sendJson(res, 400, { error: 'Invalid outbox status filter.', requestId });
        return;
      }
      try {
        const tasks = await appState.getOutboxTasks(requestedStatuses.length > 0 ? requestedStatuses : undefined);
        sendJson(res, 200, { tasks, requestId });
      } catch (error: any) {
        sendJson(res, 500, { error: error.message, requestId });
      }
      return;
    }

    if (url === '/api/outbox/retry' && method === 'POST') {
      if (!appState.retryOutboxTask) {
        sendJson(res, 503, { error: 'Outbox retry is unavailable.', requestId });
        return;
      }
      if (req.headers['x-destructive-confirmation'] !== 'retry-unknown-delivery') {
        sendJson(res, 412, { error: 'Explicit retry-unknown-delivery confirmation header required.', requestId });
        return;
      }
      try {
        const payload = await readJsonBody(req);
        if (typeof payload.id !== 'string' || payload.id.length < 1 || payload.id.length > 256) {
          throw new HttpError(400, 'A valid outbox task id is required.');
        }
        const retried = await appState.retryOutboxTask(payload.id);
        if (!retried) {
          sendJson(res, 409, { error: 'Only failed or unknown outbox tasks can be retried.', requestId });
          return;
        }
        sendJson(res, 202, { success: true, requestId });
      } catch (error: any) {
        const statusCode = error instanceof HttpError ? error.statusCode : 500;
        sendJson(res, statusCode, { error: error.message, requestId });
      }
      return;
    }

    if (url === '/api/outbox/acknowledge' && method === 'POST') {
      if (!appState.acknowledgeOutboxTask) {
        sendJson(res, 503, { error: 'Outbox reconciliation is unavailable.', requestId });
        return;
      }
      if (req.headers['x-destructive-confirmation'] !== 'acknowledge-unknown-delivery') {
        sendJson(res, 412, { error: 'Explicit acknowledge-unknown-delivery confirmation header required.', requestId });
        return;
      }
      try {
        const payload = await readJsonBody(req);
        if (typeof payload.id !== 'string' || payload.id.length < 1 || payload.id.length > 256) {
          throw new HttpError(400, 'A valid outbox task id is required.');
        }
        if (typeof payload.reason !== 'string' || payload.reason.trim().length < 10) {
          throw new HttpError(400, 'A reconciliation reason of at least 10 characters is required.');
        }
        const acknowledged = await appState.acknowledgeOutboxTask(payload.id, payload.reason.trim());
        if (!acknowledged) {
          sendJson(res, 409, { error: 'Only unknown outbox tasks can be acknowledged.', requestId });
          return;
        }
        sendJson(res, 200, { success: true, requestId });
      } catch (error: any) {
        const statusCode = error instanceof HttpError ? error.statusCode : 500;
        sendJson(res, statusCode, { error: error.message, requestId });
      }
      return;
    }

    // DELETE /api/incoming-messages
    if (url === '/api/incoming-messages' && method === 'DELETE') {
      const idStr = parsedUrl.searchParams.get('id');
      const id = idStr ? parseInt(idStr, 10) : NaN;
      if (isNaN(id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing or invalid id.' }));
        return;
      }
      try {
        await deleteIncomingMessage(id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // DELETE /api/processed-signals
    if (url === '/api/processed-signals' && method === 'DELETE') {
      const id = parsedUrl.searchParams.get('id');
      if (!id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing id.' }));
        return;
      }
      try {
        await deleteProcessedSignal(id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // POST /api/control
    if (url === '/api/control' && method === 'POST') {
      try {
        const payload = await readJsonBody(req);
        if (payload.action === 'start') {
          if (appState.state.isRunning) {
            sendJson(res, 409, { error: 'Routing is already active.', requestId });
            return;
          }
          appState.startForwarding(appState.config).catch(err => {
            addLog(`[ERROR] request_id=${requestId} Web start failed: ${err.message}`);
          });
          sendJson(res, 202, { success: true, message: 'Routing start requested.', requestId });
        } else if (payload.action === 'stop') {
          if (!appState.state.isRunning) {
            sendJson(res, 409, { error: 'Routing is not active.', requestId });
            return;
          }
          await appState.stopForwarding();
          sendJson(res, 200, { success: true, message: 'Routing stopped.', requestId });
        } else {
          sendJson(res, 400, { error: 'Invalid action.', requestId });
        }
      } catch (err: any) {
        const statusCode = err instanceof HttpError ? err.statusCode : 500;
        sendJson(res, statusCode, { error: err.message, requestId });
      }
      return;
    }

    // GET /api/config
    if (url === '/api/config' && method === 'GET') {
      sendJson(res, 200, publicConfig(appState.config));
      return;
    }

    // POST /api/config
    if (url === '/api/config' && method === 'POST') {
      try {
        const newConfig = await readJsonBody(req);
        if (!newConfig || typeof newConfig !== 'object' || Array.isArray(newConfig)) {
          throw new HttpError(400, 'Configuration must be a JSON object.');
        }
        if (containsSecretConfig(newConfig)) {
          throw new HttpError(400, 'Secrets are environment-only and cannot be saved through the dashboard.');
        }
        const candidateConfig = structuredClone(appState.config);
        Object.assign(candidateConfig, newConfig);
        delete candidateConfig.apiHash;
        writeConfigSync(candidateConfig);
        Object.assign(appState.config, candidateConfig);
        appState.reloadConfig();
        appState.applyRuntimeConfig(appState.config);
        addLog(`[INFO] request_id=${requestId} Dashboard configuration updated.`);
        sendJson(res, 200, { success: true, message: 'Configuration saved successfully.', queue: appState.getQueueState(), requestId });
      } catch (err: any) {
        const statusCode = err instanceof HttpError ? err.statusCode : 500;
        sendJson(res, statusCode, { error: err.message, requestId });
      }
      return;
    }

    // Secrets and environment variables are intentionally not web-editable.
    if (url === '/api/env' && method === 'POST') {
      sendJson(res, 405, { error: 'Environment variables are read-only at runtime.', requestId });
      return;
    }

    // POST /api/import
    if (url === '/api/import' && method === 'POST') {
      try {
        const bundle = await readJsonBody(req);
        if (!bundle.config || typeof bundle.config !== 'object' || Array.isArray(bundle.config)) {
          throw new HttpError(400, 'Import file does not contain a valid "config" section.');
        }
        if (bundle.env !== undefined || containsSecretConfig(bundle.config)) {
          throw new HttpError(400, 'Imports may contain non-secret configuration only.');
        }
        const candidateConfig = structuredClone(appState.config);
        Object.assign(candidateConfig, bundle.config);
        delete candidateConfig.apiHash;
        writeConfigSync(candidateConfig);
        Object.assign(appState.config, candidateConfig);
        appState.reloadConfig();
        appState.applyRuntimeConfig(appState.config);
        addLog(`[INFO] request_id=${requestId} Dashboard configuration imported.`);
        sendJson(res, 200, { success: true, message: 'Configuration imported successfully.', requestId });
      } catch (err: any) {
        const statusCode = err instanceof HttpError ? err.statusCode : 500;
        sendJson(res, statusCode, { error: err.message, requestId });
      }
      return;
    }

    // GET /api/templates
    if (url === '/api/templates' && method === 'GET') {
      const templatesDir = path.join(__dirname, '../templates');
      try {
        await fsPromises.mkdir(templatesDir, { recursive: true });
        const files = await fsPromises.readdir(templatesDir);
        const templates: Record<string, string> = {};
        
        let defaultContent = '';
        try {
          defaultContent = await fsPromises.readFile(path.join(templatesDir, 'default.txt'), 'utf-8');
        } catch (error: any) {
          addLog(`[WARN] Default template could not be read: ${error.message}`);
          defaultContent = '';
        }
        templates['default'] = defaultContent;

        for (const file of files) {
          if (file.endsWith('.txt') && file !== 'default.txt') {
            const name = file.slice(0, -4);
            try {
              const content = await fsPromises.readFile(path.join(templatesDir, file), 'utf-8');
              templates[name] = content;
            } catch (error: any) {
              addLog(`[WARN] Template '${file}' could not be read: ${error.message}`);
            }
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ templates }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // POST /api/templates
    if (url === '/api/templates' && method === 'POST') {
      try {
        const payload = await readJsonBody(req, 128 * 1024);
        const { name, content } = payload;
        if (!name || typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
          throw new HttpError(400, 'Invalid template name.');
        }
        if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 96 * 1024) {
          throw new HttpError(400, 'Template content must be a string no larger than 96 KiB.');
        }
        const templatesDir = path.join(__dirname, '../templates');
        await fsPromises.mkdir(templatesDir, { recursive: true });
        await fsPromises.writeFile(path.join(templatesDir, `${name}.txt`), content, 'utf-8');
        addLog(`[INFO] request_id=${requestId} Template '${name}' saved.`);
        sendJson(res, 200, { success: true, requestId });
      } catch (err: any) {
        const statusCode = err instanceof HttpError ? err.statusCode : 500;
        sendJson(res, statusCode, { error: err.message, requestId });
      }
      return;
    }

    // DELETE /api/templates
    if (url === '/api/templates' && method === 'DELETE') {
      const name = parsedUrl.searchParams.get('name');
      if (!name || typeof name !== 'string' || name === 'default' || !/^[a-zA-Z0-9_-]+$/.test(name)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid template name for deletion.' }));
        return;
      }

      try {
        const templatesDir = path.join(__dirname, '../templates');
        const filePath = path.join(templatesDir, `${name}.txt`);
        try {
          await fsPromises.unlink(filePath);
          addLog(`[INFO] Template '${name}' deleted via Web Dashboard.`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (err: any) {
          if (err.code === 'ENOENT') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Template not found.' }));
          } else {
            throw err;
          }
        }
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // POST /api/factory-reset
    if (url === '/api/factory-reset' && method === 'POST') {
      if (req.headers['x-destructive-confirmation'] !== 'factory-reset') {
        sendJson(res, 412, { error: 'Explicit factory-reset confirmation header required.', requestId });
        return;
      }
      if (appState.state.isRunning) {
        sendJson(res, 409, { error: 'Stop routing before resetting configuration.', requestId });
        return;
      }
      try {
        const { DEFAULT_CONFIG } = await import('./config.js');
        const candidateConfig = structuredClone(DEFAULT_CONFIG);
        writeConfigSync(candidateConfig);
        for (const key of Object.keys(appState.config)) delete appState.config[key];
        Object.assign(appState.config, candidateConfig);
        appState.reloadConfig();
        appState.applyRuntimeConfig(appState.config);
        addLog('[INFO] Konfiguration über das Web-Dashboard auf Werkseinstellungen zurückgesetzt.');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Factory reset completed.' }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // POST /api/clear-database
    if (url === '/api/clear-database' && method === 'POST') {
      if (req.headers['x-destructive-confirmation'] !== 'clear-database') {
        sendJson(res, 412, { error: 'Explicit clear-database confirmation header required.', requestId });
        return;
      }
      if (appState.state.isRunning) {
        sendJson(res, 409, { error: 'Stop routing before clearing the database.', requestId });
        return;
      }
      try {
        await clearDb();
        addLog('[INFO] SQLite-Datenbank über das Web-Dashboard geleert.');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Database cleared successfully.' }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url.startsWith('/api/')) {
      sendJson(res, 404, { error: 'API endpoint not found.', requestId });
      return;
    }

    // Serve static files from frontend/dist
    const staticRoot = path.resolve(__dirname, '../frontend/dist');
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(url === '/' ? 'index.html' : url.replace(/^\/+/, ''));
    } catch {
      sendJson(res, 400, { error: 'Invalid URL encoding.', requestId });
      return;
    }
    const absolutePath = path.resolve(staticRoot, decodedPath);
    if (absolutePath !== staticRoot && !absolutePath.startsWith(`${staticRoot}${path.sep}`)) {
      sendJson(res, 403, { error: 'Invalid static file path.', requestId });
      return;
    }

    try {
      const stats = await fsPromises.stat(absolutePath);
      if (stats.isFile()) {
        const ext = path.extname(absolutePath).toLowerCase();
        let mimeType = 'application/octet-stream';
        if (ext === '.html') mimeType = 'text/html; charset=utf-8';
        else if (ext === '.js') mimeType = 'application/javascript; charset=utf-8';
        else if (ext === '.css') mimeType = 'text/css; charset=utf-8';
        else if (ext === '.png') mimeType = 'image/png';
        else if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
        else if (ext === '.gif') mimeType = 'image/gif';
        else if (ext === '.svg') mimeType = 'image/svg+xml';
        else if (ext === '.ico') mimeType = 'image/x-icon';
        else if (ext === '.json') mimeType = 'application/json';

        res.writeHead(200, { 'Content-Type': mimeType });
        const content = await fsPromises.readFile(absolutePath);
        res.end(content);
        return;
      }
    } catch {
      // Fallback to index.html for SPA routing
      try {
        const fallbackPath = path.join(__dirname, '../frontend/dist/index.html');
        const content = await fsPromises.readFile(fallbackPath);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
        return;
      } catch {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html>
<html>
<head><title>Dashboard Dev Mode</title></head>
<body style="font-family:sans-serif;background:#0d1117;color:#c9d1d9;padding:2rem;">
  <h1>Dashboard Development Mode</h1>
  <p>Bitte compile das React-Frontend mit: <code>npm run build</code></p>
</body>
</html>`);
        return;
      }
    }
  });

  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.listen(port, host, () => {
    const address = server?.address();
    const listeningPort = typeof address === 'object' && address ? address.port : port;
    console.log(`[INFO] Web Control Dashboard listening on http://${host}:${listeningPort}`);
  });
  return server;
}

export function stopWebServer(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (server) {
      server.close(() => {
        resolve();
      });
      server = null;
    } else {
      resolve();
    }
  });
}
