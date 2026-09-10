import { getDatabase, withDatabaseTransaction } from './db.js';
import { getTradingSignalSchemaById, getTradingStrategyVersion, getSignalContractVersion,
  publishTradingStrategyVersion, archiveTradingStrategyVersion, deleteTradingStrategyVersion,
  publishSignalContractVersion, archiveSignalContractVersion, deleteSignalContractDraft, deleteSignalContractVersion,
  deleteTradingSignalSchema, updateTradingSignalSchema } from './trading_repository.js';
import { createWorkflowResourceDraft, getActiveWorkflow } from './workflow_repository.js';
import { decodeUiCursor, encodeUiCursor, filterFingerprint } from './ui_cursor.js';
import { reviewHash, redactReview } from './ui_change_review.js';
import { uiObjectId } from './ui_trading_reads.js';

const MODELS = {
  strategy: { table: 'trading_strategy_versions', reference: 'strategyVersionId', clock: 'created_at',
    fields: 'id, strategy_id AS familyId, name, description, version, status, configuration_sha256 AS contentHash, created_at AS createdAt' },
  contract: { table: 'trading_signal_contract_versions', reference: 'contractVersionId', clock: 'created_at',
    fields: `id, contract_id AS familyId, (SELECT name FROM trading_signal_contracts WHERE id = contract_id) AS name, version, status, definition_sha256 AS contentHash, created_at AS createdAt` },
  schema: { table: 'trading_signal_schemas', reference: 'schemaId', clock: 'created_at',
    fields: `id, name, description, CASE enabled WHEN 1 THEN 'enabled' ELSE 'disabled' END AS status, template_name AS templateName, updated_at AS updatedAt, created_at AS createdAt` },
} as const;
export type UiModelKind = keyof typeof MODELS;
function modelKind(value: unknown): UiModelKind {
  if (typeof value !== 'string' || !Object.hasOwn(MODELS, value)) throw new Error('Unsupported model kind.');
  return value as UiModelKind;
}

export async function uiModelPage(inputKind: unknown, query: URLSearchParams) {
  const kind = modelKind(inputKind); const definition = MODELS[kind]; const limit = Number(query.get('limit') || 40);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid model page size.');
  const filter = filterFingerprint({ kind, limit }); const cursor = decodeUiCursor(query.get('cursor'), filter);
  const observedAt = cursor?.observedAt ?? Date.now(); const values: unknown[] = [observedAt];
  const where = ['created_at <= ?'];
  if (cursor) { where.push('(created_at < ? OR (created_at = ? AND id < ?))'); values.push(cursor.createdAt, cursor.createdAt, cursor.id); }
  const rows = await getDatabase().all(`SELECT ${definition.fields} FROM ${definition.table} WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`, [...values, limit + 1]);
  const last = rows[Math.min(limit, rows.length) - 1];
  return { contractVersion: 1, kind, observedAt, entries: redactReview(rows.slice(0, limit)), hasMore: rows.length > limit,
    snapshotContext: 'Creation cutoff; current model state on each page.',
    nextCursor: rows.length > limit && last ? encodeUiCursor({ version: 1, filter, observedAt, createdAt: last.createdAt, id: last.id }) : null };
}

async function modelObject(kind: UiModelKind, id: string): Promise<any> {
  if (kind === 'strategy') return getTradingStrategyVersion(id);
  if (kind === 'schema') return getTradingSignalSchemaById(id);
  const version = await getSignalContractVersion(id); if (!version) return null;
  const family = await getDatabase().get('SELECT name, description FROM trading_signal_contracts WHERE id = ?', [version.contractId]);
  return { ...version, ...family };
}
async function modelReferences(kind: UiModelKind, id: string) {
  const condition = `kind = ? AND json_extract(configuration_json, '$.${MODELS[kind].reference}') = ?`;
  const [resources, count, active] = await Promise.all([
    getDatabase().all(`SELECT id, resource_id AS resourceId, name, version, status FROM workflow_resource_versions WHERE ${condition} ORDER BY id LIMIT 100`, [kind, id]),
    getDatabase().get(`SELECT COUNT(*) AS count FROM workflow_resource_versions WHERE ${condition}`, [kind, id]),
    getActiveWorkflow(),
  ]);
  const activeIds = [...new Set(active?.graph.nodes.map(node => node.resourceVersionId) ?? [])];
  const activeReferences = activeIds.length ? await getDatabase().all(`SELECT id FROM workflow_resource_versions WHERE ${condition} AND id IN (${activeIds.map(() => '?').join(',')})`, [kind, id, ...activeIds]) : [];
  return { resources, resourceCount: count.count, activeReferenceCount: activeReferences.length, activeRevisionId: active?.id ?? null };
}

export async function uiModelDetail(inputKind: unknown, inputId: unknown) {
  const kind = modelKind(inputKind); const id = uiObjectId(inputId); const original = await modelObject(kind, id);
  if (!original) return null;
  const references = await modelReferences(kind, id); const model = redactReview(original, 0, false);
  return { contractVersion: 1, kind, model, ...references, observedAt: Date.now(), reviewHash: reviewHash({ kind, original, references }),
    effect: 'Gespeichertes Modell. Ressourcenentwurf, Publikation und Graphaktivierung sind getrennte Schritte. Historische Handelspläne bleiben unverändert.' };
}

async function schemaLifecycle(id: string, action: string) {
  if (action === 'delete') return { deleted: await deleteTradingSignalSchema(id) };
  if (action === 'enable' || action === 'disable') return { model: await updateTradingSignalSchema(id, { ...(await getTradingSignalSchemaById(id))!, enabled: action === 'enable' }) };
  throw new Error('Unsupported model action.');
}

async function strategyLifecycle(id: string, action: string) {
  if (action === 'publish') return { model: await publishTradingStrategyVersion(id) };
  if (action === 'archive') return { model: await archiveTradingStrategyVersion(id) };
  if (action === 'delete') return { deleted: await deleteTradingStrategyVersion(id) };
  throw new Error('Unsupported model action.');
}

async function contractLifecycle(id: string, action: string, status: string) {
  if (action === 'publish') return { model: await publishSignalContractVersion(id) };
  if (action === 'archive') return { model: await archiveSignalContractVersion(id) };
  if (action === 'delete') return { deleted: await (status === 'draft' ? deleteSignalContractDraft(id) : deleteSignalContractVersion(id)) };
  throw new Error('Unsupported model action.');
}

async function modelLifecycle(kind: UiModelKind, id: string, action: string, current: any) {
  if (action === 'attach') return { resource: await createWorkflowResourceDraft({ kind, name: current.model.name, description: current.model.description ?? '', configuration: { [MODELS[kind].reference]: id } }) };
  if (kind === 'schema') return schemaLifecycle(id, action);
  if (kind === 'strategy') return strategyLifecycle(id, action);
  return contractLifecycle(id, action, current.model.status);
}

export function mutateUiModel(input: { kind: unknown; id: unknown; action: unknown; reviewHash: unknown }) {
  const kind = modelKind(input.kind); const id = uiObjectId(input.id); const action = uiObjectId(input.action, 16);
  return withDatabaseTransaction(async () => {
    const current = await uiModelDetail(kind, id);
    if (!current || typeof input.reviewHash !== 'string' || input.reviewHash !== current.reviewHash) throw new Error('MODEL_REVIEW_CONFLICT: Model or references changed; review the current version.');
    if (action === 'delete' && current.resourceCount > 0) throw new Error('Retained resource versions still reference this model.');
    if (['archive', 'disable'].includes(action) && current.activeReferenceCount > 0) throw new Error('Active workflow references block this model change.');
    const result = await modelLifecycle(kind, id, action, current);
    return { contractVersion: 1, kind, id, action, ...redactReview(result), observedAt: Date.now(), effect: 'Command committed. No workflow activation or trade execution.' };
  });
}
