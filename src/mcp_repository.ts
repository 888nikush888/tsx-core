import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { getDatabase, withDatabaseTransaction } from './db.js';
import { TRADING_EVENT_TYPES, type TradingEventType } from './trading_telemetry.js';

export const MCP_PERMISSIONS = [
  'system.read',
  'contracts.read',
  'positions.read',
  'signals.read',
  'risk.read',
  'contracts.write',
  'risk.write',
  'trading.reconcile',
  'trading.cancel_entries',
  'trading.kill_switch',
  'trading.flatten',
] as const;

export type McpPermission = typeof MCP_PERMISSIONS[number];
export type McpControlAction =
  | 'contracts.create'
  | 'contracts.update'
  | 'contracts.publish'
  | 'contracts.archive'
  | 'contracts.delete_draft'
  | 'risk.update'
  | 'risk.delete'
  | 'trading.reconcile'
  | 'trading.cancel_entries'
  | 'trading.kill_switch'
  | 'trading.flatten';

export interface McpAgent {
  id: string;
  name: string;
  tokenPrefix: string;
  permissions: McpPermission[];
  eventSubscriptions: TradingEventType[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number | null;
}

export interface AuthenticatedMcpAgent extends McpAgent {
  tokenSha256: string;
}

export interface McpAgentSession {
  id: string;
  agentId: string;
  clientName: string;
  clientVersion: string;
  connectedAt: number;
  lastSeenAt: number;
  disconnectedAt: number | null;
}

export interface McpAgentAction {
  id: string;
  agentId: string;
  agentName: string;
  sessionId: string | null;
  toolName: string;
  permission: string;
  outcome: 'succeeded' | 'rejected' | 'failed';
  request: unknown;
  result: unknown;
  error: string | null;
  startedAt: number;
  completedAt: number;
  durationMs: number;
}

export interface McpControlRequest {
  id: string;
  agentId: string;
  sessionId: string | null;
  action: McpControlAction;
  payload: unknown;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  result: unknown;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

export interface McpTradingEvent {
  id: string;
  eventType: TradingEventType;
  intentId: string | null;
  channelId: string | null;
  accountId: string | null;
  exchange: string | null;
  mode: string | null;
  occurredAt: number;
  details: Record<string, unknown>;
  correlationId: string | null;
}

const PERMISSION_SET = new Set<string>(MCP_PERMISSIONS);
const EVENT_SET = new Set<string>(TRADING_EVENT_TYPES);
const CONTROL_ACTIONS = new Set<McpControlAction>([
  'contracts.create',
  'contracts.update',
  'contracts.publish',
  'contracts.archive',
  'contracts.delete_draft',
  'risk.update',
  'risk.delete',
  'trading.reconcile',
  'trading.cancel_entries',
  'trading.kill_switch',
  'trading.flatten',
]);
const TOKEN_PREFIX = 'tsx_mcp_';
const MAXIMUM_JSON_BYTES = 64 * 1024;

function identifier(value: unknown, label: string, maximum = 128): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum || /[\r\n\0]/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value.trim();
}

function boundedList<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): T[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const normalized = [...new Set(value.map(item => identifier(item, label, 80)))];
  if (normalized.length > allowed.size || normalized.some(item => !allowed.has(item))) {
    throw new Error(`${label} contains an unsupported value.`);
  }
  return normalized as T[];
}

function permissions(value: unknown): McpPermission[] {
  return boundedList<McpPermission>(value, PERMISSION_SET, 'MCP permissions');
}

function subscriptions(value: unknown): TradingEventType[] {
  return boundedList<TradingEventType>(value, EVENT_SET, 'MCP event subscriptions');
}

function json(value: unknown, label: string): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value ?? null);
  } catch {
    throw new Error(`${label} must be JSON-serializable.`);
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAXIMUM_JSON_BYTES) {
    throw new Error(`${label} exceeds 64 KiB.`);
  }
  return serialized;
}

function boundedError(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Error) return value.message.slice(0, 2_000);
  if (typeof value === 'string') return value.slice(0, 2_000);
  try {
    return (JSON.stringify(value) || 'Unknown error.').slice(0, 2_000);
  } catch {
    return 'Unknown error.';
  }
}

function parsed(value: unknown): any {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function tokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function generatedToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

function constantTimeDigestMatch(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function mappedAgent(row: any): McpAgent {
  return {
    id: String(row.id),
    name: String(row.name),
    tokenPrefix: String(row.tokenPrefix),
    permissions: permissions(parsed(row.permissionsJson)),
    eventSubscriptions: subscriptions(parsed(row.eventSubscriptionsJson)),
    enabled: Boolean(row.enabled),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    lastSeenAt: row.lastSeenAt === null ? null : Number(row.lastSeenAt),
  };
}

function mappedSession(row: any): McpAgentSession {
  return {
    id: String(row.id),
    agentId: String(row.agentId),
    clientName: String(row.clientName),
    clientVersion: String(row.clientVersion),
    connectedAt: Number(row.connectedAt),
    lastSeenAt: Number(row.lastSeenAt),
    disconnectedAt: row.disconnectedAt === null ? null : Number(row.disconnectedAt),
  };
}

function mappedControlRequest(row: any): McpControlRequest {
  return {
    id: String(row.id),
    agentId: String(row.agentId),
    sessionId: row.sessionId === null ? null : String(row.sessionId),
    action: String(row.action) as McpControlAction,
    payload: parsed(row.payloadJson),
    status: row.status,
    result: parsed(row.resultJson),
    error: row.error === null ? null : String(row.error),
    createdAt: Number(row.createdAt),
    startedAt: row.startedAt === null ? null : Number(row.startedAt),
    completedAt: row.completedAt === null ? null : Number(row.completedAt),
  };
}

export async function createMcpAgent(input: {
  name: unknown;
  permissions: unknown;
  eventSubscriptions?: unknown;
}): Promise<{ agent: McpAgent; token: string }> {
  const name = identifier(input.name, 'MCP agent name', 80);
  const grantedPermissions = permissions(input.permissions);
  const eventSubscriptions = subscriptions(input.eventSubscriptions ?? []);
  const token = generatedToken();
  const digest = tokenDigest(token);
  const now = Date.now();
  const id = randomUUID();
  await getDatabase().run(
    `INSERT INTO mcp_agents (
       id, name, token_sha256, token_prefix, permissions_json,
       event_subscriptions_json, enabled, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [
      id,
      name,
      digest,
      token.slice(0, 16),
      json(grantedPermissions, 'MCP permissions'),
      json(eventSubscriptions, 'MCP event subscriptions'),
      now,
      now,
    ],
  );
  return {
    agent: {
      id,
      name,
      tokenPrefix: token.slice(0, 16),
      permissions: grantedPermissions,
      eventSubscriptions,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: null,
    },
    token,
  };
}

export async function listMcpAgents(): Promise<McpAgent[]> {
  const rows = await getDatabase().all<any[]>(
    `SELECT id, name, token_prefix AS tokenPrefix, permissions_json AS permissionsJson,
            event_subscriptions_json AS eventSubscriptionsJson, enabled,
            created_at AS createdAt, updated_at AS updatedAt, last_seen_at AS lastSeenAt
     FROM mcp_agents
     WHERE deleted_at IS NULL
     ORDER BY name COLLATE NOCASE, created_at`,
  );
  return rows.map(mappedAgent);
}

export async function updateMcpAgent(input: {
  id: unknown;
  name: unknown;
  permissions: unknown;
  eventSubscriptions?: unknown;
  enabled: unknown;
}): Promise<McpAgent> {
  const id = identifier(input.id, 'MCP agent identifier', 64);
  const name = identifier(input.name, 'MCP agent name', 80);
  const grantedPermissions = permissions(input.permissions);
  const eventSubscriptions = subscriptions(input.eventSubscriptions ?? []);
  if (typeof input.enabled !== 'boolean') throw new Error('MCP agent enabled state must be boolean.');
  const now = Date.now();
  const result = await getDatabase().run(
    `UPDATE mcp_agents SET name = ?, permissions_json = ?, event_subscriptions_json = ?,
       enabled = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
    [
      name,
      json(grantedPermissions, 'MCP permissions'),
      json(eventSubscriptions, 'MCP event subscriptions'),
      input.enabled ? 1 : 0,
      now,
      id,
    ],
  );
  if (Number(result.changes || 0) !== 1) throw new Error('MCP agent does not exist.');
  if (!input.enabled) {
    await getDatabase().run(
      `UPDATE mcp_agent_sessions SET disconnected_at = COALESCE(disconnected_at, ?)
       WHERE agent_id = ? AND disconnected_at IS NULL`,
      [now, id],
    );
  }
  const agents = await listMcpAgents();
  return agents.find(agent => agent.id === id)!;
}

export async function rotateMcpAgentToken(idValue: unknown): Promise<{ agent: McpAgent; token: string }> {
  const id = identifier(idValue, 'MCP agent identifier', 64);
  const token = generatedToken();
  const now = Date.now();
  const result = await getDatabase().run(
    `UPDATE mcp_agents SET token_sha256 = ?, token_prefix = ?, updated_at = ?
     WHERE id = ? AND deleted_at IS NULL`,
    [tokenDigest(token), token.slice(0, 16), now, id],
  );
  if (Number(result.changes || 0) !== 1) throw new Error('MCP agent does not exist.');
  await getDatabase().run(
    `UPDATE mcp_agent_sessions SET disconnected_at = COALESCE(disconnected_at, ?)
     WHERE agent_id = ? AND disconnected_at IS NULL`,
    [now, id],
  );
  const agents = await listMcpAgents();
  return { agent: agents.find(agent => agent.id === id)!, token };
}

export async function deleteMcpAgent(idValue: unknown): Promise<boolean> {
  const id = identifier(idValue, 'MCP agent identifier', 64);
  const now = Date.now();
  const revokedToken = generatedToken();
  return withDatabaseTransaction(async database => {
    const result = await database.run(
      `UPDATE mcp_agents
       SET name = ?, token_sha256 = ?, token_prefix = ?,
           permissions_json = '[]', event_subscriptions_json = '[]',
           enabled = 0, updated_at = ?, last_seen_at = NULL, deleted_at = ?
       WHERE id = ? AND deleted_at IS NULL`,
      [
        `Gelöschter MCP-Agent ${id.slice(0, 8)}`,
        tokenDigest(revokedToken),
        `deleted_${id.slice(0, 8)}`,
        now,
        now,
        id,
      ],
    );
    if (Number(result.changes || 0) !== 1) throw new Error('MCP agent does not exist.');
    await database.run(
      `UPDATE mcp_agent_sessions
       SET disconnected_at = COALESCE(disconnected_at, ?)
       WHERE agent_id = ? AND disconnected_at IS NULL`,
      [now, id],
    );
    await database.run(
      `UPDATE mcp_control_requests
       SET status = 'failed', error = 'MCP agent was deleted by an administrator.', completed_at = ?
       WHERE agent_id = ? AND status IN ('pending', 'running')`,
      [now, id],
    );
    return true;
  });
}

export async function authenticateMcpToken(value: unknown): Promise<AuthenticatedMcpAgent | null> {
  if (typeof value !== 'string' || !value.startsWith(TOKEN_PREFIX) || value.length > 128) return null;
  const digest = tokenDigest(value);
  const row = await getDatabase().get<any>(
    `SELECT id, name, token_sha256 AS tokenSha256, token_prefix AS tokenPrefix,
            permissions_json AS permissionsJson, event_subscriptions_json AS eventSubscriptionsJson,
            enabled, created_at AS createdAt, updated_at AS updatedAt, last_seen_at AS lastSeenAt
     FROM mcp_agents WHERE token_sha256 = ? AND deleted_at IS NULL`,
    [digest],
  );
  if (!row?.enabled || !constantTimeDigestMatch(digest, String(row.tokenSha256))) return null;
  return { ...mappedAgent(row), tokenSha256: String(row.tokenSha256) };
}

export function agentHasPermission(agent: McpAgent, permission: McpPermission): boolean {
  return agent.enabled && agent.permissions.includes(permission);
}

export async function connectMcpSession(input: {
  id: unknown;
  agentId: unknown;
  clientName?: unknown;
  clientVersion?: unknown;
}): Promise<McpAgentSession> {
  const id = identifier(input.id, 'MCP session identifier', 128);
  const agentId = identifier(input.agentId, 'MCP agent identifier', 64);
  const clientName = input.clientName
    ? identifier(input.clientName, 'MCP client name', 100)
    : 'unknown-client';
  const clientVersion = input.clientVersion
    ? identifier(input.clientVersion, 'MCP client version', 80)
    : 'unknown';
  const now = Date.now();
  await getDatabase().run(
    `INSERT INTO mcp_agent_sessions (
       id, agent_id, client_name, client_version, connected_at, last_seen_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, agentId, clientName, clientVersion, now, now],
  );
  await getDatabase().run(`UPDATE mcp_agents SET last_seen_at = ? WHERE id = ?`, [now, agentId]);
  return { id, agentId, clientName, clientVersion, connectedAt: now, lastSeenAt: now, disconnectedAt: null };
}

export async function touchMcpSession(idValue: unknown, agentIdValue: unknown): Promise<boolean> {
  const id = identifier(idValue, 'MCP session identifier', 128);
  const agentId = identifier(agentIdValue, 'MCP agent identifier', 64);
  const now = Date.now();
  const result = await getDatabase().run(
    `UPDATE mcp_agent_sessions SET last_seen_at = ?
     WHERE id = ? AND agent_id = ? AND disconnected_at IS NULL`,
    [now, id, agentId],
  );
  if (Number(result.changes || 0) === 1) {
    await getDatabase().run(`UPDATE mcp_agents SET last_seen_at = ? WHERE id = ?`, [now, agentId]);
    return true;
  }
  return false;
}

export async function disconnectMcpSession(idValue: unknown, agentIdValue?: unknown): Promise<void> {
  const id = identifier(idValue, 'MCP session identifier', 128);
  const now = Date.now();
  if (agentIdValue === undefined) {
    await getDatabase().run(
      `UPDATE mcp_agent_sessions SET disconnected_at = COALESCE(disconnected_at, ?)
       WHERE id = ?`,
      [now, id],
    );
    return;
  }
  const agentId = identifier(agentIdValue, 'MCP agent identifier', 64);
  await getDatabase().run(
    `UPDATE mcp_agent_sessions SET disconnected_at = COALESCE(disconnected_at, ?)
     WHERE id = ? AND agent_id = ?`,
    [now, id, agentId],
  );
}

export async function listMcpSessions(limit = 200): Promise<McpAgentSession[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error('MCP session limit is invalid.');
  const rows = await getDatabase().all<any[]>(
    `SELECT id, agent_id AS agentId, client_name AS clientName, client_version AS clientVersion,
            connected_at AS connectedAt, last_seen_at AS lastSeenAt, disconnected_at AS disconnectedAt
     FROM mcp_agent_sessions ORDER BY connected_at DESC LIMIT ?`,
    [limit],
  );
  return rows.map(mappedSession);
}

export async function recordMcpAgentAction(input: {
  agentId: unknown;
  sessionId?: unknown;
  toolName: unknown;
  permission: unknown;
  outcome: 'succeeded' | 'rejected' | 'failed';
  request: unknown;
  result?: unknown;
  error?: unknown;
  startedAt: number;
}): Promise<void> {
  const completedAt = Date.now();
  const error = boundedError(input.error);
  await getDatabase().run(
    `INSERT INTO mcp_agent_actions (
       id, agent_id, session_id, tool_name, permission, outcome,
       request_json, result_json, error, started_at, completed_at, duration_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      identifier(input.agentId, 'MCP agent identifier', 64),
      input.sessionId ? identifier(input.sessionId, 'MCP session identifier', 128) : null,
      identifier(input.toolName, 'MCP tool name', 128),
      identifier(input.permission, 'MCP permission', 80),
      input.outcome,
      json(input.request, 'MCP tool request'),
      input.result === undefined ? null : json(input.result, 'MCP tool result'),
      error,
      input.startedAt,
      completedAt,
      Math.max(0, completedAt - input.startedAt),
    ],
  );
}

export async function listMcpAgentActions(limit = 200): Promise<McpAgentAction[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error('MCP action limit is invalid.');
  const rows = await getDatabase().all<any[]>(
    `SELECT a.id, a.agent_id AS agentId, g.name AS agentName, a.session_id AS sessionId,
            a.tool_name AS toolName, a.permission, a.outcome, a.request_json AS requestJson,
            a.result_json AS resultJson, a.error, a.started_at AS startedAt,
            a.completed_at AS completedAt, a.duration_ms AS durationMs
     FROM mcp_agent_actions a JOIN mcp_agents g ON g.id = a.agent_id
     ORDER BY a.completed_at DESC LIMIT ?`,
    [limit],
  );
  return rows.map(row => ({
    id: String(row.id),
    agentId: String(row.agentId),
    agentName: String(row.agentName),
    sessionId: row.sessionId === null ? null : String(row.sessionId),
    toolName: String(row.toolName),
    permission: String(row.permission),
    outcome: row.outcome,
    request: parsed(row.requestJson),
    result: parsed(row.resultJson),
    error: row.error === null ? null : String(row.error),
    startedAt: Number(row.startedAt),
    completedAt: Number(row.completedAt),
    durationMs: Number(row.durationMs),
  }));
}

export async function enqueueMcpControlRequest(input: {
  agentId: unknown;
  sessionId?: unknown;
  action: McpControlAction;
  payload?: unknown;
}): Promise<McpControlRequest> {
  if (!CONTROL_ACTIONS.has(input.action)) throw new Error('MCP control action is invalid.');
  const id = randomUUID();
  const createdAt = Date.now();
  const agentId = identifier(input.agentId, 'MCP agent identifier', 64);
  const sessionId = input.sessionId
    ? identifier(input.sessionId, 'MCP session identifier', 128)
    : null;
  await getDatabase().run(
    `INSERT INTO mcp_control_requests (
       id, agent_id, session_id, action, payload_json, status, created_at
     ) VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    [
      id,
      agentId,
      sessionId,
      input.action,
      json(input.payload ?? {}, 'MCP control payload'),
      createdAt,
    ],
  );
  return {
    id,
    agentId,
    sessionId,
    action: input.action,
    payload: input.payload ?? {},
    status: 'pending',
    result: null,
    error: null,
    createdAt,
    startedAt: null,
    completedAt: null,
  };
}

export async function getMcpControlRequest(idValue: unknown): Promise<McpControlRequest | null> {
  const id = identifier(idValue, 'MCP control request identifier', 64);
  const row = await getDatabase().get<any>(
    `SELECT id, agent_id AS agentId, session_id AS sessionId, action,
            payload_json AS payloadJson, status, result_json AS resultJson,
            error, created_at AS createdAt, started_at AS startedAt, completed_at AS completedAt
     FROM mcp_control_requests WHERE id = ?`,
    [id],
  );
  return row ? mappedControlRequest(row) : null;
}

export async function waitForMcpControlRequest(
  id: unknown,
  timeoutMs = 30_000,
): Promise<McpControlRequest> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw new Error('MCP control request timeout is invalid.');
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const request = await getMcpControlRequest(id);
    if (!request) throw new Error('MCP control request disappeared.');
    if (request.status === 'succeeded' || request.status === 'failed') return request;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('TSX Core did not complete the MCP control request before the timeout.');
}

export async function claimNextMcpControlRequest(): Promise<McpControlRequest | null> {
  return withDatabaseTransaction(async database => {
    const row = await database.get<any>(
      `SELECT id, agent_id AS agentId, session_id AS sessionId, action,
              payload_json AS payloadJson, status, result_json AS resultJson,
              error, created_at AS createdAt, started_at AS startedAt, completed_at AS completedAt
       FROM mcp_control_requests WHERE status = 'pending'
       ORDER BY created_at, id LIMIT 1`,
    );
    if (!row) return null;
    const startedAt = Date.now();
    const update = await database.run(
      `UPDATE mcp_control_requests SET status = 'running', started_at = ?
       WHERE id = ? AND status = 'pending'`,
      [startedAt, row.id],
    );
    if (Number(update.changes || 0) !== 1) return null;
    return mappedControlRequest({ ...row, status: 'running', startedAt });
  });
}

export async function completeMcpControlRequest(
  idValue: unknown,
  outcome: { result: unknown } | { error: unknown },
): Promise<void> {
  const id = identifier(idValue, 'MCP control request identifier', 64);
  const completedAt = Date.now();
  const succeeded = 'result' in outcome;
  const result = await getDatabase().run(
    `UPDATE mcp_control_requests
     SET status = ?, result_json = ?, error = ?, completed_at = ?
     WHERE id = ? AND status = 'running'`,
    [
      succeeded ? 'succeeded' : 'failed',
      succeeded ? json(outcome.result, 'MCP control result') : null,
      succeeded ? null : boundedError(outcome.error),
      completedAt,
      id,
    ],
  );
  if (Number(result.changes || 0) !== 1) throw new Error('MCP control request is not running.');
}

export async function recoverInterruptedMcpControlRequests(): Promise<number> {
  const now = Date.now();
  const result = await getDatabase().run(
    `UPDATE mcp_control_requests
     SET status = 'failed', error = 'TSX Core restarted while the request was running.', completed_at = ?
     WHERE status = 'running'`,
    [now],
  );
  return Number(result.changes || 0);
}

export async function listPendingMcpEvents(
  agent: McpAgent,
  session: McpAgentSession,
  limit = 100,
): Promise<McpTradingEvent[]> {
  if (agent.eventSubscriptions.length < 1) return [];
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('MCP event limit is invalid.');
  const placeholders = agent.eventSubscriptions.map(() => '?').join(', ');
  const rows = await getDatabase().all<any[]>(
    `SELECT e.id, e.intent_id AS intentId, e.channel_id AS channelId,
            e.account_id AS accountId, e.exchange, e.mode, e.event_type AS eventType,
            e.occurred_at AS occurredAt, e.details_json AS detailsJson,
            e.correlation_id AS correlationId
     FROM trading_execution_events e
     WHERE e.occurred_at >= ?
       AND e.event_type IN (${placeholders})
       AND NOT EXISTS (
         SELECT 1 FROM mcp_event_deliveries d
         WHERE d.source_event_id = e.id AND d.agent_id = ? AND d.session_id = ?
           AND d.status = 'delivered'
       )
     ORDER BY e.occurred_at, e.id LIMIT ?`,
    [session.connectedAt, ...agent.eventSubscriptions, agent.id, session.id, limit],
  );
  return rows.map(row => ({
    id: String(row.id),
    eventType: String(row.eventType) as TradingEventType,
    intentId: row.intentId === null ? null : String(row.intentId),
    channelId: row.channelId === null ? null : String(row.channelId),
    accountId: row.accountId === null ? null : String(row.accountId),
    exchange: row.exchange === null ? null : String(row.exchange),
    mode: row.mode === null ? null : String(row.mode),
    occurredAt: Number(row.occurredAt),
    details: parsed(row.detailsJson) ?? {},
    correlationId: row.correlationId === null ? null : String(row.correlationId),
  }));
}

export async function recordMcpEventDelivery(input: {
  eventId: unknown;
  agentId: unknown;
  sessionId: unknown;
  eventType: TradingEventType;
  status: 'delivered' | 'failed';
  error?: unknown;
}): Promise<void> {
  await getDatabase().run(
    `INSERT INTO mcp_event_deliveries (
       id, source_event_id, agent_id, session_id, event_type, status, delivered_at, error
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_event_id, agent_id, session_id) DO UPDATE SET
       status = excluded.status,
       delivered_at = excluded.delivered_at,
       error = excluded.error`,
    [
      randomUUID(),
      identifier(input.eventId, 'Trading event identifier', 64),
      identifier(input.agentId, 'MCP agent identifier', 64),
      identifier(input.sessionId, 'MCP session identifier', 128),
      input.eventType,
      input.status,
      Date.now(),
      boundedError(input.error),
    ],
  );
}

export async function mcpDashboardSnapshot(): Promise<{
  agents: McpAgent[];
  sessions: McpAgentSession[];
  actions: Array<Omit<McpAgentAction, 'request' | 'result'>>;
  permissions: readonly McpPermission[];
  eventTypes: readonly TradingEventType[];
}> {
  const [agents, sessions, actions] = await Promise.all([
    listMcpAgents(),
    listMcpSessions(),
    listMcpAgentActions(),
  ]);
  const visibleAgentIds = new Set(agents.map(agent => agent.id));
  return {
    agents,
    sessions: sessions.filter(session => visibleAgentIds.has(session.agentId)),
    actions: actions.map(({ request: _request, result: _result, ...action }) => action),
    permissions: MCP_PERMISSIONS,
    eventTypes: TRADING_EVENT_TYPES,
  };
}
