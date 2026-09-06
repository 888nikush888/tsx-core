import { getDatabase } from './db.js';
import { decodeUiCursor, encodeUiCursor, filterFingerprint } from './ui_cursor.js';
import { getActiveWorkflow, getWorkflowResourceById, getWorkflowRevisionById } from './workflow_repository.js';
import { WORKFLOW_RESOURCE_KINDS } from './ui_contracts.js';
import { redactReview } from './ui_change_review.js';
import { uiResourcePublication } from './ui_resource_publication.js';
import { getTradingStrategyVersion } from './trading_repository.js';
import { uiEffectiveParameters } from './ui_effective_parameters.js';

export type UiWorkflowList = 'resources' | 'paths' | 'revisions';
function id(value: string | null) {
  if (value !== null && (!value || value.length > 128 || /[\r\n\0]/.test(value))) throw new Error('Invalid workflow object identifier.');
  return value;
}
function workflowFilters(kind: UiWorkflowList, query: URLSearchParams) {
  if (!['resources', 'paths', 'revisions'].includes(kind)) throw new Error('Unsupported workflow list.');
  const limit = Number(query.get('limit') || 40); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid page size.');
  const resourceId = id(query.get('resourceId')); const revisionId = id(query.get('revisionId')); const accountId = id(query.get('accountId'));
  const resourceKind = query.get('resourceKind') || ''; const status = query.get('status') || ''; const activeOnly = query.get('active') !== 'false';
  validateFilterScope(kind, { resourceId, resourceKind, revisionId, accountId, status });
  if ((resourceKind && !(WORKFLOW_RESOURCE_KINDS as readonly string[]).includes(resourceKind)) || (status && !['draft', 'published', 'archived', 'active'].includes(status))) throw new Error('Invalid workflow filters.');
  return { limit, resourceId, revisionId, accountId, resourceKind, status, activeOnly };
}

function validateFilterScope(kind: UiWorkflowList, filters: { resourceId: string | null; resourceKind: string; revisionId: string | null; accountId: string | null; status: string }) {
  if (kind !== 'resources' && (filters.resourceId || filters.resourceKind)
    || kind !== 'paths' && (filters.revisionId || filters.accountId)
    || kind === 'paths' && filters.status) throw new Error('Filter does not belong to this workflow list.');
}

function workflowSelection(kind: UiWorkflowList, filters: ReturnType<typeof workflowFilters>, effectiveRevisionId: string | null, observedAt: number) {
  const { resourceId, resourceKind, activeOnly, accountId, status } = filters;
  const where = ['created_at <= ?']; const values: unknown[] = [observedAt];
  let fields: string; let table: string;
  if (kind === 'resources') {
    table = 'workflow_resource_versions'; fields = 'id, resource_id AS resourceId, version, kind, name, description, status, configuration_sha256 AS configurationSha256, edit_revision AS editRevision, created_at AS createdAt, published_at AS publishedAt';
    if (resourceId) { where.push('resource_id = ?'); values.push(resourceId); }
    if (resourceKind) { where.push('kind = ?'); values.push(resourceKind); }
  } else if (kind === 'paths') {
    table = 'workflow_execution_paths'; fields = 'id, workflow_revision_id AS revisionId, path_key AS pathKey, channel_id AS channelId, account_id AS accountId, fallback_rank AS fallbackRank, enabled, created_at AS createdAt';
    if (effectiveRevisionId) { where.push('workflow_revision_id = ?'); values.push(effectiveRevisionId); }
    else if (activeOnly) where.push('0 = 1');
    if (accountId) { where.push('account_id = ?'); values.push(accountId); }
  } else {
    table = 'workflow_revisions'; fields = 'id, revision, status, base_revision_id AS baseRevisionId, definition_sha256 AS definitionSha256, created_by AS createdBy, created_at AS createdAt';
  }
  if (status && kind !== 'paths') { where.push('status = ?'); values.push(status); }
  return { fields, table, where, values };
}

export async function uiWorkflowPage(kind: UiWorkflowList, query: URLSearchParams) {
  const filters = workflowFilters(kind, query);
  const { limit, resourceId, revisionId, accountId, resourceKind, status, activeOnly } = filters;
  const effectiveRevisionId = kind === 'paths' && !revisionId && activeOnly
    ? (await getDatabase().get('SELECT revision_id AS id FROM workflow_active_revision WHERE singleton_id = 1'))?.id ?? null : revisionId;
  const fingerprint = filterFingerprint({ kind, limit, resourceId, revisionId: effectiveRevisionId, accountId, resourceKind, status, activeOnly });
  const cursor = decodeUiCursor(query.get('cursor'), fingerprint); const observedAt = cursor?.observedAt ?? Date.now();
  const { fields, table, where, values } = workflowSelection(kind, filters, effectiveRevisionId, observedAt);
  if (cursor) { where.push('(created_at < ? OR (created_at = ? AND id < ?))'); values.push(cursor.createdAt, cursor.createdAt, cursor.id); }
  const rows = await getDatabase().all(`SELECT ${fields} FROM ${table} WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`, [...values, limit + 1]);
  const last = rows[Math.min(limit, rows.length) - 1];
  return { contractVersion: 1, observedAt, snapshotContext: 'Creation cutoff; current lifecycle state at each page read.', entries: rows.slice(0, limit), hasMore: rows.length > limit,
    nextCursor: rows.length > limit && last ? encodeUiCursor({ version: 1, filter: fingerprint, observedAt, createdAt: last.createdAt, id: last.id }) : null };
}

async function resourceDetail(objectId: string, observedAt: number) {
    const resource = await getWorkflowResourceById(objectId); if (!resource) return null;
    const active = await getActiveWorkflow();
    const nodeIds = new Set(active?.graph.nodes.filter(node => node.resourceVersionId === objectId).map(node => node.id) ?? []);
    const visibleResource = redactReview(resource, 0, false);
    return { contractVersion: 1, observedAt, resource: visibleResource,
      editingBlockedByRedaction: JSON.stringify(visibleResource.configuration) !== JSON.stringify(resource.configuration),
      publication: redactReview(await uiResourcePublication(objectId)),
      activeRevisionId: active?.id ?? null, activePaths: (active?.compiled.paths ?? []).filter(path => path.nodeIds.some(node => nodeIds.has(node)))
        .map(path => ({ id: path.id, channelId: path.channelId, accountId: path.accountId })),
      effect: 'Gespeicherte Quelle. Eine publizierte Version wird erst nach einer separaten Graphaktivierung für neue Intents verwendet.' };
}

export async function uiWorkflowDetail(kind: UiWorkflowList, objectId: string) {
  id(objectId); const observedAt = Date.now();
  if (kind === 'resources') return resourceDetail(objectId, observedAt);
  const revisionId = kind === 'paths' ? (await getDatabase().get('SELECT workflow_revision_id AS id FROM workflow_execution_paths WHERE id = ?', [objectId]))?.id : objectId;
  if (!revisionId) return null;
  const revision = await getWorkflowRevisionById(revisionId); if (!revision) return null;
  const path = kind === 'paths' ? revision.compiled.paths.find(path => path.id === objectId) : null;
  if (kind === 'paths' && !path) return null;
  const relevantNodes = path ? revision.graph.nodes.filter(node => path.nodeIds.includes(node.id)) : revision.graph.nodes;
  const parameterEffects = path ? uiEffectiveParameters(path, await getTradingStrategyVersion(path.strategyVersionId), path.sizingResourceVersionId ? await getWorkflowResourceById(path.sizingResourceVersionId) : null) : [];
  const sources = await Promise.all(relevantNodes.map(async node => {
    const resource = await getWorkflowResourceById(node.resourceVersionId);
    return { nodeId: node.id, resource: resource ? { id: resource.id, resourceId: resource.resourceId, name: resource.name, version: resource.version,
      kind: resource.kind, status: resource.status, configurationSha256: resource.configurationSha256 } : null };
  }));
  return { contractVersion: 1, observedAt, integrityVerified: true, path: redactReview(path), sources: redactReview(sources),
    parameterEffects: redactReview(parameterEffects),
    revision: { id: revision.id, revision: revision.revision, status: revision.status, baseRevisionId: revision.baseRevisionId, definitionSha256: revision.definitionSha256,
      createdAt: revision.createdAt, createdBy: revision.createdBy, graph: revision.graph, warnings: revision.compiled.warnings },
    effect: 'Originalquellen und kompilierte Parameter dieser Revision. Der ausgeführte Trade besitzt zusätzlich seinen eigenen gepinnten Plan und spätere Markt-/Schutzbelege.' };
}
