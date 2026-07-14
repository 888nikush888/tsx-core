import * as tdl from 'tdl';
import { getTdjson } from 'prebuilt-tdlib';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  canonicalizeResolvedSources,
  readConfigSync,
  writeConfigSync,
  isValidTargetChannel,
  mergeConfigDefaults
} from './config.js';
import { loadEnv } from './env.js';
import { getMessageTextAndType, shouldForward } from './filters.js';
import { ConcurrencyQueue } from './queue.js';
import { isDuplicateSignal, normalizeSignalXml } from './dupe_blocker.js';
import {
  acknowledgeOutboxTask,
  claimOutboxTask,
  closeDb,
  completeOutboxTask,
  enqueueOutboxTask,
  failOutboxTask,
  getMediaGroupBuffers,
  getAiUsage,
  getDatabaseStorageStats,
  getLastForwardedAt,
  getOutboxStatusCounts,
  getTotalForwardedCount,
  incrementForwardedCount,
  initDb,
  isDatabaseHealthy,
  listOutboxTasks,
  markOutboxSending,
  recoverInterruptedOutboxTasks,
  removeMediaGroupBuffer,
  requeueOutboxTask,
  saveIncomingMessage,
  saveMediaGroupBuffer,
  saveSignal,
  updateIncomingMessageStatus
} from './db.js';
import type { OutboxTask, SignalProvenance } from './db.js';
import { startMetricsServer, stopMetricsServer, type OperationalMetrics } from './metrics.js';
import { startWebServer, stopWebServer } from './web_server.js';
import { parseSignalToXml, type AiLimits, type ParsedSignal } from './signal_parser.js';
import { MetricsTracker } from './metrics_tracker.js';
import { TelegramDeliveryTracker } from './delivery_tracker.js';
import { checkCrashLoopFiles } from './crash_guard.js';
import { BackupScheduler } from './backup.js';
import { offsiteBackupFromEnvironment } from './backup_replication.js';
import { OperationalDataRetention, retentionPolicyFromEnvironment } from './retention.js';
import { invokeWithFloodWaitRetry } from './tdlib_retry.js';
import { DeliverySloTracker } from './slo_tracker.js';
import { auditTrailFromEnvironment, type EnterpriseAuditTrail } from './audit_trail.js';
import {
  C_RESET, C_GREEN, C_DARK_GREEN, C_RED,
  clearConsole, pressAnyKey, addLog, clearLogHistory,
  runMenuSystem, runLiveLogScreen, playStartupAnimation, initFileLogger
} from './ui.js';

process.on('uncaughtException', (error: any) => {
  const errMsg = `[FATAL ERROR] Unbehandelte Ausnahme: ${error?.stack || error?.message || error}`;
  console.error(errMsg);
  try {
    addLog(errMsg);
  } catch {
    /* ignore logging failure during fatal crash */
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason: any) => {
  if (reason && reason.message === 'Client was closed') {
    return; // Ignore expected connection close errors
  }
  const errMsg = `[FATAL REJECTION] Unbehandelte Rejection: ${reason?.stack || reason?.message || reason}`;
  console.error(errMsg);
  try {
    addLog(errMsg);
  } catch {
    /* ignore logging failure during fatal rejection */
  }
  process.exit(1);
});

const DEFAULT_PARSER_TIMEOUT_MS = 60000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function checkCrashLoop() {
  try {
    await checkCrashLoopFiles(path.join(__dirname, '../session_data'));
  } catch (err) {
    console.error(`[FATAL] Crash-Loop-Schutz blockiert den Start: ${err.message}`);
    throw err;
  }
}

try { tdl.configure({ tdjson: getTdjson() }); } catch (error) {
  console.error("Fehler beim Initialisieren der TDLib-Bibliothek:", error.message);
  process.exit(1);
}

const forwardQueue = new ConcurrencyQueue(2);
const LEGACY_PERSIST_FILE = './session_data/queue_persist.json';
const LEGACY_MEDIA_BUFFER_FILE = './session_data/media_group_buffer.json';

interface OutboxExecutionContext {
  signal: AbortSignal;
  markSending: () => Promise<void>;
}

let deliveryTracker: TelegramDeliveryTracker | null = null;

function initializeDeliveryTracker(): void {
  const configured = Number(process.env.DELIVERY_CONFIRM_TIMEOUT_MS || 30_000);
  const timeoutMs = Number.isSafeInteger(configured) && configured >= 1_000 && configured <= 300_000 ? configured : 30_000;
  deliveryTracker?.close('Delivery tracker reinitialized.');
  deliveryTracker = new TelegramDeliveryTracker(timeoutMs);
}

function requireDeliveryTracker(): TelegramDeliveryTracker {
  if (!deliveryTracker) throw new Error('Delivery tracker is not initialized.');
  return deliveryTracker;
}

function applyQueueSettings(config: any) {
  const maxConcurrency = config?.forwardOptions?.maxConcurrency ?? 2;
  const queueTimeoutSeconds = config?.forwardOptions?.queueTimeoutSeconds ?? 60;
  forwardQueue.updateSettings(maxConcurrency, queueTimeoutSeconds * 1000);
}

function configSnapshot(config: any): any {
  const forbidden = new Set([
    'apiHash', 'openRouterApiKey', 'OPENROUTER_API_KEY', 'TELEGRAM_API_HASH',
    'DASHBOARD_ADMIN_TOKEN', 'DASHBOARD_VIEWER_TOKEN', 'BACKUP_OFFSITE_TOKEN',
    'BACKUP_ENCRYPTION_KEY', 'ALERT_RELAY_TOKEN', 'ALERT_WEBHOOK_TOKEN',
    'PROMETHEUS_TOKEN', 'AUDIT_WEBHOOK_TOKEN'
  ]);
  return JSON.parse(JSON.stringify(config, (key, value) => forbidden.has(key) ? undefined : value));
}

async function migrateLegacyPersistedTasks(config: any): Promise<void> {
  try {
    const data = await fsPromises.readFile(LEGACY_PERSIST_FILE, 'utf-8');
    const tasks = JSON.parse(data);
    if (!Array.isArray(tasks)) throw new Error('Legacy queue file must contain an array.');
    for (const task of tasks) {
      await enqueueOutboxTask({
        id: String(task.id || ''),
        type: task.type,
        chatId: String(task.chatId || ''),
        messageId: task.messageId,
        messageIds: task.messageIds,
        mediaGroupId: task.mediaGroupId,
        addedAt: Number(task.addedAt) || Date.now(),
        config: configSnapshot(config)
      });
    }
    await fsPromises.unlink(LEGACY_PERSIST_FILE);
    addLog(`[INFO] ${tasks.length} legacy JSON outbox task(s) migrated to SQLite.`);
  } catch (err: any) {
    if (err.code === 'ENOENT') return;
    throw new Error(`Legacy outbox migration failed: ${err.message}`, { cause: err });
  }
}

async function executePersistedOutboxTask(task: OutboxTask, config: any, context: OutboxExecutionContext): Promise<any> {
  if (task.type === 'single') {
    const message = await invokeWithRetry(client, {
      _: 'getMessage',
      chat_id: Number(task.chatId),
      message_id: Number(task.messageId)
    }, context.signal);
    if (!message || Number(message.id) !== Number(task.messageId)) {
      throw new Error(`Could not reload source message ${task.chatId}/${task.messageId}.`);
    }
    return forwardSingleMessage(message, config, context);
  }

  const messages = [];
  for (const messageId of task.messageIds || []) {
    const message = await invokeWithRetry(client, {
      _: 'getMessage',
      chat_id: Number(task.chatId),
      message_id: Number(messageId)
    }, context.signal);
    if (!message || Number(message.id) !== Number(messageId)) {
      throw new Error(`Could not reload album message ${task.chatId}/${messageId}.`);
    }
    messages.push(message);
  }
  if (messages.length !== task.messageIds?.length) {
    throw new Error(`Album ${task.mediaGroupId} could not be reconstructed completely.`);
  }
  return forwardMediaGroup(task.mediaGroupId, config, { messages, fromChatId: Number(task.chatId) }, context);
}

function scheduleOutboxTask(
  taskId: string,
  fallbackConfig: any,
  executeLogic?: (context: OutboxExecutionContext) => Promise<any>
): void {
  forwardQueue.add(async (signal) => {
    const task = await claimOutboxTask(taskId);
    if (!task) return;
    const effectiveConfig = task.config ? mergeConfigDefaults(task.config) : fallbackConfig;
    let deliveryAttempted = false;
    const context: OutboxExecutionContext = {
      signal,
      markSending: async () => {
        await markOutboxSending(task.id);
        if (!deliveryAttempted) {
          deliveryAttempted = true;
          deliverySlo.recordAttempt();
        }
      }
    };
    const startedAt = Date.now();
    addLog(`[INFO] Outbox task ${task.id} claimed.`, {
      correlation_id: task.id,
      event: 'outbox_claimed',
      attempt: task.attempts,
      outcome: 'started'
    });
    try {
      const result = executeLogic
        ? await executeLogic(context)
        : await executePersistedOutboxTask(task, effectiveConfig, context);
      await completeOutboxTask(task.id, result);
      if (deliveryAttempted) deliverySlo.recordConfirmed(Math.max(0, Date.now() - Number(task.addedAt || startedAt)));
      addLog(`[SUCCESS] Outbox task ${task.id} completed.`, {
        correlation_id: task.id,
        event: 'outbox_completed',
        attempt: task.attempts,
        outcome: 'completed',
        latency_ms: Date.now() - startedAt
      });
      return result;
    } catch (error: any) {
      const finalStatus = await failOutboxTask(task.id, error);
      if (deliveryAttempted) deliverySlo.recordFailure(finalStatus === 'unknown' ? 'unknown' : 'failed');
      addLog(`[ERROR] Outbox task ${task.id} failed with status ${finalStatus}: ${error.message}`, {
        correlation_id: task.id,
        event: 'outbox_failed',
        attempt: task.attempts,
        outcome: finalStatus,
        latency_ms: Date.now() - startedAt,
        error_code: String(error?.code || error?.name || 'Error'),
        retryable: finalStatus === 'failed'
      });
      if (finalStatus === 'unknown') {
        addLog(`[CRITICAL] Outbox task ${task.id} has unknown delivery outcome; automatic retry blocked.`);
      }
      throw error;
    }
  }).catch(err => {
    addLog(`[ERROR] Outbox task ${taskId}: ${err.message}`);
  });
}

async function enqueueTask(taskData: any, config: any, executeLogic: (context: OutboxExecutionContext) => Promise<any>): Promise<void> {
  const inserted = await enqueueOutboxTask({ ...taskData, config: configSnapshot(config) });
  if (inserted) {
    deliverySlo.recordAccepted();
    scheduleOutboxTask(taskData.id, config, executeLogic);
  }
  else addLog(`[INFO] Duplicate outbox task ${taskData.id} ignored.`);
}

async function enqueueSingleMessage(message, config) {
  const task = {
    id: `single_${message.chat_id}_${message.id}`,
    type: 'single',
    chatId: String(message.chat_id),
    messageId: message.id,
    addedAt: Date.now()
  };
  await enqueueTask(
    task,
    config,
    (context) => forwardSingleMessage(message, config, context)
  );
}

async function enqueueMediaGroup(gId, config, g) {
  const task = {
    id: `group_${g.fromChatId}_${gId}`,
    type: 'mediaGroup',
    chatId: String(g.fromChatId),
    mediaGroupId: gId,
    messageIds: g.messages.map(m => m.id),
    addedAt: Date.now()
  };
  await enqueueTask(
    task,
    config,
    (context) => forwardMediaGroup(gId, config, g, context)
  );
}

async function resumePersistedTasks(config: any): Promise<void> {
  await migrateLegacyPersistedTasks(config);
  const recovery = await recoverInterruptedOutboxTasks();
  if (recovery.requeued > 0) addLog(`[WARN] Safely requeued ${recovery.requeued} task(s) interrupted before provider send.`);
  if (recovery.unknown > 0) addLog(`[CRITICAL] ${recovery.unknown} task(s) stopped during provider send and require reconciliation.`);

  const pendingTasks = await listOutboxTasks(['pending'], 1000);
  const unresolvedTasks = await listOutboxTasks(['failed', 'unknown'], 1000);
  if (unresolvedTasks.length > 0) {
    addLog(`[ERROR] ${unresolvedTasks.length} failed/unknown outbox task(s) retained for operator recovery.`);
  }
  if (pendingTasks.length > 0) addLog(`[INFO] Resuming ${pendingTasks.length} durable outbox task(s).`);
  for (const task of pendingTasks) scheduleOutboxTask(task.id, config);
}

async function retryPersistedTask(taskId: string, config: any): Promise<boolean> {
  if (!await requeueOutboxTask(taskId)) return false;
  scheduleOutboxTask(taskId, config);
  return true;
}

const mediaGroupBuffer = new Map();
const ALBUM_DELAY_MS = 800;
let client = null, targetChatId = null;
let metricsTracker: MetricsTracker | null = null;
let backupScheduler: BackupScheduler | null = null;
let retentionScheduler: OperationalDataRetention | null = null;
let auditTrail: EnterpriseAuditTrail | null = null;
let processLockPath = path.join(process.cwd(), 'session_data', '.process_active');
const state = {
  isRunning: false,
  connectionState: 'disconnected',
  resolvedSourceChatIds: new Set(),
  totalForwardedCount: 0,
  processedSinceRestart: 0,
  lastSuccessfulForwardAt: null as number | null,
  startupTime: null as number | null
};
const deliverySlo = new DeliverySloTracker();

async function recordForwardedMessages(amount = 1) {
  const forwardedAt = Date.now();
  state.totalForwardedCount += amount;
  state.processedSinceRestart += amount;
  state.lastSuccessfulForwardAt = forwardedAt;
  try {
    await incrementForwardedCount(amount, forwardedAt);
  } catch (error: any) {
    addLog(`[WARN] Weiterleitungszähler konnte nicht gespeichert werden: ${error.message}`);
  }
}

async function availableDiskBytes(databasePath: string): Promise<number> {
  const stats = await fsPromises.statfs(path.dirname(databasePath));
  const available = Number(stats.bavail) * Number(stats.bsize);
  if (!Number.isSafeInteger(available) || available < 0) {
    throw new Error('Operational filesystem reported an invalid available byte count.');
  }
  return available;
}

function backupMetricSnapshot(): Pick<OperationalMetrics,
  | 'backupHealthy'
  | 'backupLastSuccessAt'
  | 'backupOffsiteHealthy'
  | 'backupOffsiteRequired'
  | 'backupOffsiteLastSuccessAt'
> {
  const backup = backupScheduler?.getStatus();
  if (!backup) return {
    backupHealthy: false,
    backupLastSuccessAt: null,
    backupOffsiteHealthy: false,
    backupOffsiteRequired: false,
    backupOffsiteLastSuccessAt: null
  };
  return {
    backupHealthy: backup.healthy,
    backupLastSuccessAt: backup.lastSuccessAt,
    backupOffsiteHealthy: backup.offsiteHealthy,
    backupOffsiteRequired: backup.offsiteRequired,
    backupOffsiteLastSuccessAt: backup.lastOffsiteSuccessAt
  };
}

function retentionMetricSnapshot(): Pick<OperationalMetrics,
  | 'retentionHealthy'
  | 'retentionLastSuccessAt'
  | 'retentionDeletedTotal'
  | 'retentionBacklog'
  | 'databaseAllocatedBytes'
  | 'databaseReusableBytes'
> {
  const retention = retentionScheduler?.getStatus();
  if (!retention) {
    return {
      retentionHealthy: false,
      retentionLastSuccessAt: null,
      retentionDeletedTotal: 0,
      retentionBacklog: false,
      databaseAllocatedBytes: 0,
      databaseReusableBytes: 0
    };
  }
  return {
    retentionHealthy: retention.healthy,
    retentionLastSuccessAt: retention.lastSuccessAt,
    retentionDeletedTotal: retention.deletedTotal,
    retentionBacklog: retention.backlog,
    databaseAllocatedBytes: retention.allocatedBytes,
    databaseReusableBytes: retention.reusableBytes
  };
}

function auditMetricSnapshot(): Pick<OperationalMetrics,
  | 'auditHealthy'
  | 'auditRemoteRequired'
  | 'auditLastRemoteSuccessAt'
> {
  const audit = auditTrail?.snapshot();
  return {
    auditHealthy: audit?.healthy ?? false,
    auditRemoteRequired: audit?.remoteRequired ?? false,
    auditLastRemoteSuccessAt: audit?.lastRemoteSuccessAt ?? null
  };
}

async function collectOperationalMetrics(
  databasePath: string,
  minimumFreeBytes: number
): Promise<OperationalMetrics> {
  const databaseHealthy = await isDatabaseHealthy();
  const diskAvailableBytes = await availableDiskBytes(databasePath);
  const diskCapacityHealthy = diskAvailableBytes >= minimumFreeBytes;
  const emptyOutbox = { pending: 0, preparing: 0, sending: 0, completed: 0, failed: 0, unknown: 0 };
  const base = {
    databaseHealthy,
    isRunning: state.isRunning,
    connectionState: state.connectionState,
    queuePaused: forwardQueue.paused,
    lastForwardedAt: state.lastSuccessfulForwardAt,
    ...backupMetricSnapshot(),
    ...retentionMetricSnapshot(),
    ...auditMetricSnapshot(),
    diskAvailableBytes,
    diskCapacityHealthy,
    deliverySlo: deliverySlo.snapshot()
  };
  if (!databaseHealthy) {
    return {
      ...base,
      outbox: emptyOutbox,
      aiRequestsToday: 0,
      aiUsedTokensToday: 0,
      aiReservedTokensToday: 0
    };
  }

  const [outbox, aiUsage, storage] = await Promise.all([
    getOutboxStatusCounts(),
    getAiUsage(new Date().toISOString().slice(0, 10)),
    getDatabaseStorageStats()
  ]);
  return {
    ...base,
    outbox,
    aiRequestsToday: aiUsage.requestCount,
    aiUsedTokensToday: aiUsage.usedTokens,
    aiReservedTokensToday: aiUsage.reservedTokens,
    databaseAllocatedBytes: storage.allocatedBytes,
    databaseReusableBytes: storage.reusableBytes
  };
}

async function invokeWithRetry(tdClient, query, signal: AbortSignal | null = null, maxAttempts = 3) {
  return invokeWithFloodWaitRetry(tdClient, query, {
    signal,
    maxAttempts,
    maxFloodWaitSeconds: 60,
    logger: addLog
  });
}

async function parseSignalNative(
  text: string,
  timeoutMs: number,
  templateName: string | null = null,
  models: { primaryModel?: string; fallbackModel?: string } = {},
  signal: AbortSignal | null = null,
  limits?: Partial<AiLimits>
): Promise<ParsedSignal> {
  if (signal?.aborted) throw new Error('Task aborted');
  const effectiveTimeout = timeoutMs || DEFAULT_PARSER_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, effectiveTimeout);

  try {
    return await parseSignalToXml(text, templateName || undefined, models, {
      signal: controller.signal,
      limits
    });
  } catch (error: any) {
    if (timedOut) throw new Error(`Parser Timeout (${effectiveTimeout}ms)`, { cause: error });
    if (signal?.aborted) throw new Error('Task aborted', { cause: error });
    throw error;
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function resolveChatId(identifier) {
  const idStr = String(identifier).trim();
  
  if (/^-?\d+$/.test(idStr)) {
    // Es ist eine ID. Versuche zuerst getChat für alle IDs.
    // TDLib erwartet für chat_id oft eine Zahl, wenn es in int53 passt.
    // In tdl kann man meist Strings oder Number übergeben.
    
    try {
      const chat = await invokeWithRetry(client, { _: 'getChat', chat_id: Number(idStr) });
      return String(chat.id);
    } catch (e) {
      addLog(`[DEBUG] getChat für ${idStr} fehlgeschlagen: ${e.message}`);
      
      // Fallback für Supergroups / Channels, falls getChat fehlschlägt (oft weil der Chat nicht geladen ist)
      if (idStr.startsWith('-100')) {
        try {
          const supergroupId = Number(idStr.slice(4));
          const chat = await invokeWithRetry(client, { _: 'createSupergroupChat', supergroup_id: supergroupId, force: false });
          return String(chat.id);
        } catch (e2) { 
          addLog(`[DEBUG] Supergroup-Fallback für ${idStr} fehlgeschlagen: ${e2.message}`); 
        }
      }
    }
    throw new Error(`Kanal mit ID ${idStr} konnte nicht geladen werden.`);
  }
  
  const username = idStr.startsWith('@') ? idStr.slice(1) : idStr;
  try {
    const chat = await client.invoke({ _: 'searchPublicChat', username });
    return String(chat.id);
  } catch (e) { throw new Error(`Kanal @${username} nicht gefunden (${e.message})`, { cause: e }); }
}

async function resolveConfiguredSources(config) {
  const resolutions: Array<{ configured: string; canonicalId: string }> = [];
  for (const source of config.sourceChannels) {
    const canonicalId = await resolveChatId(source);
    resolutions.push({ configured: source, canonicalId });
    addLog(`[SUCCESS] Quell-Knoten geladen: ${source} -> ${canonicalId}`);
  }

  const canonicalized = canonicalizeResolvedSources(config, resolutions);
  if (canonicalized.changed) {
    Object.assign(config, canonicalized.config);
    writeConfigSync(config);
    addLog('[INFO] Quellenidentitäten, Filter und KI-Templates wurden atomar auf numerische Telegram-IDs migriert.');
  }

  state.resolvedSourceChatIds.clear();
  for (const sourceId of canonicalized.config.sourceChannels) {
    state.resolvedSourceChatIds.add(sourceId);
  }
}

function isForwardRestrictedError(error: any): boolean {
  const message = String(error?.message || error || '');
  return /CHAT_FORWARDS_RESTRICTED|MESSAGE_COPY_FORBIDDEN|CONTENT_RESTRICTED/i.test(message);
}

async function tryManualCopyFallback(message, context: OutboxExecutionContext) {
  const content = message.content;
  if (!content) throw new Error(`Message ${message.id} has no content for manual-copy fallback.`);
  
  let formattedText = null;
  if (content._ === 'messageText') {
    formattedText = content.text;
  } else if (content.caption) {
    formattedText = content.caption;
  }
  
  if (formattedText && formattedText.text?.trim()) {
    addLog(`[Forward Fallback] Kanal geschützt. Versuche Text manuell zu kopieren und zu senden...`);
    if (context.signal.aborted) throw new Error('Task aborted before manual-copy fallback.');
    const response = await invokeWithRetry(client, {
      _: 'sendMessage', chat_id: targetChatId,
      input_message_content: {
        _: 'inputMessageText',
        text: formattedText,
        clear_draft: true
      }
    }, context.signal);
    const confirmation = await requireDeliveryTracker().waitForResult(response, context.signal);
    addLog(`[SUCCESS] Paket ${message.id} manuell als Text kopiert und bestätigt.`);
    await recordForwardedMessages();
    return { mode: 'manual-copy', ...confirmation };
  }
  throw new Error(`Message ${message.id} has no text that can be used for manual-copy fallback.`);
}

async function forwardRawMessage(message, config, context: OutboxExecutionContext) {
  addLog(`[Forward] Route Einzelpaket ${message.id} an Ziel-Knoten...`);
  if (context.signal.aborted) throw new Error('Task aborted before Telegram send.');
  await context.markSending();
  try {
    const response = await invokeWithRetry(client, {
      _: 'forwardMessages', chat_id: targetChatId, from_chat_id: message.chat_id, message_ids: [message.id],
      options: { _: 'sendMessageOptions' }, as_album: false,
      send_copy: !!config.forwardOptions?.sendCopy, remove_caption: !!config.forwardOptions?.removeCaption
    }, context.signal);
    const confirmation = await requireDeliveryTracker().waitForResult(response, context.signal);
    addLog(`[SUCCESS] Paket ${message.id} erfolgreich übertragen und bestätigt.`);
    await recordForwardedMessages();
    updateIncomingMessageStatus(String(message.chat_id), message.id, 'processed')
      .catch(error => addLog(`[WARN] Inbox status update failed for ${message.id}: ${error.message}`));
    return { mode: 'telegram-forward', ...confirmation };
  } catch (error: any) {
    addLog(`[ERROR] Übertragungsfehler bei Paket ${message.id}: ${error.message}`);
    updateIncomingMessageStatus(String(message.chat_id), message.id, 'failed')
      .catch(statusError => addLog(`[WARN] Inbox failure status update failed for ${message.id}: ${statusError.message}`));
    if (config.forwardOptions?.sendCopy && isForwardRestrictedError(error)) {
      return tryManualCopyFallback(message, context);
    }
    throw error;
  }
}

async function checkDuplicateAndSave(
  message,
  xmlString,
  xmlParsing,
  dupeBlocker,
  provenance?: SignalProvenance
) {
  const signalId = `signal_${message.chat_id}_${message.id}`;
  if (dupeBlocker.enabled) {
    const baseDir = xmlParsing.signalsDir || './signals';
    const cooldown = dupeBlocker.cooldownHours !== undefined ? dupeBlocker.cooldownHours : 24;
    const dupeResult = await isDuplicateSignal(xmlString, baseDir, cooldown, signalId);
    if (dupeResult.isDupe) {
      addLog(`[DUPE-BLOCKER] Paket ${message.id} blockiert: ${dupeResult.reason}`);
      updateIncomingMessageStatus(String(message.chat_id), message.id, 'duplicate')
        .catch(error => addLog(`[WARN] Inbox duplicate status update failed for ${message.id}: ${error.message}`));
      return true;
    }
  }
  
  if (xmlParsing.saveToFile) {
    const baseDir = xmlParsing.signalsDir || './signals';
    const channelDir = path.join(baseDir, String(message.chat_id));
    await fsPromises.mkdir(channelDir, { recursive: true });
    await fsPromises.writeFile(path.join(channelDir, `signal_${message.id}.xml`), xmlString, 'utf-8');
  }

  const normalizedNew = normalizeSignalXml(xmlString);
  await saveSignal(signalId, String(message.chat_id), message.id, xmlString, normalizedNew, provenance);
  
  return false;
}

async function sendXmlMessage(xmlString, context: OutboxExecutionContext) {
  addLog(`[Forward] Sende extrahiertes XML...`);
  if (context.signal.aborted) throw new Error('Task aborted before XML send.');
  await context.markSending();
  const response = await invokeWithRetry(client, {
    _: 'sendMessage', chat_id: targetChatId,
    input_message_content: { _: 'inputMessageText', text: { _: 'formattedText', text: xmlString } }
  }, context.signal);
  const confirmation = await requireDeliveryTracker().waitForResult(response, context.signal);
  await recordForwardedMessages();
  return { mode: 'xml-forward', ...confirmation };
}

async function processXmlSignal(message, text, xmlParsing, dupeBlocker, shouldForwardToTelegram, context: OutboxExecutionContext) {
  addLog(`[XML-Parser] Analysiere Signal-Text für Paket ${message.id}...`);
  const forwardXml = shouldForwardToTelegram && xmlParsing.forwardXmlToTarget;
  try {
    const sourceId = String(message.chat_id);
    const sourceTemplates = xmlParsing.sourceTemplates || {};
    const templateName = sourceTemplates[sourceId];
    
    const parsedSignal = await parseSignalNative(
      text,
      xmlParsing.timeout || DEFAULT_PARSER_TIMEOUT_MS,
      templateName,
      {
        primaryModel: xmlParsing.primaryModel,
        fallbackModel: xmlParsing.fallbackModel
      },
      context.signal,
      xmlParsing.aiLimits
    );
    addLog(`[XML-Parser SUCCESS] Paket ${message.id} erfolgreich analysiert.`);
    
    const isDupe = await checkDuplicateAndSave(
      message,
      parsedSignal.xml,
      xmlParsing,
      dupeBlocker,
      parsedSignal.provenance
    );
    if (isDupe) return { handled: true, result: { mode: 'duplicate-blocked' } };
    
    if (forwardXml) {
      const result = await sendXmlMessage(parsedSignal.xml, context);
      updateIncomingMessageStatus(String(message.chat_id), message.id, 'processed')
        .catch(error => addLog(`[WARN] Inbox status update failed for ${message.id}: ${error.message}`));
      return { handled: true, result };
    }
    
    if (!shouldForwardToTelegram) {
      updateIncomingMessageStatus(String(message.chat_id), message.id, 'processed')
        .catch(error => addLog(`[WARN] Inbox status update failed for ${message.id}: ${error.message}`));
      return { handled: true, result: { mode: 'local-signal-only' } };
    }
  } catch (error: any) {
    addLog(`[XML-Parser ERROR] Paket ${message.id}: ${error.message}`);
    updateIncomingMessageStatus(String(message.chat_id), message.id, 'failed')
      .catch(statusError => addLog(`[WARN] Inbox failure status update failed for ${message.id}: ${statusError.message}`));
    if (forwardXml || !shouldForwardToTelegram) {
      throw error;
    }
  }
  return { handled: false };
}

async function forwardSingleMessage(message, config, context: OutboxExecutionContext) {
  if (context.signal.aborted) throw new Error('Task aborted');
  const { text } = getMessageTextAndType(message);
  const shouldForwardToTelegram = config.forwardOptions?.forwardToTarget ?? true;

  const xmlParsing = config.xmlParsing || {};
  const dupeBlocker = config.dupeBlocker || {};

  let xmlResult = { handled: false } as { handled: boolean; result?: any };
  if (xmlParsing.enabled && text?.trim()) {
    xmlResult = await processXmlSignal(message, text, xmlParsing, dupeBlocker, shouldForwardToTelegram, context);
  }

  if (xmlResult.handled) return xmlResult.result;
  if (shouldForwardToTelegram) {
    return forwardRawMessage(message, config, context);
  }
  throw new Error(`Message ${message.id} produced no configured side effect.`);
}

async function migrateLegacyMediaGroupBuffer(): Promise<void> {
  try {
    const raw = await fsPromises.readFile(LEGACY_MEDIA_BUFFER_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Legacy media buffer must contain an object.');
    }
    for (const [groupId, group] of Object.entries<any>(data)) {
      if (!group || !Array.isArray(group.messages) || group.messages.length === 0) {
        throw new Error(`Legacy media group ${groupId} is invalid.`);
      }
      await saveMediaGroupBuffer(groupId, String(group.fromChatId), group.messages);
    }
    await fsPromises.unlink(LEGACY_MEDIA_BUFFER_FILE);
    addLog(`[INFO] ${Object.keys(data).length} legacy media buffer group(s) migrated to SQLite.`);
  } catch (err: any) {
    if (err.code === 'ENOENT') return;
    throw new Error(`Legacy media-buffer migration failed: ${err.message}`, { cause: err });
  }
}

async function loadAndResumeMediaGroupBuffer(config) {
  await migrateLegacyMediaGroupBuffer();
  const data = await getMediaGroupBuffers();
  const groupIds = Object.keys(data);
  if (groupIds.length === 0) return;
  addLog(`[INFO] Recovering ${groupIds.length} incomplete album(s) from SQLite.`);
  for (const groupId of groupIds) {
    await enqueueMediaGroup(groupId, config, data[groupId]);
    await removeMediaGroupBuffer(groupId);
  }
}

async function handleMediaGroupMessage(message, config) {
  const gId = message.media_group_id;
  if (!mediaGroupBuffer.has(gId)) mediaGroupBuffer.set(gId, { messages: [], fromChatId: message.chat_id, timer: null });
  const g = mediaGroupBuffer.get(gId);
  if (g.timer) clearTimeout(g.timer);
  g.messages.push(message);
  await saveMediaGroupBuffer(String(gId), String(g.fromChatId), g.messages);

  g.timer = setTimeout(() => {
    void (async () => {
      mediaGroupBuffer.delete(gId);
      try {
        await enqueueMediaGroup(gId, config, g);
        await removeMediaGroupBuffer(String(gId));
      } catch (err: any) {
        addLog(`[ERROR] Album buffer promotion failed for ${gId}: ${err.message}`);
      }
    })();
  }, ALBUM_DELAY_MS);
}


// Gruppen-Objekt wird jetzt direkt als Parameter übergeben statt aus der Map gelesen
async function forwardMediaGroup(gId, config, g, context: OutboxExecutionContext) {
  if (context.signal.aborted) throw new Error('Task aborted');
  if (!g || !Array.isArray(g.messages) || g.messages.length === 0) throw new Error(`Album ${gId} is empty.`);
  g.messages.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  const ids = g.messages.map(m => m.id);
  addLog(`[Forward] Route Album-Paketgruppe ${gId} (${ids.length} Teile) an Ziel-Knoten...`);
  try {
    await context.markSending();
    const response = await invokeWithRetry(client, {
      _: 'forwardMessages', chat_id: targetChatId, from_chat_id: g.fromChatId, message_ids: ids,
      options: { _: 'sendMessageOptions' }, as_album: true,
      send_copy: !!config.forwardOptions?.sendCopy, remove_caption: !!config.forwardOptions?.removeCaption
    }, context.signal);
    const confirmation = await requireDeliveryTracker().waitForResult(response, context.signal);
    addLog(`[SUCCESS] Album-Paketgruppe ${gId} erfolgreich übertragen und bestätigt.`);
    await recordForwardedMessages(ids.length);
    for (const msg of g.messages) {
      updateIncomingMessageStatus(String(msg.chat_id), msg.id, 'processed')
        .catch(error => addLog(`[WARN] Inbox status update failed for ${msg.id}: ${error.message}`));
    }
    return { mode: 'telegram-album', ...confirmation };
  } catch (error: any) {
    for (const msg of g.messages) {
      updateIncomingMessageStatus(String(msg.chat_id), msg.id, 'failed')
        .catch(statusError => addLog(`[WARN] Inbox failure status update failed for ${msg.id}: ${statusError.message}`));
    }
    throw error;
  }
}

async function routeIncomingMessage(message: any, config: any): Promise<void> {
  const chatId = String(message.chat_id);
  if (!state.resolvedSourceChatIds.has(chatId) || message.is_outgoing) return;

  const { text, type } = getMessageTextAndType(message);
  const sender = config.sourceAliases?.[chatId] || chatId;
  const inserted = await saveIncomingMessage(chatId, message.id, sender, text || '', type, 'received');
  if (!inserted) {
    addLog(`[INFO] Duplicate incoming message ${chatId}/${message.id} ignored.`);
    return;
  }

  addLog(`[INFO] Neues Datenpaket ${message.id} an Quell-Knoten ${chatId} abgefangen.`);
  if (!shouldForward(message, config.filters, addLog, chatId, config)) {
    await updateIncomingMessageStatus(chatId, message.id, 'filtered');
    return;
  }
  if (!message.media_group_id || message.media_group_id === '0') {
    await enqueueSingleMessage(message, config);
    return;
  }
  if (config.forwardOptions?.forwardToTarget ?? true) {
    await handleMediaGroupMessage(message, config);
    return;
  }
  addLog(`[INFO] Album-Paketgruppe ${message.media_group_id} übersprungen (Weiterleitung deaktiviert).`);
}

async function handleUpdate(update: any, config: any): Promise<void> {
  deliveryTracker?.handleUpdate(update);
  if (update._ === 'updateConnectionState') {
    addLog(`[TDLib Status] Verbindungszustand geändert: ${update.state?._ || 'unknown'}`);
  }
  if (update._ === 'updateNewMessage') await routeIncomingMessage(update.message, config);
}

async function stopForwarding() {
  addLog("[INFO] Stoppe Weiterleitung...");
  state.isRunning = false;
  state.connectionState = 'disconnected';
  state.startupTime = null;
  state.resolvedSourceChatIds.clear();
  forwardQueue.pause();
  forwardQueue.clear();
  forwardQueue.abortRunning('Routing stopped by operator.');
  const drained = await forwardQueue.waitForIdle(getShutdownGraceMs());
  if (!drained) {
    addLog('[CRITICAL] Laufende Queue-Tasks konnten nicht innerhalb der Shutdown-Frist beendet werden.');
  }

  if (client) {
    try {
      await client.close();
    } catch (error: any) {
      addLog(`[WARN] TDLib client close failed while stopping routing: ${error.message}`);
    }
    client = null;
  }
  if (!drained) {
    throw new Error('Forward queue did not drain; restart the process before routing again.');
  }
  try {
    await fsPromises.unlink('./session_data/.routing_active');
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
  }
  addLog("[SUCCESS] Weiterleitung gestoppt!");
}

function routingCredentials(config: any): { apiId: number; apiHash: string } {
  const apiId = process.env.TELEGRAM_API_ID ? parseInt(process.env.TELEGRAM_API_ID, 10) : config.apiId;
  return { apiId, apiHash: process.env.TELEGRAM_API_HASH || '' };
}

function routingConfigurationIsComplete(config: any, apiId: number, apiHash: string): boolean {
  return Boolean(
    apiId
    && /^[a-f0-9]{32}$/i.test(apiHash)
    && config.sourceChannels.length > 0
    && isValidTargetChannel(config.targetChannel)
  );
}

async function preloadTelegramChats(): Promise<void> {
  for (const list of [{ _: 'chatListMain' }, { _: 'chatListArchive' }]) {
    try {
      for (let index = 0; index < 15; index++) {
        await client.invoke({ _: 'loadChats', chat_list: list, limit: 100 });
      }
    } catch (error: any) {
      if (error.message && !error.message.includes('CHAT_LIST_LOAD')) {
        addLog(`[WARN] loadChats (${list._}): ${error.message}`);
      }
    }
  }
}

function attachTelegramUpdateHandler(config: any): void {
  client.on('update', update => {
    void handleUpdate(update, config).catch(error => {
      addLog(`[ERROR] Telegram update handling failed: ${error.message}`);
    });
  });
}

async function writeRoutingActiveMarker(): Promise<void> {
  try {
    await fsPromises.mkdir('./session_data', { recursive: true });
    await fsPromises.writeFile('./session_data/.routing_active', 'active', 'utf-8');
  } catch (error: any) {
    addLog(`[WARN] Konnte Lockfile nicht erstellen: ${error.message}`);
  }
}

async function connectAndActivateRouting(
  config: any,
  apiId: number,
  apiHash: string,
  resetLogs: boolean,
  activeMessage: string
): Promise<void> {
  state.connectionState = 'connecting';
  client = tdl.createClient({ apiId, apiHash, databaseDirectory: './session_data', filesDirectory: './session_files' });
  client.on('error', err => {
    state.connectionState = 'error';
    addLog(`[TDLib Fehler] ${err.message || err}`);
  });
  await client.login();
  state.connectionState = 'connected';
  if (resetLogs) clearLogHistory();
  addLog("[SUCCESS] Mainframe-Verbindung autorisiert!");
  await preloadTelegramChats();
  await resolveConfiguredSources(config);
  targetChatId = await resolveChatId(config.targetChannel);
  addLog(`[SUCCESS] Ziel-Knoten geladen: ${config.targetChannel} -> ${targetChatId}`);
  attachTelegramUpdateHandler(config);
  state.startupTime = Math.floor(Date.now() / 1000);
  state.isRunning = true;
  addLog(activeMessage);
  await writeRoutingActiveMarker();
  forwardQueue.resume();
  await resumePersistedTasks(config);
  await loadAndResumeMediaGroupBuffer(config);
}

async function cleanupFailedRoutingStart(reason: string): Promise<boolean> {
  state.isRunning = false;
  state.startupTime = null;
  state.resolvedSourceChatIds.clear();
  targetChatId = null;
  forwardQueue.pause();
  forwardQueue.clear();
  forwardQueue.abortRunning(reason);
  const drained = await forwardQueue.waitForIdle(getShutdownGraceMs());
  if (client) {
    try {
      await client.close();
    } catch (error: any) {
      addLog(`[WARN] TDLib client close failed after startup error: ${error.message}`);
    }
    client = null;
  }
  if (drained) {
    try {
      await fsPromises.unlink('./session_data/.routing_active');
    } catch (error: any) {
      if (error.code !== 'ENOENT') addLog(`[WARN] Routing lock cleanup failed after startup error: ${error.message}`);
    }
  }
  return drained;
}

async function startForwardingNonInteractive(config) {
  if (forwardQueue.running > 0) throw new Error('Cannot start routing while previous queue tasks are still running.');
  applyQueueSettings(config);
  const { apiId, apiHash } = routingCredentials(config);
  if (!routingConfigurationIsComplete(config, apiId, apiHash)) {
    addLog("[ERROR] Konfiguration unvollständig! Bitte apiId, TELEGRAM_API_HASH, sourceChannels und targetChannel prüfen.");
    throw new Error('Non-interactive routing configuration is incomplete.');
  }

  try {
    addLog("[INFO] Verbinde mit Telegram Mainframe...");
    await connectAndActivateRouting(config, apiId, apiHash, false, "[SUCCESS] Mainframe-Routing aktiv!");
  } catch (error: any) {
    state.connectionState = 'error';
    addLog(`[FATAL] Fehler beim Starten des Forwardings: ${error.message}`);
    const drained = await cleanupFailedRoutingStart('Non-interactive startup failed.');
    if (!drained) addLog('[CRITICAL] Queue did not drain after non-interactive startup failure.');
    throw error;
  }
}

async function startForwarding(config) {
  if (forwardQueue.running > 0) throw new Error('Cannot start routing while previous queue tasks are still running.');
  applyQueueSettings(config);
  const { apiId, apiHash } = routingCredentials(config);
  if (!routingConfigurationIsComplete(config, apiId, apiHash)) {
    console.log(`\n${C_RED}FEHLER: Konfiguration unvollständig!${C_RESET}\n${C_GREEN}Beliebige Taste drücken...${C_RESET}`);
    await pressAnyKey(); return 'main';
  }
  clearConsole();
  console.log(`${C_DARK_GREEN}===================================================\n Verbinde mit Telegram Mainframe... Bitte warten.\n===================================================${C_RESET}`);
  try {
    await connectAndActivateRouting(config, apiId, apiHash, true, "[SUCCESS] Mainframe-Routing aktiv!");
    await runLiveLogScreen(
      config,
      client,
      () => state.totalForwardedCount,
      async () => {
        await stopForwarding();
      },
      (cmd) => {
        if (cmd === 'p') {
          forwardQueue.pause();
          addLog("[WARN] Weiterleitung PAUSIERT. Nachrichten werden in der Queue gesammelt.");
        } else if (cmd === 'r') {
          forwardQueue.resume();
          addLog("[SUCCESS] Weiterleitung REAKTIVIERT. Abarbeitung fortgesetzt.");
        }
      },
      () => forwardQueue.paused,
      () => ({
        running: forwardQueue.running,
        queued: forwardQueue.queue.length,
        maxConcurrency: forwardQueue.maxConcurrency
      })
    );
  } catch (error: any) {
    state.connectionState = 'error';
    console.error(`\n${C_RED}Startfehler:${C_RESET}`, error.message);
    const drained = await cleanupFailedRoutingStart('Interactive startup failed.');
    if (!drained) addLog('[CRITICAL] Queue did not drain after interactive startup failure.');
    console.log(`\n${C_GREEN}Beliebige Taste drücken...${C_RESET}`); await pressAnyKey();
  }
  return 'main';
}

async function restartApp() {
  clearConsole(); console.log(`${C_GREEN}Initialisiere Neustart des Mainframes...${C_RESET}`);
  await stopForwarding();
  clearLogHistory();
  await new Promise(r => setTimeout(r, 800)); await playStartupAnimation(); return 'main';
}

function getShutdownGraceMs(): number {
  const configured = Number(process.env.SHUTDOWN_GRACE_MS || 30_000);
  return Number.isSafeInteger(configured) && configured >= 1_000 && configured <= 120_000 ? configured : 30_000;
}

let shutdownPromise: Promise<void> | null = null;

async function stopScheduler(scheduler: { stop: () => Promise<void> } | null, label: string): Promise<void> {
  if (!scheduler) return;
  try {
    await scheduler.stop();
  } catch (error: any) {
    console.warn(`[WARN] ${label} konnte nicht sauber beendet werden: ${error.message}`);
  }
}

async function stopRuntimeServices(): Promise<void> {
  await stopScheduler(backupScheduler, 'Laufendes Backup');
  await stopScheduler(retentionScheduler, 'Laufende Daten-Retention');
  try {
    metricsTracker?.stop();
  } catch {
    /* ignore stop error */
  }
  try {
    await stopMetricsServer();
  } catch {
    /* ignore metrics server close error */
  }
  try {
    await stopWebServer();
  } catch {
    /* ignore web server close error */
  }
  if (!client) return;
  try {
    await client.close();
  } catch (error: any) {
    console.warn(`[WARN] Fehler beim Schließen des TDLib Clients: ${error.message}`);
  }
  client = null;
}

async function closeDatabaseAfterDrain(drained: boolean): Promise<boolean> {
  if (!drained) return false;
  try {
    await closeDb();
    return true;
  } catch (error: any) {
    console.warn(`[WARN] Fehler beim Schließen der SQLite-Datenbank: ${error.message}`);
    return false;
  }
}

async function removeOperationalLock(lockPath: string, label: string): Promise<void> {
  try {
    await fsPromises.unlink(lockPath);
  } catch (error: any) {
    if (error.code !== 'ENOENT') console.warn(`[WARN] ${label} konnte nicht entfernt werden: ${error.message}`);
  }
}

async function performShutdown(exitCode: number): Promise<void> {
  addLog("[INFO] System-Shutdown eingeleitet...");
  state.isRunning = false;
  state.connectionState = 'disconnected';
  forwardQueue.pause();
  forwardQueue.clear();
  forwardQueue.abortRunning('Process shutdown.');
  deliveryTracker?.close('Process shutdown.');
  const drained = await forwardQueue.waitForIdle(getShutdownGraceMs());
  if (!drained) {
    addLog('[CRITICAL] Shutdown-Frist abgelaufen; nicht abgeschlossene Tasks werden beim Neustart reconciled.');
  }
  await stopRuntimeServices();
  const databaseClosed = await closeDatabaseAfterDrain(drained);
  if (drained) await removeOperationalLock('./session_data/.routing_active', 'Routing-Lock');
  if (databaseClosed) await removeOperationalLock(processLockPath, 'Prozess-Lock');
  process.exitCode = exitCode;
}

function shutdown(exitCode = 0): Promise<void> {
  if (!shutdownPromise) shutdownPromise = performShutdown(exitCode);
  return shutdownPromise;
}

process.on('SIGINT', () => { void shutdown(0).finally(() => process.exit(process.exitCode || 0)); });
process.on('SIGTERM', () => { void shutdown(0).finally(() => process.exit(process.exitCode || 0)); });

interface RuntimeConfiguration {
  config: any;
}

async function initializeCoreRuntime() {
  initializeDeliveryTracker();
  await initFileLogger();
  auditTrail = auditTrailFromEnvironment();
  await auditTrail.initialize();
  await auditTrail.record({ phase: 'startup', action: 'service.startup', actorRole: 'system', actorId: 'forwarder' });
  await initDb();
  const databasePath = path.resolve(process.env.FORWARDER_DB_PATH || path.join(process.cwd(), 'session_data', 'forwarder.db'));
  processLockPath = path.join(path.dirname(databasePath), '.process_active');
  await fsPromises.mkdir(path.dirname(processLockPath), { recursive: true });
  await fsPromises.writeFile(processLockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), {
    encoding: 'utf8', mode: 0o600
  });
  state.totalForwardedCount = await getTotalForwardedCount();
  state.lastSuccessfulForwardAt = await getLastForwardedAt();
  await checkCrashLoop();

  const retentionPolicy = retentionPolicyFromEnvironment();
  retentionScheduler = new OperationalDataRetention(retentionPolicy, addLog);
  await retentionScheduler.start();
  return { databasePath, retentionPolicy };
}

async function startBackupRuntime(runtime: RuntimeConfiguration): Promise<void> {
  const offsiteBackup = offsiteBackupFromEnvironment();
  const backupIntervalValue = Number(process.env.BACKUP_INTERVAL_MS || 15 * 60_000);
  const backupIntervalMs = Number.isSafeInteger(backupIntervalValue) && backupIntervalValue >= 60_000 && backupIntervalValue <= 15 * 60_000
    ? backupIntervalValue
    : 15 * 60_000;
  const retentionValue = Number(process.env.BACKUP_RETENTION_COUNT || 672);
  const backupRetention = Number.isSafeInteger(retentionValue) && retentionValue >= 1 && retentionValue <= 10_000 ? retentionValue : 672;
  backupScheduler = new BackupScheduler(
    process.env.BACKUP_DIR || path.join(process.cwd(), 'backups'),
    () => configSnapshot(runtime.config),
    backupIntervalMs,
    backupRetention,
    addLog,
    offsiteBackup.replicator,
    offsiteBackup.required
  );
  await backupScheduler.start();
}

function startMonitoringRuntime(databasePath: string, minimumFreeBytes: number): void {
  startMetricsServer(Number(process.env.METRICS_PORT || 9100), {
    totalForwardedCountCallback: () => state.totalForwardedCount,
    getQueueStateCallback: () => ({
      running: forwardQueue.running,
      queued: forwardQueue.queue.length,
      maxConcurrency: forwardQueue.maxConcurrency
    }),
    getOperationalMetricsCallback: () => collectOperationalMetrics(
      databasePath,
      minimumFreeBytes
    )
  });

  try {
    metricsTracker = new MetricsTracker({
      totalForwardedCountCallback: () => state.totalForwardedCount,
      getQueueStateCallback: () => ({
        running: forwardQueue.running,
        queued: forwardQueue.queue.length,
        maxConcurrency: forwardQueue.maxConcurrency,
        paused: forwardQueue.paused
      })
    });
    metricsTracker.start();
  } catch (err: any) {
    console.error(`[WARN] Konnte Metrics Tracker nicht initialisieren: ${err.message}`);
  }
}

function startDashboardRuntime(runtime: RuntimeConfiguration): void {
  const webPort = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
  try {
    startWebServer(webPort, {
      config: runtime.config,
      state,
      startForwarding: async (cfg) => {
        await startForwardingNonInteractive(cfg);
      },
      stopForwarding: async () => {
        await stopForwarding();
      },
      getQueueState: () => ({
        running: forwardQueue.running,
        queued: forwardQueue.queue.length,
        maxConcurrency: forwardQueue.maxConcurrency,
        paused: forwardQueue.paused
      }),
      reloadConfig: () => {
        runtime.config = readConfigSync();
      },
      applyRuntimeConfig: (updatedConfig) => {
        applyQueueSettings(updatedConfig);
      },
      getMetricsHistory: () => {
        return metricsTracker ? metricsTracker.getHistory() : [];
      },
      getOutboxTasks: async (statuses) => {
        return listOutboxTasks(statuses as any, 1000);
      },
      retryOutboxTask: async (taskId) => {
        return retryPersistedTask(taskId, runtime.config);
      },
      acknowledgeOutboxTask: async (taskId, reason) => {
        return acknowledgeOutboxTask(taskId, reason);
      },
      auditTrail
    });
  } catch (err: any) {
    addLog(`[WARN] Web Dashboard konnte nicht gestartet werden: ${err.message}`);
  }
}

async function runConfiguredMode(runtime: RuntimeConfiguration): Promise<void> {
  const isNonInteractive = process.env.NON_INTERACTIVE === 'true' || !process.stdout.isTTY;
  if (isNonInteractive) {
    addLog("[INFO] Starte im nicht-interaktiven Modus (Daemon-Modus)...");
    await startForwardingNonInteractive(runtime.config);
    return;
  }

  await playStartupAnimation();
  let menu = 'main';
  try {
    await fsPromises.access('./session_data/.routing_active');
    menu = 'start';
    addLog('[INFO] Unerwarteter Abbruch erkannt. Starte automatische Wiederaufnahme des Routings...');
  } catch {
    // Lockfile existiert nicht, normal starten
  }
  while (menu !== 'exit') {
    if (menu === 'main') menu = await runMenuSystem(runtime.config, writeConfigSync, state);
    else if (menu === 'start') menu = await startForwarding(runtime.config);
    else if (menu === 'restart') {
      menu = await restartApp();
      runtime.config = readConfigSync();
    }
  }
  clearConsole(); console.log(`${C_GREEN}Beende Programm...${C_RESET}`);
  await shutdown(0);
}

async function run() {
  loadEnv();
  const runtime = { config: readConfigSync() };
  const { databasePath, retentionPolicy } = await initializeCoreRuntime();
  await startBackupRuntime(runtime);
  startMonitoringRuntime(databasePath, retentionPolicy.minFreeBytes);
  startDashboardRuntime(runtime);
  await runConfiguredMode(runtime);
}
run().catch(async err => {
  console.error("Kritischer Fehler:", err.message);
  await shutdown(1);
  process.exit(process.exitCode || 1);
});
