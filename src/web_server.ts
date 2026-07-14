import http from 'http';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { writeConfigSync } from './config.js';
import { addLog, getLogHistory } from './logger.js';
import {
  getIncomingMessages,
  getProcessedSignals,
  clearDb,
  deleteIncomingMessage,
  deleteProcessedSignal,
} from './db.js';
import type { EnterpriseAuditTrail } from './audit_trail.js';
import {
  dashboardAuthenticatorFromEnvironment,
  type AuthenticatedActor,
  type DashboardAuthenticator,
} from './dashboard_auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dirname, '../templates');
const STATIC_ROOT = path.resolve(__dirname, '../frontend/dist');
const SECRET_CONFIG_KEYS = new Set([
  'apiHash',
  'openRouterApiKey',
  'OPENROUTER_API_KEY',
  'TELEGRAM_API_HASH',
  'DASHBOARD_ADMIN_TOKEN',
  'DASHBOARD_VIEWER_TOKEN',
  'BACKUP_OFFSITE_TOKEN',
  'BACKUP_ENCRYPTION_KEY',
  'ALERT_RELAY_TOKEN',
  'ALERT_WEBHOOK_TOKEN',
  'PROMETHEUS_TOKEN',
  'AUDIT_WEBHOOK_TOKEN',
]);
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

interface WebServerState {
  config: any;
  state: any;
  getQueueState: () => {
    running: number;
    queued: number;
    maxConcurrency: number;
    paused: boolean;
  };
  startForwarding: (config: any) => Promise<void>;
  stopForwarding: () => Promise<any>;
  reloadConfig: () => void;
  applyRuntimeConfig: (config: any) => void;
  persistConfig?: (config: any) => void;
  getMetricsHistory?: () => any[];
  getOutboxTasks?: (statuses?: string[]) => Promise<any[]>;
  retryOutboxTask?: (id: string) => Promise<boolean>;
  acknowledgeOutboxTask?: (id: string, reason: string) => Promise<boolean>;
  auditTrail?: Pick<EnterpriseAuditTrail, 'record'>;
  authenticator?: DashboardAuthenticator;
}

interface RequestContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  requestId: string;
  parsedUrl: URL;
  appState: WebServerState;
}

type ApiHandler = (context: RequestContext) => Promise<void> | void;

let server: http.Server | null = null;

class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function errorStatus(error: unknown): number {
  return error instanceof HttpError ? error.statusCode : 500;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected server error.';
}

function sendError(context: RequestContext, error: unknown): void {
  sendJson(context.res, errorStatus(error), {
    error: errorMessage(error),
    requestId: context.requestId,
  });
}

function recordAuditCompletion(
  auditTrail: WebServerState['auditTrail'],
  actor: AuthenticatedActor,
  requestId: string,
  method: string,
  url: string,
  statusCode: number
): void {
  addLog(
    `[AUDIT] request_id=${requestId} actor_role=${actor.role} method=${method} path=${url} status=${statusCode}`
  );
  void auditTrail
    ?.record({
      phase: 'completed',
      action: 'dashboard.mutation',
      requestId,
      actorId: actor.id,
      actorRole: actor.role,
      method,
      path: url,
      statusCode,
    })
    .catch((error) =>
      addLog(`[CRITICAL] Audit outcome delivery failed: ${error.message}`, {
        request_id: requestId,
        event: 'audit_delivery_failed',
      })
    );
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  const configuredOrigin = process.env.DASHBOARD_ALLOWED_ORIGIN?.trim();
  if (configuredOrigin && origin === configuredOrigin) return true;
  try {
    const parsed = new URL(origin);
    return (
      parsed.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function setSecurityHeaders(res: http.ServerResponse, origin?: string): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  );
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
  return JSON.parse(
    JSON.stringify(config || {}, (key, value) => (SECRET_CONFIG_KEYS.has(key) ? undefined : value))
  );
}

function containsSecretConfig(input: any): boolean {
  if (!input || typeof input !== 'object') return false;
  return Object.entries(input).some(
    ([key, value]) => SECRET_CONFIG_KEYS.has(key) || containsSecretConfig(value)
  );
}

function requireMutationHeaders(req: http.IncomingMessage): void {
  if (req.headers['x-requested-with'] !== 'forwarder-dashboard') {
    throw new HttpError(400, 'Missing X-Requested-With header.');
  }
}

async function authorizeMutationAudit(
  context: RequestContext,
  actor: AuthenticatedActor,
  method: string,
  url: string
): Promise<boolean> {
  try {
    requireMutationHeaders(context.req);
    await context.appState.auditTrail?.record({
      phase: 'authorized',
      action: 'dashboard.mutation',
      requestId: context.requestId,
      actorId: actor.id,
      actorRole: actor.role,
      method,
      path: url,
    });
    return true;
  } catch (error) {
    if (error instanceof HttpError) {
      sendError(context, error);
      return false;
    }
    addLog(`[CRITICAL] Audit precondition failed; dashboard mutation blocked: ${errorMessage(error)}`, {
      request_id: context.requestId,
      event: 'audit_precondition_failed',
    });
    sendJson(context.res, 503, {
      error: 'Audit trail unavailable; mutation blocked.',
      requestId: context.requestId,
    });
    return false;
  }
}

async function authenticateApiRequest(
  context: RequestContext,
  authenticator: DashboardAuthenticator,
  method: string,
  url: string
): Promise<AuthenticatedActor | null> {
  const { res, requestId, appState } = context;
  if (!authenticator.isConfigured()) {
    sendJson(res, 503, { error: 'Dashboard authentication is not configured.', requestId });
    return null;
  }
  const actor = await authenticator.authenticate(context.req.headers.authorization);
  if (!actor) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="forwarder-dashboard"');
    sendJson(res, 401, { error: 'Valid dashboard bearer token required.', requestId });
    return null;
  }
  res.setHeader('X-Authenticated-Role', actor.role);
  if (method === 'GET') return actor;
  res.once('finish', () => {
    recordAuditCompletion(appState.auditTrail, actor, requestId, method, url, res.statusCode);
  });
  if (actor.role !== 'admin') {
    sendJson(res, 403, { error: 'Administrator role required.', requestId });
    return null;
  }
  return (await authorizeMutationAudit(context, actor, method, url)) ? actor : null;
}

function firstConfigured(...values: Array<string | undefined>): string {
  return values.find((value) => Boolean(value)) ?? '';
}

function statusHandler({ res, appState }: RequestContext): void {
  const xmlConfig = appState.config.xmlParsing ?? {};
  const apiKey = process.env.OPENROUTER_API_KEY;
  sendJson(res, 200, {
    isRunning: appState.state.isRunning,
    connectionState: firstConfigured(appState.state.connectionState, 'disconnected'),
    totalForwardedCount: appState.state.totalForwardedCount ?? 0,
    processedSinceRestart: appState.state.processedSinceRestart ?? 0,
    forwardingEnabled: appState.config.forwardOptions?.forwardToTarget ?? true,
    forwardXmlToTarget: xmlConfig.forwardXmlToTarget ?? false,
    startTime: appState.state.startupTime
      ? new Date(appState.state.startupTime * 1000).toISOString()
      : null,
    queue: appState.getQueueState(),
    resolvedSources: Array.from(appState.state.resolvedSourceChatIds ?? []),
    openRouterModel: firstConfigured(
      process.env.OPENROUTER_MODEL,
      xmlConfig.primaryModel,
      'google/gemini-flash-1.5'
    ),
    openRouterFallbackModel: firstConfigured(
      process.env.OPENROUTER_FALLBACK_MODEL,
      xmlConfig.fallbackModel,
      'anthropic/claude-3-haiku'
    ),
    openRouterApiKeyConfigured: Boolean(apiKey && apiKey !== 'your_openrouter_api_key_here'),
    config: {
      sourceChannels: appState.config.sourceChannels,
      targetChannel: appState.config.targetChannel,
    },
  });
}

function logsHandler({ res }: RequestContext): void {
  sendJson(res, 200, { logs: getLogHistory() });
}

function metricsHistoryHandler({ res, appState }: RequestContext): void {
  sendJson(res, 200, { history: appState.getMetricsHistory?.() ?? [] });
}

async function incomingMessagesHandler(context: RequestContext): Promise<void> {
  try {
    sendJson(context.res, 200, { messages: await getIncomingMessages(100) });
  } catch (error) {
    sendError(context, error);
  }
}

async function processedSignalsHandler(context: RequestContext): Promise<void> {
  try {
    sendJson(context.res, 200, { signals: await getProcessedSignals(100) });
  } catch (error) {
    sendError(context, error);
  }
}

async function outboxHandler(context: RequestContext): Promise<void> {
  const getTasks = context.appState.getOutboxTasks;
  if (!getTasks) {
    sendJson(context.res, 503, {
      error: 'Outbox inspection is unavailable.',
      requestId: context.requestId,
    });
    return;
  }
  const allowed = new Set(['pending', 'preparing', 'sending', 'completed', 'failed', 'unknown']);
  const statuses = (context.parsedUrl.searchParams.get('status') || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (statuses.some((status) => !allowed.has(status))) {
    sendJson(context.res, 400, {
      error: 'Invalid outbox status filter.',
      requestId: context.requestId,
    });
    return;
  }
  try {
    sendJson(context.res, 200, {
      tasks: await getTasks(statuses.length > 0 ? statuses : undefined),
      requestId: context.requestId,
    });
  } catch (error) {
    sendError(context, error);
  }
}

function requireConfirmation(context: RequestContext, expected: string, message: string): boolean {
  if (context.req.headers['x-destructive-confirmation'] === expected) return true;
  sendJson(context.res, 412, { error: message, requestId: context.requestId });
  return false;
}

function requireTaskId(payload: any): string {
  if (typeof payload.id !== 'string' || payload.id.length < 1 || payload.id.length > 256) {
    throw new HttpError(400, 'A valid outbox task id is required.');
  }
  return payload.id;
}

async function retryOutboxHandler(context: RequestContext): Promise<void> {
  const retryTask = context.appState.retryOutboxTask;
  if (!retryTask) {
    sendJson(context.res, 503, {
      error: 'Outbox retry is unavailable.',
      requestId: context.requestId,
    });
    return;
  }
  if (
    !requireConfirmation(
      context,
      'retry-unknown-delivery',
      'Explicit retry-unknown-delivery confirmation header required.'
    )
  )
    return;
  try {
    const retried = await retryTask(requireTaskId(await readJsonBody(context.req)));
    if (!retried) throw new HttpError(409, 'Only failed or unknown outbox tasks can be retried.');
    sendJson(context.res, 202, { success: true, requestId: context.requestId });
  } catch (error) {
    sendError(context, error);
  }
}

async function acknowledgeOutboxHandler(context: RequestContext): Promise<void> {
  const acknowledgeTask = context.appState.acknowledgeOutboxTask;
  if (!acknowledgeTask) {
    sendJson(context.res, 503, {
      error: 'Outbox reconciliation is unavailable.',
      requestId: context.requestId,
    });
    return;
  }
  if (
    !requireConfirmation(
      context,
      'acknowledge-unknown-delivery',
      'Explicit acknowledge-unknown-delivery confirmation header required.'
    )
  )
    return;
  try {
    const payload = await readJsonBody(context.req);
    const id = requireTaskId(payload);
    if (typeof payload.reason !== 'string' || payload.reason.trim().length < 10) {
      throw new HttpError(400, 'A reconciliation reason of at least 10 characters is required.');
    }
    const acknowledged = await acknowledgeTask(id, payload.reason.trim());
    if (!acknowledged) throw new HttpError(409, 'Only unknown outbox tasks can be acknowledged.');
    sendJson(context.res, 200, { success: true, requestId: context.requestId });
  } catch (error) {
    sendError(context, error);
  }
}

async function deleteIncomingHandler(context: RequestContext): Promise<void> {
  const idValue = context.parsedUrl.searchParams.get('id');
  const id = idValue === null ? Number.NaN : Number(idValue);
  if (!Number.isSafeInteger(id) || id < 1) {
    sendJson(context.res, 400, { error: 'Missing or invalid id.' });
    return;
  }
  try {
    await deleteIncomingMessage(id);
    sendJson(context.res, 200, { success: true });
  } catch (error) {
    sendError(context, error);
  }
}

async function deleteSignalHandler(context: RequestContext): Promise<void> {
  const id = context.parsedUrl.searchParams.get('id');
  if (!id) {
    sendJson(context.res, 400, { error: 'Missing id.' });
    return;
  }
  try {
    await deleteProcessedSignal(id);
    sendJson(context.res, 200, { success: true });
  } catch (error) {
    sendError(context, error);
  }
}

async function controlHandler(context: RequestContext): Promise<void> {
  try {
    const payload = await readJsonBody(context.req);
    if (payload.action === 'start') {
      if (context.appState.state.isRunning) {
        throw new HttpError(409, 'Routing is already active.');
      }
      void context.appState.startForwarding(context.appState.config).catch((error) => {
        addLog(`[ERROR] request_id=${context.requestId} Web start failed: ${error.message}`);
      });
      sendJson(context.res, 202, {
        success: true,
        message: 'Routing start requested.',
        requestId: context.requestId,
      });
      return;
    }
    if (payload.action !== 'stop') throw new HttpError(400, 'Invalid action.');
    if (!context.appState.state.isRunning) throw new HttpError(409, 'Routing is not active.');
    await context.appState.stopForwarding();
    sendJson(context.res, 200, {
      success: true,
      message: 'Routing stopped.',
      requestId: context.requestId,
    });
  } catch (error) {
    sendError(context, error);
  }
}

function getConfigHandler({ res, appState }: RequestContext): void {
  sendJson(res, 200, publicConfig(appState.config));
}

function applyConfiguration(context: RequestContext, update: any, logMessage: string): void {
  const candidateConfig = structuredClone(context.appState.config);
  Object.assign(candidateConfig, update);
  delete candidateConfig.apiHash;
  (context.appState.persistConfig ?? writeConfigSync)(candidateConfig);
  Object.assign(context.appState.config, candidateConfig);
  context.appState.reloadConfig();
  context.appState.applyRuntimeConfig(context.appState.config);
  addLog(`[INFO] request_id=${context.requestId} ${logMessage}`);
}

async function postConfigHandler(context: RequestContext): Promise<void> {
  try {
    const newConfig = await readJsonBody(context.req);
    if (!newConfig || typeof newConfig !== 'object' || Array.isArray(newConfig)) {
      throw new HttpError(400, 'Configuration must be a JSON object.');
    }
    if (containsSecretConfig(newConfig)) {
      throw new HttpError(400, 'Secrets are environment-only and cannot be saved through the dashboard.');
    }
    applyConfiguration(context, newConfig, 'Dashboard configuration updated.');
    sendJson(context.res, 200, {
      success: true,
      message: 'Configuration saved successfully.',
      queue: context.appState.getQueueState(),
      requestId: context.requestId,
    });
  } catch (error) {
    sendError(context, error);
  }
}

function environmentHandler(context: RequestContext): void {
  sendJson(context.res, 405, {
    error: 'Environment variables are read-only at runtime.',
    requestId: context.requestId,
  });
}

async function importHandler(context: RequestContext): Promise<void> {
  try {
    const bundle = await readJsonBody(context.req);
    if (!bundle.config || typeof bundle.config !== 'object' || Array.isArray(bundle.config)) {
      throw new HttpError(400, 'Import file does not contain a valid "config" section.');
    }
    if (bundle.env !== undefined || containsSecretConfig(bundle.config)) {
      throw new HttpError(400, 'Imports may contain non-secret configuration only.');
    }
    applyConfiguration(context, bundle.config, 'Dashboard configuration imported.');
    sendJson(context.res, 200, {
      success: true,
      message: 'Configuration imported successfully.',
      requestId: context.requestId,
    });
  } catch (error) {
    sendError(context, error);
  }
}

async function readTemplate(file: string): Promise<string | null> {
  try {
    return await fsPromises.readFile(path.join(TEMPLATES_DIR, file), 'utf8');
  } catch (error) {
    addLog(`[WARN] Template '${file}' could not be read: ${errorMessage(error)}`);
    return null;
  }
}

async function getTemplatesHandler(context: RequestContext): Promise<void> {
  try {
    await fsPromises.mkdir(TEMPLATES_DIR, { recursive: true });
    const files = await fsPromises.readdir(TEMPLATES_DIR);
    const templates: Record<string, string> = {
      default: (await readTemplate('default.txt')) ?? '',
    };
    for (const file of files.filter((name) => name.endsWith('.txt') && name !== 'default.txt')) {
      const content = await readTemplate(file);
      if (content !== null) templates[file.slice(0, -4)] = content;
    }
    sendJson(context.res, 200, { templates });
  } catch (error) {
    sendError(context, error);
  }
}

function requireTemplateName(name: unknown): string {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    throw new HttpError(400, 'Invalid template name.');
  }
  return name;
}

async function postTemplateHandler(context: RequestContext): Promise<void> {
  try {
    const payload = await readJsonBody(context.req, 128 * 1024);
    const name = requireTemplateName(payload.name);
    if (typeof payload.content !== 'string' || Buffer.byteLength(payload.content, 'utf8') > 96 * 1024) {
      throw new HttpError(400, 'Template content must be a string no larger than 96 KiB.');
    }
    await fsPromises.mkdir(TEMPLATES_DIR, { recursive: true });
    await fsPromises.writeFile(path.join(TEMPLATES_DIR, `${name}.txt`), payload.content, 'utf8');
    addLog(`[INFO] request_id=${context.requestId} Template '${name}' saved.`);
    sendJson(context.res, 200, { success: true, requestId: context.requestId });
  } catch (error) {
    sendError(context, error);
  }
}

async function deleteTemplateHandler(context: RequestContext): Promise<void> {
  const name = context.parsedUrl.searchParams.get('name');
  if (!name || name === 'default' || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    sendJson(context.res, 400, { error: 'Invalid template name for deletion.' });
    return;
  }
  try {
    await fsPromises.unlink(path.join(TEMPLATES_DIR, `${name}.txt`));
    addLog(`[INFO] Template '${name}' deleted via Web Dashboard.`);
    sendJson(context.res, 200, { success: true });
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      sendJson(context.res, 404, { error: 'Template not found.' });
      return;
    }
    sendError(context, error);
  }
}

async function factoryResetHandler(context: RequestContext): Promise<void> {
  if (
    !requireConfirmation(
      context,
      'factory-reset',
      'Explicit factory-reset confirmation header required.'
    )
  )
    return;
  if (context.appState.state.isRunning) {
    sendJson(context.res, 409, {
      error: 'Stop routing before resetting configuration.',
      requestId: context.requestId,
    });
    return;
  }
  try {
    const { DEFAULT_CONFIG } = await import('./config.js');
    const candidateConfig = structuredClone(DEFAULT_CONFIG);
    (context.appState.persistConfig ?? writeConfigSync)(candidateConfig);
    for (const key of Object.keys(context.appState.config)) delete context.appState.config[key];
    Object.assign(context.appState.config, candidateConfig);
    context.appState.reloadConfig();
    context.appState.applyRuntimeConfig(context.appState.config);
    addLog('[INFO] Configuration reset to defaults through the web dashboard.');
    sendJson(context.res, 200, { success: true, message: 'Factory reset completed.' });
  } catch (error) {
    sendError(context, error);
  }
}

async function clearDatabaseHandler(context: RequestContext): Promise<void> {
  if (
    !requireConfirmation(
      context,
      'clear-database',
      'Explicit clear-database confirmation header required.'
    )
  )
    return;
  if (context.appState.state.isRunning) {
    sendJson(context.res, 409, {
      error: 'Stop routing before clearing the database.',
      requestId: context.requestId,
    });
    return;
  }
  try {
    await clearDb();
    addLog('[INFO] SQLite database cleared through the web dashboard.');
    sendJson(context.res, 200, { success: true, message: 'Database cleared successfully.' });
  } catch (error) {
    sendError(context, error);
  }
}

const API_ROUTES = new Map<string, ApiHandler>([
  ['GET /api/status', statusHandler],
  ['GET /api/logs', logsHandler],
  ['GET /api/metrics-history', metricsHistoryHandler],
  ['GET /api/incoming-messages', incomingMessagesHandler],
  ['GET /api/processed-signals', processedSignalsHandler],
  ['GET /api/outbox', outboxHandler],
  ['POST /api/outbox/retry', retryOutboxHandler],
  ['POST /api/outbox/acknowledge', acknowledgeOutboxHandler],
  ['DELETE /api/incoming-messages', deleteIncomingHandler],
  ['DELETE /api/processed-signals', deleteSignalHandler],
  ['POST /api/control', controlHandler],
  ['GET /api/config', getConfigHandler],
  ['POST /api/config', postConfigHandler],
  ['POST /api/env', environmentHandler],
  ['POST /api/import', importHandler],
  ['GET /api/templates', getTemplatesHandler],
  ['POST /api/templates', postTemplateHandler],
  ['DELETE /api/templates', deleteTemplateHandler],
  ['POST /api/factory-reset', factoryResetHandler],
  ['POST /api/clear-database', clearDatabaseHandler],
]);

function handleOptions(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, X-Requested-With, X-Destructive-Confirmation'
  );
  res.writeHead(204);
  res.end();
}

async function serveSpaFallback(res: http.ServerResponse): Promise<void> {
  try {
    const content = await fsPromises.readFile(path.join(STATIC_ROOT, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(content);
  } catch {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html>
<head><title>Dashboard Dev Mode</title></head>
<body style="font-family:sans-serif;background:#0d1117;color:#c9d1d9;padding:2rem;">
  <h1>Dashboard Development Mode</h1>
  <p>Compile the React frontend with: <code>npm run build</code></p>
</body>
</html>`);
  }
}

async function serveStatic(context: RequestContext, url: string): Promise<void> {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url === '/' ? 'index.html' : url.replace(/^\/+/, ''));
  } catch {
    sendJson(context.res, 400, { error: 'Invalid URL encoding.', requestId: context.requestId });
    return;
  }
  const absolutePath = path.resolve(STATIC_ROOT, decodedPath);
  if (absolutePath !== STATIC_ROOT && !absolutePath.startsWith(`${STATIC_ROOT}${path.sep}`)) {
    sendJson(context.res, 403, { error: 'Invalid static file path.', requestId: context.requestId });
    return;
  }
  try {
    const stats = await fsPromises.stat(absolutePath);
    if (!stats.isFile()) {
      await serveSpaFallback(context.res);
      return;
    }
    const mimeType = MIME_TYPES[path.extname(absolutePath).toLowerCase()] ?? 'application/octet-stream';
    context.res.writeHead(200, { 'Content-Type': mimeType });
    context.res.end(await fsPromises.readFile(absolutePath));
  } catch {
    await serveSpaFallback(context.res);
  }
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  appState: WebServerState,
  authenticator: DashboardAuthenticator
): Promise<void> {
  const requestId = randomUUID();
  res.setHeader('X-Request-Id', requestId);
  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const url = parsedUrl.pathname;
  const method = req.method || 'GET';
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  const context = { req, res, requestId, parsedUrl, appState };
  setSecurityHeaders(res, origin);
  if (!isAllowedOrigin(origin)) {
    sendJson(res, 403, { error: 'Origin is not allowed.', requestId });
    return;
  }
  if (method === 'OPTIONS') {
    handleOptions(res);
    return;
  }
  if (!url.startsWith('/api/')) {
    await serveStatic(context, url);
    return;
  }
  if (!(await authenticateApiRequest(context, authenticator, method, url))) return;
  const handler = API_ROUTES.get(`${method} ${url}`);
  if (!handler) {
    sendJson(res, 404, { error: 'API endpoint not found.', requestId });
    return;
  }
  await handler(context);
}

export function startWebServer(
  port: number,
  appState: WebServerState,
  host = process.env.WEB_HOST?.trim() || '127.0.0.1'
): http.Server {
  const authenticator = appState.authenticator ?? dashboardAuthenticatorFromEnvironment();
  server = http.createServer((req, res) => {
    void handleRequest(req, res, appState, authenticator).catch((error) => {
      addLog(`[ERROR] Unhandled dashboard request error: ${errorMessage(error)}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'Unexpected server error.' });
      else res.destroy();
    });
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
  return new Promise<void>((resolve, reject) => {
    if (!server) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
    server = null;
  });
}
