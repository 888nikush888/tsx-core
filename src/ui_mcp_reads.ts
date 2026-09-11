import { getDatabase } from './db.js';
import { getMcpRuntimeState, MCP_PERMISSIONS } from './mcp_repository.js';
import { TRADING_EVENT_TYPES } from './trading_telemetry.js';
import { decodeUiCursor, encodeUiCursor, filterFingerprint } from './ui_cursor.js';
import { uiObjectId } from './ui_trading_reads.js';

const AGENT_FIELDS = 'a.id,a.name,a.token_prefix AS tokenPrefix,a.permissions_json AS permissionsJson,a.event_subscriptions_json AS subscriptionsJson,a.enabled,a.created_at AS createdAt,a.updated_at AS updatedAt,a.last_seen_at AS lastSeenAt';
const LISTS = {
  agents: { from: 'mcp_agents a', id: 'a.id', time: 'a.created_at', fields: AGENT_FIELDS, where: 'a.deleted_at IS NULL' },
  proposals: { from: 'mcp_agent_proposals p JOIN mcp_agents a ON a.id=p.agent_id', id: 'p.id', time: 'p.requested_at', where: '1=1', fields: 'p.id,p.agent_id AS agentId,a.name AS agentName,p.action,p.status,p.requested_at AS requestedAt,p.expires_at AS expiresAt' },
  sessions: { from: 'mcp_agent_sessions s JOIN mcp_agents a ON a.id=s.agent_id', id: 's.id', time: 's.connected_at', where: 'a.deleted_at IS NULL', fields: 's.id,s.agent_id AS agentId,a.name AS agentName,s.client_name AS clientName,s.client_version AS clientVersion,s.connected_at AS connectedAt,s.last_seen_at AS lastSeenAt,s.disconnected_at AS disconnectedAt' },
  actions: { from: 'mcp_agent_actions x JOIN mcp_agents a ON a.id=x.agent_id', id: 'x.id', time: 'x.completed_at', where: '1=1', fields: 'x.id,x.agent_id AS agentId,a.name AS agentName,x.tool_name AS toolName,x.permission,x.outcome,x.started_at AS startedAt,x.completed_at AS completedAt,x.duration_ms AS durationMs' },
} as const;
type Kind = keyof typeof LISTS;
type AgentRow = Record<string, unknown> & { enabled: number | boolean; permissionsJson: string; subscriptionsJson: string };
function mappedAgent({ permissionsJson, subscriptionsJson, ...row }: AgentRow) {
  return { ...row, enabled: row.enabled === 1, permissions: JSON.parse(permissionsJson), eventSubscriptions: JSON.parse(subscriptionsJson) };
}
function pageStatusFilter(kind: Kind, query: URLSearchParams): string | null {
  const status = kind === 'proposals' ? query.get('proposalsStatus') || 'pending' : null;
  if (status && !['all', 'pending', 'approved', 'rejected', 'executing', 'completed', 'failed', 'expired'].includes(status)) throw new Error('Unsupported proposal status.');
  return status;
}
function pageStatusWhere(status: string | null, now: number): { clause: string; params: unknown[]; expression: string } {
  const expression = `CASE WHEN p.status='pending' AND p.expires_at<=${now} THEN 'expired' ELSE p.status END`;
  if (!status || status === 'all') return { clause: '', params: [], expression };
  return { clause: ` AND (${expression})=?`, params: [status], expression };
}

function pageTimeScope(definition: (typeof LISTS)[Kind], cursor: { createdAt: number; id: string } | null): { clause: string; params: unknown[] } {
  if (!cursor) return { clause: '', params: [] };
  return { clause: ` AND (${definition.time} < ? OR (${definition.time}=? AND ${definition.id}<?))`, params: [cursor.createdAt, cursor.createdAt, cursor.id] };
}

async function page(kind: Kind, query: URLSearchParams, now: number) {
  const definition = LISTS[kind]; const limit = 30; const status = pageStatusFilter(kind, query);
  const filter = filterFingerprint({ kind, limit, status, view: 'mcp-operator-v1' });
  const cursor = decodeUiCursor(query.get(`${kind}Cursor`), filter); const observedAt = cursor?.observedAt ?? now;
  const scope = pageStatusWhere(status, now);
  const values = scope.params.length > 0 ? [observedAt, ...scope.params] : [observedAt];
  const after = pageTimeScope(definition, cursor);
  const fields = kind === 'proposals' ? definition.fields.replace('p.status', `${scope.expression} AS status`) : definition.fields;
  const rows = await getDatabase().all(`SELECT ${fields},${definition.time} AS cursorTime FROM ${definition.from}
    WHERE ${definition.where} AND ${definition.time}<=?${scope.clause}${after.clause} ORDER BY ${definition.time} DESC,${definition.id} DESC LIMIT ?`,
  [...values, ...after.params, limit + 1]);
  const last = rows[Math.min(rows.length, limit) - 1]; const hasMore = rows.length > limit;
  return { entries: rows.slice(0, limit).map(({ cursorTime: _time, ...row }) => kind === 'agents' ? mappedAgent(row) : row), observedAt, hasMore,
    nextCursor: hasMore ? encodeUiCursor({ version: 1, filter, observedAt, createdAt: last.cursorTime, id: last.id }) : null };
}
export async function uiMcpSnapshot(query: URLSearchParams) {
  const agentId = query.get('agentId'); if (agentId) uiObjectId(agentId, 64);
  const now = Date.now(); const kinds = Object.keys(LISTS) as Kind[];
  const [runtime, pages, selected, count] = await Promise.all([
    getMcpRuntimeState(), Promise.all(kinds.map(kind => page(kind, query, now))),
    agentId ? getDatabase().get(`SELECT ${AGENT_FIELDS} FROM mcp_agents a WHERE a.id=? AND a.deleted_at IS NULL`, [agentId]) : null,
    getDatabase().get('SELECT COUNT(*) AS total FROM mcp_agent_sessions s JOIN mcp_agents a ON a.id=s.agent_id WHERE a.deleted_at IS NULL AND s.disconnected_at IS NULL'),
  ]);
  return { contractVersion: 1, observedAt: now, runtime, ...Object.fromEntries(kinds.map((kind, index) => [kind, pages[index].entries])),
    pages: Object.fromEntries(kinds.map((kind, index) => [kind, { ...pages[index], entries: undefined }])), selectedAgent: selected ? mappedAgent(selected) : null,
    activeSessionCount: count.total, permissions: MCP_PERMISSIONS, eventTypes: TRADING_EVENT_TYPES,
    interpretation: 'Listen lesen ausschließlich Metadaten, je 30 Einträge. Freigabeinhalt und aktueller Preflight werden im einzelnen Vorschlag geprüft. Cursor begrenzen Erstellzeiten; Ablauf und Sitzungsstatus bleiben aktuelle Beobachtungen.' };
}
