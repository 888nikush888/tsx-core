import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { getDatabase, withDatabaseTransaction } from './db.js';
import { TRADING_EVENT_TYPES, type TradingEventType } from './trading_telemetry.js';

export const MCP_PERMISSIONS = [
  'system.read',
  'contracts.read',
  'positions.read',
  'signals.read',
  'risk.read',
  'strategies.read',
  'routes.read',
  'analytics.read',
  'journal.read',
  'contracts.write',
  'risk.write',
  'strategies.write',
  'routes.write',
  'trading.reconcile',
  'trading.cancel_entries',
  'trading.kill_switch',
  'trading.flatten',
] as const;

export const MCP_RUNTIME_MODES = ['active', 'standby', 'disabled'] as const;

export type McpPermission = typeof MCP_PERMISSIONS[number];
export type McpRuntimeMode = typeof MCP_RUNTIME_MODES[number];
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

export type McpProposalAction =
  | 'contracts.create_version'
  | 'contracts.duplicate'
  | 'contracts.publish'
  | 'contracts.archive'
  | 'contracts.delete_draft'
  | 'contracts.delete_version'
  | 'schemas.create'
  | 'schemas.update'
  | 'schemas.delete'
  | 'strategies.create'
  | 'strategies.update'
  | 'strategies.publish'
  | 'strategies.archive'
  | 'strategies.delete'
  | 'routes.set'
  | 'routes.delete'
  | 'risk.update'
  | 'risk.delete'
  | 'trading.release_kill_switch';

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

export interface McpPreflight {
  action: McpProposalAction;
  requiresApproval: boolean;
  allowed: boolean;
  blockers: string[];
  impact: string[];
  checkedAt: number;
}

export interface McpAgentProposal {
  id: string;
  agentId: string;
  agentName: string;
  sessionId: string | null;
  action: McpProposalAction;
  payload: unknown;
  preflight: McpPreflight;
  status: 'pending' | 'approved' | 'rejected' | 'executing' | 'completed' | 'failed' | 'expired';
  requestedAt: number;
  expiresAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  executedAt: number | null;
  result: unknown;
  error: string | null;
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

export interface McpRuntimeState {
  mode: McpRuntimeMode;
  updatedAt: number;
  updatedBy: string;
}

export interface McpRuntimeTransition {
  previousMode: McpRuntimeMode;
  state: McpRuntimeState;
  disconnectedSessions: number;
  cancelledControlRequests: number;
  cancelledProposals: number;
}

const PERMISSION_SET = new Set<string>(MCP_PERMISSIONS);
const RUNTIME_MODE_SET = new Set<string>(MCP_RUNTIME_MODES);
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
const PROPOSAL_ACTIONS = new Set<McpProposalAction>([
  'contracts.create_version',
  'contracts.duplicate',
  'contracts.publish',
  'contracts.archive',
  'contracts.delete_draft',
  'contracts.delete_version',
  'schemas.create',
  'schemas.update',
  'schemas.delete',
  'strategies.create',
  'strategies.update',
  'strategies.publish',
  'strategies.archive',
  'strategies.delete',
  'routes.set',
  'routes.delete',
  'risk.update',
  'risk.delete',
  'trading.release_kill_switch',
]);
const APPROVAL_REQUIRED_ACTIONS = new Set<McpProposalAction>([
  'contracts.publish',
  'contracts.archive',
  'contracts.delete_draft',
  'contracts.delete_version',
  'schemas.update',
  'schemas.delete',
  'strategies.publish',
  'strategies.archive',
  'strategies.delete',
  'routes.set',
  'routes.delete',
  'risk.update',
  'risk.delete',
  'trading.release_kill_switch',
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

function runtimeMode(value: unknown): McpRuntimeMode {
  if (typeof value !== 'string' || !RUNTIME_MODE_SET.has(value)) {
    throw new Error('MCP runtime mode must be active, standby, or disabled.');
  }
  return value as McpRuntimeMode;
}

async function runtimeStateFrom(database: any): Promise<McpRuntimeState> {
  const row = await database.get(
    `SELECT mode, updated_at AS updatedAt, updated_by AS updatedBy
     FROM mcp_runtime_state WHERE singleton_id = 1`,
  );
  if (!row) throw new Error('MCP runtime state is unavailable.');
  return {
    mode: runtimeMode(row.mode),
    updatedAt: Number(row.updatedAt),
    updatedBy: String(row.updatedBy),
  };
}

async function assertRuntimeActiveFrom(database: any): Promise<void> {
  if ((await runtimeStateFrom(database)).mode !== 'active') {
    throw new Error('MCP runtime is not active. Enable it in the dashboard before using agents or actions.');
  }
}

export async function getMcpRuntimeState(): Promise<McpRuntimeState> {
  return runtimeStateFrom(getDatabase());
}

export async function assertMcpRuntimeActive(): Promise<void> {
  await assertRuntimeActiveFrom(getDatabase());
}

export async function setMcpRuntimeMode(
  modeValue: unknown,
  actorValue: unknown,
): Promise<McpRuntimeTransition> {
  const mode = runtimeMode(modeValue);
  const actor = identifier(actorValue, 'MCP runtime actor', 128);
  return withDatabaseTransaction(async database => {
    const previous = await runtimeStateFrom(database);
    if (previous.mode === mode) {
      return {
        previousMode: previous.mode,
        state: previous,
        disconnectedSessions: 0,
        cancelledControlRequests: 0,
        cancelledProposals: 0,
      };
    }
    const now = Date.now();
    await database.run(
      `UPDATE mcp_runtime_state SET mode = ?, updated_at = ?, updated_by = ?
       WHERE singleton_id = 1`,
      [mode, now, actor],
    );
    let disconnectedSessions = 0;
    let cancelledControlRequests = 0;
    let cancelledProposals = 0;
    if (mode !== 'active') {
      const disconnected = await database.run(
        `UPDATE mcp_agent_sessions SET disconnected_at = COALESCE(disconnected_at, ?)
         WHERE disconnected_at IS NULL`,
        [now],
      );
      disconnectedSessions = Number(disconnected.changes || 0);
    }
    if (mode === 'disabled') {
      const requests = await database.run(
        `UPDATE mcp_control_requests
         SET status = 'failed', error = 'MCP runtime was disabled by an administrator.', completed_at = ?
         WHERE status = 'pending'`,
        [now],
      );
      cancelledControlRequests = Number(requests.changes || 0);
      const proposals = await database.run(
        `UPDATE mcp_agent_proposals
         SET status = 'failed', error = 'MCP runtime was disabled by an administrator.', executed_at = ?
         WHERE status = 'approved'`,
        [now],
      );
      cancelledProposals = Number(proposals.changes || 0);
    }
    return {
      previousMode: previous.mode,
      state: { mode, updatedAt: now, updatedBy: actor },
      disconnectedSessions,
      cancelledControlRequests,
      cancelledProposals,
    };
  });
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

function mappedProposal(row: any): McpAgentProposal {
  return {
    id: String(row.id),
    agentId: String(row.agentId),
    agentName: String(row.agentName || row.agentId),
    sessionId: row.sessionId === null ? null : String(row.sessionId),
    action: String(row.action) as McpProposalAction,
    payload: parsed(row.payloadJson),
    preflight: parsed(row.preflightJson) as McpPreflight,
    status: row.status,
    requestedAt: Number(row.requestedAt),
    expiresAt: Number(row.expiresAt),
    decidedAt: row.decidedAt === null ? null : Number(row.decidedAt),
    decidedBy: row.decidedBy === null ? null : String(row.decidedBy),
    executedAt: row.executedAt === null ? null : Number(row.executedAt),
    result: parsed(row.resultJson),
    error: row.error === null ? null : String(row.error),
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
    await database.run(
      `UPDATE mcp_agent_proposals
       SET status = CASE WHEN status = 'executing' THEN 'failed' ELSE 'rejected' END,
           error = 'MCP agent was deleted by an administrator.',
           decided_at = COALESCE(decided_at, ?),
           decided_by = COALESCE(decided_by, 'system:agent-deletion'),
           executed_at = CASE WHEN status = 'executing' THEN ? ELSE executed_at END
       WHERE agent_id = ? AND status IN ('pending', 'approved', 'executing')`,
      [now, now, id],
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
  await withDatabaseTransaction(async database => {
    await assertRuntimeActiveFrom(database);
    await database.run(
      `INSERT INTO mcp_agent_sessions (
         id, agent_id, client_name, client_version, connected_at, last_seen_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, agentId, clientName, clientVersion, now, now],
    );
    await database.run(`UPDATE mcp_agents SET last_seen_at = ? WHERE id = ?`, [now, agentId]);
  });
  return { id, agentId, clientName, clientVersion, connectedAt: now, lastSeenAt: now, disconnectedAt: null };
}

export async function touchMcpSession(idValue: unknown, agentIdValue: unknown): Promise<boolean> {
  const id = identifier(idValue, 'MCP session identifier', 128);
  const agentId = identifier(agentIdValue, 'MCP agent identifier', 64);
  const now = Date.now();
  const result = await getDatabase().run(
    `UPDATE mcp_agent_sessions SET last_seen_at = ?
     WHERE id = ? AND agent_id = ? AND disconnected_at IS NULL
       AND EXISTS (SELECT 1 FROM mcp_runtime_state WHERE singleton_id = 1 AND mode = 'active')`,
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
  await withDatabaseTransaction(async database => {
    await assertRuntimeActiveFrom(database);
    await database.run(
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
  });
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
         AND EXISTS (SELECT 1 FROM mcp_runtime_state WHERE singleton_id = 1 AND mode = 'active')
       ORDER BY created_at, id LIMIT 1`,
    );
    if (!row) return null;
    const startedAt = Date.now();
    const update = await database.run(
      `UPDATE mcp_control_requests SET status = 'running', started_at = ?
       WHERE id = ? AND status = 'pending'
         AND EXISTS (SELECT 1 FROM mcp_runtime_state WHERE singleton_id = 1 AND mode = 'active')`,
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

function proposalAction(value: unknown): McpProposalAction {
  if (typeof value !== 'string' || !PROPOSAL_ACTIONS.has(value as McpProposalAction)) {
    throw new Error('MCP proposal action is invalid.');
  }
  return value as McpProposalAction;
}

function proposalPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('MCP proposal payload must be an object.');
  }
  return value as Record<string, unknown>;
}

async function signalSchemaActiveRouteCount(schemaId: string): Promise<number> {
  const rows = await getDatabase().all<Array<{ configuration_json: string }>>(
    `SELECT strategy.configuration_json
     FROM trading_routes AS route
     JOIN trading_strategy_versions AS strategy ON strategy.id = route.strategy_version_id
     WHERE route.enabled = 1`,
  );
  return rows.filter(row => {
    const configuration = parsed(row.configuration_json) as { allowedSignalSchemas?: unknown };
    return Array.isArray(configuration?.allowedSignalSchemas)
      && configuration.allowedSignalSchemas.includes(schemaId);
  }).length;
}

async function preflightContractDuplicate(
  payload: Record<string, unknown>,
  blockers: string[],
  impact: string[],
): Promise<void> {
  const sourceVersionId = identifier(payload.sourceVersionId, 'Source contract version', 64);
  const targetId = identifier(payload.id, 'Signal contract identifier', 40);
  const [source, target] = await Promise.all([
    getDatabase().get('SELECT id FROM trading_signal_contract_versions WHERE id = ?', [sourceVersionId]),
    getDatabase().get('SELECT id FROM trading_signal_contracts WHERE id = ?', [targetId]),
  ]);
  if (!source) blockers.push('Source contract version does not exist.');
  if (target) blockers.push('Target contract identifier already exists.');
  impact.push('Creates a new independent contract with an editable v1 draft.');
}

const CONTRACT_IMPACT: Partial<Record<McpProposalAction, string>> = {
  'contracts.create_version': 'Creates a new immutable-version candidate copied from the selected version.',
  'contracts.publish': 'Makes the validated contract version selectable by signal schema profiles.',
  'contracts.archive': 'Removes the published version from future active use.',
  'contracts.delete_draft': 'Permanently removes the selected draft contract version.',
  'contracts.delete_version': 'Permanently removes the selected contract version when no references remain.',
};

function contractStatusBlocker(action: McpProposalAction, status: string): string | null {
  const requiredStatuses: Partial<Record<McpProposalAction, string>> = {
    'contracts.publish': 'draft',
    'contracts.archive': 'published',
    'contracts.delete_draft': 'draft',
  };
  const required = requiredStatuses[action];
  if (required && status !== required) return `Contract action requires a ${required} version.`;
  if (action === 'contracts.delete_version' && status === 'draft') {
    return 'Draft versions require the draft deletion action.';
  }
  return null;
}

async function contractReferenceCount(action: McpProposalAction, versionId: string): Promise<number> {
  const enabledOnly = action === 'contracts.archive' ? ' AND enabled = 1' : '';
  const references = await getDatabase().get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM trading_signal_schemas
     WHERE contract_version_id = ?${enabledOnly}`,
    [versionId],
  );
  return Number(references?.count || 0);
}

async function preflightContractVersion(
  action: McpProposalAction,
  payload: Record<string, unknown>,
  blockers: string[],
  impact: string[],
): Promise<void> {
  const versionId = identifier(
    payload.versionId ?? payload.sourceVersionId,
    'Signal contract version identifier',
    64,
  );
  const version = await getDatabase().get<{ status: string; contract_id: string }>(
    'SELECT status, contract_id FROM trading_signal_contract_versions WHERE id = ?',
    [versionId],
  );
  if (!version) {
    blockers.push('Signal contract version does not exist.');
    return;
  }
  if (action === 'contracts.create_version') {
    const draft = await getDatabase().get(
      `SELECT id FROM trading_signal_contract_versions
       WHERE contract_id = ? AND status = 'draft'`,
      [version.contract_id],
    );
    if (draft) blockers.push('Contract already has an editable draft.');
    impact.push(CONTRACT_IMPACT[action]!);
    return;
  }
  const statusBlocker = contractStatusBlocker(action, version.status);
  if (statusBlocker) blockers.push(statusBlocker);
  const references = await contractReferenceCount(action, versionId);
  if (references > 0 && ['contracts.archive', 'contracts.delete_version'].includes(action)) {
    blockers.push('Signal schema profiles still reference this contract version.');
  }
  impact.push(CONTRACT_IMPACT[action] || 'Changes the selected contract version.');
}

async function preflightContractAction(
  action: McpProposalAction,
  payload: Record<string, unknown>,
  blockers: string[],
  impact: string[],
): Promise<void> {
  if (action === 'contracts.duplicate') {
    await preflightContractDuplicate(payload, blockers, impact);
    return;
  }
  await preflightContractVersion(action, payload, blockers, impact);
}

async function preflightSchemaAction(
  action: McpProposalAction,
  payload: Record<string, unknown>,
  blockers: string[],
  impact: string[],
): Promise<void> {
  const id = identifier(payload.id, 'Signal schema identifier', 40);
  const existing = await getDatabase().get('SELECT id FROM trading_signal_schemas WHERE id = ?', [id]);
  if (action === 'schemas.create' && existing) blockers.push('Signal schema identifier already exists.');
  if (action !== 'schemas.create' && !existing) blockers.push('Signal schema profile does not exist.');
  if (action !== 'schemas.create' && await signalSchemaActiveRouteCount(id) > 0) {
    blockers.push('An enabled route still uses a strategy that allows this schema profile.');
  }
  const message = action === 'schemas.delete'
    ? 'Permanently removes the parser/profile-to-contract binding.'
    : 'Changes which parser profile and contract validate future Telegram signals.';
  impact.push(message);
}

const STRATEGY_IMPACT: Partial<Record<McpProposalAction, string>> = {
  'strategies.create': 'Creates a new editable strategy version without routing it.',
  'strategies.update': 'Changes only an unpublished strategy draft.',
  'strategies.publish': 'Makes an immutable strategy version eligible for channel routing.',
  'strategies.archive': 'Removes the strategy version from future routing.',
  'strategies.delete': 'Permanently deletes the strategy version when no routes reference it.',
};

async function preflightStrategyAction(
  action: McpProposalAction,
  payload: Record<string, unknown>,
  blockers: string[],
  impact: string[],
): Promise<void> {
  if (action === 'strategies.create') {
    impact.push(STRATEGY_IMPACT[action]!);
    return;
  }
  const id = identifier(payload.id, 'Strategy version identifier', 64);
  const strategy = await getDatabase().get<{ status: string }>(
    'SELECT status FROM trading_strategy_versions WHERE id = ?',
    [id],
  );
  if (!strategy) blockers.push('Strategy version does not exist.');
  if (action === 'strategies.update' && strategy?.status !== 'draft') blockers.push('Only a strategy draft can be edited.');
  if (action === 'strategies.publish' && strategy?.status !== 'draft') blockers.push('Only a strategy draft can be published.');
  const routes = await getDatabase().get<{ count: number }>(
    'SELECT COUNT(*) AS count FROM trading_routes WHERE strategy_version_id = ?',
    [id],
  );
  if (Number(routes?.count || 0) > 0 && ['strategies.archive', 'strategies.delete'].includes(action)) {
    blockers.push('Channel routes still reference this strategy version.');
  }
  impact.push(STRATEGY_IMPACT[action] || 'Changes the selected strategy version.');
}

async function preflightRouteAction(
  action: McpProposalAction,
  payload: Record<string, unknown>,
  blockers: string[],
  impact: string[],
): Promise<void> {
  const channelId = identifier(payload.channelId, 'Channel identifier', 128);
  if (action === 'routes.delete') {
    const active = await getDatabase().get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM trading_trade_intents
       WHERE channel_id = ? AND status IN ('pending', 'planned', 'submitting', 'monitoring', 'unknown')`,
      [channelId],
    );
    if (Number(active?.count || 0) > 0) blockers.push('Route owns active or unresolved trades.');
    impact.push('Stops future automatic execution for the Telegram source channel.');
    return;
  }
  const strategyId = identifier(payload.strategyVersionId, 'Strategy version identifier', 64);
  const accountId = identifier(payload.accountId, 'Trading account identifier', 64);
  const [strategy, account] = await Promise.all([
    getDatabase().get<{ status: string }>('SELECT status FROM trading_strategy_versions WHERE id = ?', [strategyId]),
    getDatabase().get<{ status: string; enabled: number }>('SELECT status, enabled FROM trading_accounts WHERE id = ?', [accountId]),
  ]);
  if (strategy?.status !== 'published') blockers.push('Route requires a published strategy version.');
  if (!account) blockers.push('Trading account does not exist.');
  if (payload.enabled === true && (account?.status !== 'ready' || account.enabled !== 1)) {
    blockers.push('Enabled route requires an enabled and verified trading account.');
  }
  impact.push('Changes the strategy/account destination for future signals from this channel.');
}

async function preflightConfigurationAction(
  action: McpProposalAction,
  payload: Record<string, unknown>,
  blockers: string[],
  impact: string[],
): Promise<void> {
  if (action.startsWith('schemas.')) return preflightSchemaAction(action, payload, blockers, impact);
  if (action.startsWith('strategies.')) return preflightStrategyAction(action, payload, blockers, impact);
  return preflightRouteAction(action, payload, blockers, impact);
}

export async function preflightMcpAction(
  actionValue: unknown,
  payloadValue: unknown,
): Promise<McpPreflight> {
  const action = proposalAction(actionValue);
  const payload = proposalPayload(payloadValue);
  const blockers: string[] = [];
  const impact: string[] = [];
  try {
    if (action.startsWith('contracts.')) {
      await preflightContractAction(action, payload, blockers, impact);
    } else if (action.startsWith('schemas.') || action.startsWith('strategies.') || action.startsWith('routes.')) {
      await preflightConfigurationAction(action, payload, blockers, impact);
    } else if (action.startsWith('risk.')) {
      identifier(payload.channelId, 'Channel identifier', 128);
      impact.push(action === 'risk.update'
        ? 'Changes capital-at-risk policy for future trades from the selected channel.'
        : 'Removes the channel-specific risk override.');
    } else {
      const state = await getDatabase().get<{ kill_switch_active: number }>(
        'SELECT kill_switch_active FROM trading_runtime_state WHERE singleton_id = 1',
      );
      if (state?.kill_switch_active !== 1) blockers.push('Kill switch is not active.');
      impact.push('Requires successful exchange reconciliation before releasing the trading kill switch.');
    }
  } catch (error) {
    blockers.push(boundedError(error) || 'Proposal payload is invalid.');
  }
  return {
    action,
    requiresApproval: APPROVAL_REQUIRED_ACTIONS.has(action),
    allowed: blockers.length === 0,
    blockers,
    impact,
    checkedAt: Date.now(),
  };
}

export async function createMcpProposal(input: {
  agentId: unknown;
  sessionId?: unknown;
  action: unknown;
  payload?: unknown;
  autoApprove?: boolean;
}): Promise<McpAgentProposal> {
  const agentId = identifier(input.agentId, 'MCP agent identifier', 64);
  const sessionId = input.sessionId
    ? identifier(input.sessionId, 'MCP session identifier', 128)
    : null;
  const action = proposalAction(input.action);
  const payload = proposalPayload(input.payload ?? {});
  const preflight = await preflightMcpAction(action, payload);
  if (!preflight.allowed) throw new Error(`MCP preflight blocked the action: ${preflight.blockers.join(' ')}`);
  const autoApprove = input.autoApprove === true && !preflight.requiresApproval;
  const id = randomUUID();
  const now = Date.now();
  return withDatabaseTransaction(async database => {
    await assertRuntimeActiveFrom(database);
    await database.run(
      `INSERT INTO mcp_agent_proposals (
         id, agent_id, session_id, action, payload_json, preflight_json,
         status, requested_at, expires_at, decided_at, decided_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        agentId,
        sessionId,
        action,
        json(payload, 'MCP proposal payload'),
        json(preflight, 'MCP proposal preflight'),
        autoApprove ? 'approved' : 'pending',
        now,
        now + 24 * 60 * 60 * 1_000,
        autoApprove ? now : null,
        autoApprove ? `mcp:${agentId}` : null,
      ],
    );
    const row = await database.get<any>(
      `SELECT proposal.id, proposal.agent_id AS agentId, agent.name AS agentName,
              proposal.session_id AS sessionId, proposal.action,
              proposal.payload_json AS payloadJson, proposal.preflight_json AS preflightJson,
              proposal.status, proposal.requested_at AS requestedAt,
              proposal.expires_at AS expiresAt, proposal.decided_at AS decidedAt,
              proposal.decided_by AS decidedBy, proposal.executed_at AS executedAt,
              proposal.result_json AS resultJson, proposal.error
       FROM mcp_agent_proposals AS proposal
       JOIN mcp_agents AS agent ON agent.id = proposal.agent_id
       WHERE proposal.id = ?`,
      [id],
    );
    if (!row) throw new Error('MCP proposal was not persisted.');
    return mappedProposal(row);
  });
}

export async function expireMcpProposals(now = Date.now()): Promise<number> {
  const result = await getDatabase().run(
    `UPDATE mcp_agent_proposals
     SET status = 'expired', error = 'Approval window expired.'
     WHERE status IN ('pending', 'approved') AND expires_at <= ?`,
    [now],
  );
  return Number(result.changes || 0);
}

export async function getMcpProposal(idValue: unknown): Promise<McpAgentProposal | null> {
  const id = identifier(idValue, 'MCP proposal identifier', 64);
  const row = await getDatabase().get<any>(
    `SELECT proposal.id, proposal.agent_id AS agentId, agent.name AS agentName,
            proposal.session_id AS sessionId, proposal.action,
            proposal.payload_json AS payloadJson, proposal.preflight_json AS preflightJson,
            proposal.status, proposal.requested_at AS requestedAt,
            proposal.expires_at AS expiresAt, proposal.decided_at AS decidedAt,
            proposal.decided_by AS decidedBy, proposal.executed_at AS executedAt,
            proposal.result_json AS resultJson, proposal.error
     FROM mcp_agent_proposals AS proposal
     JOIN mcp_agents AS agent ON agent.id = proposal.agent_id
     WHERE proposal.id = ?`,
    [id],
  );
  return row ? mappedProposal(row) : null;
}

export async function listMcpProposals(limit = 200): Promise<McpAgentProposal[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error('MCP proposal limit is invalid.');
  await expireMcpProposals();
  const rows = await getDatabase().all<any[]>(
    `SELECT proposal.id, proposal.agent_id AS agentId, agent.name AS agentName,
            proposal.session_id AS sessionId, proposal.action,
            proposal.payload_json AS payloadJson, proposal.preflight_json AS preflightJson,
            proposal.status, proposal.requested_at AS requestedAt,
            proposal.expires_at AS expiresAt, proposal.decided_at AS decidedAt,
            proposal.decided_by AS decidedBy, proposal.executed_at AS executedAt,
            proposal.result_json AS resultJson, proposal.error
     FROM mcp_agent_proposals AS proposal
     JOIN mcp_agents AS agent ON agent.id = proposal.agent_id
     ORDER BY CASE proposal.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
              proposal.requested_at DESC LIMIT ?`,
    [limit],
  );
  return rows.map(mappedProposal);
}

export async function approveMcpProposal(idValue: unknown, actorValue: unknown): Promise<McpAgentProposal> {
  await assertMcpRuntimeActive();
  const id = identifier(idValue, 'MCP proposal identifier', 64);
  const actor = identifier(actorValue, 'Proposal decision actor', 128);
  const current = await getMcpProposal(id);
  if (current?.status !== 'pending' || current.expiresAt <= Date.now()) {
    throw new Error('Only a non-expired pending MCP proposal can be approved.');
  }
  const preflight = await preflightMcpAction(current.action, current.payload);
  if (!preflight.allowed) throw new Error(`MCP proposal is no longer safe: ${preflight.blockers.join(' ')}`);
  const now = Date.now();
  const result = await getDatabase().run(
    `UPDATE mcp_agent_proposals
     SET status = 'approved', preflight_json = ?, decided_at = ?, decided_by = ?
     WHERE id = ? AND status = 'pending' AND expires_at > ?
       AND EXISTS (SELECT 1 FROM mcp_runtime_state WHERE singleton_id = 1 AND mode = 'active')`,
    [json(preflight, 'MCP proposal preflight'), now, actor, id, now],
  );
  if (Number(result.changes || 0) !== 1) throw new Error('MCP proposal approval lost a concurrent decision race.');
  return (await getMcpProposal(id))!;
}

export async function rejectMcpProposal(
  idValue: unknown,
  actorValue: unknown,
  reasonValue?: unknown,
): Promise<McpAgentProposal> {
  const id = identifier(idValue, 'MCP proposal identifier', 64);
  const actor = identifier(actorValue, 'Proposal decision actor', 128);
  const reason = reasonValue === undefined
    ? 'Rejected by operator.'
    : identifier(reasonValue, 'Proposal rejection reason', 500);
  const now = Date.now();
  const result = await getDatabase().run(
    `UPDATE mcp_agent_proposals
     SET status = 'rejected', decided_at = ?, decided_by = ?, error = ?
     WHERE id = ? AND status = 'pending'`,
    [now, actor, reason, id],
  );
  if (Number(result.changes || 0) !== 1) throw new Error('Only a pending MCP proposal can be rejected.');
  return (await getMcpProposal(id))!;
}

export async function claimNextApprovedMcpProposal(): Promise<McpAgentProposal | null> {
  await expireMcpProposals();
  return withDatabaseTransaction(async database => {
    const row = await database.get<{ id: string }>(
      `SELECT id FROM mcp_agent_proposals
       WHERE status = 'approved'
         AND EXISTS (SELECT 1 FROM mcp_runtime_state WHERE singleton_id = 1 AND mode = 'active')
       ORDER BY decided_at, requested_at, id LIMIT 1`,
    );
    if (!row) return null;
    const result = await database.run(
      `UPDATE mcp_agent_proposals SET status = 'executing'
       WHERE id = ? AND status = 'approved'
         AND EXISTS (SELECT 1 FROM mcp_runtime_state WHERE singleton_id = 1 AND mode = 'active')`,
      [row.id],
    );
    if (Number(result.changes || 0) !== 1) return null;
    return getMcpProposal(row.id);
  });
}

export async function completeMcpProposal(
  idValue: unknown,
  outcome: { result: unknown } | { error: unknown },
): Promise<void> {
  const id = identifier(idValue, 'MCP proposal identifier', 64);
  const succeeded = 'result' in outcome;
  const result = await getDatabase().run(
    `UPDATE mcp_agent_proposals
     SET status = ?, result_json = ?, error = ?, executed_at = ?
     WHERE id = ? AND status = 'executing'`,
    [
      succeeded ? 'completed' : 'failed',
      succeeded ? json(outcome.result, 'MCP proposal result') : null,
      succeeded ? null : boundedError(outcome.error),
      Date.now(),
      id,
    ],
  );
  if (Number(result.changes || 0) !== 1) throw new Error('MCP proposal is not executing.');
}

export async function recoverInterruptedMcpProposals(): Promise<number> {
  const result = await getDatabase().run(
    `UPDATE mcp_agent_proposals
     SET status = 'failed', error = 'TSX Core restarted while the proposal was executing.',
         executed_at = ?
     WHERE status = 'executing'`,
    [Date.now()],
  );
  return Number(result.changes || 0);
}

export async function waitForMcpProposal(idValue: unknown, timeoutMs = 45_000): Promise<McpAgentProposal> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw new Error('MCP proposal timeout is invalid.');
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const proposal = await getMcpProposal(idValue);
    if (!proposal) throw new Error('MCP proposal disappeared.');
    if (['completed', 'failed', 'rejected', 'expired'].includes(proposal.status)) return proposal;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('TSX Core did not complete the MCP proposal before the timeout.');
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
  runtime: McpRuntimeState;
  agents: McpAgent[];
  sessions: McpAgentSession[];
  actions: Array<Omit<McpAgentAction, 'request' | 'result'>>;
  proposals: McpAgentProposal[];
  permissions: readonly McpPermission[];
  eventTypes: readonly TradingEventType[];
}> {
  const [runtime, agents, sessions, actions, proposals] = await Promise.all([
    getMcpRuntimeState(),
    listMcpAgents(),
    listMcpSessions(),
    listMcpAgentActions(),
    listMcpProposals(),
  ]);
  const visibleAgentIds = new Set(agents.map(agent => agent.id));
  return {
    runtime,
    agents,
    sessions: sessions.filter(session => visibleAgentIds.has(session.agentId)),
    actions: actions.map(({ request: _request, result: _result, ...action }) => action),
    proposals,
    permissions: MCP_PERMISSIONS,
    eventTypes: TRADING_EVENT_TYPES,
  };
}
