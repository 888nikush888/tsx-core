import { getDatabase } from './db.js';
import { maskPII } from './logger.js';
import { decodeUiCursor, encodeUiCursor, filterFingerprint } from './ui_cursor.js';

const SOURCES = `WITH issues AS (
 SELECT 0 AS priority,'incident' AS kind,id,account_id AS accountId,substr(message,1,2000) AS reason,first_seen_at AS createdAt,last_seen_at AS updatedAt
 FROM trading_account_incidents WHERE status='open' AND severity='critical'
 UNION ALL SELECT 1,'order',id,account_id,substr(COALESCE(last_error,'Orderausgang unbekannt'),1,2000),created_at,updated_at FROM trading_orders WHERE status='unknown'
 UNION ALL SELECT 1,'operation',id,account_id,substr(COALESCE(last_error,'Börsenoperation ungeklärt'),1,2000),created_at,updated_at FROM trading_operations WHERE phase='unresolved'
 UNION ALL SELECT 2,'incident',id,account_id,substr(message,1,2000),first_seen_at,last_seen_at FROM trading_account_incidents WHERE status='open' AND severity<>'critical'
 UNION ALL SELECT 2,'risk',id,account_id,substr(code,1,2000),created_at,created_at FROM trading_risk_events WHERE acknowledged_at IS NULL
 UNION ALL SELECT 3,'outbox',id,NULL,substr(COALESCE(last_error,'Versand benötigt Abgleich'),1,2000),added_at,updated_at FROM pending_tasks WHERE status IN ('unknown','needs_review')
 UNION ALL SELECT 3,'ingress',id,NULL,substr(COALESCE(reason,'Eingang benötigt Prüfung'),1,2000),created_at,updated_at FROM incoming_work WHERE status='needs_review'
), selected AS (SELECT *,printf('%d:%016d:%s:%s',priority,createdAt,kind,id) AS sortKey FROM issues WHERE createdAt<=?)`;
const ACTIONS: Record<string, { label: string; path: string; query: string }> = {
  incident: { label: 'Originalvorfall und Kontonachweise prüfen', path: '/trading/incidents', query: 'objectId' },
  order: { label: 'Order und ursprünglichen Intent abgleichen', path: '/trading/orders', query: 'objectId' },
  operation: { label: 'Ungeklärte Operation lesen; nicht erneut senden', path: '/trading/operations', query: 'objectId' },
  risk: { label: 'Risikoereignis prüfen; Quittierung ist keine Ursachenbehebung', path: '/trading/risk-events', query: 'objectId' },
  outbox: { label: 'Versandbelege und Abgleich prüfen', path: '/signals/outbox', query: 'objectId' },
  ingress: { label: 'Originaleingang und Verarbeitungsspur prüfen', path: '/signals/messages', query: 'objectId' },
};
export async function uiAttention(query: URLSearchParams) {
  const limit = Number(query.get('limit') || 20);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Attention page size must be 1–50.');
  const filter = filterFingerprint({ kind: 'operator-attention', limit }); const cursor = decodeUiCursor(query.get('cursor'), filter);
  const observedAt = cursor?.observedAt ?? Date.now();
  const [rows, counts] = await Promise.all([
    getDatabase().all(`${SOURCES} SELECT * FROM selected WHERE sortKey>? ORDER BY sortKey LIMIT ?`, [observedAt, cursor?.id ?? '', limit + 1]),
    getDatabase().get(`${SOURCES} SELECT COUNT(*) AS total FROM selected`, [observedAt]),
  ]);
  const entries = rows.slice(0, limit).map(({ sortKey: _key, ...row }) => ({ ...row, reason: maskPII(row.reason),
    nextRead: { label: ACTIONS[row.kind].label, href: `${ACTIONS[row.kind].path}?${ACTIONS[row.kind].query}=${encodeURIComponent(row.id)}` } }));
  const last = rows[Math.min(rows.length, limit) - 1]; const hasMore = rows.length > limit;
  return { contractVersion: 1, entries, total: counts.total, observedAt, hasMore,
    nextCursor: hasMore ? encodeUiCursor({ version: 1, filter, observedAt, createdAt: 0, id: last.sortKey }) : null,
    interpretation: 'Priorität: kritische Vorfälle, unklare Börsenwirkungen, weitere Vorfälle/Risikoereignisse, Versand/Eingang. Je Gruppe älteste zuerst. Zustände werden je Seite aktuell gelesen; neue Fälle erscheinen nach Rückkehr zur ersten Seite. Die nächste Handlung ist ein Leseweg und keine Handelsfreigabe.' };
}
