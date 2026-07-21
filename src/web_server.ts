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
  getSignalDashboardAnalytics,
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
import type { ManagedSecretStore } from './secret_store.js';
import type { TelegramLoginSnapshot } from './telegram_login.js';
import type { ManagedRuntimeSettingsStore } from './runtime_settings.js';
import { DEFAULT_SIGNAL_PROMPT } from './signal_parser.js';
import type { TradingWebControl } from './trading_web_control.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TEMPLATES_DIR = path.join(__dirname, '../templates');
const STATIC_ROOT = path.resolve(__dirname, '../frontend/dist');
const SECRET_CONFIG_KEYS = new Set([
  'apiHash',
  'openRouterApiKey',
  'telegramApiHash',
  'dashboardAdminToken',
  'dashboardViewerToken',
  'auditWebhookToken',
  'alertRelayToken',
  'alertWebhookToken',
  'backupOffsiteToken',
  'backupEncryptionKey',
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

function templatesDirectory(): string {
  return path.resolve(process.env.TEMPLATES_DIR?.trim() || DEFAULT_TEMPLATES_DIR);
}

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
  auditTrail?: Pick<EnterpriseAuditTrail, 'record' | 'snapshot' | 'replayRemote' | 'flush'>;
  authenticator?: DashboardAuthenticator;
  secretStore?: Pick<ManagedSecretStore,
    | 'status'
    | 'set'
    | 'createDashboardAdminToken'
    | 'rotateDashboardToken'
    | 'removeDashboardViewerToken'
    | 'clear'
    | 'recoveryStatus'
  >;
  getTelegramLoginState?: () => TelegramLoginSnapshot;
  submitTelegramLogin?: (payload: unknown) => TelegramLoginSnapshot;
  getOperationsStatus?: () => Record<string, unknown>;
  runBackupNow?: () => Promise<string>;
  listBackups?: () => Promise<string[]>;
  verifyBackup?: (artifactName: string) => Promise<unknown>;
  recoverOffsiteBackup?: (objectName: string) => Promise<string>;
  restoreBackup?: (artifactName: string) => Promise<{ previousDatabase: string | null; previousConfig: string | null }>;
  performFactoryReset?: () => Promise<void>;
  requestRestart?: () => void;
  runtimeSettings?: Pick<ManagedRuntimeSettingsStore, 'snapshot' | 'set' | 'recoveryStatus'>;
  tradingControl?: TradingWebControl;
  recovery?: {
    active: boolean;
    allowLoopbackLocalSession: boolean;
    issues: Array<{ component: 'configuration' | 'runtimeSettings' | 'managedSecret'; name?: string; reason: string }>;
  };
}

interface RequestContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  requestId: string;
  parsedUrl: URL;
  appState: WebServerState;
  mutationAudit?: MutationAuditContext;
}

interface MutationAuditContext {
  actor: AuthenticatedActor;
  action: string;
  target: unknown;
  before: unknown;
}

type ApiHandler = (context: RequestContext) => Promise<void> | void;

let server: http.Server | null = null;
let mutationInProgress = false;
const requestContexts = new WeakMap<http.IncomingMessage, RequestContext>();

class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
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

function isLoopbackBrowserOrigin(origin: string): boolean {
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
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const context = requestContexts.get(req);
    if (context?.mutationAudit) {
      context.mutationAudit.target = {
        ...(typeof context.mutationAudit.target === 'object' && context.mutationAudit.target
          ? context.mutationAudit.target as Record<string, unknown>
          : {}),
        request: safeAuditValue(parsed),
      };
    }
    return parsed;
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON.');
  }
}

function publicConfig(config: any): any {
  return JSON.parse(
    JSON.stringify(config || {}, (key, value) => (SECRET_CONFIG_KEYS.has(key) ? undefined : value))
  );
}

const AUDIT_SECRET_KEY = /(secret|token|password|private.?key|api.?key|api.?hash|authorization|credential)/i;

function safeAuditValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : '[INVALID_NUMBER]';
  if (typeof value === 'string') return value.length <= 1024 ? value : `${value.slice(0, 1024)}...[TRUNCATED]`;
  if (depth >= 6) return '[MAX_DEPTH]';
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => safeAuditValue(item, depth + 1));
  }
  if (!value || typeof value !== 'object') return String(value);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 100)
      .map(([key, item]) => [key, SECRET_CONFIG_KEYS.has(key) || AUDIT_SECRET_KEY.test(key)
        ? '[REDACTED]'
        : safeAuditValue(item, depth + 1)])
  );
}

function semanticMutationAction(method: string, url: string): string {
  const known: Record<string, string> = {
    '/api/config': 'configuration.update',
    '/api/import': 'configuration.import',
    '/api/secrets': 'secrets.update',
    '/api/control': 'routing.control',
    '/api/telegram-login': 'telegram.authentication.update',
    '/api/runtime-settings': 'runtime.settings.update',
    '/api/factory-reset': 'system.factory-reset',
    '/api/restart': 'system.restart',
    '/api/access-tokens': 'access-token.rotate',
    '/api/access-tokens/viewer': 'access-token.disable-viewer',
    '/api/operations/backup': 'backup.create',
    '/api/operations/audit-replay': 'audit.replay',
    '/api/backups/recover-offsite': 'backup.recover-offsite',
    '/api/backups/restore': 'backup.restore',
    '/api/database': 'database.clear',
    '/api/outbox/retry': 'outbox.retry',
    '/api/outbox/acknowledge': 'outbox.acknowledge',
  };
  if (known[url]) return known[url];
  if (url.startsWith('/api/trading/')) {
    const target = url.slice('/api/trading/'.length).replace(/[^a-z0-9]+/gi, '.').replace(/^\.|\.$/g, '');
    return `trading.${target || 'control'}.${method.toLowerCase()}`.slice(0, 128);
  }
  const target = url.slice('/api/'.length).replace(/[^a-z0-9]+/gi, '.').replace(/^\.|\.$/g, '');
  return `dashboard.${target || 'mutation'}.${method.toLowerCase()}`.slice(0, 128);
}

function auditTargetFromRequest(context: RequestContext): unknown {
  const query = Object.fromEntries(context.parsedUrl.searchParams.entries());
  return safeAuditValue(Object.keys(query).length > 0 ? { query } : { resource: context.parsedUrl.pathname });
}

function secretAuditState(context: RequestContext): unknown {
  return safeAuditValue(context.appState.secretStore?.status() ?? { available: false });
}

function runtimeAuditState(context: RequestContext): unknown {
  return safeAuditValue(context.appState.runtimeSettings?.snapshot() ?? { available: false });
}

function routingAuditState(context: RequestContext): unknown {
  const { appState } = context;
  return safeAuditValue({
    isRunning: appState.state.isRunning,
    connectionState: appState.state.connectionState,
    forwardingEnabled: appState.config.forwardOptions?.forwardToTarget ?? true,
    queue: appState.getQueueState(),
    telegramLogin: appState.getTelegramLoginState?.(),
  });
}

function auditDomainState(context: RequestContext, action: string): unknown {
  const { appState } = context;
  if (action.startsWith('configuration.')) return safeAuditValue(publicConfig(appState.config));
  if (action.startsWith('secrets.') || action.startsWith('access-token.')) return secretAuditState(context);
  if (action.startsWith('runtime.settings.')) return runtimeAuditState(context);
  if (action.startsWith('routing.') || action.startsWith('telegram.')) return routingAuditState(context);
  if (action.startsWith('system.')) {
    return safeAuditValue({ recovery: appState.recovery?.active ?? false, isRunning: appState.state.isRunning });
  }
  return safeAuditValue({ domain: action.split('.')[0], stateSnapshot: 'captured-in-domain-result' });
}

function installMutationAuditBarrier(context: RequestContext): void {
  const audit = context.mutationAudit;
  const trail = context.appState.auditTrail;
  if (!audit || !trail) return;
  const response = context.res;
  const originalEnd = response.end.bind(response);
  let finalizing = false;
  (response as any).end = (chunk?: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
    if (finalizing) return response;
    finalizing = true;
    const originalStatus = response.statusCode;
    const callbackFunction = typeof encodingOrCallback === 'function'
      ? encodingOrCallback
      : typeof callback === 'function' ? callback : undefined;
    let responsePayload: unknown;
    if (typeof chunk === 'string') {
      try { responsePayload = JSON.parse(chunk); } catch { responsePayload = '[NON_JSON_RESPONSE]'; }
    }
    const outcome = originalStatus < 400 ? 'succeeded' : originalStatus < 500 ? 'rejected' : 'failed';
    void trail.record({
      phase: 'completed',
      action: audit.action,
      requestId: context.requestId,
      actorId: audit.actor.id,
      actorRole: audit.actor.role,
      method: context.req.method,
      path: context.parsedUrl.pathname,
      statusCode: originalStatus,
      target: safeAuditValue(audit.target),
      before: safeAuditValue(audit.before),
      after: safeAuditValue({ state: auditDomainState(context, audit.action), response: responsePayload }),
      outcome,
    }).then(() => {
      addLog(`[AUDIT] request_id=${context.requestId} action=${audit.action} actor_role=${audit.actor.role} outcome=${outcome} status=${originalStatus}`);
      (originalEnd as any)(chunk, callbackFunction);
    }).catch((error: Error) => {
      addLog(`[CRITICAL] request_id=${context.requestId} Audit outcome persistence failed: ${error.message}`, {
        request_id: context.requestId,
        event: 'audit_outcome_persistence_failed',
        action: audit.action,
      });
      if (originalStatus < 400 && !response.headersSent) {
        response.statusCode = 503;
        response.removeHeader('Content-Length');
        (originalEnd as any)(JSON.stringify({
          error: 'Audit outcome could not be durably persisted; mutation result is not acknowledged.',
          requestId: context.requestId,
        }), callbackFunction);
        return;
      }
      (originalEnd as any)(chunk, callbackFunction);
    });
    return response;
  };
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
    if (!context.appState.auditTrail) {
      if (context.appState.recovery?.active
        && context.appState.recovery.allowLoopbackLocalSession
        && recoveryAllowsRoute(method, url)) {
        addLog(`[CRITICAL] request_id=${context.requestId} Recovery repair mutation accepted without an audit trail.`, {
          request_id: context.requestId,
          event: 'recovery_unaudited_repair',
          path: url,
        });
        return true;
      }
      throw new Error('Audit trail is unavailable.');
    }
    const action = semanticMutationAction(method, url);
    context.mutationAudit = {
      actor,
      action,
      target: auditTargetFromRequest(context),
      before: auditDomainState(context, action),
    };
    await context.appState.auditTrail.record({
      phase: 'authorized',
      action,
      requestId: context.requestId,
      actorId: actor.id,
      actorRole: actor.role,
      method,
      path: url,
      target: context.mutationAudit.target,
      before: context.mutationAudit.before,
    });
    installMutationAuditBarrier(context);
    return true;
  } catch (error) {
    context.mutationAudit = undefined;
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
  const { res, requestId } = context;
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
    telegramLogin: appState.getTelegramLoginState?.() ?? { state: 'idle' },
    config: {
      sourceChannels: appState.config.sourceChannels,
      targetChannel: appState.config.targetChannel,
    },
  });
}

function secretsHandler({ res, appState }: RequestContext): void {
  if (!appState.secretStore) {
    sendJson(res, 503, { error: 'Managed secret storage is unavailable.' });
    return;
  }
  sendJson(res, 200, { secrets: appState.secretStore.status() });
}

async function postSecretsHandler(context: RequestContext): Promise<void> {
  if (!context.appState.secretStore) {
    sendJson(context.res, 503, {
      error: 'Managed secret storage is unavailable.',
      requestId: context.requestId,
    });
    return;
  }
  try {
    const payload = await readJsonBody(context.req, 8 * 1024);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new HttpError(400, 'Managed secrets must be a JSON object.');
    }
    const allowed = new Set([
      'telegramApiHash',
      'openRouterApiKey',
      'auditWebhookToken',
      'alertRelayToken',
      'alertWebhookToken',
      'backupOffsiteToken',
      'backupEncryptionKey',
    ]);
    const entries = Object.entries(payload);
    if (entries.length === 0 || entries.some(([name]) => !allowed.has(name))) {
      throw new HttpError(400, 'The request contains an unsupported managed secret.');
    }
    await context.appState.secretStore.set(payload);
    addLog(`[INFO] request_id=${context.requestId} Managed dashboard secrets updated.`);
    sendJson(context.res, 200, {
      success: true,
      secrets: context.appState.secretStore.status(),
      requestId: context.requestId,
    });
  } catch (error) {
    sendError(context, error instanceof HttpError ? error : new HttpError(400, errorMessage(error)));
  }
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

async function dashboardAnalyticsHandler(context: RequestContext): Promise<void> {
  try {
    sendJson(context.res, 200, { analytics: await getSignalDashboardAnalytics() });
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
  if (!requireConfirmation(context, 'delete-incoming-message', 'Explicit message deletion confirmation required.')) return;
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
  if (!requireConfirmation(context, 'delete-processed-signal', 'Explicit signal deletion confirmation required.')) return;
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
      if (
        context.appState.state.isRunning
        || ['connecting', 'authentication-required'].includes(context.appState.state.connectionState)
      ) {
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
    const routingStarted = context.appState.state.isRunning
      || ['connecting', 'authentication-required'].includes(context.appState.state.connectionState);
    if (!routingStarted) throw new HttpError(409, 'Routing is not active.');
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

function telegramLoginHandler(context: RequestContext): void {
  sendJson(context.res, 200, {
    telegramLogin: context.appState.getTelegramLoginState?.() ?? { state: 'idle' },
  });
}

async function postTelegramLoginHandler(context: RequestContext): Promise<void> {
  if (!context.appState.submitTelegramLogin) {
    sendJson(context.res, 503, {
      error: 'Telegram web login is unavailable.',
      requestId: context.requestId,
    });
    return;
  }
  try {
    const snapshot = context.appState.submitTelegramLogin(await readJsonBody(context.req, 8 * 1024));
    sendJson(context.res, 202, { telegramLogin: snapshot, requestId: context.requestId });
  } catch (error) {
    sendError(context, new HttpError(400, errorMessage(error)));
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
      throw new HttpError(400, 'Secrets must be submitted through the dedicated managed-secret endpoint.');
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
    return await fsPromises.readFile(path.join(templatesDirectory(), file), 'utf8');
  } catch (error) {
    addLog(`[WARN] Template '${file}' could not be read: ${errorMessage(error)}`);
    return null;
  }
}

async function getTemplatesHandler(context: RequestContext): Promise<void> {
  try {
    const directory = templatesDirectory();
    await fsPromises.mkdir(directory, { recursive: true });
    const files = await fsPromises.readdir(directory);
    const defaultOverride = files.includes('default.txt') ? await readTemplate('default.txt') : null;
    const templates: Record<string, string> = {
      default: defaultOverride?.trim() ? defaultOverride : DEFAULT_SIGNAL_PROMPT,
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
    if (name === 'default' && !payload.content.trim()) {
      throw new HttpError(400, 'The default template override must not be empty.');
    }
    const directory = templatesDirectory();
    await fsPromises.mkdir(directory, { recursive: true });
    const destination = path.join(directory, `${name}.txt`);
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fsPromises.writeFile(temporary, payload.content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await fsPromises.rename(temporary, destination);
    } catch (error) {
      await fsPromises.unlink(temporary).catch(() => undefined);
      throw error;
    }
    addLog(`[INFO] request_id=${context.requestId} Template '${name}' saved.`);
    sendJson(context.res, 200, { success: true, requestId: context.requestId });
  } catch (error) {
    sendError(context, error);
  }
}

async function deleteTemplateHandler(context: RequestContext): Promise<void> {
  const name = context.parsedUrl.searchParams.get('name');
  if (!name || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    sendJson(context.res, 400, { error: 'Invalid template name for deletion.' });
    return;
  }
  try {
    await fsPromises.unlink(path.join(templatesDirectory(), `${name}.txt`));
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
  try {
    if (!context.appState.performFactoryReset) {
      throw new HttpError(503, 'Complete factory reset is unavailable in this runtime.');
    }
    await context.appState.performFactoryReset();
    addLog('[SECURITY] Complete factory reset executed through the web dashboard.');
    context.res.once('finish', () => context.appState.requestRestart?.());
    sendJson(context.res, 200, {
      success: true,
      message: 'Factory reset completed. The container is restarting into first-run setup.',
      restartScheduled: Boolean(context.appState.requestRestart),
      requestId: context.requestId,
    });
  } catch (error) {
    sendError(context, error);
  }
}

async function accessTokenHandler(context: RequestContext): Promise<void> {
  if (!context.appState.secretStore) {
    sendJson(context.res, 503, { error: 'Managed secret storage is unavailable.', requestId: context.requestId });
    return;
  }
  try {
    const payload = await readJsonBody(context.req, 4 * 1024);
    if (payload?.role !== 'admin' && payload?.role !== 'viewer') {
      throw new HttpError(400, 'Access-token role must be admin or viewer.');
    }
    const token = await context.appState.secretStore.rotateDashboardToken(payload.role);
    addLog(`[SECURITY] request_id=${context.requestId} Dashboard ${payload.role} token rotated.`);
    sendJson(context.res, 201, {
      token,
      role: payload.role,
      shownOnce: true,
      requestId: context.requestId,
    });
  } catch (error) {
    sendError(context, error instanceof HttpError ? error : new HttpError(409, errorMessage(error)));
  }
}

async function disableViewerTokenHandler(context: RequestContext): Promise<void> {
  if (!requireConfirmation(context, 'disable-viewer-token', 'Explicit viewer-token disable confirmation required.')) return;
  if (!context.appState.secretStore) {
    sendJson(context.res, 503, { error: 'Managed secret storage is unavailable.', requestId: context.requestId });
    return;
  }
  try {
    await context.appState.secretStore.removeDashboardViewerToken();
    addLog(`[SECURITY] request_id=${context.requestId} Dashboard viewer token disabled.`);
    sendJson(context.res, 200, { success: true, requestId: context.requestId });
  } catch (error) {
    sendError(context, new HttpError(409, errorMessage(error)));
  }
}

function operationsHandler({ res, appState }: RequestContext): void {
  sendJson(res, 200, {
    operations: appState.getOperationsStatus?.() ?? {},
  });
}

async function runBackupHandler(context: RequestContext): Promise<void> {
  if (!context.appState.runBackupNow) {
    sendJson(context.res, 503, { error: 'Backup control is unavailable.', requestId: context.requestId });
    return;
  }
  try {
    const artifact = await context.appState.runBackupNow();
    sendJson(context.res, 201, { success: true, artifact: path.basename(artifact), requestId: context.requestId });
  } catch (error) {
    sendError(context, new HttpError(409, errorMessage(error)));
  }
}

async function replayAuditHandler(context: RequestContext): Promise<void> {
  if (!requireConfirmation(context, 'replay-audit', 'Explicit audit replay confirmation required.')) return;
  if (!context.appState.auditTrail) {
    sendJson(context.res, 503, { error: 'Audit control is unavailable.', requestId: context.requestId });
    return;
  }
  try {
    const replayed = await context.appState.auditTrail.replayRemote();
    sendJson(context.res, 200, { success: true, replayed, requestId: context.requestId });
  } catch (error) {
    sendError(context, new HttpError(409, errorMessage(error)));
  }
}

function runtimeSettingsHandler({ res, appState }: RequestContext): void {
  if (!appState.runtimeSettings) {
    sendJson(res, 503, { error: 'Managed runtime settings are unavailable.' });
    return;
  }
  sendJson(res, 200, { settings: appState.runtimeSettings.snapshot() });
}

function recoveryStatusHandler({ res, appState }: RequestContext): void {
  sendJson(res, 200, {
    active: appState.recovery?.active === true,
    issues: appState.recovery?.issues ?? [],
    restartRequired: appState.recovery?.active === true,
  });
}

async function postRuntimeSettingsHandler(context: RequestContext): Promise<void> {
  if (!context.appState.runtimeSettings || !context.appState.secretStore) {
    sendJson(context.res, 503, { error: 'Managed runtime settings are unavailable.', requestId: context.requestId });
    return;
  }
  try {
    const payload = await readJsonBody(context.req, 128 * 1024);
    if (payload?.enterpriseMode === true) {
      const secrets = context.appState.secretStore.status();
      const missing = ['auditWebhookToken', 'alertRelayToken', 'alertWebhookToken', 'backupOffsiteToken', 'backupEncryptionKey']
        .filter((name) => !secrets[name as keyof typeof secrets]?.configured);
      if (missing.length > 0) {
        throw new HttpError(409, `Enterprise mode requires configured managed secrets: ${missing.join(', ')}.`);
      }
    }
    const settings = await context.appState.runtimeSettings.set(payload);
    addLog(`[SECURITY] request_id=${context.requestId} Managed runtime settings updated; restart required.`);
    sendJson(context.res, 200, { success: true, settings, restartRequired: true, requestId: context.requestId });
  } catch (error) {
    sendError(context, error instanceof HttpError ? error : new HttpError(400, errorMessage(error)));
  }
}

async function restartHandler(context: RequestContext): Promise<void> {
  if (!requireConfirmation(context, 'restart-service', 'Explicit service restart confirmation required.')) return;
  if (!context.appState.requestRestart) {
    sendJson(context.res, 503, { error: 'Service restart is unavailable.', requestId: context.requestId });
    return;
  }
  if (context.appState.state.isRunning) await context.appState.stopForwarding();
  context.res.once('finish', () => context.appState.requestRestart?.());
  sendJson(context.res, 202, { success: true, message: 'Container restart scheduled.', requestId: context.requestId });
}

function backupArtifactName(value: unknown): string {
  if (typeof value !== 'string' || !/^backup-\d{4}-[a-zA-Z0-9_.:-]{1,160}$/.test(value)) {
    throw new HttpError(400, 'Invalid backup artifact name.');
  }
  return value;
}

function offsiteBackupObjectName(value: unknown): string {
  if (typeof value !== 'string' || !/^backup-\d{4}-[a-zA-Z0-9_.:-]{1,160}\.tgfb$/.test(value)) {
    throw new HttpError(400, 'Invalid off-site backup object name.');
  }
  return value;
}

async function backupsHandler(context: RequestContext): Promise<void> {
  if (!context.appState.listBackups) {
    sendJson(context.res, 503, { error: 'Backup inventory is unavailable.' });
    return;
  }
  try {
    sendJson(context.res, 200, { backups: await context.appState.listBackups() });
  } catch (error) {
    sendError(context, error);
  }
}

async function verifyBackupHandler(context: RequestContext): Promise<void> {
  if (!context.appState.verifyBackup) {
    sendJson(context.res, 503, { error: 'Backup verification is unavailable.' });
    return;
  }
  try {
    const name = backupArtifactName(context.parsedUrl.searchParams.get('name'));
    const manifest = await context.appState.verifyBackup(name);
    sendJson(context.res, 200, { success: true, name, manifest });
  } catch (error) {
    sendError(context, error);
  }
}

async function recoverOffsiteBackupHandler(context: RequestContext): Promise<void> {
  if (!requireConfirmation(context, 'recover-offsite-backup', 'Explicit off-site recovery confirmation required.')) return;
  if (!context.appState.recoverOffsiteBackup) {
    sendJson(context.res, 503, { error: 'Off-site backup recovery is unavailable.', requestId: context.requestId });
    return;
  }
  try {
    const payload = await readJsonBody(context.req, 4 * 1024);
    const objectName = offsiteBackupObjectName(payload.objectName);
    const artifactName = await context.appState.recoverOffsiteBackup(objectName);
    sendJson(context.res, 201, { success: true, objectName, artifactName, requestId: context.requestId });
  } catch (error) {
    sendError(context, error);
  }
}

async function restoreBackupHandler(context: RequestContext): Promise<void> {
  if (!requireConfirmation(context, 'restore-backup', 'Explicit backup restore confirmation required.')) return;
  if (!context.appState.restoreBackup || !context.appState.requestRestart) {
    sendJson(context.res, 503, { error: 'Backup restore is unavailable.', requestId: context.requestId });
    return;
  }
  try {
    const payload = await readJsonBody(context.req, 4 * 1024);
    const name = backupArtifactName(payload.name);
    const restored = await context.appState.restoreBackup(name);
    context.res.once('finish', () => context.appState.requestRestart?.());
    sendJson(context.res, 200, {
      success: true,
      name,
      rollbackPreserved: Boolean(restored.previousDatabase || restored.previousConfig),
      restartScheduled: true,
      requestId: context.requestId,
    });
  } catch (error) {
    sendError(context, new HttpError(409, errorMessage(error)));
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
  try {
    const routingStopped = Boolean(context.appState.state.isRunning);
    if (routingStopped) await context.appState.stopForwarding();
    if (context.appState.state.isRunning) {
      throw new HttpError(409, 'Routing could not be stopped safely; no database data was deleted.');
    }
    const cleared = await clearDb();
    addLog(`[INFO] request_id=${context.requestId} Operational SQLite data cleared through the web dashboard; retained_trading_signals=${cleared.retainedTradingSignals}.`);
    sendJson(context.res, 200, {
      success: true,
      message: 'Operational database data cleared successfully; trading state was preserved.',
      routingStopped,
      cleared,
      requestId: context.requestId,
    });
  } catch (error) {
    sendError(context, error);
  }
}

function requireTradingControl(context: RequestContext): TradingWebControl {
  if (!context.appState.tradingControl) throw new HttpError(503, 'Trading control is unavailable in this runtime.');
  return context.appState.tradingControl;
}

async function tradingSnapshotHandler(context: RequestContext): Promise<void> {
  try {
    const snapshot = await requireTradingControl(context).snapshot();
    const configuredChannels = Array.isArray(context.appState.config?.sourceChannels)
      ? context.appState.config.sourceChannels.map((channel: any) => ({
          id: String(channel?.id ?? channel?.channelId ?? channel),
          name: String(channel?.name ?? channel?.title ?? channel?.id ?? channel),
        }))
      : [];
    sendJson(context.res, 200, { ...snapshot, configuredChannels });
  } catch (error) {
    sendError(context, error);
  }
}

async function tradingPortfolioHandler(context: RequestContext): Promise<void> {
  try {
    const refresh = context.parsedUrl.searchParams.get('refresh') === 'true';
    sendJson(context.res, 200, await requireTradingControl(context).portfolioSnapshot(refresh));
  } catch (error) {
    sendError(context, error);
  }
}

async function tradingMutation(
  context: RequestContext,
  operation: (control: TradingWebControl, payload: any) => Promise<unknown> | unknown,
  statusCode = 200,
): Promise<void> {
  try {
    const payload = await readJsonBody(context.req, 256 * 1024);
    const result = await operation(requireTradingControl(context), payload);
    sendJson(context.res, statusCode, { success: true, result, requestId: context.requestId });
  } catch (error) {
    sendError(context, error instanceof HttpError ? error : new HttpError(409, errorMessage(error)));
  }
}

const createTradingStrategyHandler = (context: RequestContext) =>
  tradingMutation(context, (control, payload) => control.createStrategy(payload), 201);
const updateTradingStrategyHandler = (context: RequestContext) =>
  tradingMutation(context, (control, payload) => control.updateStrategy(payload));
const publishTradingStrategyHandler = (context: RequestContext) =>
  tradingMutation(context, (control, payload) => control.publishStrategy(payload.id));
const archiveTradingStrategyHandler = (context: RequestContext) =>
  tradingMutation(context, (control, payload) => control.archiveStrategy(payload.id));
const deleteTradingStrategyHandler = (context: RequestContext) => {
  if (!requireConfirmation(
    context,
    'delete-trading-strategy',
    'Explicit trading strategy deletion confirmation required.',
  )) return;
  return tradingMutation(context, (control, payload) => control.removeStrategy(payload.id));
};
const createTradingAccountHandler = (context: RequestContext) =>
  tradingMutation(context, (control, payload) => control.createAccount(payload), 201);
const replaceTradingCredentialsHandler = (context: RequestContext) =>
  tradingMutation(context, (control, payload) => control.replaceAccountCredentials(payload));
const verifyTradingAccountHandler = (context: RequestContext) =>
  tradingMutation(context, (control, payload) => control.verifyAccount(payload.id));
const updateTradingAccountHandler = (context: RequestContext) =>
  tradingMutation(context, (control, payload) => control.setAccountEnabled(payload.id, payload.enabled));
const deleteTradingAccountHandler = (context: RequestContext) =>
  tradingMutation(context, (control, payload) => control.removeAccount(payload.id));
const setTradingRouteHandler = (context: RequestContext) =>
  tradingMutation(context, (control, payload) => control.setRoute(payload));
const deleteTradingRouteHandler = (context: RequestContext) =>
  tradingMutation(context, (control, payload) => control.removeRoute(payload.channelId));
const updateTradingRuntimeHandler = (context: RequestContext) =>
  tradingMutation(context, (control, payload) => control.setRuntime(payload));
const configurePaperTradingHandler = (context: RequestContext) =>
  tradingMutation(context, (control, payload) => control.configurePaper(payload));
const reconcileTradingHandler = (context: RequestContext) =>
  tradingMutation(context, (control, payload) => control.reconcile(payload.accountId));
const cancelTradingEntriesHandler = (context: RequestContext) =>
  tradingMutation(context, (control, payload) => control.cancelEntries(payload.accountId));
const emergencyFlattenHandler = (context: RequestContext) =>
  tradingMutation(context, (control, payload) => control.emergencyFlatten(payload));
const acknowledgeTradingRiskHandler = (context: RequestContext) =>
  tradingMutation(context, (control, payload) => control.acknowledgeRisk(payload.id));

const API_ROUTES = new Map<string, ApiHandler>([
  ['GET /api/status', statusHandler],
  ['GET /api/logs', logsHandler],
  ['GET /api/metrics-history', metricsHistoryHandler],
  ['GET /api/incoming-messages', incomingMessagesHandler],
  ['GET /api/processed-signals', processedSignalsHandler],
  ['GET /api/dashboard-analytics', dashboardAnalyticsHandler],
  ['GET /api/outbox', outboxHandler],
  ['POST /api/outbox/retry', retryOutboxHandler],
  ['POST /api/outbox/acknowledge', acknowledgeOutboxHandler],
  ['DELETE /api/incoming-messages', deleteIncomingHandler],
  ['DELETE /api/processed-signals', deleteSignalHandler],
  ['POST /api/control', controlHandler],
  ['GET /api/telegram-login', telegramLoginHandler],
  ['POST /api/telegram-login', postTelegramLoginHandler],
  ['GET /api/config', getConfigHandler],
  ['POST /api/config', postConfigHandler],
  ['GET /api/secrets', secretsHandler],
  ['POST /api/secrets', postSecretsHandler],
  ['POST /api/access-tokens', accessTokenHandler],
  ['DELETE /api/access-tokens/viewer', disableViewerTokenHandler],
  ['POST /api/import', importHandler],
  ['GET /api/templates', getTemplatesHandler],
  ['POST /api/templates', postTemplateHandler],
  ['DELETE /api/templates', deleteTemplateHandler],
  ['POST /api/factory-reset', factoryResetHandler],
  ['POST /api/clear-database', clearDatabaseHandler],
  ['GET /api/operations', operationsHandler],
  ['POST /api/operations/backup', runBackupHandler],
  ['POST /api/operations/audit-replay', replayAuditHandler],
  ['GET /api/runtime-settings', runtimeSettingsHandler],
  ['POST /api/runtime-settings', postRuntimeSettingsHandler],
  ['GET /api/recovery', recoveryStatusHandler],
  ['POST /api/restart', restartHandler],
  ['GET /api/backups', backupsHandler],
  ['GET /api/backups/verify', verifyBackupHandler],
  ['POST /api/backups/recover-offsite', recoverOffsiteBackupHandler],
  ['POST /api/backups/restore', restoreBackupHandler],
  ['GET /api/trading', tradingSnapshotHandler],
  ['GET /api/trading/portfolio', tradingPortfolioHandler],
  ['POST /api/trading/strategies', createTradingStrategyHandler],
  ['POST /api/trading/strategies/update', updateTradingStrategyHandler],
  ['POST /api/trading/strategies/publish', publishTradingStrategyHandler],
  ['POST /api/trading/strategies/archive', archiveTradingStrategyHandler],
  ['DELETE /api/trading/strategies', deleteTradingStrategyHandler],
  ['POST /api/trading/accounts', createTradingAccountHandler],
  ['POST /api/trading/accounts/credentials', replaceTradingCredentialsHandler],
  ['POST /api/trading/accounts/verify', verifyTradingAccountHandler],
  ['POST /api/trading/accounts/state', updateTradingAccountHandler],
  ['DELETE /api/trading/accounts', deleteTradingAccountHandler],
  ['POST /api/trading/routes', setTradingRouteHandler],
  ['DELETE /api/trading/routes', deleteTradingRouteHandler],
  ['POST /api/trading/runtime', updateTradingRuntimeHandler],
  ['POST /api/trading/paper', configurePaperTradingHandler],
  ['POST /api/trading/reconcile', reconcileTradingHandler],
  ['POST /api/trading/cancel-entries', cancelTradingEntriesHandler],
  ['POST /api/trading/emergency-flatten', emergencyFlattenHandler],
  ['POST /api/trading/risk/acknowledge', acknowledgeTradingRiskHandler],
]);

function bootstrapStatusHandler(
  context: RequestContext,
  authenticator: DashboardAuthenticator
): void {
  const required = authenticator.mode === 'token' && !authenticator.isConfigured();
  sendJson(context.res, 200, {
    mode: authenticator.mode,
    required,
    available: required && Boolean(context.appState.secretStore),
    ...(required && context.appState.recovery?.allowLoopbackLocalSession === true
      ? { recoveryBootstrap: true }
      : {}),
  });
}

async function bootstrapHandler(
  context: RequestContext,
  authenticator: DashboardAuthenticator
): Promise<void> {
  try {
    if (authenticator.mode !== 'token') {
      throw new HttpError(409, 'Token bootstrap is unavailable in OIDC mode.');
    }
    if (authenticator.isConfigured()) {
      throw new HttpError(409, 'Dashboard authentication is already configured.');
    }
    if (!context.appState.secretStore) {
      throw new HttpError(503, 'Managed secret storage is unavailable.');
    }
    const origin = typeof context.req.headers.origin === 'string' ? context.req.headers.origin : '';
    if (!origin || !isAllowedOrigin(origin)) {
      throw new HttpError(403, 'Dashboard bootstrap requires an allowed browser origin.');
    }
    const actor: AuthenticatedActor = { role: 'admin', id: 'bootstrap:local-browser' };
    if (!(await authorizeMutationAudit(context, actor, 'POST', '/api/bootstrap'))) return;
    const token = await context.appState.secretStore.createDashboardAdminToken();
    addLog(`[SECURITY] request_id=${context.requestId} Dashboard administrator token bootstrapped.`);
    sendJson(context.res, 201, {
      token,
      recoveryLocation: 'secrets/dashboard_admin_token',
      requestId: context.requestId,
    });
  } catch (error) {
    sendError(context, error instanceof HttpError ? error : new HttpError(409, errorMessage(error)));
  }
}

function localDashboardStartupEnabled(): boolean {
  return process.env.DASHBOARD_LOCAL_TRUST?.trim().toLowerCase() === 'true'
    && process.env.ENTERPRISE_MODE?.trim().toLowerCase() !== 'true';
}

function requireLocalSessionSecretStore(
  context: RequestContext,
  authenticator: DashboardAuthenticator
): NonNullable<WebServerState['secretStore']> {
  if (!localDashboardStartupEnabled() && !context.appState.recovery?.allowLoopbackLocalSession) {
    throw new HttpError(409, 'Integrated local dashboard startup is disabled.');
  }
  if (authenticator.mode !== 'token') {
    throw new HttpError(409, 'Integrated local startup is unavailable in OIDC mode.');
  }
  const secretStore = context.appState.secretStore;
  if (!secretStore) throw new HttpError(503, 'Managed secret storage is unavailable.');
  const origin = typeof context.req.headers.origin === 'string' ? context.req.headers.origin : '';
  if (!origin || !isLoopbackBrowserOrigin(origin) || context.req.headers['x-requested-with'] !== 'forwarder-dashboard') {
    throw new HttpError(403, 'Integrated local startup requires the trusted dashboard origin.');
  }
  return secretStore;
}

function isRecoveryLocalSessionBootstrap(context: RequestContext): boolean {
  return context.appState.recovery?.allowLoopbackLocalSession === true;
}

async function authorizeLocalSessionInitialization(
  context: RequestContext,
  actor: AuthenticatedActor,
  tokenWasConfigured: boolean
): Promise<boolean> {
  if (tokenWasConfigured) return true;
  if (isRecoveryLocalSessionBootstrap(context)) {
    addLog(`[CRITICAL] request_id=${context.requestId} Recovery-mode loopback session initialized without an audit trail.`, {
      request_id: context.requestId,
      event: 'recovery_local_session_bootstrap',
    });
    return true;
  }
  if (!(await authorizeMutationAudit(context, actor, 'POST', '/api/local-session'))) return false;
  return true;
}

async function localSessionHandler(
  context: RequestContext,
  authenticator: DashboardAuthenticator
): Promise<void> {
  try {
    const secretStore = requireLocalSessionSecretStore(context, authenticator);
    const tokenWasConfigured = authenticator.isConfigured();
    if (tokenWasConfigured) {
      throw new HttpError(409, 'Local-session bootstrap never discloses an existing administrator token. Use the saved token or rotate it through an authenticated session.');
    }
    const actor: AuthenticatedActor = { role: 'admin', id: 'startup:local-browser' };
    if (!(await authorizeLocalSessionInitialization(context, actor, tokenWasConfigured))) return;
    const token = await secretStore.createDashboardAdminToken();
    addLog(`[SECURITY] request_id=${context.requestId} Integrated local dashboard access initialized.`);
    sendJson(context.res, 201, {
      token,
      role: 'admin',
      localStartup: true,
      requestId: context.requestId,
    });
  } catch (error) {
    sendError(context, error instanceof HttpError ? error : new HttpError(409, errorMessage(error)));
  }
}

function recoveryAllowsRoute(method: string, url: string): boolean {
  return new Set([
    'GET /api/recovery',
    'GET /api/config',
    'POST /api/config',
    'GET /api/secrets',
    'POST /api/secrets',
    'GET /api/runtime-settings',
    'POST /api/runtime-settings',
    'POST /api/factory-reset',
    'POST /api/restart',
  ]).has(`${method} ${url}`);
}

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

async function handlePublicApiRequest(
  context: RequestContext,
  authenticator: DashboardAuthenticator,
  method: string,
  url: string
): Promise<boolean> {
  if (method === 'GET' && url === '/api/bootstrap/status') {
    bootstrapStatusHandler(context, authenticator);
    return true;
  }
  if (method === 'POST' && url === '/api/bootstrap') {
    await bootstrapHandler(context, authenticator);
    return true;
  }
  if (method === 'POST' && url === '/api/local-session') {
    await localSessionHandler(context, authenticator);
    return true;
  }
  return false;
}

async function invokeApiHandler(
  context: RequestContext,
  method: string,
  handler: ApiHandler
): Promise<void> {
  if (method === 'GET') {
    await handler(context);
    return;
  }
  if (mutationInProgress) {
    sendJson(context.res, 409, {
      error: 'Another control-plane mutation is already in progress.',
      requestId: context.requestId,
    });
    return;
  }
  mutationInProgress = true;
  try {
    await handler(context);
  } finally {
    mutationInProgress = false;
  }
}

async function handleAuthenticatedApiRequest(
  context: RequestContext,
  authenticator: DashboardAuthenticator,
  method: string,
  url: string
): Promise<void> {
  if (await handlePublicApiRequest(context, authenticator, method, url)) return;
  if (!(await authenticateApiRequest(context, authenticator, method, url))) return;
  if (context.appState.recovery?.active && !recoveryAllowsRoute(method, url)) {
    sendJson(context.res, 503, {
      error: 'Recovery mode only permits managed runtime-settings and secret repair followed by a restart.',
      requestId: context.requestId,
    });
    return;
  }
  const handler = API_ROUTES.get(`${method} ${url}`);
  if (!handler) {
    sendJson(context.res, 404, { error: 'API endpoint not found.', requestId: context.requestId });
    return;
  }
  await invokeApiHandler(context, method, handler);
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
  const context: RequestContext = { req, res, requestId, parsedUrl, appState };
  requestContexts.set(req, context);
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
  await handleAuthenticatedApiRequest(context, authenticator, method, url);
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
