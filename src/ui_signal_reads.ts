import { getDatabase } from './db.js';
import { maskPII } from './logger.js';
import { decodeUiCursor, encodeUiCursor, filterFingerprint } from './ui_cursor.js';

const LISTS = {
  messages: {
    table: 'incoming_messages', clock: 'created_at', status: null,
    fields: 'id, chat_id AS channelId, message_id AS messageId, type, status, substr(text,1,2000) AS excerpt, created_at AS createdAt',
    states: [] as string[],
  },
  ingress: {
    table: 'incoming_work', clock: 'created_at', status: 'status',
    fields: 'id, chat_id AS channelId, message_id AS messageId, workflow_revision_id AS workflowRevisionId, status, reason, created_at AS createdAt, updated_at AS updatedAt',
    states: ['pending', 'routed', 'filtered', 'album_waiting', 'needs_review'],
  },
  processed: {
    table: 'signals', clock: 'created_at', status: null,
    fields: 'id, chat_id AS channelId, message_id AS messageId, template_name AS templateName, schema_name AS schemaName, model, prompt_sha256 AS promptSha256, parser_version AS parserVersion, workflow_revision_id AS workflowRevisionId, created_at AS createdAt',
    states: [] as string[],
  },
  outbox: {
    table: 'pending_tasks', clock: 'added_at', status: 'status',
    fields: `id, type, chat_id AS channelId, message_id AS messageId, media_group_id AS albumId, status, attempts, last_error AS reason, added_at AS createdAt, updated_at AS updatedAt, completed_at AS completedAt, workflow_revision_id AS workflowRevisionId, ingress_work_id AS ingressWorkId, CASE WHEN json_valid(config_json) THEN CAST(json_extract(config_json, '$.durableIngress.targetChatId') AS TEXT) END AS targetChatId, CASE WHEN json_valid(result_json) THEN CASE WHEN json_extract(result_json, '$.acknowledged') = 1 THEN 'operator-acknowledged' ELSE json_extract(result_json, '$.mode') END END AS resultMode, CASE WHEN json_valid(result_json) THEN json_extract(result_json, '$.destinationMessageIds') END AS confirmedMessageIds`,
    states: ['pending', 'preparing', 'sending', 'completed', 'failed', 'unknown', 'needs_review'],
  },
} as const;
export type UiSignalList = keyof typeof LISTS;

function originalMessageFilter(query: URLSearchParams) {
  const value = query.get('messageId'); if (value === null || value === '') return null;
  if (!/^\d{1,16}$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid original message ID.');
  return Number(value);
}

function signalFilters(kind: UiSignalList, query: URLSearchParams) {
  if (!Object.hasOwn(LISTS, kind)) throw new Error('Unsupported signal list.');
  const definition = LISTS[kind];
  const status = query.get('status') || '';
  const channel = query.get('channelId') || '';
  const objectId = query.get('objectId') || '';
  const limit = Number(query.get('limit') || 50);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || channel.length > 128 || objectId.length > 256 || /[\r\n\0]/.test(objectId)
    || (status && !(definition.states as readonly string[]).includes(status))) throw new Error('Invalid signal list filters.');
  return { status, channel, objectId, limit };
}

export async function uiSignalPage(kind: UiSignalList, query: URLSearchParams) {
  const { status, channel, objectId, limit } = signalFilters(kind, query);
  const messageId = originalMessageFilter(query);
  const definition = LISTS[kind];
  const filter = filterFingerprint({ kind, status, channel, objectId, messageId, limit });
  const cursor = decodeUiCursor(query.get('cursor'), filter);
  const observedAt = cursor?.observedAt ?? Date.now();
  const where = [`${definition.clock} <= ?`];
  const values: unknown[] = [observedAt];
  if (status && definition.status) { where.push(`${definition.status} = ?`); values.push(status); }
  if (channel) { where.push('chat_id = ?'); values.push(channel); }
  if (messageId !== null) { where.push('message_id = ?'); values.push(messageId); }
  if (objectId) { where.push('id = ?'); values.push(objectId); }
  if (cursor) { where.push(`(${definition.clock} < ? OR (${definition.clock} = ? AND id < ?))`); values.push(cursor.createdAt, cursor.createdAt, cursor.id); }
  const rows = await getDatabase().all(`SELECT ${definition.fields} FROM ${definition.table} WHERE ${where.join(' AND ')} ORDER BY ${definition.clock} DESC, id DESC LIMIT ?`, [...values, limit + 1]);
  const hasMore = rows.length > limit;
  const entries = rows.slice(0, limit).map(row => ({ ...row, ...(row.reason ? { reason: maskPII(row.reason).slice(0, 2000) } : {}), ...(typeof row.excerpt === 'string' ? { excerpt: maskPII(row.excerpt) } : {}) }));
  const last = entries.at(-1);
  return { contractVersion: 1, entries, hasMore, observedAt, states: definition.states, redacted: true,
    snapshotContext: 'Creation cutoff; each page observes current status.',
    nextCursor: hasMore && last ? encodeUiCursor({ version: 1, filter, observedAt, createdAt: last.createdAt, id: String(last.id) }) : null };
}

export async function uiIngressDetail(id: string) {
  if (!id || id.length > 256 || /[\r\n\0]/.test(id)) throw new Error('Invalid ingress ID.');
  const database = getDatabase();
  const work = await database.get(`SELECT ${LISTS.ingress.fields} FROM incoming_work WHERE id = ?`, [id]);
  if (!work) return null;
  const source = await database.get('SELECT id, type, substr(text, 1, 10000) AS excerpt, status FROM incoming_messages WHERE chat_id = ? AND message_id = ?', [work.channelId, work.messageId]);
  return { contractVersion: 1, observedAt: Date.now(), redacted: true, work: { ...work, reason: work.reason ? maskPII(work.reason).slice(0, 2000) : null },
    source: source ? { ...source, excerpt: typeof source.excerpt === 'string' ? maskPII(source.excerpt) : null } : null,
    relationsEndpoint: '/api/signals/ingress/relations',
    interpretation: 'Originaleingang. Parser-, Album-, Trade- und Versandbeziehungen werden unabhängig und vollständig seitenweise gelesen.' };
}
