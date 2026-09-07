import { getDatabase } from './db.js';
import { decodeUiCursor, encodeUiCursor, filterFingerprint } from './ui_cursor.js';
import { DEFAULT_RUNTIME_SETTINGS } from './runtime_settings.js';
import { AI_LIMIT_LABELS, WORKFLOW_RESOURCE_KINDS } from './ui_contracts.js';
import { maskPII } from './logger.js';

const SOURCES = {
  accounts: { table: 'trading_accounts', clock: 'created_at', fields: 'id, name, exchange, mode, status', search: ['id', 'name', 'exchange'] },
  ingress: { table: 'incoming_work', clock: 'created_at', fields: 'id, chat_id AS channelId, message_id AS messageId, status', search: ['id', 'chat_id', 'CAST(message_id AS TEXT)'] },
  signals: { table: 'signals', clock: 'created_at', fields: 'id, chat_id AS channelId, message_id AS messageId, template_name AS templateName', search: ['id', 'chat_id', 'CAST(message_id AS TEXT)'] },
  intents: { table: 'trading_trade_intents', clock: 'created_at', fields: 'id, symbol, side, mode, status', search: ['id', 'symbol', 'channel_id'] },
  resources: { table: 'workflow_resource_versions', clock: 'created_at', fields: 'id, resource_id AS resourceId, name, kind, version, status', search: ['id', 'resource_id', 'name', 'kind'] },
  incidents: { table: 'trading_account_incidents', clock: 'first_seen_at', fields: 'id, account_id AS accountId, category, severity, status', search: ['id', 'account_id', 'category'] },
} as const;
const SETTING_TARGETS = [
  ...Object.keys(DEFAULT_RUNTIME_SETTINGS).map(key => ({ id: `runtime.${key}`, title: key, url: `/operations/settings?setting=${encodeURIComponent(`runtime.${key}`)}` })),
  ...Object.entries(AI_LIMIT_LABELS).map(([key, [label]]) => ({ id: `ai.${key}`, title: `${label} · ${key}`, url: `/operations/settings?setting=${encodeURIComponent(`ai.${key}`)}` })),
  ...WORKFLOW_RESOURCE_KINDS.map(kind => ({ id: `workflow.${kind}`, title: `Workflow-Baustein ${kind}`, url: `/workflows/resources?resourceKind=${kind}` })),
];

function searchUrl(kind: string, row: any): string {
  const id = encodeURIComponent(row.id);
  switch (kind) {
    case 'accounts': return `/trading/accounts/${id}`;
    case 'ingress': return `/signals/messages/${id}`;
    case 'signals': return `/signals/processed?objectId=${id}`;
    case 'intents': return `/trading/trades/${id}`;
    case 'resources': return `/workflows/resources/${encodeURIComponent(row.resourceId)}/versions/${id}`;
    default: return `/trading/incidents?objectId=${id}`;
  }
}

function searchTitle(kind: string, row: any): string {
  if (kind === 'accounts' || kind === 'resources') return row.name;
  if (kind === 'intents') return `${row.symbol} · ${row.side}`;
  if (kind === 'incidents') return row.category;
  return `${row.channelId} · Nachricht ${row.messageId}`;
}

export async function uiSearch(text: string, kind = 'all', cursorValue: string | null = null) {
  if (typeof text !== 'string' || text.trim().length < 2 || text.length > 80 || /[\r\n\0]/.test(text)) throw new Error('Search needs 2 to 80 characters.');
  if (kind !== 'all' && kind !== 'settings' && !Object.hasOwn(SOURCES, kind)) throw new Error('Unsupported search category.');
  if (cursorValue && kind === 'all') throw new Error('Pagination requires one search category.');
  const query = text.trim(); const match = `%${query.replace(/[\\%_]/g, value => `\\${value}`)}%`;
  const kinds = kind === 'all' ? [...Object.keys(SOURCES), 'settings'] : [kind];
  const groups = await Promise.all(kinds.map(async current => {
    const filter = filterFingerprint({ query, kind: current }); const cursor = decodeUiCursor(cursorValue, filter); const observedAt = cursor?.observedAt ?? Date.now();
    if (current === 'settings') {
      const rows = SETTING_TARGETS.filter(item => `${item.id} ${item.title}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && (!cursor || item.id < cursor.id)).sort((a, b) => a.id < b.id ? 1 : -1);
      return { kind: current, observedAt, entries: rows.slice(0, 20), hasMore: rows.length > 20, nextCursor: rows.length > 20 ? encodeUiCursor({ version: 1, filter, observedAt, createdAt: 0, id: rows[19].id }) : null };
    }
    const definition = SOURCES[current as keyof typeof SOURCES]; const values: unknown[] = [observedAt, ...definition.search.map(() => match)];
    const where = [`${definition.clock} <= ?`, `(${definition.search.map(column => `${column} LIKE ? ESCAPE '\\'`).join(' OR ')})`];
    if (cursor) { where.push(`(${definition.clock} < ? OR (${definition.clock} = ? AND id < ?))`); values.push(cursor.createdAt, cursor.createdAt, cursor.id); }
    const rows = await getDatabase().all(`SELECT ${definition.fields}, ${definition.clock} AS createdAt FROM ${definition.table} WHERE ${where.join(' AND ')} ORDER BY ${definition.clock} DESC, id DESC LIMIT 21`, values);
    const entries = rows.slice(0, 20).map(row => {
      return { id: row.id, title: maskPII(searchTitle(current, row)),
        subtitle: [row.status, row.mode, row.kind, row.version ? `v${row.version}` : null].filter(Boolean).join(' · '),
        url: searchUrl(current, row) };
    });
    const last = rows[19];
    return { kind: current, observedAt, entries, hasMore: rows.length > 20,
      nextCursor: rows.length > 20 ? encodeUiCursor({ version: 1, filter, observedAt, createdAt: last.createdAt, id: last.id }) : null };
  }));
  return { contractVersion: 1, groups, scope: 'Metadata and identifiers only. No signal bodies, credentials, provider payloads or trade commands.' };
}
