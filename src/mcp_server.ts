import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';
import { closeDb, getDatabase, initDb } from './db.js';
import { loadEnv } from './env.js';
import {
  getTradingOverview,
  listSignalContracts,
  listTradingActivity,
  listTradingAccounts,
  listTradingIntents,
  listTradingRoutes,
} from './trading_repository.js';
import { listChannelRiskEvaluations, listChannelRiskPolicies } from './trading_channel_risk.js';
import { getTradingExecutionAnalytics } from './trading_telemetry.js';
import {
  agentHasPermission,
  authenticateMcpToken,
  connectMcpSession,
  disconnectMcpSession,
  enqueueMcpControlRequest,
  listMcpAgents,
  listPendingMcpEvents,
  recordMcpAgentAction,
  recordMcpEventDelivery,
  touchMcpSession,
  waitForMcpControlRequest,
  type AuthenticatedMcpAgent,
  type McpAgent,
  type McpAgentSession,
  type McpControlAction,
  type McpPermission,
} from './mcp_repository.js';
import {
  databaseFileIdentity,
  mcpMaintenanceActive,
  operationalDatabasePath,
} from './mcp_maintenance.js';

const MAXIMUM_TOOL_RESULT_BYTES = 512 * 1024;
const AUTH_WINDOW_MS = 60_000;
const AUTH_MAXIMUM_FAILURES = 20;

type ToolHandler = (input: any, sessionId?: string) => Promise<unknown>;
type SessionRuntime = {
  agentId: string;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  session: McpAgentSession | null;
  notificationTimer: NodeJS.Timeout | null;
  notificationBusy: boolean;
};

const sessions = new Map<string, SessionRuntime>();
const authenticationFailures = new Map<string, { startedAt: number; failures: number }>();
let httpServer: Server | null = null;
let shuttingDown = false;
let maintenanceTimer: NodeJS.Timeout | null = null;
let maintenanceCheckBusy = false;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) || 'Unknown MCP server error.';
  } catch {
    return 'Unknown MCP server error.';
  }
}

function integerFromEnvironment(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function configuredHost(): string {
  const host = process.env.MCP_HOST?.trim() || '127.0.0.1';
  if (!/^[a-z0-9.:[\]-]+$/i.test(host) || /[\r\n/\\@]/.test(host)) throw new Error('MCP_HOST is invalid.');
  return host;
}

function allowedHosts(host: string): string[] | undefined {
  const configured = (process.env.MCP_ALLOWED_HOSTS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  if (configured.some(value => /[:/\\@\r\n]/.test(value) && value !== '[::1]')) {
    throw new Error('MCP_ALLOWED_HOSTS accepts hostnames without ports.');
  }
  if (configured.length > 0) return [...new Set(configured)];
  if (['127.0.0.1', 'localhost', '::1'].includes(host)) return undefined;
  throw new Error('MCP_ALLOWED_HOSTS is required when MCP_HOST is not loopback.');
}

function allowedOrigins(): Set<string> {
  const origins = (process.env.MCP_ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || parsed.username || parsed.password) {
      throw new Error('MCP_ALLOWED_ORIGINS must contain exact origins.');
    }
  }
  return new Set(origins);
}

function bearerToken(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([A-Za-z0-9_-]{40,128})$/.exec(header);
  return match?.[1] ?? null;
}

function remoteIdentity(req: any): string {
  return String(req.ip || req.socket?.remoteAddress || 'unknown').slice(0, 128);
}

function isRateLimited(identity: string): boolean {
  const now = Date.now();
  const state = authenticationFailures.get(identity);
  if (!state || now - state.startedAt >= AUTH_WINDOW_MS) {
    authenticationFailures.set(identity, { startedAt: now, failures: 0 });
    return false;
  }
  return state.failures >= AUTH_MAXIMUM_FAILURES;
}

function recordAuthenticationFailure(identity: string): void {
  const now = Date.now();
  const state = authenticationFailures.get(identity);
  if (!state || now - state.startedAt >= AUTH_WINDOW_MS) {
    authenticationFailures.set(identity, { startedAt: now, failures: 1 });
    return;
  }
  state.failures += 1;
}

function clearAuthenticationFailures(identity: string): void {
  authenticationFailures.delete(identity);
}

function jsonText(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(text, 'utf8') > MAXIMUM_TOOL_RESULT_BYTES) {
    throw new Error('Tool result exceeds 512 KiB. Narrow the requested limit or filter.');
  }
  return text;
}

function toolResult(value: unknown): any {
  return { content: [{ type: 'text', text: jsonText(value) }] };
}

function toolError(error: unknown): any {
  return {
    isError: true,
    content: [{ type: 'text', text: errorMessage(error).slice(0, 4_000) }],
  };
}

function actionSummary(value: unknown): unknown {
  if (Array.isArray(value)) return { type: 'array', count: value.length };
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return {
      type: 'object',
      keys: Object.keys(record).slice(0, 50),
      ...(typeof record.id === 'string' ? { id: record.id } : {}),
    };
  }
  return { type: typeof value };
}

async function currentAgent(agentId: string): Promise<McpAgent> {
  const agent = (await listMcpAgents()).find(candidate => candidate.id === agentId);
  if (!agent?.enabled) throw new Error('MCP agent is disabled or no longer exists.');
  return agent;
}

function registerTool(
  server: McpServer,
  agentId: string,
  name: string,
  permission: McpPermission,
  config: any,
  handler: ToolHandler,
): void {
  server.registerTool(name, config, async (input: any, extra: any) => {
    const startedAt = Date.now();
    const sessionId = typeof extra?.sessionId === 'string' ? extra.sessionId : undefined;
    try {
      const agent = await currentAgent(agentId);
      if (!agentHasPermission(agent, permission)) {
        await recordMcpAgentAction({
          agentId,
          sessionId,
          toolName: name,
          permission,
          outcome: 'rejected',
          request: input,
          error: 'Permission denied.',
          startedAt,
        });
        return toolError(new Error(`Permission '${permission}' is not granted to this agent.`));
      }
      const result = await handler(input, sessionId);
      await recordMcpAgentAction({
        agentId,
        sessionId,
        toolName: name,
        permission,
        outcome: 'succeeded',
        request: input,
        result: actionSummary(result),
        startedAt,
      });
      return toolResult(result);
    } catch (error) {
      await recordMcpAgentAction({
        agentId,
        sessionId,
        toolName: name,
        permission,
        outcome: 'failed',
        request: input,
        error: errorMessage(error),
        startedAt,
      }).catch(() => undefined);
      return toolError(error);
    }
  });
}

function enqueueControl(
  agentId: string,
  sessionId: string | undefined,
  action: McpControlAction,
  payload: unknown,
): Promise<unknown> {
  return enqueueMcpControlRequest({ agentId, sessionId, action, payload })
    .then(request => waitForMcpControlRequest(request.id, 45_000))
    .then(request => {
      if (request.status === 'failed') throw new Error(request.error || 'TSX Core rejected the control request.');
      return { requestId: request.id, status: request.status, result: request.result };
    });
}

function registerReadTools(server: McpServer, agentId: string): void {
  registerTool(server, agentId, 'tsx_system_status', 'system.read', {
    title: 'TSX Core system status',
    description: 'Reads execution safety state, route/account counts and current execution latency metrics.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => ({
    overview: await getTradingOverview(),
    execution: await getTradingExecutionAnalytics(),
  }));

  registerTool(server, agentId, 'tsx_contracts_list', 'contracts.read', {
    title: 'List signal contracts',
    description: 'Lists the reusable, versioned XML signal contracts and their definitions.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => listSignalContracts());

  registerTool(server, agentId, 'tsx_positions_list', 'positions.read', {
    title: 'List managed positions',
    description: 'Lists managed trading positions and their recent order/fill state.',
    inputSchema: { limit: z.number().int().min(1).max(500).default(100) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ limit }) => {
    const activity = await listTradingActivity(limit);
    return { positions: activity.positions, orders: activity.orders, fills: activity.fills };
  });

  registerTool(server, agentId, 'tsx_signals_list', 'signals.read', {
    title: 'List trading signals',
    description: 'Lists recently accepted trading intents with their source-channel context.',
    inputSchema: { limit: z.number().int().min(1).max(500).default(100) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ limit }) => listTradingIntents(limit));

  registerTool(server, agentId, 'tsx_risk_status', 'risk.read', {
    title: 'Read risk configuration',
    description: 'Reads channel risk policies/evaluations, accounts and channel routes.',
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const [policies, evaluations, accounts, routes] = await Promise.all([
      listChannelRiskPolicies(),
      listChannelRiskEvaluations(200),
      listTradingAccounts(),
      listTradingRoutes(),
    ]);
    return {
      policies,
      evaluations,
      accounts: accounts.map(({ credentialRef: _credentialRef, ...account }) => account),
      routes,
    };
  });

}

function registerControlTool(
  server: McpServer,
  agentId: string,
  name: string,
  permission: McpPermission,
  action: McpControlAction,
  config: any,
): void {
  registerTool(
    server,
    agentId,
    name,
    permission,
    config,
    (input, sessionId) => enqueueControl(agentId, sessionId, action, input),
  );
}

function registerContractTools(server: McpServer, agentId: string): void {
  registerControlTool(server, agentId, 'tsx_contract_create', 'contracts.write', 'contracts.create', {
    title: 'Create signal contract',
    description: 'Creates a new reusable signal contract as a draft version.',
    inputSchema: {
      id: z.string().min(1).max(64).optional(),
      name: z.string().min(1).max(80),
      description: z.string().max(2_000).default(''),
      definition: z.record(z.string(), z.unknown()),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  });
  registerControlTool(server, agentId, 'tsx_contract_update', 'contracts.write', 'contracts.update', {
    title: 'Update signal contract draft',
    description: 'Updates an existing draft contract version.',
    inputSchema: {
      contractId: z.string().min(1).max(64),
      versionId: z.string().min(1).max(64),
      name: z.string().min(1).max(80),
      description: z.string().max(2_000).default(''),
      definition: z.record(z.string(), z.unknown()),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  });
  registerControlTool(server, agentId, 'tsx_contract_publish', 'contracts.write', 'contracts.publish', {
    title: 'Publish signal contract',
    description: 'Publishes a validated draft contract version.',
    inputSchema: { versionId: z.string().min(1).max(64) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  });
  registerControlTool(server, agentId, 'tsx_contract_archive', 'contracts.write', 'contracts.archive', {
    title: 'Archive signal contract',
    description: 'Archives a published signal contract version.',
    inputSchema: { versionId: z.string().min(1).max(64) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  });
  registerControlTool(server, agentId, 'tsx_contract_delete_draft', 'contracts.write', 'contracts.delete_draft', {
    title: 'Delete contract draft',
    description: 'Permanently deletes a draft contract version.',
    inputSchema: { versionId: z.string().min(1).max(64) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  });
}

function registerRiskTools(server: McpServer, agentId: string): void {
  registerControlTool(server, agentId, 'tsx_risk_policy_update', 'risk.write', 'risk.update', {
    title: 'Update channel risk policy',
    description: 'Creates or updates adaptive risk settings for one source channel.',
    inputSchema: {
      channelId: z.string().min(1).max(128),
      mode: z.enum(['fixed', 'shadow', 'automatic']),
      tiers: z.array(z.object({ riskPercent: z.string().min(1).max(24) })).min(1).max(20),
      currentTier: z.number().int().min(0).optional(),
      lookbackWeeks: z.number().int().min(1).max(52),
      minimumClosedTrades: z.number().int().min(1).max(10_000),
      lossThresholdPercent: z.string().min(1).max(24),
      profitThresholdPercent: z.string().min(1).max(24),
      weakChannelAction: z.enum(['none', 'reduce', 'block']),
      weakWeeksBeforeBlock: z.number().int().min(1).max(52),
      manuallyBlocked: z.boolean().optional(),
      lockedTier: z.number().int().min(0).nullable().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  });
  registerControlTool(server, agentId, 'tsx_risk_policy_delete', 'risk.write', 'risk.delete', {
    title: 'Delete channel risk policy',
    description: 'Deletes the adaptive risk policy for one source channel.',
    inputSchema: { channelId: z.string().min(1).max(128) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  });
}

function registerTradingTools(server: McpServer, agentId: string): void {
  registerControlTool(server, agentId, 'tsx_reconcile', 'trading.reconcile', 'trading.reconcile', {
    title: 'Reconcile exchange state',
    description: 'Reconciles one account, or all enabled accounts, against the exchange.',
    inputSchema: { accountId: z.string().min(1).max(64).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  });
  registerControlTool(server, agentId, 'tsx_cancel_open_entries', 'trading.cancel_entries', 'trading.cancel_entries', {
    title: 'Cancel open entry orders',
    description: 'Cancels managed open entry orders for one account or all accounts.',
    inputSchema: { accountId: z.string().min(1).max(64).optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  });
  registerControlTool(server, agentId, 'tsx_set_kill_switch', 'trading.kill_switch', 'trading.kill_switch', {
    title: 'Set kill switch',
    description: 'Activates or deactivates the trading kill switch. Deactivation reconciles enabled accounts first.',
    inputSchema: {
      active: z.boolean(),
      reason: z.string().min(1).max(300).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  });
  registerControlTool(server, agentId, 'tsx_emergency_flatten', 'trading.flatten', 'trading.flatten', {
    title: 'Emergency flatten',
    description: 'Activates the kill switch and closes all managed positions, optionally scoped to one account.',
    inputSchema: { accountId: z.string().min(1).max(64).optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  });
}

function registerTools(server: McpServer, agentId: string): void {
  registerReadTools(server, agentId);
  registerContractTools(server, agentId);
  registerRiskTools(server, agentId);
  registerTradingTools(server, agentId);
}

function createServer(agent: AuthenticatedMcpAgent): McpServer {
  const server = new McpServer(
    { name: 'tsx-core', version: '2.0.0' },
    { capabilities: { logging: {} } },
  );
  registerTools(server, agent.id);
  return server;
}

async function pumpNotifications(runtime: SessionRuntime): Promise<void> {
  if (!runtime.session || shuttingDown || runtime.notificationBusy) return;
  runtime.notificationBusy = true;
  try {
    if (!await touchMcpSession(runtime.session.id, runtime.agentId)) return;
    const agent = await currentAgent(runtime.agentId);
    const events = await listPendingMcpEvents(agent, runtime.session, 100);
    for (const event of events) {
      try {
        await runtime.server.sendLoggingMessage({
          level: event.eventType === 'kill_switch_activated' ? 'critical' : 'info',
          logger: 'tsx-core.events',
          data: { type: 'tsx_core_event', event },
        }, runtime.session.id);
        await recordMcpEventDelivery({
          eventId: event.id,
          agentId: agent.id,
          sessionId: runtime.session.id,
          eventType: event.eventType,
          status: 'delivered',
        });
      } catch (error) {
        await recordMcpEventDelivery({
          eventId: event.id,
          agentId: agent.id,
          sessionId: runtime.session.id,
          eventType: event.eventType,
          status: 'failed',
          error: errorMessage(error),
        });
        break;
      }
    }
  } catch (error) {
    console.error(`[WARN] MCP notification pump failed: ${errorMessage(error)}`);
  } finally {
    runtime.notificationBusy = false;
  }
}

async function closeSession(sessionId: string): Promise<void> {
  const runtime = sessions.get(sessionId);
  if (!runtime) return;
  sessions.delete(sessionId);
  if (runtime.notificationTimer) clearInterval(runtime.notificationTimer);
  await disconnectMcpSession(sessionId, runtime.agentId).catch(() => undefined);
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (maintenanceTimer) clearInterval(maintenanceTimer);
  maintenanceTimer = null;
  for (const [sessionId, runtime] of sessions) {
    if (runtime.notificationTimer) clearInterval(runtime.notificationTimer);
    await runtime.transport.close().catch(() => undefined);
    await disconnectMcpSession(sessionId, runtime.agentId).catch(() => undefined);
  }
  sessions.clear();
  await new Promise<void>(resolve => {
    if (!httpServer) return resolve();
    httpServer.close(() => resolve());
  });
  await closeDb().catch(() => undefined);
}

async function initializeOperationalDatabase(databasePath: string): Promise<string> {
  if (await mcpMaintenanceActive(databasePath)) throw new Error('TSX Core database maintenance is active.');
  const initialDatabaseIdentity = await databaseFileIdentity(databasePath);
  await initDb(databasePath);
  if (await mcpMaintenanceActive(databasePath)) throw new Error('TSX Core database maintenance started during MCP initialization.');
  if (await databaseFileIdentity(databasePath) !== initialDatabaseIdentity) {
    throw new Error('TSX Core database changed during MCP initialization.');
  }
  return initialDatabaseIdentity;
}

function configureHttpSecurity(app: any, origins: Set<string>): void {
  app.use((req: any, res: any, next: any) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
    if (origin && !origins.has(origin)) {
      res.status(403).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Origin is not allowed.' }, id: null });
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
}

function configureHealthCheck(app: any): void {
  app.get('/healthz', async (_req: any, res: any) => {
    try {
      await getDatabase().get('SELECT 1');
      res.status(200).json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'unhealthy' });
    }
  });
}

async function authenticateRequest(req: any, res: any): Promise<AuthenticatedMcpAgent | null> {
  const identity = remoteIdentity(req);
  if (isRateLimited(identity)) {
    res.status(429).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Too many authentication failures.' }, id: null });
    return null;
  }
  const token = bearerToken(req.headers.authorization);
  const agent = token ? await authenticateMcpToken(token) : null;
  if (!agent) {
    recordAuthenticationFailure(identity);
    res.setHeader('WWW-Authenticate', 'Bearer realm="tsx-core-mcp"');
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Valid MCP agent token required.' }, id: null });
    return null;
  }
  clearAuthenticationFailures(identity);
  return agent;
}

async function handleExistingSession(
  agent: AuthenticatedMcpAgent,
  sessionId: string,
  req: any,
  res: any,
): Promise<void> {
  const runtime = sessions.get(sessionId);
  if (runtime?.agentId !== agent.id) {
    res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'MCP session is invalid.' }, id: null });
    return;
  }
  if (!await touchMcpSession(sessionId, agent.id)) {
    await closeSession(sessionId);
    res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'MCP session is no longer active.' }, id: null });
    return;
  }
  await runtime.transport.handleRequest(req, res, req.body);
}

async function initializeMcpSession(agent: AuthenticatedMcpAgent, req: any, res: any): Promise<void> {
  const clientInfo = req.body?.params?.clientInfo ?? {};
  const runtime: SessionRuntime = {
    agentId: agent.id,
    transport: undefined as unknown as StreamableHTTPServerTransport,
    server: undefined as unknown as McpServer,
    session: null,
    notificationTimer: null,
    notificationBusy: false,
  };
  let sessionRegistration: Promise<McpAgentSession> | null = null;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId: string) => {
      sessionRegistration = connectMcpSession({
        id: sessionId,
        agentId: agent.id,
        clientName: clientInfo.name,
        clientVersion: clientInfo.version,
      }).then(session => {
        runtime.session = session;
        runtime.notificationTimer = setInterval(() => void pumpNotifications(runtime), 1_000);
        runtime.notificationTimer.unref();
        return session;
      });
      sessions.set(sessionId, runtime);
    },
  });
  const server = createServer(agent);
  runtime.transport = transport;
  runtime.server = server;
  transport.onclose = () => {
    const sessionId = transport.sessionId;
    if (sessionId) void closeSession(sessionId);
  };
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
  if (sessionRegistration !== null) await sessionRegistration;
}

async function handleMcpRequest(req: any, res: any): Promise<void> {
  const agent = await authenticateRequest(req, res);
  if (!agent) return;
  const requestedSession = typeof req.headers['mcp-session-id'] === 'string'
    ? req.headers['mcp-session-id']
    : null;
  if (requestedSession) {
    await handleExistingSession(agent, requestedSession, req, res);
    return;
  }
  if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
    res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Initialize request or valid MCP session required.' }, id: null });
    return;
  }
  await initializeMcpSession(agent, req, res);
}

function configureMcpRoute(app: any): void {
  app.all('/mcp', (req: any, res: any) => {
    void handleMcpRequest(req, res).catch(error => {
      console.error(`[ERROR] MCP request failed: ${errorMessage(error)}`);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error.' }, id: null });
      } else {
        res.end();
      }
    });
  });
}

function startMaintenanceMonitor(databasePath: string, initialDatabaseIdentity: string): void {
  maintenanceTimer = setInterval(() => {
    if (maintenanceCheckBusy || shuttingDown) return;
    maintenanceCheckBusy = true;
    void Promise.all([
      mcpMaintenanceActive(databasePath),
      databaseFileIdentity(databasePath),
    ]).then(async ([maintenance, identity]) => {
      if (!maintenance && identity === initialDatabaseIdentity) return;
      console.error('[CRITICAL] MCP service is closing for TSX Core database maintenance or replacement.');
      await shutdown();
      process.exit(1);
    }).catch(async () => {
      console.error('[CRITICAL] MCP service lost the operational database path and is closing.');
      await shutdown();
      process.exit(1);
    }).finally(() => {
      maintenanceCheckBusy = false;
    });
  }, 250);
  maintenanceTimer.unref();
}

async function main(): Promise<void> {
  loadEnv();
  const host = configuredHost();
  const port = integerFromEnvironment('MCP_PORT', 8091, 1, 65_535);
  const origins = allowedOrigins();
  const databasePath = operationalDatabasePath();
  const initialDatabaseIdentity = await initializeOperationalDatabase(databasePath);
  const app = createMcpExpressApp({ host, allowedHosts: allowedHosts(host) });
  configureHttpSecurity(app, origins);
  configureHealthCheck(app);
  configureMcpRoute(app);
  httpServer = app.listen(port, host, () => {
    console.log(`[INFO] TSX Core MCP server listening on http://${host}:${port}/mcp`);
  });
  startMaintenanceMonitor(databasePath, initialDatabaseIdentity);
}

process.on('SIGINT', () => void shutdown().finally(() => process.exit(0)));
process.on('SIGTERM', () => void shutdown().finally(() => process.exit(0)));

await main().catch(async error => {
  console.error(`[FATAL] MCP server startup failed: ${errorMessage(error)}`);
  await shutdown();
  process.exitCode = 1;
});
