import { getDatabase } from './db.js';
import { maskPII } from './logger.js';
import { decodeUiCursor, encodeUiCursor, filterFingerprint } from './ui_cursor.js';
import { uiObjectId } from './ui_trading_reads.js';

function originalColumn(kind: string, field: string, id: string) {
  const columns: Record<string, string> = kind === 'messages' ? { text: 'text' } : { xml: 'xml_content', normalized: 'normalized_content' };
  if (!Object.hasOwn(columns, field) || (kind === 'messages' && !/^[1-9]\d{0,14}$/.test(id))) throw new Error('Invalid original field or message ID.');
  return columns[field];
}
function originalSelection(query: URLSearchParams) {
  const id = query.get('id') || ''; uiObjectId(id, 256);
  const kind = query.get('kind') || 'processed'; const field = query.get('field') || (kind === 'messages' ? 'text' : 'xml');
  if (!['messages', 'processed'].includes(kind)) throw new Error('Unsupported original kind.');
  const column = originalColumn(kind, field, id);
  const filter = filterFingerprint({ kind, id, field }); const cursor = decodeUiCursor(query.get('cursor'), filter);
  const offset = cursor ? Number(cursor.id) : 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid text cursor.');
  return { id, kind, field, column, filter, cursor, offset };
}

/** SQLite slices before transport; legacy payload size never determines the response budget. */
export async function uiSignalOriginal(query: URLSearchParams) {
  const { id, kind, field, column, filter, cursor, offset } = originalSelection(query);
  const table = kind === 'messages' ? 'incoming_messages' : 'signals';
  const row = await getDatabase().get(`SELECT id,chat_id AS channelId,message_id AS messageId,created_at AS createdAt,
    length(${column}) AS totalCharacters,substr(${column},?,10000) AS text,
    ${kind === 'processed' ? 'template_name AS templateName,schema_name AS schemaName,model,prompt_sha256 AS promptSha256,parser_version AS parserVersion,workflow_revision_id AS workflowRevisionId' : 'type,status'}
    FROM ${table} WHERE id=?`, [offset + 1, id]);
  if (!row) return null;
  const observedAt = cursor?.observedAt ?? Date.now(); const hasMore = offset + 10000 < row.totalCharacters;
  return { contractVersion: 1, observedAt, kind, field, offset, ...row, text: typeof row.text === 'string' ? maskPII(row.text) : null,
    redacted: true, hasMore, nextCursor: hasMore ? encodeUiCursor({ version: 1, filter, observedAt, createdAt: 0, id: String(offset + 10000) }) : null,
    interpretation: 'Gespeicherter Originaltext, redigiert und in Abschnitten von höchstens 10.000 Unicode-Zeichen gelesen. Keine Neuinterpretation mit heutigen Modellen; ein Parserergebnis beweist weder Grounding noch Order oder Versand.' };
}
