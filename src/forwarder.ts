import * as tdl from 'tdl';
import { getTdjson } from 'prebuilt-tdlib';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalizeResolvedSources,
  configurationPathFromEnvironment,
  DEFAULT_CONFIG,
  readConfigSync,
  writeConfigSync,
  isValidTargetChannel,
  mergeConfigDefaults
} from './config.js';
import { loadEnv } from './env.js';
import { getMessageTextAndType, shouldForward } from './filters.js';
import { ConcurrencyQueue } from './queue.js';
import { DurableOutboxScheduler } from './outbox_scheduler.js';
import { acquireProcessLock, type ProcessLock } from './process_lock.js';
import { isDuplicateSignal, normalizeSignalXml } from './dupe_blocker.js';
import {
  acknowledgeOutboxTask,
  beginDatabaseMaintenance,
  claimOutboxTask,
  closeDb,
  completeOutboxTask,
  enqueueOutboxTask,
  failOutboxTask,
  getMediaGroupBuffers,
  getAiUsage,
  getDatabaseStorageStats,
  getLastForwardedAt,
  getOldestPendingOutboxAgeSeconds,
  getOutboxStatusCounts,
  getTotalForwardedCount,
  incrementForwardedCount,
  initDb,
  isDatabaseHealthy,
  listOutboxTasks,
  listPendingOutboxTasksForScheduling,
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
import type { ExecutableSignalSchemaSelection } from './signal_schema.js';
import { MetricsTracker } from './metrics_tracker.js';
import { TelegramDeliveryTracker } from './delivery_tracker.js';
import { checkCrashLoopFiles } from './crash_guard.js';
import { BackupScheduler, restoreBackupArtifact, verifyBackupArtifact } from './backup.js';
import { offsiteBackupFromEnvironment, type BackupReplicator } from './backup_replication.js';
import { OperationalDataRetention, retentionPolicyFromEnvironment } from './retention.js';
import { invokeWithFloodWaitRetry } from './tdlib_retry.js';
import { DeliverySloTracker } from './slo_tracker.js';
import { auditTrailFromEnvironment, type EnterpriseAuditTrail } from './audit_trail.js';
import { addLog, clearLogHistory, initFileLogger } from './logger.js';
import { managedSecretStoreFromEnvironment, type ManagedSecretStore } from './secret_store.js';
import {
  assertFactoryResetTarget,
  clearFactoryResetTarget,
  type FactoryResetBoundary,
} from './factory_reset_paths.js';
import { TelegramLoginCoordinator } from './telegram_login.js';
import {
  managedRuntimeSettingsFromEnvironment,
  type ManagedRuntimeSettingsStore,
} from './runtime_settings.js';
import {
  telegramViewerSettingsFromEnvironment,
  type ManagedTelegramViewerSettingsStore,
} from './telegram_viewer_settings.js';
import {
  telegramViewerSecretStoreFromEnvironment,
  type TelegramViewerSecretStore,
} from './telegram_viewer_secrets.js';
import { requireTrustedServiceUrl } from './telegram_viewer/internal_transport.js';
import {
  createTradingIntent,
  getSignalContractVersion,
  getTradingSignalSchemaForTemplate,
  getTradingOperationalSnapshot,
  getTradingRuntimeState,
  listTradingAccounts,
  listTradingSignalSchemas,
} from './trading_repository.js';
import {
  createWorkflowTradingIntents,
  getActiveWorkflow,
  getWorkflowSignalPlans,
  migrateLegacyTradingRoutesToWorkflow,
} from './workflow_repository.js';
import { PaperExchangeAdapter } from './paper_exchange.js';
import { TradingEngine } from './trading_engine.js';
import { TradingRuntime } from './trading_runtime.js';
import {
  tradingCredentialStoreFromEnvironment,
  type TradingCredentialStore,
} from './trading_credentials.js';
import { CcxtExchangeAdapter } from './ccxt_exchange.js';
import { ExchangeCatalogClient } from './exchange_catalog.js';
import { TradingWebControl } from './trading_web_control.js';
import { ClockGuard, clockDriftLimitFromEnvironment } from './clock_guard.js';
import { recordTradingExecutionEvent } from './trading_telemetry.js';
import { McpControlBridge } from './mcp_control_bridge.js';
import {
  beginMcpSharedMaintenance,
  clearMcpMaintenanceMarker,
  operationalDatabasePath,
} from './mcp_maintenance.js';

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
  if (reason?.message === 'Client was closed') {
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

const OUTBOX_MAX_IN_MEMORY_TASKS = 200;
const forwardQueue = new ConcurrencyQueue(2, 60_000, OUTBOX_MAX_IN_MEMORY_TASKS);
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

async function executeScheduledOutboxTask(
  taskId: string,
  fallbackConfig: any,
  signal: AbortSignal
): Promise<void> {
  await (async () => {
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
      const result = await executePersistedOutboxTask(task, effectiveConfig, context);
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
  })();
}

let activeOutboxConfig: any = null;
const outboxScheduler = new DurableOutboxScheduler({
  queue: forwardQueue,
  listPending: (excludedTaskIds, limit) => listPendingOutboxTasksForScheduling(excludedTaskIds, limit),
  execute: (taskId, signal) => executeScheduledOutboxTask(taskId, activeOutboxConfig, signal),
  logError: message => addLog(`[ERROR] ${message}`),
  batchSize: 100
});

function scheduleOutboxTask(taskId: string, fallbackConfig: any): void {
  activeOutboxConfig = fallbackConfig;
  if (outboxScheduler.schedule(taskId)) return;
  // SQLite retains the task; a later scheduler cycle reloads it safely.
  outboxScheduler.requestPump();
}

async function enqueueTask(taskData: any, config: any): Promise<void> {
  const inserted = await enqueueOutboxTask({ ...taskData, config: configSnapshot(config) });
  if (inserted) {
    deliverySlo.recordAccepted();
    scheduleOutboxTask(taskData.id, config);
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
  await enqueueTask(task, config);
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
  await enqueueTask(task, config);
}

async function resumePersistedTasks(config: any): Promise<void> {
  await migrateLegacyPersistedTasks(config);
  const recovery = await recoverInterruptedOutboxTasks();
  if (recovery.requeued > 0) addLog(`[WARN] Safely requeued ${recovery.requeued} task(s) interrupted before provider send.`);
  if (recovery.unknown > 0) addLog(`[CRITICAL] ${recovery.unknown} task(s) stopped during provider send and require reconciliation.`);

  activeOutboxConfig = config;
  const outboxCounts = await getOutboxStatusCounts();
  const unresolvedCount = outboxCounts.failed + outboxCounts.unknown;
  if (unresolvedCount > 0) {
    addLog(`[ERROR] ${unresolvedCount} failed/unknown outbox task(s) retained for operator recovery.`);
  }
  if (outboxCounts.pending > 0) addLog(`[INFO] Resuming ${outboxCounts.pending} durable outbox task(s) through a bounded scheduler.`);
  await outboxScheduler.resume();
}

async function retryPersistedTask(taskId: string, config: any): Promise<boolean> {
  if (!await requeueOutboxTask(taskId)) return false;
  activeOutboxConfig = config;
  scheduleOutboxTask(taskId, config);
  return true;
}

const mediaGroupBuffer = new Map();
const ALBUM_DELAY_MS = 800;
let client = null, targetChatId = null;
let routingStopRequested = false;
let metricsTracker: MetricsTracker | null = null;
let backupScheduler: BackupScheduler | null = null;
let offsiteBackupReplicator: BackupReplicator | null = null;
let retentionScheduler: OperationalDataRetention | null = null;
let tradingRuntime: TradingRuntime | null = null;
let tradingWebControl: TradingWebControl | null = null;
let mcpControlBridge: McpControlBridge | null = null;
let activeMaintenanceOperation: string | null = null;
let auditTrail: EnterpriseAuditTrail | null = null;
let processLockPath = path.join(process.cwd(), 'session_data', '.process_active');
let processLock: ProcessLock | null = null;
const state = {
  isRunning: false,
  connectionState: 'disconnected',
  resolvedSourceChatIds: new Set(),
  totalForwardedCount: 0,
  processedSinceRestart: 0,
  lastSuccessfulForwardAt: null as number | null,
  startupTime: null as number | null
};
const telegramLogin = new TelegramLoginCoordinator((snapshot) => {
  if (snapshot.state === 'waiting') state.connectionState = 'authentication-required';
  if (snapshot.state === 'authenticating' && !state.isRunning) state.connectionState = 'connecting';
});
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
  minimumFreeBytes: number,
  clockGuard: ClockGuard,
): Promise<OperationalMetrics> {
  const databaseHealthy = await isDatabaseHealthy();
  const diskAvailableBytes = await availableDiskBytes(databasePath);
  const diskCapacityHealthy = diskAvailableBytes >= minimumFreeBytes;
  const emptyOutbox = { pending: 0, preparing: 0, sending: 0, completed: 0, failed: 0, unknown: 0 };
  const trading = databaseHealthy ? await getTradingOperationalSnapshot() : {
    executionEnabled: false,
    liveTradingEnabled: false,
    killSwitchActive: false,
    enabledRoutes: 0,
    openPositions: 0,
    pendingIntents: 0,
    unknownOrders: 0,
    unprotectedPositions: 0,
    unacknowledgedCriticalRiskEvents: 0,
    intentCount: 0,
    fillCount: 0,
    latestReconciliationAt: null,
  };
  const reconciliationCurrent = !trading.executionEnabled
    || (trading.latestReconciliationAt !== null && Date.now() - trading.latestReconciliationAt <= 30_000);
  const clock = clockGuard.sample();
  const base = {
    databaseHealthy,
    isRunning: state.isRunning,
    connectionState: state.connectionState,
    queuePaused: forwardQueue.paused,
    lastForwardedAt: state.lastSuccessfulForwardAt,
    ...backupMetricSnapshot(),
    ...retentionMetricSnapshot(),
    ...auditMetricSnapshot(),
    clockHealthy: clock.healthy,
    clockDriftMilliseconds: clock.driftMilliseconds,
    clockMaxDriftMilliseconds: clock.maxDriftMilliseconds,
    clockCheckedAt: clock.checkedAt,
    diskAvailableBytes,
    diskCapacityHealthy,
    deliverySlo: deliverySlo.snapshot(),
    tradingHealthy: clock.healthy
      && !trading.killSwitchActive
      && trading.unknownOrders === 0
      && trading.unprotectedPositions === 0
      && reconciliationCurrent,
    tradingExecutionEnabled: trading.executionEnabled,
    tradingLiveEnabled: trading.liveTradingEnabled,
    tradingKillSwitchActive: trading.killSwitchActive,
    tradingEnabledRoutes: trading.enabledRoutes,
    tradingOpenPositions: trading.openPositions,
    tradingPendingIntents: trading.pendingIntents,
    tradingUnknownOrders: trading.unknownOrders,
    tradingUnprotectedPositions: trading.unprotectedPositions,
    tradingUnacknowledgedCriticalRiskEvents: trading.unacknowledgedCriticalRiskEvents,
    tradingIntentCount: trading.intentCount,
    tradingFillCount: trading.fillCount,
    tradingLatestReconciliationAt: trading.latestReconciliationAt,
  };
  if (!databaseHealthy) {
    return {
      ...base,
      outbox: emptyOutbox,
      oldestPendingOutboxAgeSeconds: 0,
      aiRequestsToday: 0,
      aiUsedTokensToday: 0,
      aiReservedTokensToday: 0
    };
  }

  const [outbox, oldestPendingOutboxAgeSeconds, aiUsage, storage] = await Promise.all([
    getOutboxStatusCounts(),
    getOldestPendingOutboxAgeSeconds(),
    getAiUsage(new Date().toISOString().slice(0, 10)),
    getDatabaseStorageStats()
  ]);
  return {
    ...base,
    outbox,
    oldestPendingOutboxAgeSeconds,
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
  limits?: Partial<AiLimits>,
  executableSchema?: ExecutableSignalSchemaSelection | null,
  promptTemplate?: string,
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
      limits,
      executableSchema,
      promptTemplate,
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
        } catch (error_) {
          addLog(`[DEBUG] Supergroup-Fallback für ${idStr} fehlgeschlagen: ${error_.message}`);
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
  
  if (formattedText?.text?.trim()) {
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
  provenance?: SignalProvenance,
  requestedSignalId?: string,
  dedupeScope?: string,
) {
  const signalId = requestedSignalId || `signal_${message.chat_id}_${message.id}`;
  if (dupeBlocker.enabled) {
    const baseDir = xmlParsing.signalsDir || './signals';
    const cooldown = dupeBlocker.cooldownHours !== undefined ? dupeBlocker.cooldownHours : 24;
    const dupeResult = await isDuplicateSignal(xmlString, baseDir, cooldown, signalId, dedupeScope);
    if (dupeResult.isDupe) {
      addLog(`[DUPE-BLOCKER] Paket ${message.id} blockiert: ${dupeResult.reason}`);
      updateIncomingMessageStatus(String(message.chat_id), message.id, 'duplicate')
        .catch(error => addLog(`[WARN] Inbox duplicate status update failed for ${message.id}: ${error.message}`));
      return null;
    }
  }
  
  const normalizedNew = normalizeSignalXml(xmlString);
  await saveSignal(signalId, String(message.chat_id), message.id, xmlString, normalizedNew, provenance);
  
  return signalId;
}

async function recordCreatedIntents(intents: any[], sourceId: string, signalReceivedAt: number): Promise<void> {
  for (const intent of intents) {
    await recordTradingExecutionEvent({
      eventType: 'intent_created',
      intentId: intent.id,
      channelId: intent.channelId,
      accountId: intent.accountId,
      exchange: intent.exchange,
      mode: intent.mode,
      details: { symbol: intent.symbol, status: intent.status, signalReceivedAt },
    });
    addLog(`[TRADING] intent=${intent.id} path=${intent.executionPathId || 'legacy'} channel=${sourceId} account=${intent.accountId} status=${intent.status} symbol=${intent.symbol}`);
  }
}

async function parseWorkflowPlan(
  plan: any,
  message: any,
  text: string,
  xmlParsing: any,
  context: OutboxExecutionContext,
  sourceId: string,
  schemas: any[],
) {
  const configuredSchema = schemas.find(schema => schema.id === plan.schemaId);
  const contractVersion = await getSignalContractVersion(plan.contractVersionId);
  if (!configuredSchema || !configuredSchema.enabled || contractVersion?.status !== 'published') {
    throw new Error(`Workflow parser plan ${plan.key.slice(0, 12)} references a stale schema or contract.`);
  }
  addLog(`[XML-Parser] Analysiere Paket ${message.id} über Workflow-Pfadgruppe ${plan.key.slice(0, 12)}...`);
  const parsedSignal = await parseSignalNative(
    text,
    plan.timeoutMs,
    plan.templateName,
    {
      primaryModel: plan.primaryModel || xmlParsing.primaryModel,
      fallbackModel: plan.fallbackModel || xmlParsing.fallbackModel,
    },
    context.signal,
    xmlParsing.aiLimits,
    {
      id: configuredSchema.id,
      parserSchema: configuredSchema.parserSchema,
      schemaDefinition: configuredSchema.definition,
      contractVersionId: contractVersion.id,
      contractDefinition: contractVersion.definition,
    },
    plan.prompt,
  );
  await recordTradingExecutionEvent({
    eventType: 'signal_validated',
    channelId: sourceId,
    details: {
      telegramMessageId: String(message.id),
      workflowRevisionId: plan.workflowRevisionId,
      workflowPlan: plan.key,
      schema: parsedSignal.signal.schema,
      contractVersionId: plan.contractVersionId,
    },
  });
  return parsedSignal;
}

async function finishWorkflowOutput(
  message: any,
  context: OutboxExecutionContext,
  sourceId: string,
  outputModes: Set<string>,
  firstXml: string | null,
): Promise<{ handled: boolean; result?: any; workflowOriginal?: boolean }> {
  if (outputModes.has('telegram_xml') && firstXml) {
    const result = await sendXmlMessage(firstXml, context);
    await updateIncomingMessageStatus(sourceId, message.id, 'processed');
    return { handled: true, result };
  }
  if (outputModes.has('telegram_original')) return { handled: false, workflowOriginal: true };
  await updateIncomingMessageStatus(sourceId, message.id, 'processed');
  return { handled: true, result: { mode: 'local-workflow-signal' } };
}

async function processWorkflowSignal(
  message: any,
  text: string,
  contentType: string,
  xmlParsing: any,
  context: OutboxExecutionContext,
  signalReceivedAt: number,
) {
  const sourceId = String(message.chat_id);
  const plans = await getWorkflowSignalPlans({ channelId: sourceId, text, contentType });
  if (plans.length === 0) {
    addLog(`[WORKFLOW] Paket ${message.id} hat keinen aktiven, filterkonformen Ausführungspfad.`);
    await updateIncomingMessageStatus(sourceId, message.id, 'filtered');
    return { handled: true, result: { mode: 'workflow-filtered' } };
  }
  const schemas = await listTradingSignalSchemas();
  let firstXml: string | null = null;
  let createdIntents = 0;
  const outputModes = new Set<string>();
  for (const plan of plans) {
    plan.outputModes.forEach(mode => outputModes.add(mode));
    const parsedSignal = await parseWorkflowPlan(plan, message, text, xmlParsing, context, sourceId, schemas);
    firstXml ||= parsedSignal.xml;
    const signalId = await checkDuplicateAndSave(
      message,
      parsedSignal.xml,
      xmlParsing,
      plan.dedupe,
      parsedSignal.provenance,
      `signal_${message.chat_id}_${message.id}_${plan.key}`,
      plan.key,
    );
    if (!signalId) continue;
    if (!parsedSignal.signal.execution) {
      addLog(`[TRADING] Workflow-Pfadgruppe ${plan.key.slice(0, 12)} lieferte kein ausführbares Signal.`);
      continue;
    }
    const intents = await createWorkflowTradingIntents({
      sourceSignalId: signalId,
      channelId: sourceId,
      sourceText: text,
      contentType,
      signal: parsedSignal.signal.execution,
      executionPathIds: plan.executionPathIds,
    });
    createdIntents += intents.length;
    await recordCreatedIntents(intents, sourceId, signalReceivedAt);
  }
  addLog(`[WORKFLOW] Paket ${message.id} erzeugte ${createdIntents} kontospezifische Trade-Intent(s).`);
  return finishWorkflowOutput(message, context, sourceId, outputModes, firstXml);
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

function parserSchemaOverride(configuredSchema: any): any {
  if (!configuredSchema) return null;
  return {
    id: configuredSchema.id,
    parserSchema: configuredSchema.parserSchema,
    schemaDefinition: configuredSchema.definition,
    contractVersionId: configuredSchema.contractVersionId,
    contractDefinition: configuredSchema.contractDefinition,
  };
}

async function parseLegacyXmlSignal(
  message: any,
  text: string,
  sourceId: string,
  xmlParsing: any,
  context: OutboxExecutionContext,
) {
  const templateName = (xmlParsing.sourceTemplates || {})[sourceId];
  const configuredSchema = await getTradingSignalSchemaForTemplate(templateName);
  const parsedSignal = await parseSignalNative(
    text,
    xmlParsing.timeout || DEFAULT_PARSER_TIMEOUT_MS,
    templateName,
    { primaryModel: xmlParsing.primaryModel, fallbackModel: xmlParsing.fallbackModel },
    context.signal,
    xmlParsing.aiLimits,
    parserSchemaOverride(configuredSchema),
  );
  await recordTradingExecutionEvent({
    eventType: 'signal_validated',
    channelId: sourceId,
    details: {
      telegramMessageId: String(message.id),
      schema: parsedSignal.signal.schema,
      contractVersionId: configuredSchema?.contractVersionId ?? null,
    },
  });
  return parsedSignal;
}

async function createLegacyIntentForSignal(
  parsedSignal: any,
  signalId: string,
  sourceId: string,
  signalReceivedAt: number,
): Promise<void> {
  if (!parsedSignal.signal.execution) {
    addLog(`[TRADING] channel=${sourceId} schema=${parsedSignal.signal.schema} is not executable; no trade intent created.`);
    return;
  }
  const intent = await createTradingIntent({
    sourceSignalId: signalId,
    channelId: sourceId,
    signal: parsedSignal.signal.execution,
  });
  await recordCreatedIntents(intent ? [intent] : [], sourceId, signalReceivedAt);
}

async function finishLegacySignalOutput(input: {
  message: any;
  parsedXml: string;
  forwardXml: boolean;
  shouldForwardToTelegram: boolean;
  context: OutboxExecutionContext;
}): Promise<{ handled: boolean; result?: any }> {
  const { message, parsedXml, forwardXml, shouldForwardToTelegram, context } = input;
  if (forwardXml) {
    const result = await sendXmlMessage(parsedXml, context);
    updateIncomingMessageStatus(String(message.chat_id), message.id, 'processed')
      .catch(error => addLog(`[WARN] Inbox status update failed for ${message.id}: ${error.message}`));
    return { handled: true, result };
  }
  if (shouldForwardToTelegram) return { handled: false };
  updateIncomingMessageStatus(String(message.chat_id), message.id, 'processed')
    .catch(error => addLog(`[WARN] Inbox status update failed for ${message.id}: ${error.message}`));
  return { handled: true, result: { mode: 'local-signal-only' } };
}

async function processXmlSignal(message, text, contentType, xmlParsing, dupeBlocker, shouldForwardToTelegram, context: OutboxExecutionContext) {
  addLog(`[XML-Parser] Analysiere Signal-Text für Paket ${message.id}...`);
  const forwardXml = shouldForwardToTelegram && xmlParsing.forwardXmlToTarget;
  try {
    const sourceId = String(message.chat_id);
    const signalReceivedAt = Date.now();
    await recordTradingExecutionEvent({
      eventType: 'signal_received',
      occurredAt: signalReceivedAt,
      channelId: sourceId,
      details: { telegramMessageId: String(message.id) },
    });
    if (await getActiveWorkflow()) {
      return processWorkflowSignal(
        message,
        text,
        contentType,
        xmlParsing,
        context,
        signalReceivedAt,
      );
    }
    const parsedSignal = await parseLegacyXmlSignal(message, text, sourceId, xmlParsing, context);
    addLog(`[XML-Parser SUCCESS] Paket ${message.id} erfolgreich analysiert.`);
    
    const signalId = await checkDuplicateAndSave(
      message,
      parsedSignal.xml,
      xmlParsing,
      dupeBlocker,
      parsedSignal.provenance
    );
    if (!signalId) return { handled: true, result: { mode: 'duplicate-blocked' } };
    await createLegacyIntentForSignal(parsedSignal, signalId, sourceId, signalReceivedAt);
    return finishLegacySignalOutput({ message, parsedXml: parsedSignal.xml, forwardXml, shouldForwardToTelegram, context });
  } catch (error: any) {
    addLog(`[XML-Parser ERROR] Paket ${message.id}: ${error.message}`);
    updateIncomingMessageStatus(String(message.chat_id), message.id, 'failed')
      .catch(statusError => addLog(`[WARN] Inbox failure status update failed for ${message.id}: ${statusError.message}`));
    throw error;
  }
}

async function forwardSingleMessage(message, config, context: OutboxExecutionContext) {
  if (context.signal.aborted) throw new Error('Task aborted');
  const { text, type } = getMessageTextAndType(message);
  const shouldForwardToTelegram = config.forwardOptions?.forwardToTarget ?? true;

  const xmlParsing = config.xmlParsing || {};
  const dupeBlocker = config.dupeBlocker || {};
  const activeWorkflow = await getActiveWorkflow();

  let xmlResult = { handled: false } as { handled: boolean; result?: any; workflowOriginal?: boolean };
  if ((activeWorkflow || xmlParsing.enabled) && text?.trim()) {
    if (xmlParsing.externalDataPolicyAccepted !== true) {
      throw new Error('AI parsing is blocked until the external data-processing policy is explicitly accepted in the Web UI.');
    }
    xmlResult = await processXmlSignal(message, text, type, xmlParsing, dupeBlocker, shouldForwardToTelegram, context);
  }

  if (xmlResult.handled) return xmlResult.result;
  if ((activeWorkflow && xmlResult.workflowOriginal) || shouldForwardToTelegram) {
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

async function messagePassesRoutingFilters(
  message: any,
  config: any,
  activeWorkflow: any,
  chatId: string,
  text: string,
  contentType: string,
): Promise<boolean> {
  if (!activeWorkflow) return shouldForward(message, config.filters, addLog, chatId, config);
  const workflowPlans = await getWorkflowSignalPlans({ channelId: chatId, text, contentType });
  return workflowPlans.length > 0;
}

async function routeAcceptedMessage(message: any, config: any, activeWorkflow: any): Promise<void> {
  if (!message.media_group_id || message.media_group_id === '0' || activeWorkflow) {
    await enqueueSingleMessage(message, config);
    return;
  }
  if (config.forwardOptions?.forwardToTarget ?? true) {
    await handleMediaGroupMessage(message, config);
    return;
  }
  addLog(`[INFO] Album-Paketgruppe ${message.media_group_id} übersprungen (Weiterleitung deaktiviert).`);
}

async function routeIncomingMessage(message: any, config: any): Promise<void> {
  if (message.is_outgoing) return;
  const chatId = String(message.chat_id);
  const activeWorkflow = await getActiveWorkflow();
  const workflowSource = activeWorkflow ? activeWorkflow.compiled.paths.some(path => path.channelId === chatId) : false;
  if (!state.resolvedSourceChatIds.has(chatId) && !workflowSource) return;
  const { text, type } = getMessageTextAndType(message);
  const sender = config.sourceAliases?.[chatId] || chatId;
  const inserted = await saveIncomingMessage(chatId, message.id, sender, text || '', type, 'received');
  if (!inserted) {
    addLog(`[INFO] Duplicate incoming message ${chatId}/${message.id} ignored.`);
    return;
  }
  addLog(`[INFO] Neues Datenpaket ${message.id} an Quell-Knoten ${chatId} abgefangen.`);
  if (!await messagePassesRoutingFilters(message, config, activeWorkflow, chatId, text || '', type)) {
    await updateIncomingMessageStatus(chatId, message.id, 'filtered');
    return;
  }
  // A workflow-qualified caption must traverse the same parser/filter path as
  // an ordinary message. The legacy album forwarder is intentionally not
  // allowed to bypass the graph's output node.
  await routeAcceptedMessage(message, config, activeWorkflow);
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
  routingStopRequested = true;
  telegramLogin.cancel();
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
  const environmentApiId = Number(process.env.TELEGRAM_API_ID);
  const apiId = Number.isSafeInteger(environmentApiId) && environmentApiId > 0
    ? environmentApiId
    : config.apiId;
  return { apiId, apiHash: process.env.TELEGRAM_API_HASH || '' };
}

function routingConfigurationIsComplete(
  config: any,
  apiId: number,
  apiHash: string,
  requiresTelegramTarget = true,
): boolean {
  return Boolean(
    apiId
    && /^[a-f0-9]{32}$/i.test(apiHash)
    && config.sourceChannels.length > 0
    && (!requiresTelegramTarget || isValidTargetChannel(config.targetChannel))
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
  activeMessage: string,
  requiresTelegramTarget = true,
): Promise<void> {
  state.connectionState = 'connecting';
  client = tdl.createClient({ apiId, apiHash, databaseDirectory: './session_data', filesDirectory: './session_files' });
  client.on('error', err => {
    state.connectionState = 'error';
    addLog(`[TDLib Fehler] ${err.message || err}`);
  });
  telegramLogin.begin();
  try {
    await client.login(telegramLogin.loginDetails());
    telegramLogin.complete();
  } catch (error) {
    if (!routingStopRequested) telegramLogin.fail();
    throw error;
  }
  state.connectionState = 'connected';
  if (resetLogs) clearLogHistory();
  addLog("[SUCCESS] Mainframe-Verbindung autorisiert!");
  await preloadTelegramChats();
  await resolveConfiguredSources(config);
  if (requiresTelegramTarget) {
    targetChatId = await resolveChatId(config.targetChannel);
    addLog(`[SUCCESS] Ziel-Knoten geladen: ${config.targetChannel} -> ${targetChatId}`);
  } else {
    targetChatId = null;
    addLog('[INFO] Aktiver Workflow besitzt keine Telegram-Ausgabe; kein Ziel-Knoten erforderlich.');
  }
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
  const activeWorkflow = await getActiveWorkflow();
  const workflowSources = activeWorkflow?.compiled.paths.map(path => path.channelId) ?? [];
  const effectiveConfig = {
    ...config,
    sourceChannels: [...new Set([...(config.sourceChannels || []), ...workflowSources])],
  };
  const requiresTelegramTarget = !activeWorkflow || activeWorkflow.compiled.paths.some(path => {
    const resources = path.effectiveConfiguration?.resources as Record<string, any> | undefined;
    return ['telegram_xml', 'telegram_original'].includes(String(resources?.output?.mode || 'audit_only'));
  });
  applyQueueSettings(effectiveConfig);
  routingStopRequested = false;
  const { apiId, apiHash } = routingCredentials(effectiveConfig);
  if (!routingConfigurationIsComplete(effectiveConfig, apiId, apiHash, requiresTelegramTarget)) {
    addLog("[ERROR] Konfiguration unvollständig! Bitte apiId, TELEGRAM_API_HASH, sourceChannels und targetChannel prüfen.");
    throw new Error('Non-interactive routing configuration is incomplete.');
  }

  try {
    addLog("[INFO] Verbinde mit Telegram Mainframe...");
    await connectAndActivateRouting(
      effectiveConfig,
      apiId,
      apiHash,
      false,
      "[SUCCESS] Mainframe-Routing aktiv!",
      requiresTelegramTarget,
    );
  } catch (error: any) {
    if (routingStopRequested) {
      await cleanupFailedRoutingStart('Routing start cancelled by operator.');
      state.connectionState = 'disconnected';
      addLog('[INFO] Routing start cancelled by operator.');
      return;
    }
    state.connectionState = 'error';
    addLog(`[FATAL] Fehler beim Starten des Forwardings: ${error.message}`);
    const drained = await cleanupFailedRoutingStart('Non-interactive startup failed.');
    if (!drained) addLog('[CRITICAL] Queue did not drain after non-interactive startup failure.');
    throw error;
  }
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

function beginApplicationMaintenance(operation: string): () => void {
  if (activeMaintenanceOperation) {
    throw new Error(`Maintenance operation '${activeMaintenanceOperation}' is already active.`);
  }
  activeMaintenanceOperation = operation;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeMaintenanceOperation = null;
  };
}

async function stopSchedulerForMaintenance(
  scheduler: { stop: () => Promise<void> } | null,
  label: string,
): Promise<void> {
  if (!scheduler) return;
  try {
    await scheduler.stop();
  } catch (error: any) {
    throw new Error(`${label} could not be drained for maintenance.`, { cause: error });
  }
}

async function restartSchedulerAfterFailedMaintenance(
  stopped: boolean,
  scheduler: { start: () => Promise<void> | void } | null,
): Promise<void> {
  if (stopped && scheduler) await scheduler.start();
}

async function stopRuntimeServices(): Promise<void> {
  await stopScheduler(mcpControlBridge, 'MCP control bridge');
  mcpControlBridge = null;
  await stopScheduler(tradingRuntime, 'Trading Runtime');
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

async function releaseProcessLock(label: string): Promise<void> {
  if (!processLock) return;
  try {
    await processLock.release();
    processLock = null;
  } catch (error: any) {
    console.warn(`[WARN] ${label} konnte nicht entfernt werden: ${error.message}`);
  }
}

async function performShutdown(exitCode: number): Promise<void> {
  addLog("[INFO] System-Shutdown eingeleitet...");
  routingStopRequested = true;
  telegramLogin.cancel();
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
  await auditTrail?.flush();
  if (drained) await removeOperationalLock('./session_data/.routing_active', 'Routing-Lock');
  if (databaseClosed) await releaseProcessLock('Prozess-Lock');
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
  configurationRecoveryReason?: string;
}

function loadRuntimeConfiguration(): RuntimeConfiguration {
  try {
    return { config: readConfigSync() };
  } catch (error: any) {
    return {
      config: structuredClone(DEFAULT_CONFIG),
      configurationRecoveryReason: error instanceof Error ? error.message : 'Configuration could not be read.'
    };
  }
}

async function initializeCoreRuntime(
  tradingCredentials: TradingCredentialStore,
  clockGuard: ClockGuard,
  runtimeConfig: any,
) {
  initializeDeliveryTracker();
  const databasePath = path.resolve(process.env.FORWARDER_DB_PATH || path.join(process.cwd(), 'session_data', 'forwarder.db'));
  processLockPath = path.join(path.dirname(databasePath), '.process_active');
  processLock = await acquireProcessLock(processLockPath);
  await initFileLogger();
  auditTrail = auditTrailFromEnvironment();
  await auditTrail.initialize();
  await auditTrail.record({ phase: 'startup', action: 'service.startup', actorRole: 'system', actorId: 'forwarder' });
  await initDb();
  try {
    const migration = await migrateLegacyTradingRoutesToWorkflow(runtimeConfig);
    if (migration.migrated) {
      addLog(`[WORKFLOW] ${migration.paths} legacy trading route(s) migrated to the active visual workflow.`);
    }
    for (const skipped of migration.skipped) addLog(`[WARN] Legacy workflow migration skipped ${skipped}.`);
  } catch (error: any) {
    addLog(`[WARN] Legacy visual-workflow migration was not activated; existing routing remains intact: ${error.message}`);
  }
  const tradingEngine = await composeTradingControl(tradingCredentials, clockGuard);
  if (!tradingWebControl || !auditTrail) throw new Error('MCP control dependencies are unavailable.');
  tradingRuntime = new TradingRuntime(
    tradingEngine,
    2_000,
    addLog,
    clockGuard,
  );
  tradingWebControl.attachEntryRuntime(tradingRuntime);
  mcpControlBridge = new McpControlBridge(tradingWebControl, auditTrail, addLog);
  await mcpControlBridge.start();
  await clearMcpMaintenanceMarker(databasePath);
  // Existing exposure is reconciled immediately, but pending entries remain
  // latched off until crash, retention, dashboard, monitoring and backup gates
  // have all completed below.
  await tradingRuntime.startProtectionOnly();
  state.totalForwardedCount = await getTotalForwardedCount();
  state.lastSuccessfulForwardAt = await getLastForwardedAt();
  await checkCrashLoop();

  const retentionPolicy = retentionPolicyFromEnvironment();
  retentionScheduler = new OperationalDataRetention(retentionPolicy, addLog);
  await retentionScheduler.start();
  return { databasePath, retentionPolicy };
}

async function composeTradingControl(
  tradingCredentials: TradingCredentialStore,
  clockGuard: ClockGuard,
): Promise<TradingEngine> {
  const paperAdapter = new PaperExchangeAdapter();
  const exchangeIds = [...new Set(
    (await listTradingAccounts())
      .map(account => account.exchange)
      .filter(exchange => exchange !== 'paper'),
  )];
  const ccxtAdapters = exchangeIds.map(exchange => new CcxtExchangeAdapter(exchange, tradingCredentials));
  const tradingEngine = new TradingEngine(
    [paperAdapter, ...ccxtAdapters],
    addLog,
    clockGuard,
    { isolateUnavailableMarketFailures: process.env.TRADING_ISOLATE_UNAVAILABLE_MARKET_FAILURES === 'true' },
  );
  tradingWebControl = new TradingWebControl(
    tradingCredentials,
    paperAdapter,
    ccxtAdapters,
    tradingEngine,
    null,
    new ExchangeCatalogClient(tradingCredentials),
    exchange => new CcxtExchangeAdapter(exchange, tradingCredentials),
  );
  return tradingEngine;
}

async function startBackupRuntime(runtime: RuntimeConfiguration): Promise<void> {
  const offsiteBackup = offsiteBackupFromEnvironment();
  offsiteBackupReplicator = offsiteBackup.replicator;
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

async function startMonitoringRuntime(
  databasePath: string,
  minimumFreeBytes: number,
  clockGuard: ClockGuard,
): Promise<void> {
  startMetricsServer(Number(process.env.METRICS_PORT || 9100), {
    totalForwardedCountCallback: () => state.totalForwardedCount,
    getQueueStateCallback: () => ({
      running: forwardQueue.running,
      queued: forwardQueue.queue.length,
      maxConcurrency: forwardQueue.maxConcurrency
    }),
    getOperationalMetricsCallback: () => collectOperationalMetrics(
      databasePath,
      minimumFreeBytes,
      clockGuard,
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
  } catch (error) {
    metricsTracker = null;
    await stopMetricsServer();
    throw error;
  }
}

async function resetTelegramViewerState(
  settings?: ManagedTelegramViewerSettingsStore,
  secrets?: TelegramViewerSecretStore,
): Promise<void> {
  await secrets?.clear();
  await settings?.reset();
}

async function performCompleteFactoryReset(
  runtime: RuntimeConfiguration,
  secretStore: ManagedSecretStore,
  runtimeSettings: ManagedRuntimeSettingsStore,
  tradingCredentials: TradingCredentialStore,
  telegramViewerSettings?: ManagedTelegramViewerSettingsStore,
  telegramViewerSecrets?: TelegramViewerSecretStore,
): Promise<void> {
  secretStore.assertClearable();
  if (!tradingWebControl) throw new Error('Factory reset requires initialized trading safety controls.');
  const configPath = configurationPathFromEnvironment();
  const applicationRoot = path.resolve(process.cwd());
  if (!configPath.startsWith(`${applicationRoot}${path.sep}`)) {
    throw new Error(`Factory reset refuses to erase a configuration outside the application root: ${configPath}`);
  }
  const logsDirectory = path.resolve(process.env.LOG_DIR || path.join(process.cwd(), 'logs'));
  const configuredSignalsDirectory = path.resolve(runtime.config.xmlParsing?.signalsDir || path.join(process.cwd(), 'signals'));
  const applicationBoundary: FactoryResetBoundary = { kind: 'application', applicationRoot };
  const managedSecretRoot = secretStore.rootPath();
  const resetDirectories: Array<{ directory: string; boundary: FactoryResetBoundary }> = [
    {
      directory: managedSecretRoot,
      boundary: { kind: 'exact-managed-secret', configuredRoot: managedSecretRoot, applicationRoot },
    },
    { directory: process.env.TEMPLATES_DIR || path.resolve(__dirname, '../templates'), boundary: applicationBoundary },
    { directory: path.join(process.cwd(), 'session_data'), boundary: applicationBoundary },
    { directory: path.join(process.cwd(), 'session_files'), boundary: applicationBoundary },
    { directory: configuredSignalsDirectory, boundary: applicationBoundary },
    { directory: path.join(process.cwd(), 'signals'), boundary: applicationBoundary },
    { directory: process.env.BACKUP_DIR || path.join(process.cwd(), 'backups'), boundary: applicationBoundary },
    { directory: logsDirectory, boundary: applicationBoundary },
  ];
  const targets = new Map<string, FactoryResetBoundary>();
  for (const target of resetDirectories) {
    const resolved = await assertFactoryResetTarget(target.directory, target.boundary);
    targets.set(resolved, target.boundary);
  }

  await stopScheduler(mcpControlBridge, 'MCP control bridge');
  mcpControlBridge = null;
  await stopScheduler(tradingRuntime, 'Trading Runtime');
  tradingRuntime = null;
  await tradingWebControl.assertFactoryResetSafe();
  await stopForwarding();
  await stopScheduler(backupScheduler, 'Laufendes Backup');
  await stopScheduler(retentionScheduler, 'Laufende Daten-Retention');
  backupScheduler = null;
  retentionScheduler = null;
  metricsTracker?.stop();
  metricsTracker = null;
  deliveryTracker?.close('Factory reset.');
  deliveryTracker = null;
  const sharedMcpMaintenance = await beginMcpSharedMaintenance('factory reset', operationalDatabasePath());
  await closeDb();
  await tradingCredentials.clear();
  await resetTelegramViewerState(telegramViewerSettings, telegramViewerSecrets);
  await secretStore.clear();
  await runtimeSettings.reset();
  await fsPromises.rm(configPath, { force: true });
  const maintenanceMarker = path.resolve(sharedMcpMaintenance.markerPath);
  for (const [target, boundary] of targets) {
    const preserve = path.dirname(maintenanceMarker) === path.resolve(target)
      ? [path.basename(maintenanceMarker)]
      : [];
    await clearFactoryResetTarget(target, boundary, preserve);
  }
  await auditTrail?.resetLocal();

  const candidateConfig = structuredClone(DEFAULT_CONFIG);
  writeConfigSync(candidateConfig);
  for (const key of Object.keys(runtime.config)) delete runtime.config[key];
  Object.assign(runtime.config, candidateConfig);
  state.isRunning = false;
  state.connectionState = 'factory-reset';
  state.startupTime = null;
  state.totalForwardedCount = 0;
  state.processedSinceRestart = 0;
  state.resolvedSourceChatIds.clear();
  clearLogHistory();
}

function backupDirectoryPath(): string {
  return path.resolve(process.env.BACKUP_DIR || path.join(process.cwd(), 'backups'));
}

function resolvedBackupArtifact(artifactName: string): string {
  const directory = backupDirectoryPath();
  const artifact = path.resolve(directory, artifactName);
  if (path.dirname(artifact) !== directory) throw new Error('Invalid backup artifact path.');
  return artifact;
}

async function listAvailableBackups(): Promise<string[]> {
  const entries = await fsPromises.readdir(backupDirectoryPath(), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && /^backup-\d{4}-/.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))
    .reverse();
}

async function recoverNamedOffsiteBackup(objectName: string): Promise<string> {
  if (!offsiteBackupReplicator) throw new Error('Off-site backup recovery is not configured.');
  const recovered = await offsiteBackupReplicator.recover(objectName, backupDirectoryPath());
  return path.basename(recovered.artifactPath);
}

async function restoreNamedBackup(artifactName: string) {
  const releaseApplicationMaintenance = beginApplicationMaintenance('backup-restore');
  const artifact = resolvedBackupArtifact(artifactName);
  const databasePath = path.resolve(process.env.FORWARDER_DB_PATH || path.join(process.cwd(), 'session_data', 'forwarder.db'));
  const previousTradingRuntime = tradingRuntime;
  const previousMcpControlBridge = mcpControlBridge;
  const previousBackupScheduler = backupScheduler;
  const previousRetentionScheduler = retentionScheduler;
  let databaseMaintenance: Awaited<ReturnType<typeof beginDatabaseMaintenance>> | null = null;
  let closeAttempted = false;
  let restored = false;
  let tradingStopped = false;
  let backupStopped = false;
  let retentionStopped = false;
  let mcpBridgeStopped = false;
  let sharedMcpMaintenance: Awaited<ReturnType<typeof beginMcpSharedMaintenance>> | null = null;
  try {
    await verifyBackupArtifact(artifact);
    await stopForwarding();
    mcpBridgeStopped = previousMcpControlBridge !== null;
    await stopSchedulerForMaintenance(previousMcpControlBridge, 'MCP control bridge');
    tradingStopped = previousTradingRuntime !== null;
    await stopSchedulerForMaintenance(previousTradingRuntime, 'Trading Runtime');
    if (!tradingWebControl) throw new Error('Backup restore requires initialized trading safety controls.');
    await tradingWebControl.assertFactoryResetSafe();
    backupStopped = previousBackupScheduler !== null;
    await stopSchedulerForMaintenance(previousBackupScheduler, 'Backup scheduler');
    retentionStopped = previousRetentionScheduler !== null;
    await stopSchedulerForMaintenance(previousRetentionScheduler, 'Data retention scheduler');
    sharedMcpMaintenance = await beginMcpSharedMaintenance('verified backup restore', databasePath);
    databaseMaintenance = await beginDatabaseMaintenance('verified backup restore');
    closeAttempted = true;
    await closeDb();
    await removeOperationalLock('./session_data/.routing_active', 'Routing-Lock');
    const result = await restoreBackupArtifact(
      artifact,
      databasePath,
      configurationPathFromEnvironment(),
      path.dirname(databasePath),
      { allowCurrentProcessLock: true }
    );
    tradingRuntime = null;
    mcpControlBridge = null;
    backupScheduler = null;
    retentionScheduler = null;
    restored = true;
    return result;
  } finally {
    if (!restored) {
      await sharedMcpMaintenance?.release();
      if (closeAttempted) {
        await initDb(databasePath).catch(error => {
          if (!String(error?.message || error).includes('already initialized')) throw error;
        });
      }
      databaseMaintenance?.release();
      releaseApplicationMaintenance();
      await Promise.all([
        restartSchedulerAfterFailedMaintenance(retentionStopped, previousRetentionScheduler),
        restartSchedulerAfterFailedMaintenance(backupStopped, previousBackupScheduler),
        restartSchedulerAfterFailedMaintenance(tradingStopped, previousTradingRuntime),
        restartSchedulerAfterFailedMaintenance(mcpBridgeStopped, previousMcpControlBridge),
      ]);
    }
  }
}

function dashboardRecoveryState(
  runtime: RuntimeConfiguration,
  runtimeSettings: ManagedRuntimeSettingsStore,
  secretStore: ManagedSecretStore,
) {
  const runtimeRecovery = runtimeSettings.recoveryStatus();
  const secretRecovery = secretStore.recoveryStatus();
  const active = Boolean(runtime.configurationRecoveryReason) || runtimeRecovery.active || secretRecovery.length > 0;
  return {
    active,
    allowLoopbackLocalSession: active
      && process.env.DASHBOARD_RECOVERY_LOCAL_TRUST?.trim().toLowerCase() === 'true',
    issues: [
      ...(runtime.configurationRecoveryReason
        ? [{ component: 'configuration' as const, reason: runtime.configurationRecoveryReason }]
        : []),
      ...(runtimeRecovery.active && runtimeRecovery.reason
        ? [{ component: 'runtimeSettings' as const, reason: runtimeRecovery.reason }]
        : []),
      ...secretRecovery.map((issue) => ({
        component: 'managedSecret' as const,
        name: issue.name,
        reason: issue.reason,
      })),
    ],
  };
}

function startDashboardRuntime(
  runtime: RuntimeConfiguration,
  secretStore: ManagedSecretStore,
  runtimeSettings: ManagedRuntimeSettingsStore,
  tradingCredentials: TradingCredentialStore,
  telegramViewerSettings?: ManagedTelegramViewerSettingsStore,
  telegramViewerSecrets?: TelegramViewerSecretStore,
): void {
  const webPort = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 8080;
  const recovery = dashboardRecoveryState(runtime, runtimeSettings, secretStore);
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
      getTelegramLoginState: () => telegramLogin.snapshot(),
      submitTelegramLogin: (payload) => telegramLogin.submit(payload),
      auditTrail,
      secretStore,
      runtimeSettings,
      telegramViewerSettings,
      telegramViewerSecrets,
      getTelegramViewerStatus: telegramViewerSecrets
        ? () => getTelegramViewerServiceStatus(telegramViewerSecrets)
        : undefined,
      tradingControl: tradingWebControl ?? undefined,
      getOperationsStatus: () => ({
        backup: backupScheduler?.getStatus() ?? null,
        retention: retentionScheduler?.getStatus() ?? null,
        audit: auditTrail?.snapshot() ?? null,
      }),
      runBackupNow: async () => {
        if (!backupScheduler) throw new Error('Backup scheduler is unavailable.');
        return backupScheduler.runNow();
      },
      listBackups: listAvailableBackups,
      verifyBackup: (artifactName) => verifyBackupArtifact(resolvedBackupArtifact(artifactName)),
      recoverOffsiteBackup: recoverNamedOffsiteBackup,
      restoreBackup: restoreNamedBackup,
      performFactoryReset: async () => {
        await performCompleteFactoryReset(
          runtime,
          secretStore,
          runtimeSettings,
          tradingCredentials,
          telegramViewerSettings,
          telegramViewerSecrets,
        );
      },
      recovery,
      requestRestart: () => {
        setTimeout(() => {
          void shutdown(0).finally(() => process.exit(process.exitCode || 0));
        }, 150).unref();
      }
  });
}

async function getTelegramViewerServiceStatus(secrets: TelegramViewerSecretStore): Promise<Record<string, unknown>> {
  const configured = requireTrustedServiceUrl(
    process.env.TELEGRAM_VIEWER_STATUS_URL,
    'TELEGRAM_VIEWER_STATUS_URL',
    ['telegram-viewer', 'localhost', '127.0.0.1', '[::1]'],
  );
  const endpoint = new URL(configured);
  const response = await fetch(endpoint, {
    method: 'GET',
    headers: { Authorization: `Bearer ${await secrets.serviceToken()}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(3_000),
  });
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > 64 * 1024) throw new Error('Telegram viewer status response is too large.');
  if (!response.ok) throw new Error(`Telegram viewer status request failed with status ${response.status}.`);
  const payload = JSON.parse(text);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Telegram viewer status is malformed.');
  return payload as Record<string, unknown>;
}

async function runConfiguredMode(runtime: RuntimeConfiguration): Promise<boolean> {
  addLog('[INFO] Starting configured Docker service.');
  try {
    await startForwardingNonInteractive(runtime.config);
    return true;
  } catch (error: any) {
    if (error?.message === 'Non-interactive routing configuration is incomplete.') {
      state.connectionState = 'configuration-required';
    }
    addLog(`[ERROR] Automatic routing start failed; dashboard remains available: ${error.message}`);
    return false;
  }
}

async function run() {
  loadEnv();
  const runtimeSettings = managedRuntimeSettingsFromEnvironment();
  await runtimeSettings.initialize({ recoverInvalidFile: true });
  runtimeSettings.applyToEnvironment();
  const clockGuard = new ClockGuard(clockDriftLimitFromEnvironment());
  const secretStore = managedSecretStoreFromEnvironment();
  await secretStore.initialize({ recoverInvalidManagedFiles: true });
  const tradingCredentials = tradingCredentialStoreFromEnvironment();
  await tradingCredentials.initialize();
  let telegramViewerSettings: ManagedTelegramViewerSettingsStore | undefined;
  let telegramViewerSecrets: TelegramViewerSecretStore | undefined;
  try {
    telegramViewerSettings = telegramViewerSettingsFromEnvironment();
    await telegramViewerSettings.initialize({ recoverInvalidFile: true });
    telegramViewerSecrets = telegramViewerSecretStoreFromEnvironment();
    await telegramViewerSecrets.initialize({ recoverInvalidBotToken: true });
  } catch (error: any) {
    telegramViewerSettings = undefined;
    telegramViewerSecrets = undefined;
    addLog(`[ERROR] Telegram viewer control could not initialize; core routing and trading remain unaffected: ${error.message}`);
  }
  const runtime = loadRuntimeConfiguration();
  if (runtimeSettings.recoveryStatus().active || secretStore.recoveryStatus().length > 0 || runtime.configurationRecoveryReason) {
    state.connectionState = 'recovery-required';
    addLog('[CRITICAL] Managed settings or secrets are invalid. Routing and background operations remain disabled until repaired in the dashboard and restarted.');
    try {
      await initDb();
      await composeTradingControl(tradingCredentials, clockGuard);
    } catch (error: any) {
      addLog(`[CRITICAL] Trading safety state could not be loaded in recovery mode; factory reset remains blocked until database recovery: ${error.message}`);
    }
    startDashboardRuntime(
      runtime, secretStore, runtimeSettings, tradingCredentials, telegramViewerSettings, telegramViewerSecrets,
    );
    return;
  }
  const { databasePath, retentionPolicy } = await initializeCoreRuntime(tradingCredentials, clockGuard, runtime.config);
  startDashboardRuntime(
    runtime, secretStore, runtimeSettings, tradingCredentials, telegramViewerSettings, telegramViewerSecrets,
  );
  let operationalGatesHealthy = true;
  try {
    await startMonitoringRuntime(databasePath, retentionPolicy.minFreeBytes, clockGuard);
  } catch (error: any) {
    operationalGatesHealthy = false;
    addLog(`[CRITICAL] Monitoring runtime failed to initialize; trading entries remain disabled: ${error.message}`);
  }
  try {
    await startBackupRuntime(runtime);
  } catch (error: any) {
    operationalGatesHealthy = false;
    addLog(`[CRITICAL] Backup runtime failed to initialize; trading entries remain disabled: ${error.message}`);
  }
  const routingHealthy = await runConfiguredMode(runtime);
  const tradingState = await getTradingRuntimeState();
  if (operationalGatesHealthy && routingHealthy && tradingState.executionEnabled && !tradingState.killSwitchActive) {
    try {
      await tradingRuntime?.enableEntries();
      addLog('[TRADING] Entry processing enabled after all startup gates passed.');
    } catch (error: any) {
      addLog(`[CRITICAL] Trading entry latch remains disabled: ${error.message}`);
    }
  } else if (tradingState.executionEnabled) {
    addLog('[CRITICAL] Persisted trading execution was enabled, but one or more startup gates failed; entry processing remains disabled.');
  }
}
try {
  await run();
} catch (err: any) {
  console.error("Kritischer Fehler:", err.message);
  await shutdown(1);
  process.exit(process.exitCode || 1);
}
