import { assertIngressMessage, readIngressMessage } from './ingress_contracts.js';
import type { DurableIngressSnapshot, IngressConfiguration, TelegramMessageIdentity } from './ingress_contracts.js';
import type { WorkflowRevision } from './trading_types.js';
import type { WorkflowSignalPlan } from './workflow_repository.js';
import type { RouteRow } from './trading_repository_rows.js';
import { requireString } from './contract_values.js';
import type { IncomingWorkRow, IncomingAlbumRow } from './incoming_work_rows.js';
import { createHash } from 'node:crypto';
import {
  enqueueOutboxTask, getDatabase, saveIncomingMessage, updateIncomingMessageStatus, withDatabaseTransaction,
} from './db.js';
import { getMessageTextAndType, shouldForward } from './filters.js';
import { getActiveWorkflow, getWorkflowSignalPlans } from './workflow_repository.js';
import { getSignalContractVersion, getTradingSignalSchemaForTemplate, listTradingSignalSchemas } from './trading_repository.js';
import { loadSignalPromptTemplate, type ParsedSignal } from './signal_parser.js';
import { validateSignalXml, type ExecutableSignalSchemaSelection } from './signal_schema.js';

export interface IncomingWork {
  id: string;
  status: string;
  workflowRevisionId: string | null;
}

export function nonSecretConfigSnapshot(config: IngressConfiguration): IngressConfiguration;
export function nonSecretConfigSnapshot(config: Record<string, unknown>): Record<string, unknown>;
export function nonSecretConfigSnapshot(config: object): object {
  const forbidden = /(?:secret|password|credential|(?:api|private|encryption).?key|api.?hash|token)$/i;
  return JSON.parse(JSON.stringify(config, (key: string, value: unknown) => forbidden.test(key) ? undefined : value));
}

function pinnedParserResources(config: IngressConfiguration) {
  const pinned = config.durableIngress;
  if (!pinned?.schemas || !pinned.contracts) throw new Error('Pinned parser resources are missing; review required.');
  return { schemas: pinned.schemas, contracts: pinned.contracts, workflowRevisionId: pinned.workflowRevisionId };
}

export function pinnedWorkflowParserSelection(config: IngressConfiguration, plan: WorkflowSignalPlan): ExecutableSignalSchemaSelection {
  const pinned = pinnedParserResources(config);
  const schema = pinned.schemas.find(candidate => candidate.id === plan.schemaId);
  const contract = pinned.contracts[plan.contractVersionId];
  if (!schema?.enabled || !contract || pinned.workflowRevisionId !== plan.workflowRevisionId) {
    throw new Error('Pinned parser schema, contract or workflow is missing; review required.');
  }
  return { id: schema.id, parserSchema: schema.parserSchema, schemaDefinition: schema.definition,
    contractVersionId: contract.id, contractDefinition: contract.definition };
}

export async function persistedParsedSignal(
  signalId: string, templateName: string | undefined, schema: ExecutableSignalSchemaSelection | null, workflowRevisionId: string | null,
): Promise<ParsedSignal | null> {
  const existing = await getDatabase().get<{ xml_content: string; workflow_revision_id: string | null }>('SELECT * FROM signals WHERE id = ?', [signalId]);
  if (!existing) return null;
  const attempt = await getDatabase().get<{ provenance_json: string }>('SELECT provenance_json FROM signal_parser_attempts WHERE signal_id = ? ORDER BY created_at LIMIT 1', [signalId]);
  if (existing.workflow_revision_id !== workflowRevisionId || !attempt) throw new Error('Signal provenance conflict; review required.');
  return { xml: existing.xml_content, signal: validateSignalXml(existing.xml_content, templateName, schema),
    provenance: JSON.parse(attempt.provenance_json) };
}

function workId(chatId: string, messageId: number): string {
  return `ingress_${chatId}_${messageId}`;
}

function resourceObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Pinned workflow resource must be an object.');
  return value as Record<string, unknown>;
}

async function pinWorkflowParserResources(ingress: DurableIngressSnapshot, workflow: WorkflowRevision): Promise<void> {
  for (const candidate of workflow.compiled.paths) {
    const resources = resourceObject(candidate.effectiveConfiguration.resources);
    const parser = resourceObject(resources.parser);
    const contract = resourceObject(resources.contract);
    const templateName = requireString(parser.templateName, 'Pinned parser template');
    ingress.prompts[templateName] = parser.prompt ? requireString(parser.prompt, 'Pinned parser prompt') : (await loadSignalPromptTemplate(templateName)).promptTemplate;
    const version = await getSignalContractVersion(requireString(contract.contractVersionId, 'Pinned contract version'));
    if (!version) throw new Error('Workflow contract is missing; ingress cannot be pinned.');
    ingress.contracts[version.id] = version;
  }
}

async function pinLegacyParserResources(ingress: DurableIngressSnapshot, xmlParsing: IngressConfiguration['xmlParsing']): Promise<void> {
  const template = xmlParsing.sourceTemplates?.[ingress.chatId];
  ingress.legacySchema = await getTradingSignalSchemaForTemplate(template);
  ingress.legacyPrompt = (await loadSignalPromptTemplate(template)).promptTemplate;
  ingress.legacyRoute = await getDatabase().get<RouteRow>('SELECT * FROM trading_routes WHERE channel_id = ?', [ingress.chatId]) ?? null;
}

async function pinParserResources(config: IngressConfiguration, workflow: WorkflowRevision | null): Promise<void> {
  const ingress = config.durableIngress;
  if (!ingress) throw new Error('Durable ingress identity is missing.');
  ingress.schemas = await listTradingSignalSchemas();
  ingress.prompts = {};
  ingress.contracts = {};
  if (workflow) await pinWorkflowParserResources(ingress, workflow);
  else if (config.xmlParsing?.enabled) await pinLegacyParserResources(ingress, config.xmlParsing);
}

async function incomingSnapshot(config: IngressConfiguration, id: string, chatId: string, now: number, pinResources: boolean) {
  const workflow = await getActiveWorkflow();
  const workflowRevisionId = workflow?.id ?? null;
  const snapshot = nonSecretConfigSnapshot(config);
  snapshot.durableIngress = { id, chatId, receivedAt: now, workflowRevisionId,
    targetChatId: config.resolvedTargetChatId ?? null, workflow };
  if (pinResources) await pinParserResources(snapshot, workflow);
  return { snapshot, workflowRevisionId };
}

async function saveSourceInbox(message: TelegramMessageIdentity, config: IngressConfiguration, chatId: string): Promise<void> {
  const { text, type } = getMessageTextAndType(message);
  await saveIncomingMessage(chatId, message.id, config.sourceAliases?.[chatId] || chatId, text || '', type, 'received');
}

/** The Telegram key, complete source payload, and workflow selection share one commit boundary. */
export async function acceptIncomingMessage(message: TelegramMessageIdentity, config: IngressConfiguration, now = Date.now()): Promise<IncomingWork> {
  assertIngressMessage(message);
  const chatId = String(message.chat_id);
  return await withDatabaseTransaction(async database => {
    const existing = await database.get<IncomingWorkRow>('SELECT * FROM incoming_work WHERE chat_id = ? AND message_id = ?', [chatId, message.id]);
    if (existing) return { id: existing.id, status: existing.status, workflowRevisionId: existing.workflow_revision_id };
    const previousInbox = await database.get<{ chat_id: string; message_id: number }>('SELECT * FROM incoming_messages WHERE chat_id = ? AND message_id = ?', [chatId, message.id]);
    const id = workId(chatId, message.id);
    const { snapshot, workflowRevisionId } = await incomingSnapshot(config, id, chatId, now, !previousInbox);
    await saveSourceInbox(message, config, chatId);
    const status = previousInbox ? 'needs_review' : 'pending';
    await database.run(
      'INSERT INTO incoming_work VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, chatId, message.id, JSON.stringify(message), JSON.stringify(snapshot), workflowRevisionId, status,
        previousInbox ? 'Existing legacy inbox has no proven durable work; historical replay is blocked.' : null, now, now]
    );
    if (previousInbox) await updateIncomingMessageStatus(chatId, message.id, 'needs_review');
    return { id, status, workflowRevisionId };
  });
}

async function finishClassification(row: IncomingWorkRow, status: string, reason: string): Promise<void> {
  await getDatabase().run('UPDATE incoming_work SET status = ?, reason = ?, updated_at = ? WHERE id = ?', [status, reason, Date.now(), row.id]);
  await updateIncomingMessageStatus(row.chat_id, row.message_id, status);
}

async function addAlbumPart(row: IncomingWorkRow, message: TelegramMessageIdentity, config: IngressConfiguration): Promise<void> {
  const database = getDatabase();
  const id = `album_${row.chat_id}_${message.media_group_id}`;
  const group = await database.get<IncomingAlbumRow>('SELECT * FROM incoming_album_groups WHERE id = ?', [id]);
  if (group && group.status !== 'waiting') {
    await finishClassification(row, 'needs_review', 'Album already closed; late part requires explicit review.');
    return;
  }
  const ids: string[] = group ? JSON.parse(group.work_ids_json) : [];
  if (!ids.includes(row.id)) ids.push(row.id);
  await database.run(
    `INSERT INTO incoming_album_groups VALUES (?, ?, ?, ?, ?, ?, 'waiting')
     ON CONFLICT(id) DO UPDATE SET work_ids_json = excluded.work_ids_json, ready_at = excluded.ready_at`,
    [id, row.chat_id, String(message.media_group_id), JSON.stringify(ids), JSON.stringify(config), Date.now() + 800]
  );
  await finishClassification(row, 'album_waiting', 'Waiting for durable album closure.');
}

async function routeWorkflowPlans(row: IncomingWorkRow, config: IngressConfiguration, text: string, contentType: string): Promise<void> {
  const plans = await getWorkflowSignalPlans({ channelId: row.chat_id, text, contentType, workflowRevisionId: row.workflow_revision_id });
  if (plans.length === 0) {
    await finishClassification(row, 'filtered', 'Pinned workflow has no eligible path for this content.');
    return;
  }
  for (const plan of plans) {
    const child = { ...config, durableIngress: { ...config.durableIngress, planKey: plan.key } };
    await enqueueOutboxTask({ id: `${row.id}_${plan.key}`, type: 'single', chatId: row.chat_id,
      messageId: row.message_id, addedAt: row.created_at, config: child,
      workflowRevisionId: row.workflow_revision_id, ingressWorkId: row.id });
  }
  await finishClassification(row, 'routed', 'Pinned workflow fanout durably enqueued.');
}

async function acceptsLegacySource(row: IncomingWorkRow, message: TelegramMessageIdentity, config: IngressConfiguration): Promise<boolean> {
  if (!config.sourceChannels?.map(String).includes(row.chat_id)) {
    await finishClassification(row, 'filtered', 'Source is absent from the transactionally selected workflow and source configuration.');
    return false;
  }
  const reasons: string[] = [];
  if (!shouldForward(message, config.filters, reason => reasons.push(reason), row.chat_id, config)) {
    await finishClassification(row, 'filtered', reasons.join('; ') || 'Configured ingress filter.');
    return false;
  }
  return true;
}

async function routeLegacyAlbum(row: IncomingWorkRow, message: TelegramMessageIdentity, config: IngressConfiguration): Promise<void> {
  if (config.forwardOptions?.forwardToTarget === false) {
    await finishClassification(row, 'filtered', 'Album forwarding is disabled.');
    return;
  }
  await addAlbumPart(row, message, config);
}

async function classifyIncomingRow(row: IncomingWorkRow): Promise<void> {
  const message = readIngressMessage(row.message_json);
  const config: IngressConfiguration = JSON.parse(row.config_json);
  const { text, type } = getMessageTextAndType(message);
  if (row.workflow_revision_id) {
    await routeWorkflowPlans(row, config, text || '', type);
    return;
  }
  if (!await acceptsLegacySource(row, message, config)) return;
  if (message.media_group_id && message.media_group_id !== '0') {
    await routeLegacyAlbum(row, message, config);
    return;
  }
  await enqueueOutboxTask({ id: `single_${row.chat_id}_${row.message_id}`, type: 'single', chatId: row.chat_id,
    messageId: row.message_id, addedAt: row.created_at, config, ingressWorkId: row.id, workflowRevisionId: null });
  await finishClassification(row, 'routed', 'Single-message outbox durably enqueued.');
}

/** No provider calls inside this transaction; restart simply scans remaining pending rows. */
export async function processIncomingWork(limit = 100): Promise<void> {
  const rows = await getDatabase().all<Array<Pick<IncomingWorkRow, 'id'>>>(
    "SELECT id FROM incoming_work WHERE status = 'pending' ORDER BY created_at, id LIMIT ?", [limit]
  );
  for (const candidate of rows) {
    try {
      await withDatabaseTransaction(async database => {
        const row = await database.get<IncomingWorkRow>("SELECT * FROM incoming_work WHERE id = ? AND status = 'pending'", [candidate.id]);
        if (row) await classifyIncomingRow(row);
      });
    } catch (error) {
      // Invalid resources remain visible; an unrelated message must continue being classified.
      await withDatabaseTransaction(async database => {
        const row = await database.get<IncomingWorkRow>('SELECT * FROM incoming_work WHERE id = ?', [candidate.id]);
        if (row) await finishClassification(row, 'needs_review', error instanceof Error ? error.message : 'Classification failed.');
      });
    }
  }
}

async function closeAlbum(group: IncomingAlbumRow): Promise<void> {
  const database = getDatabase();
  const rows = await database.all<IncomingWorkRow[]>(
    'SELECT * FROM incoming_work WHERE id IN (SELECT value FROM json_each(?)) ORDER BY message_id', [group.work_ids_json]
  );
  const config: IngressConfiguration = JSON.parse(group.config_json);
  config.durableIngress.albumMessages = rows.map(row => readIngressMessage(row.message_json));
  await enqueueOutboxTask({ id: group.id, type: 'mediaGroup', chatId: group.chat_id,
    messageIds: rows.map(row => row.message_id), mediaGroupId: group.media_group_id,
    addedAt: Math.min(...rows.map(row => row.created_at)), config, ingressWorkId: rows[0].id });
  await database.run("UPDATE incoming_album_groups SET status = 'completed' WHERE id = ?", [group.id]);
  for (const row of rows) await finishClassification(row, 'routed', 'Album closure and child outbox committed together.');
}

export async function flushIncomingAlbums(now = Date.now()): Promise<void> {
  await withDatabaseTransaction(async database => {
    const groups = await database.all<IncomingAlbumRow[]>("SELECT * FROM incoming_album_groups WHERE status = 'waiting' AND ready_at <= ?", [now]);
    for (const group of groups) await closeAlbum(group);
  });
}

/** Local workflow completion publishes independent Telegram effects without re-running the parser on retry. */
export async function enqueueWorkflowOutputs(taskId: string, message: TelegramMessageIdentity, config: IngressConfiguration, xml: string, modes: Set<string>): Promise<void> {
  for (const mode of modes) {
    if (!['telegram_xml', 'telegram_original'].includes(mode)) continue;
    const digest = createHash('sha256').update(mode).digest('hex').slice(0, 12);
    await enqueueOutboxTask({ id: `${taskId}_output_${digest}`, type: 'single', chatId: String(message.chat_id),
      messageId: message.id, addedAt: config.durableIngress.receivedAt,
      workflowRevisionId: config.durableIngress.workflowRevisionId, ingressWorkId: config.durableIngress.id,
      config: { ...config, durableIngress: { ...config.durableIngress, deliveryMode: mode, parsedXml: xml } } });
  }
}
