import { createHash } from 'node:crypto';
import {
  enqueueOutboxTask, getDatabase, saveIncomingMessage, updateIncomingMessageStatus, withDatabaseTransaction,
} from './db.js';
import { getMessageTextAndType, shouldForward } from './filters.js';
import { getActiveWorkflow, getWorkflowSignalPlans } from './workflow_repository.js';
import { getSignalContractVersion, getTradingSignalSchemaForTemplate, listTradingSignalSchemas } from './trading_repository.js';
import { loadSignalPromptTemplate } from './signal_parser.js';
import { validateSignalXml, type ExecutableSignalSchemaSelection } from './signal_schema.js';

export interface IncomingWork {
  id: string;
  status: string;
  workflowRevisionId: string | null;
}

export function nonSecretConfigSnapshot(config: any): any {
  const forbidden = /(?:secret|password|credential|(?:api|private|encryption).?key|api.?hash|token)$/i;
  return JSON.parse(JSON.stringify(config, (key, value) => forbidden.test(key) ? undefined : value));
}

export function pinnedWorkflowParserSelection(config: any, plan: any): ExecutableSignalSchemaSelection {
  const pinned = config.durableIngress;
  const schema = pinned.schemas.find((candidate: any) => candidate.id === plan.schemaId);
  const contract = pinned.contracts[plan.contractVersionId];
  if (!schema?.enabled || !contract || pinned.workflowRevisionId !== plan.workflowRevisionId) {
    throw new Error('Pinned parser schema, contract or workflow is missing; review required.');
  }
  return { id: schema.id, parserSchema: schema.parserSchema, schemaDefinition: schema.definition,
    contractVersionId: contract.id, contractDefinition: contract.definition };
}

export async function persistedParsedSignal(
  signalId: string, templateName: string | undefined, schema: ExecutableSignalSchemaSelection | null, workflowRevisionId: string | null,
) {
  const existing = await getDatabase().get<any>('SELECT * FROM signals WHERE id = ?', [signalId]);
  if (!existing) return null;
  const attempt = await getDatabase().get<any>('SELECT provenance_json FROM signal_parser_attempts WHERE signal_id = ? ORDER BY created_at LIMIT 1', [signalId]);
  if (existing.workflow_revision_id !== workflowRevisionId || !attempt) throw new Error('Signal provenance conflict; review required.');
  return { xml: existing.xml_content, signal: validateSignalXml(existing.xml_content, templateName, schema),
    provenance: JSON.parse(attempt.provenance_json) };
}

function workId(chatId: string, messageId: number): string {
  return `ingress_${chatId}_${messageId}`;
}

async function pinParserResources(config: any, workflow: any): Promise<void> {
  const ingress = config.durableIngress;
  const schemas = await listTradingSignalSchemas();
  ingress.schemas = schemas;
  ingress.prompts = {};
  ingress.contracts = {};
  for (const candidate of workflow?.compiled.paths ?? []) {
    const resources = candidate.effectiveConfiguration.resources;
    const parser = resources.parser;
    const contract = resources.contract;
    ingress.prompts[parser.templateName] = parser.prompt || (await loadSignalPromptTemplate(parser.templateName)).promptTemplate;
    const version = await getSignalContractVersion(contract.contractVersionId);
    if (!version) throw new Error('Workflow contract is missing; ingress cannot be pinned.');
    ingress.contracts[version.id] = version;
  }
  if (!workflow && config.xmlParsing?.enabled) {
    const template = config.xmlParsing.sourceTemplates?.[ingress.chatId];
    ingress.legacySchema = await getTradingSignalSchemaForTemplate(template);
    ingress.legacyPrompt = (await loadSignalPromptTemplate(template)).promptTemplate;
    ingress.legacyRoute = await getDatabase().get('SELECT * FROM trading_routes WHERE channel_id = ?', [ingress.chatId]) ?? null;
  }
}

/** The Telegram key, complete source payload, and workflow selection share one commit boundary. */
export async function acceptIncomingMessage(message: any, config: any, now = Date.now()): Promise<IncomingWork> {
  const chatId = String(message.chat_id);
  if (!Number.isSafeInteger(message.id)) throw new Error('Incoming message requires a safe Telegram message ID.');
  return withDatabaseTransaction(async database => {
    const existing = await database.get<any>('SELECT * FROM incoming_work WHERE chat_id = ? AND message_id = ?', [chatId, message.id]);
    if (existing) return { id: existing.id, status: existing.status, workflowRevisionId: existing.workflow_revision_id };
    const previousInbox = await database.get<any>('SELECT * FROM incoming_messages WHERE chat_id = ? AND message_id = ?', [chatId, message.id]);
    const id = workId(chatId, message.id);
    const workflow = await getActiveWorkflow();
    const workflowRevisionId = workflow?.id ?? null;
    const snapshot = nonSecretConfigSnapshot(config);
    snapshot.durableIngress = { id, chatId, receivedAt: now, workflowRevisionId,
      targetChatId: config.resolvedTargetChatId ?? null, workflow };
    if (!previousInbox) await pinParserResources(snapshot, workflow);
    const { text, type } = getMessageTextAndType(message);
    await saveIncomingMessage(chatId, message.id, config.sourceAliases?.[chatId] || chatId, text || '', type, 'received');
    const status = previousInbox ? 'needs_review' : 'pending';
    await database.run(
      `INSERT INTO incoming_work VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, chatId, message.id, JSON.stringify(message), JSON.stringify(snapshot), workflowRevisionId, status,
        previousInbox ? 'Existing legacy inbox has no proven durable work; historical replay is blocked.' : null, now, now]
    );
    if (previousInbox) await updateIncomingMessageStatus(chatId, message.id, 'needs_review');
    return { id, status, workflowRevisionId };
  });
}

async function finishClassification(row: any, status: string, reason: string): Promise<void> {
  await getDatabase().run('UPDATE incoming_work SET status = ?, reason = ?, updated_at = ? WHERE id = ?', [status, reason, Date.now(), row.id]);
  await updateIncomingMessageStatus(row.chat_id, row.message_id, status);
}

async function addAlbumPart(row: any, message: any, config: any): Promise<void> {
  const database = getDatabase();
  const id = `album_${row.chat_id}_${message.media_group_id}`;
  const group = await database.get<any>('SELECT * FROM incoming_album_groups WHERE id = ?', [id]);
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

async function routeWorkflowPlans(row: any, config: any, text: string, contentType: string): Promise<void> {
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

async function classifyIncomingRow(row: any): Promise<void> {
  const message = JSON.parse(row.message_json);
  const config = JSON.parse(row.config_json);
  const { text, type } = getMessageTextAndType(message);
  if (row.workflow_revision_id) return routeWorkflowPlans(row, config, text || '', type);
  if (!config.sourceChannels?.map(String).includes(row.chat_id)) {
    await finishClassification(row, 'filtered', 'Source is absent from the transactionally selected workflow and source configuration.');
    return;
  }
  const reasons: string[] = [];
  if (!shouldForward(message, config.filters, reason => reasons.push(reason), row.chat_id, config)) {
    await finishClassification(row, 'filtered', reasons.join('; ') || 'Configured ingress filter.');
    return;
  }
  if (message.media_group_id && message.media_group_id !== '0') {
    if (config.forwardOptions?.forwardToTarget === false) {
      await finishClassification(row, 'filtered', 'Album forwarding is disabled.');
      return;
    }
    return addAlbumPart(row, message, config);
  }
  await enqueueOutboxTask({ id: `single_${row.chat_id}_${row.message_id}`, type: 'single', chatId: row.chat_id,
    messageId: row.message_id, addedAt: row.created_at, config, ingressWorkId: row.id, workflowRevisionId: null });
  await finishClassification(row, 'routed', 'Single-message outbox durably enqueued.');
}

/** No provider calls inside this transaction; restart simply scans remaining pending rows. */
export async function processIncomingWork(limit = 100): Promise<void> {
  const rows = await getDatabase().all<any[]>(
    "SELECT id FROM incoming_work WHERE status = 'pending' ORDER BY created_at, id LIMIT ?", [limit]
  );
  for (const candidate of rows) {
    try {
      await withDatabaseTransaction(async database => {
        const row = await database.get<any>("SELECT * FROM incoming_work WHERE id = ? AND status = 'pending'", [candidate.id]);
        if (row) await classifyIncomingRow(row);
      });
    } catch (error) {
      // Invalid resources remain visible; an unrelated message must continue being classified.
      await withDatabaseTransaction(async database => {
        const row = await database.get<any>('SELECT * FROM incoming_work WHERE id = ?', [candidate.id]);
        await finishClassification(row, 'needs_review', error instanceof Error ? error.message : 'Classification failed.');
      });
    }
  }
}

async function closeAlbum(group: any): Promise<void> {
  const database = getDatabase();
  const rows = await database.all<any[]>(
    'SELECT * FROM incoming_work WHERE id IN (SELECT value FROM json_each(?)) ORDER BY message_id', [group.work_ids_json]
  );
  const config = JSON.parse(group.config_json);
  config.durableIngress.albumMessages = rows.map(row => JSON.parse(row.message_json));
  await enqueueOutboxTask({ id: group.id, type: 'mediaGroup', chatId: group.chat_id,
    messageIds: rows.map(row => row.message_id), mediaGroupId: group.media_group_id,
    addedAt: Math.min(...rows.map(row => row.created_at)), config, ingressWorkId: rows[0].id });
  await database.run("UPDATE incoming_album_groups SET status = 'completed' WHERE id = ?", [group.id]);
  for (const row of rows) await finishClassification(row, 'routed', 'Album closure and child outbox committed together.');
}

export async function flushIncomingAlbums(now = Date.now()): Promise<void> {
  await withDatabaseTransaction(async database => {
    const groups = await database.all<any[]>("SELECT * FROM incoming_album_groups WHERE status = 'waiting' AND ready_at <= ?", [now]);
    for (const group of groups) await closeAlbum(group);
  });
}

/** Local workflow completion publishes independent Telegram effects without re-running the parser on retry. */
export async function enqueueWorkflowOutputs(taskId: string, message: any, config: any, xml: string, modes: Set<string>): Promise<void> {
  for (const mode of modes) {
    if (!['telegram_xml', 'telegram_original'].includes(mode)) continue;
    const digest = createHash('sha256').update(mode).digest('hex').slice(0, 12);
    await enqueueOutboxTask({ id: `${taskId}_output_${digest}`, type: 'single', chatId: String(message.chat_id),
      messageId: message.id, addedAt: config.durableIngress.receivedAt,
      workflowRevisionId: config.durableIngress.workflowRevisionId, ingressWorkId: config.durableIngress.id,
      config: { ...config, durableIngress: { ...config.durableIngress, deliveryMode: mode, parsedXml: xml } } });
  }
}
