import { getDatabase } from './db.js';
import { decodeUiCursor, encodeUiCursor, filterFingerprint } from './ui_cursor.js';
import { redactReview } from './ui_change_review.js';
import { uiObjectId } from './ui_trading_reads.js';

const WORK_SCOPE = `WITH albums AS (
 SELECT * FROM incoming_album_groups WHERE EXISTS (SELECT 1 FROM json_each(work_ids_json) WHERE value=?)
), works AS (
 SELECT id,chat_id,message_id,created_at,workflow_revision_id,status FROM incoming_work WHERE id=?
 OR id IN (SELECT member.value FROM albums,json_each(albums.work_ids_json) member)
), related_signals AS (
 SELECT signals.id FROM signals WHERE EXISTS (SELECT 1 FROM works WHERE works.chat_id=signals.chat_id AND works.message_id=signals.message_id)
)`;
const DEFINITIONS = {
  albums: { from: 'albums', time: '0', id: 'id', fields: 'id,media_group_id AS albumId,chat_id AS channelId,status,ready_at AS readyAt,json_array_length(work_ids_json) AS memberCount', where: '1=1' },
  members: { from: 'works', time: 'created_at', id: 'id', fields: 'id,chat_id AS channelId,message_id AS messageId,status,workflow_revision_id AS workflowRevisionId', where: '1=1' },
  signals: { from: 'signals', time: 'created_at', id: 'id', fields: 'id,chat_id AS channelId,message_id AS messageId,model,parser_version AS parserVersion,prompt_sha256 AS promptSha256,workflow_revision_id AS workflowRevisionId', where: 'id IN (SELECT id FROM related_signals)' },
  tasks: { from: 'pending_tasks', time: 'added_at', id: 'id', fields: `id,status,attempts,substr(last_error,1,2000) AS reason,workflow_revision_id AS workflowRevisionId,ingress_work_id AS ingressWorkId,
    CAST(json_extract(config_json,'$.durableIngress.targetChatId') AS TEXT) AS targetChatId,
    json_extract(result_json,'$.mode') AS deliveryMode,json_extract(result_json,'$.acknowledged') AS acknowledged`, where: 'ingress_work_id IN (SELECT id FROM works)' },
  intents: { from: 'trading_trade_intents', time: 'created_at', id: 'id', fields: 'id,source_signal_id AS signalId,account_id AS accountId,symbol,side,status,workflow_revision_id AS workflowRevisionId,execution_path_id AS executionPathId', where: 'source_signal_id IN (SELECT id FROM related_signals) OR root_source_signal_id IN (SELECT id FROM related_signals)' },
  attempts: { from: 'signal_parser_attempts', time: 'created_at', id: 'id', fields: `id,signal_id AS signalId,
    json_extract(provenance_json,'$.model') AS model,json_extract(provenance_json,'$.parserVersion') AS parserVersion,
    json_extract(provenance_json,'$.templateName') AS templateName,json_extract(provenance_json,'$.schemaName') AS schemaName,
    json_extract(provenance_json,'$.promptSha256') AS promptSha256,json_extract(provenance_json,'$.providerRequestId') AS providerRequestId,
    json_extract(provenance_json,'$.promptTokens') AS promptTokens,json_extract(provenance_json,'$.completionTokens') AS completionTokens,
    json_extract(provenance_json,'$.workflowRevisionId') AS workflowRevisionId`, where: 'signal_id IN (SELECT id FROM related_signals)' },
  runs: { from: 'workflow_signal_runs', time: 'created_at', id: 'id', fields: `id,source_signal_id AS signalId,status,input_sha256 AS inputSha256,workflow_revision_id AS workflowRevisionId,
    substr(error,1,2000) AS reason,json_array_length(result_json,'$.branches') AS branchCount,completed_at AS completedAt`, where: 'source_signal_id IN (SELECT id FROM related_signals)' },
  branches: { from: "workflow_signal_runs r,json_each(r.result_json,'$.branches') branch", time: 'r.created_at', id: "r.id || ':' || printf('%06d',CAST(branch.key AS INTEGER))", fields: `r.id AS runId,
    json_extract(branch.value,'$.routeGroupKey') AS routeGroupKey,json_extract(branch.value,'$.pathId') AS executionPathId,
    json_extract(branch.value,'$.intentId') AS intentId,json_extract(branch.value,'$.status') AS status,
    substr(json_extract(branch.value,'$.reason'),1,2000) AS reason`, where: 'r.source_signal_id IN (SELECT id FROM related_signals)' },
  fallbacks: { from: 'trading_fallback_runs', time: 'created_at', id: 'id', fields: 'id,source_signal_id AS signalId,signal_run_id AS runId,workflow_revision_id AS workflowRevisionId,route_group_key AS routeGroupKey,status,current_rank AS currentRank,selected_intent_id AS intentId,substr(stop_reason,1,2000) AS reason', where: 'source_signal_id IN (SELECT id FROM related_signals)' },
  candidates: { from: 'trading_fallback_candidates c JOIN trading_fallback_runs r ON r.id=c.fallback_run_id', time: 'c.created_at', id: "c.fallback_run_id || ':' || printf('%06d',c.rank)", fields: `c.fallback_run_id AS fallbackRunId,c.rank,c.account_id AS accountId,c.execution_path_id AS executionPathId,c.intent_id AS intentId,
    c.status,c.error_code AS errorCode,substr(json_extract(c.details_json,'$.message'),1,2000) AS reason`, where: 'r.source_signal_id IN (SELECT id FROM related_signals)' },
  plans: { from: "incoming_work w,json_each(w.config_json,'$.durableIngress.workflow.compiled.paths') p", time: 'w.created_at', id: "w.id || ':' || printf('%06d',CAST(p.key AS INTEGER))", fields: `w.id AS ingressWorkId,w.workflow_revision_id AS workflowRevisionId,
    json_extract(p.value,'$.id') AS executionPathId,json_extract(p.value,'$.accountId') AS accountId,
    json_extract(p.value,'$.channelId') AS channelId,json_extract(p.value,'$.routeGroupKey') AS routeGroupKey,
    json_extract(p.value,'$.effectiveConfiguration.resources.parser.templateName') AS templateName,
    json_extract(p.value,'$.effectiveConfiguration.resources.schema.schemaId') AS schemaId,
    json_extract(p.value,'$.effectiveConfiguration.resources.contract.contractVersionId') AS contractVersionId,
    json_extract(p.value,'$.effectiveConfiguration.resources.dedupe.enabled') AS dedupeEnabled,
    json_extract(p.value,'$.effectiveConfiguration.resources.dedupe.cooldownHours') AS dedupeCooldownHours`, where: "w.id IN (SELECT id FROM works) AND json_extract(p.value,'$.channelId')=w.chat_id" },
} as const;
export type UiIngressRelation = keyof typeof DEFINITIONS;

export async function uiIngressRelations(workId: string, kind: UiIngressRelation, query: URLSearchParams) {
  uiObjectId(workId, 256); if (!Object.hasOwn(DEFINITIONS, kind)) throw new Error('Unsupported ingress relation.');
  const definition = DEFINITIONS[kind]; const limit = Number(query.get('limit') || 30);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Ingress relation page size must be 1–100.');
  if (!await getDatabase().get('SELECT id FROM incoming_work WHERE id=?', [workId])) return null;
  const filter = filterFingerprint({ workId, kind, limit }); const cursor = decodeUiCursor(query.get('cursor'), filter);
  const observedAt = cursor?.observedAt ?? Date.now(); const where = [`(${definition.where})`, `${definition.time} <= ?`];
  const values: unknown[] = [workId, workId, observedAt];
  if (cursor) { where.push(`(${definition.time} < ? OR (${definition.time}=? AND (${definition.id}) < ?))`); values.push(cursor.createdAt, cursor.createdAt, cursor.id); }
  const rows = await getDatabase().all(`${WORK_SCOPE} SELECT ${definition.fields},(${definition.id}) AS id,${definition.time} AS createdAt
    FROM ${definition.from} WHERE ${where.join(' AND ')} ORDER BY createdAt DESC,id DESC LIMIT ?`, [...values, limit + 1]);
  const entries = rows.slice(0, limit); const last = entries.at(-1); const hasMore = rows.length > limit;
  return { contractVersion: 1, observedAt, entries: redactReview(entries), hasMore,
    nextCursor: hasMore && last ? encodeUiCursor({ version: 1, filter, observedAt, createdAt: last.createdAt, id: last.id }) : null,
    interpretation: 'Originalbeziehungen dieses Eingangs einschließlich gespeicherter Albummitglieder. Erstellzeit begrenzt die Auswahl; Zustände und Albumzugehörigkeit werden je Seite aktuell gelesen. Gepinnte Pfade sind Konfiguration, keine erfolgreiche Parser-/Dedupe-/Groundingentscheidung. Fehlende Entscheidungsbelege werden nicht aus der heutigen Konfiguration rekonstruiert.' };
}
