import { getDatabase, withDatabaseTransaction } from './db.js';
import { createHash } from 'node:crypto';
import { policyFromRow, evaluationFromRow, workflowRiskStateAnalytics, workflowRiskEvaluationAnalytics, workflowPolicyHash } from './trading_channel_risk.js';
import { createWorkflowResourceDraft, getWorkflowResourceById, legacyAdaptiveRiskDefinition } from './workflow_repository.js';
import { decodeUiCursor, encodeUiCursor, filterFingerprint } from './ui_cursor.js';
import { uiObjectId } from './ui_trading_reads.js';
import { redactReview, reviewHash } from './ui_change_review.js';

const KINDS = ['states', 'evaluations', 'paths', 'sources', 'legacy', 'legacy-evaluations'] as const;
type Kind = typeof KINDS[number];
const EVALUATION_COLUMNS = `e.id,e.policy_sha256,e.state_key,e.week_started_at,e.week_ended_at,e.closed_trades,e.wins,e.losses,
 e.realized_pnl,e.starting_equity,e.return_percent,e.previous_tier,e.recommended_tier,e.applied_tier,e.action,e.reason,e.created_at,
 e.realized_pnl_value_json,e.return_percent_value_json,e.reporting_currency,e.source_hash,e.invalidated_at,e.invalidation_reason,
 json_object('returnPercentReason',json_extract(e.source_json,'$.returnPercentReason')) AS source_json`;

function validateFilterScope(kind: Kind, filters: Record<string, string | null>) {
  if (kind === 'paths' && (filters.accountId || filters.channelId || filters.id) || kind === 'sources' && (filters.accountId || filters.stateKey)) throw new Error('Filter does not belong to this evidence kind.');
}

async function selection(query: URLSearchParams) {
  const kind = (query.get('kind') || 'states') as Kind;
  if (!KINDS.includes(kind)) throw new Error('Unsupported adaptive evidence kind.');
  const limit = Number(query.get('limit') || 20);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Adaptive evidence limit must be 1–50.');
  const filters = Object.fromEntries(['accountId', 'channelId', 'stateKey', 'id'].map(key => [key, query.has(key) ? uiObjectId(query.get(key), 128) : null]));
  validateFilterScope(kind, filters);
  const revisionId = kind === 'paths' ? (await getDatabase().get('SELECT revision_id FROM workflow_active_revision WHERE singleton_id=1'))?.revision_id ?? null : null;
  const filter = filterFingerprint({ kind, limit, ...filters, revisionId });
  const cursor = decodeUiCursor(query.get('cursor'), filter);
  return { kind, limit, filters, filter, cursor, revisionId, observedAt: cursor?.observedAt ?? Date.now() };
}
type Selection = Awaited<ReturnType<typeof selection>>;
function pageResult(page: Selection, rows: any[], entries: unknown[], timeKey = 'created_at', idKey = 'id') {
  const last = rows[Math.min(page.limit, rows.length) - 1]; const hasMore = rows.length > page.limit;
  return { contractVersion: 1, observedAt: page.observedAt, entries: redactReview(entries.slice(0, page.limit)), hasMore,
    nextCursor: hasMore && last ? encodeUiCursor({ version: 1, filter: page.filter, observedAt: page.observedAt, createdAt: last[timeKey], id: String(last[idKey]) }) : null,
    interpretation: 'Gespeicherte Belege; keine Neuauswertung und keine Handelsfreigabe. Zeitgrenze begrenzt die Auswahl, Invalidierungen und Runtimezustand werden aktuell gelesen.' };
}
function conditions(page: Selection, alias: string, timeKey: string, idKey: string) {
  const where = [`${alias}.${timeKey} <= ?`]; const values: unknown[] = [page.observedAt];
  for (const key of ['accountId', 'channelId', 'stateKey'] as const) {
    if (page.filters[key]) { where.push(`s.${{ accountId: 'account_id', channelId: 'channel_id', stateKey: 'state_key' }[key]} = ?`); values.push(page.filters[key]); }
  }
  if (page.filters.id) { where.push(`${alias}.${idKey} = ?`); values.push(page.filters.id); }
  if (page.cursor) { where.push(`(${alias}.${timeKey} < ? OR (${alias}.${timeKey} = ? AND ${alias}.${idKey} < ?))`); values.push(page.cursor.createdAt, page.cursor.createdAt, page.cursor.id); }
  return { where, values };
}
async function states(page: Selection) {
  const { where, values } = conditions(page, 's', 'updated_at', 'state_key');
  const rows = await getDatabase().all(`SELECT s.*,s.resource_id AS resource_name,a.name AS account_name,a.mode,
    (SELECT e.id FROM workflow_adaptive_risk_evaluations e WHERE e.state_key=s.state_key AND e.policy_sha256=s.policy_sha256 ORDER BY e.week_ended_at DESC,e.id DESC LIMIT 1) AS latest_id
    FROM workflow_adaptive_risk_state s JOIN trading_accounts a ON a.id=s.account_id
    WHERE ${where.join(' AND ')} ORDER BY s.updated_at DESC,s.state_key DESC LIMIT ?`, [...values, page.limit + 1]);
  return pageResult(page, rows, rows.map(row => ({ ...workflowRiskStateAnalytics(row), accountName: row.account_name, mode: row.mode, latestEvaluationId: row.latest_id })), 'updated_at', 'state_key');
}
async function evaluations(page: Selection) {
  const { where, values } = conditions(page, 'e', 'created_at', 'id');
  const rows = await getDatabase().all(`SELECT ${EVALUATION_COLUMNS},s.channel_id,s.account_id,s.resource_id,s.resource_id AS resource_name,
    a.mode,a.name AS account_name,s.policy_sha256 AS current_policy
    FROM workflow_adaptive_risk_evaluations e JOIN workflow_adaptive_risk_state s ON s.state_key=e.state_key
    JOIN trading_accounts a ON a.id=s.account_id WHERE ${where.join(' AND ')} ORDER BY e.created_at DESC,e.id DESC LIMIT ?`, [...values, page.limit + 1]);
  return pageResult(page, rows, rows.map(row => ({ ...workflowRiskEvaluationAnalytics(row), policySha256: row.policy_sha256,
    matchesCurrentStatePolicy: row.policy_sha256 === row.current_policy, accountName: row.account_name, mode: row.mode })));
}
async function activePaths(page: Selection) {
  if (!page.filters.stateKey) throw new Error('State key required for active policy paths.');
  const state = await getDatabase().get('SELECT * FROM workflow_adaptive_risk_state WHERE state_key=?', [page.filters.stateKey]);
  if (!state) return null;
  const active = page.revisionId;
  const after = page.cursor?.id ?? '';
  const rows = await getDatabase().all(`SELECT p.id,p.created_at,p.workflow_revision_id AS revisionId,p.adaptive_risk_resource_version_id AS versionId
    FROM workflow_execution_paths p JOIN workflow_resource_versions r ON r.id=p.adaptive_risk_resource_version_id
    WHERE p.workflow_revision_id=? AND p.channel_id=? AND p.account_id=? AND r.resource_id=? AND p.id>? ORDER BY p.id LIMIT ?`,
  [active, state.channel_id, state.account_id, state.resource_id, after, page.limit + 1]);
  const entries = await Promise.all(rows.slice(0, page.limit).map(async row => {
    const resource = await getWorkflowResourceById(row.versionId);
    if (!resource) throw new Error('Active policy resource disappeared.');
    const policySha256 = workflowPolicyHash(resource.configuration as any);
    return { id: row.id, revisionId: row.revisionId, resource, policySha256, matchesStoredState: policySha256 === state.policy_sha256 };
  }));
  return { ...pageResult(page, rows.map(row => ({ ...row, created_at: 0 })), entries), activeRevisionId: active };
}
async function evaluationSources(page: Selection) {
  if (!page.filters.id) throw new Error('Original evaluation ID required.');
  const table = page.filters.channelId ? 'trading_channel_risk_evaluations' : 'workflow_adaptive_risk_evaluations';
  const channelClause = page.filters.channelId ? ' AND channel_id=?' : '';
  const row = await getDatabase().get(`SELECT id,source_json,source_hash,invalidated_at,invalidation_reason FROM ${table} WHERE id=?${channelClause}`, [page.filters.id, ...(page.filters.channelId ? [page.filters.channelId] : [])]);
  if (!row) return null;
  if (!row.source_json) return { ...pageResult(page, [], []), sourceAvailable: false, reason: 'Originaldaten wurden für diese historische Auswertung nicht gespeichert.' };
  if (createHash('sha256').update(row.source_json).digest('hex') !== row.source_hash) throw new Error('Original evaluation source hash does not match.');
  const source = JSON.parse(row.source_json); const after = page.cursor ? Number(page.cursor.id) : -1;
  if (!Number.isSafeInteger(after) || after < -1) throw new Error('Invalid original source cursor.');
  const rows = (source.positions ?? []).slice(after + 1, after + page.limit + 2).map((item: any, index: number) => ({ ...item, ordinal: after + index + 1, created_at: 0 }));
  const { fingerprint: _fingerprint, generation: _generation, ...capital } = source.capital ?? {};
  return { ...pageResult(page, rows, rows.map(({ created_at: _time, ordinal: _ordinal, ...item }: any) => item), 'created_at', 'ordinal'),
    sourceAvailable: true, sourceHash: row.source_hash, integrityVerified: true, scope: source.scope, capital: redactReview(capital),
    invalidatedAt: row.invalidated_at, invalidationReason: redactReview(row.invalidation_reason), sourceCount: source.positions?.length ?? 0 };
}
async function legacy(page: Selection) {
  if (page.filters.accountId || page.filters.stateKey || page.filters.id) throw new Error('Legacy policies have channel scope, not account/state scope.');
  const where = ['updated_at <= ?']; const values: unknown[] = [page.observedAt];
  if (page.filters.channelId) { where.push('channel_id = ?'); values.push(page.filters.channelId); }
  if (page.cursor) { where.push('channel_id > ?'); values.push(page.cursor.id); }
  const rows = await getDatabase().all(`SELECT * FROM trading_channel_risk_policies WHERE ${where.join(' AND ')} ORDER BY channel_id LIMIT ?`, [...values, page.limit + 1]);
  const entries = await Promise.all(rows.slice(0, page.limit).map(async row => {
    const copyHash = reviewHash(row); const resourceId = `legacy-policy-copy:${copyHash}`;
    const copy = await getDatabase().get('SELECT id FROM workflow_resource_versions WHERE resource_id=? ORDER BY version DESC LIMIT 1', [resourceId]);
    return { policy: policyFromRow(row), copyHash, configuration: legacyAdaptiveRiskDefinition(row.channel_id, row)[0]!.configuration, copiedVersionId: copy?.id ?? null, copiedResourceId: resourceId };
  }));
  return { ...pageResult(page, rows.map(row => ({ ...row, created_at: 0 })), entries, 'created_at', 'channel_id'),
    interpretation: 'Legacy-Policen gelten für Intents ohne Workflowpfad. Aktive Workflowpfade verwenden ihre gepinnte Ressourcenpolicy. Der Start migriert geeignete alte Routen nur ohne aktive Revision. Die Kopie erzeugt ausschließlich einen Entwurf; Publikation, Pfadzuordnung und Aktivierung werden anschließend geprüft.' };
}
async function legacyEvaluations(page: Selection) {
  if (!page.filters.channelId || page.filters.accountId || page.filters.stateKey) throw new Error('Legacy evaluation requires a channel scope.');
  const where = ['e.channel_id=?', 'e.created_at<=?']; const values: unknown[] = [page.filters.channelId, page.observedAt];
  if (page.filters.id) { where.push('e.id=?'); values.push(page.filters.id); }
  if (page.cursor) { where.push('(e.created_at<? OR (e.created_at=? AND e.id<?))'); values.push(page.cursor.createdAt, page.cursor.createdAt, page.cursor.id); }
  const fields = EVALUATION_COLUMNS.replace('e.policy_sha256,e.state_key', 'e.policy_version,e.channel_id');
  const rows = await getDatabase().all(`SELECT ${fields} FROM trading_channel_risk_evaluations e WHERE ${where.join(' AND ')} ORDER BY e.created_at DESC,e.id DESC LIMIT ?`, [...values, page.limit + 1]);
  return pageResult(page, rows, rows.map(evaluationFromRow));
}
export async function uiAdaptiveRisk(query: URLSearchParams) {
  const page = await selection(query);
  const handlers = { states, evaluations, paths: activePaths, sources: evaluationSources, legacy, 'legacy-evaluations': legacyEvaluations };
  return handlers[page.kind](page);
}
export async function copyLegacyRiskPolicy(input: { channelId: unknown; copyHash: unknown }) {
  const channelId = uiObjectId(input.channelId, 128);
  return withDatabaseTransaction(async db => {
    const row = await db.get('SELECT * FROM trading_channel_risk_policies WHERE channel_id=?', [channelId]);
    if (!row || typeof input.copyHash !== 'string' || reviewHash(row) !== input.copyHash) throw new Error('Legacy policy changed. Review the current policy again.');
    const resourceId = `legacy-policy-copy:${input.copyHash}`;
    const existing = await db.get('SELECT id FROM workflow_resource_versions WHERE resource_id=? ORDER BY version DESC LIMIT 1', [resourceId]);
    if (existing) return { resource: await getWorkflowResourceById(existing.id), alreadyCopied: true, activated: false };
    const definition = legacyAdaptiveRiskDefinition(channelId, row)[0]!;
    const resource = await createWorkflowResourceDraft({ ...definition, resourceId, description: 'Geprüfte Legacy-Kopie; nicht automatisch aktiviert. Bestehende Legacy-Intents bleiben unverändert.' });
    return { resource, alreadyCopied: false, activated: false };
  });
}
