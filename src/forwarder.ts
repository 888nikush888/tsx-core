import * as tdl from 'tdl';
import { getTdjson } from 'prebuilt-tdlib';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { readConfigSync, writeConfigSync, isValidTargetChannel } from './config.js';
import { loadEnv } from './env.js';
import { getMessageTextAndType, shouldForward } from './filters.js';
import { ConcurrencyQueue } from './queue.js';
import { isDuplicateSignal, normalizeSignalXml } from './dupe_blocker.js';
import { getTotalForwardedCount, incrementForwardedCount, initDb, saveSignal, saveIncomingMessage, updateIncomingMessageStatus } from './db.js';
import { startMetricsServer, stopMetricsServer } from './metrics.js';
import { startWebServer, stopWebServer } from './web_server.js';
import { parseSignalToXml } from './signal_parser.js';
import { MetricsTracker } from './metrics_tracker.js';
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
  const CRASH_COUNTER_FILE = path.join(__dirname, '../session_data/.crash_counter');
  try {
    const lockExists = await fsPromises.stat('./session_data/.routing_active').then(() => true).catch(() => false);
    if (!lockExists) {
      await fsPromises.mkdir('./session_data', { recursive: true });
      await fsPromises.writeFile(CRASH_COUNTER_FILE, JSON.stringify({ count: 0, lastCrash: 0 }), 'utf-8');
      return;
    }
    
    let counter = { count: 0, lastCrash: 0 };
    try {
      const raw = await fsPromises.readFile(CRASH_COUNTER_FILE, 'utf-8');
      counter = JSON.parse(raw);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.warn(`[WARN] Fehler beim Lesen der Crash-Counter Datei: ${e.message}`);
      }
    }
    
    const now = Date.now();
    if (now - counter.lastCrash < 5 * 60 * 1000) {
      counter.count++;
    } else {
      counter.count = 1;
    }
    counter.lastCrash = now;
    
    await fsPromises.mkdir('./session_data', { recursive: true });
    await fsPromises.writeFile(CRASH_COUNTER_FILE, JSON.stringify(counter), 'utf-8');
    
    if (counter.count >= 3) {
      console.error(`\n[FATAL] Crash-Loop erkannt (${counter.count} Crashes in unter 5 Minuten).`);
      console.error(`Please check logs/ folder to identify the issue before restarting.`);
      try { await fsPromises.unlink('./session_data/.routing_active'); } catch (e) {
        if (e.code !== 'ENOENT') console.warn(`[WARN] Konnte .routing_active nicht löschen: ${e.message}`);
      }
      process.exit(1);
    }
  } catch (err) {
    console.warn(`[WARN] Unerwarteter Fehler im Crash-Loop-Checker: ${err.message}`);
  }
}

try { tdl.configure({ tdjson: getTdjson() }); } catch (error) {
  console.error("Fehler beim Initialisieren der TDLib-Bibliothek:", error.message);
  process.exit(1);
}

const forwardQueue = new ConcurrencyQueue(2);
const PERSIST_FILE = './session_data/queue_persist.json';
let persistedTasks = [];

function applyQueueSettings(config: any) {
  const maxConcurrency = config?.forwardOptions?.maxConcurrency ?? 2;
  const queueTimeoutSeconds = config?.forwardOptions?.queueTimeoutSeconds ?? 60;
  forwardQueue.updateSettings(maxConcurrency, queueTimeoutSeconds * 1000);
}

async function savePersistedTasks() {
  try {
    await fsPromises.writeFile(PERSIST_FILE, JSON.stringify(persistedTasks, null, 2), 'utf-8');
  } catch (err) {
    addLog(`[WARN] Fehler beim Speichern der Persistenz-Queue: ${err.message}`);
  }
}

async function loadPersistedTasks() {
  try {
    const data = await fsPromises.readFile(PERSIST_FILE, 'utf-8');
    persistedTasks = JSON.parse(data);
    addLog(`[INFO] Persistenz-Queue geladen: ${persistedTasks.length} offene Tasks.`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[WARN] Fehler beim Laden der persistierten Tasks: ${err.message}`);
    }
    persistedTasks = [];
  }
}

async function resumePersistedTasks(config) {
  if (persistedTasks.length === 0) return;
  addLog(`[INFO] Setze ${persistedTasks.length} unterbrochene(n) Task(s) fort...`);
  
  const tasksToRun = [...persistedTasks];
  for (const task of tasksToRun) {
    forwardQueue.add(async (signal) => {
      try {
        if (task.type === 'single') {
          const message = await invokeWithRetry(client, {
            _: 'getMessage',
            chat_id: Number(task.chatId),
            message_id: Number(task.messageId)
          });
          await forwardSingleMessage(message, config, signal);
        } else if (task.type === 'mediaGroup') {
          const messages = [];
          for (const mId of task.messageIds) {
            try {
              const msg = await invokeWithRetry(client, {
                _: 'getMessage',
                chat_id: Number(task.chatId),
                message_id: Number(mId)
              });
              messages.push(msg);
            } catch (e) {
              addLog(`[WARN] Konnte Nachricht ${mId} für Album ${task.mediaGroupId} nicht laden: ${e.message}`);
            }
          }
          if (messages.length > 0) {
            await forwardMediaGroup(task.mediaGroupId, config, {
              messages,
              fromChatId: Number(task.chatId)
            }, signal);
          }
        }
      } catch (err) {
        addLog(`[ERROR] Wiederaufnahme-Fehler für Task ${task.id}: ${err.message}`);
      } finally {
        persistedTasks = persistedTasks.filter(t => t.id !== task.id);
        await savePersistedTasks();
      }
    }).catch(err => {
      addLog(`[ERROR] Wiederaufnahme-Fehler in Queue für Task ${task.id}: ${err.message}`);
    });
  }
}

async function enqueueTask(taskData, executeLogic, errorPrefix) {
  persistedTasks.push(taskData);
  await savePersistedTasks();

  forwardQueue.add(async (signal) => {
    try {
      await executeLogic(signal);
    } finally {
      persistedTasks = persistedTasks.filter(t => t.id !== taskData.id);
      await savePersistedTasks();
    }
  }).catch(err => {
    addLog(`[ERROR] ${errorPrefix}: ${err.message}`);
  });
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
    (signal) => forwardSingleMessage(message, config, signal),
    `Fehler beim Weiterleiten von Einzelnachricht ${message.id}`
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
    (signal) => forwardMediaGroup(gId, config, g, signal),
    `Album-Fehler ${gId}`
  );
}

const mediaGroupBuffer = new Map();
const ALBUM_DELAY_MS = 800;
let client = null, targetChatId = null;
let metricsTracker: MetricsTracker | null = null;
const state = {
  isRunning: false,
  connectionState: 'disconnected',
  resolvedSourceChatIds: new Set(),
  totalForwardedCount: 0,
  processedSinceRestart: 0,
  startupTime: null as number | null
};

async function recordForwardedMessages(amount = 1) {
  state.totalForwardedCount += amount;
  state.processedSinceRestart += amount;
  try {
    await incrementForwardedCount(amount);
  } catch (error: any) {
    addLog(`[WARN] Weiterleitungszähler konnte nicht gespeichert werden: ${error.message}`);
  }
}

async function invokeWithRetry(tdClient, query, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await tdClient.invoke(query);
    } catch (e) {
      if (e.message && e.message.includes('FLOOD_WAIT_')) {
        const match = e.message.match(/FLOOD_WAIT_(\d+)/);
        const waitSeconds = match ? parseInt(match[1], 10) : 2;
        addLog(`[WARN] Telegram Rate Limit erreicht. Warte ${waitSeconds}s (Versuch ${i + 1}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, waitSeconds * 1000));
      } else {
        throw e;
      }
    }
  }
  throw new Error(`Aktion nach ${maxRetries} Rate-Limit-Retries fehlgeschlagen.`);
}

async function parseSignalNative(
  text: string,
  timeoutMs: number,
  templateName: string | null = null,
  models: { primaryModel?: string; fallbackModel?: string } = {},
  signal: any = null
): Promise<string> {
  if (signal?.aborted) throw new Error('Task aborted');

  let onAbort: (() => void) | undefined;
  let timeoutId: NodeJS.Timeout | undefined;

  const parsePromise = parseSignalToXml(text, templateName || undefined, models);
  
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Parser Timeout (${timeoutMs || DEFAULT_PARSER_TIMEOUT_MS}ms)`));
    }, timeoutMs || DEFAULT_PARSER_TIMEOUT_MS);
  });

  const abortPromise = signal ? new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('Task aborted'));
    signal.addEventListener('abort', onAbort);
  }) : null;

  const promises: Promise<any>[] = [parsePromise, timeoutPromise];
  if (abortPromise) promises.push(abortPromise);

  try {
    return await Promise.race(promises);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
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

async function tryManualCopyFallback(message) {
  const content = message.content;
  if (!content) return;
  
  let formattedText = null;
  if (content._ === 'messageText') {
    formattedText = content.text;
  } else if (content.caption) {
    formattedText = content.caption;
  }
  
  if (formattedText && formattedText.text?.trim()) {
    addLog(`[Forward Fallback] Kanal geschützt. Versuche Text manuell zu kopieren und zu senden...`);
    try {
      await invokeWithRetry(client, {
        _: 'sendMessage', chat_id: targetChatId,
        input_message_content: {
          _: 'inputMessageText',
          text: formattedText,
          clear_draft: true
        }
      });
      addLog(`[SUCCESS] Paket ${message.id} manuell als Text kopiert und gesendet.`);
      await recordForwardedMessages();
    } catch (fallbackError) {
      addLog(`[ERROR] Manueller Kopier-Fallback fehlgeschlagen: ${fallbackError.message}`);
    }
  }
}

async function forwardRawMessage(message, config) {
  addLog(`[Forward] Route Einzelpaket ${message.id} an Ziel-Knoten...`);
  try {
    await invokeWithRetry(client, {
      _: 'forwardMessages', chat_id: targetChatId, from_chat_id: message.chat_id, message_ids: [message.id],
      options: { _: 'sendMessageOptions' }, as_album: false,
      send_copy: !!config.forwardOptions?.sendCopy, remove_caption: !!config.forwardOptions?.removeCaption
    });
    addLog(`[SUCCESS] Paket ${message.id} erfolgreich übertragen.`);
    await recordForwardedMessages();
    updateIncomingMessageStatus(String(message.chat_id), message.id, 'processed').catch(() => {});
  } catch (error) {
    addLog(`[ERROR] Übertragungsfehler bei Paket ${message.id}: ${error.message}`);
    updateIncomingMessageStatus(String(message.chat_id), message.id, 'failed').catch(() => {});
    if (config.forwardOptions?.sendCopy) {
      await tryManualCopyFallback(message);
    }
  }
}

async function checkDuplicateAndSave(message, xmlString, xmlParsing, dupeBlocker) {
  if (dupeBlocker.enabled) {
    const baseDir = xmlParsing.signalsDir || './signals';
    const cooldown = dupeBlocker.cooldownHours !== undefined ? dupeBlocker.cooldownHours : 24;
    const dupeResult = await isDuplicateSignal(xmlString, baseDir, cooldown);
    if (dupeResult.isDupe) {
      addLog(`[DUPE-BLOCKER] Paket ${message.id} blockiert: ${dupeResult.reason}`);
      updateIncomingMessageStatus(String(message.chat_id), message.id, 'duplicate').catch(() => {});
      return true;
    }
  }
  
  if (xmlParsing.saveToFile) {
    const baseDir = xmlParsing.signalsDir || './signals';
    const channelDir = path.join(baseDir, String(message.chat_id));
    await fsPromises.mkdir(channelDir, { recursive: true });
    await fsPromises.writeFile(path.join(channelDir, `signal_${message.id}.xml`), xmlString, 'utf-8');
  }

  // Save the successfully extracted signal into SQLite DB
  try {
    const normalizedNew = normalizeSignalXml(xmlString);
    const sigId = `signal_${message.chat_id}_${message.id}`;
    await saveSignal(sigId, String(message.chat_id), message.id, xmlString, normalizedNew);
  } catch (dbErr: any) {
    addLog(`[WARN] Signal konnte nicht in der DB gespeichert werden: ${dbErr.message}`);
  }
  
  return false;
}

async function sendXmlMessage(xmlString) {
  addLog(`[Forward] Sende extrahiertes XML...`);
  await invokeWithRetry(client, {
    _: 'sendMessage', chat_id: targetChatId,
    input_message_content: { _: 'inputMessageText', text: { _: 'formattedText', text: xmlString } }
  });
  await recordForwardedMessages();
}

async function processXmlSignal(message, text, xmlParsing, dupeBlocker, shouldForwardToTelegram, signal = null) {
  addLog(`[XML-Parser] Analysiere Signal-Text für Paket ${message.id}...`);
  const forwardXml = shouldForwardToTelegram && xmlParsing.forwardXmlToTarget;
  try {
    const sourceId = String(message.chat_id);
    const sourceTemplates = xmlParsing.sourceTemplates || {};
    const templateName = sourceTemplates[sourceId];
    
    const xmlString = await parseSignalNative(
      text,
      xmlParsing.timeout || DEFAULT_PARSER_TIMEOUT_MS,
      templateName,
      {
        primaryModel: xmlParsing.primaryModel,
        fallbackModel: xmlParsing.fallbackModel
      },
      signal
    );
    addLog(`[XML-Parser SUCCESS] Paket ${message.id} erfolgreich analysiert.`);
    
    const isDupe = await checkDuplicateAndSave(message, xmlString, xmlParsing, dupeBlocker);
    if (isDupe) return true;
    
    if (forwardXml) {
      await sendXmlMessage(xmlString);
    }
    
    if (!shouldForwardToTelegram || forwardXml) {
      updateIncomingMessageStatus(String(message.chat_id), message.id, 'processed').catch(() => {});
      return true;
    }
  } catch (error) {
    addLog(`[XML-Parser ERROR] Paket ${message.id}: ${error.message}`);
    updateIncomingMessageStatus(String(message.chat_id), message.id, 'failed').catch(() => {});
    if (forwardXml) {
      addLog(`[Forward] Überspringe Paket ${message.id} wegen Parser-Fehler (Raw-Fallback deaktiviert).`);
      return true;
    }
  }
  return false;
}

async function forwardSingleMessage(message, config, signal = null) {
  if (signal?.aborted) throw new Error('Task aborted');
  const { text } = getMessageTextAndType(message);
  const shouldForwardToTelegram = config.forwardOptions?.forwardToTarget ?? true;

  const xmlParsing = config.xmlParsing || {};
  const dupeBlocker = config.dupeBlocker || {};

  let xmlProcessed = false;
  if (xmlParsing.enabled && text?.trim()) {
    xmlProcessed = await processXmlSignal(message, text, xmlParsing, dupeBlocker, shouldForwardToTelegram, signal);
  }

  if (!xmlProcessed && shouldForwardToTelegram) {
    await forwardRawMessage(message, config);
  }
}

const BUFFER_PERSIST_FILE = './session_data/media_group_buffer.json';

async function saveMediaGroupBuffer() {
  try {
    const data = {};
    for (const [gId, g] of mediaGroupBuffer.entries()) {
      data[gId] = {
        messages: g.messages,
        fromChatId: g.fromChatId
      };
    }
    await fsPromises.writeFile(BUFFER_PERSIST_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    addLog(`[WARN] Fehler beim Speichern des Media-Group-Buffers: ${err.message}`);
  }
}

async function loadAndResumeMediaGroupBuffer(config) {
  try {
    const raw = await fsPromises.readFile(BUFFER_PERSIST_FILE, 'utf-8');
    const data = JSON.parse(raw);
    const keys = Object.keys(data);
    if (keys.length === 0) return;
    addLog(`[INFO] Wiederherstellung von ${keys.length} unvollständigen Alben aus dem Festplatten-Buffer...`);
    for (const gId of keys) {
      const g = data[gId];
      await enqueueMediaGroup(gId, config, g);
    }
    await fsPromises.writeFile(BUFFER_PERSIST_FILE, '{}', 'utf-8');
  } catch {
    // Datei existiert nicht oder ist ungültig - ignorieren
  }
}

function handleMediaGroupMessage(message, config) {
  const gId = message.media_group_id;
  if (!mediaGroupBuffer.has(gId)) mediaGroupBuffer.set(gId, { messages: [], fromChatId: message.chat_id, timer: null });
  const g = mediaGroupBuffer.get(gId);
  if (g.timer) clearTimeout(g.timer);
  g.messages.push(message);
  
  saveMediaGroupBuffer().catch(() => {});

  g.timer = setTimeout(() => {
    // Race-Condition-Fix: Gruppe sofort aus der Map entfernen, bevor sie in die Queue geht,
    // damit verspätete Nachrichten nicht der bereits getriggerten Gruppe hinzugefügt werden
    mediaGroupBuffer.delete(gId);
    saveMediaGroupBuffer().catch(() => {});
    enqueueMediaGroup(gId, config, g).catch(err => addLog(`[ERROR] Album-Fehler: ${err.message}`));
  }, ALBUM_DELAY_MS);
}


// Gruppen-Objekt wird jetzt direkt als Parameter übergeben statt aus der Map gelesen
async function forwardMediaGroup(gId, config, g, signal = null) {
  if (signal?.aborted) throw new Error('Task aborted');
  if (!g) return;
  g.messages.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  const ids = g.messages.map(m => m.id);
  addLog(`[Forward] Route Album-Paketgruppe ${gId} (${ids.length} Teile) an Ziel-Knoten...`);
  try {
    await invokeWithRetry(client, {
      _: 'forwardMessages', chat_id: targetChatId, from_chat_id: g.fromChatId, message_ids: ids,
      options: { _: 'sendMessageOptions' }, as_album: true,
      send_copy: !!config.forwardOptions?.sendCopy, remove_caption: !!config.forwardOptions?.removeCaption
    });
    addLog(`[SUCCESS] Album-Paketgruppe ${gId} erfolgreich übertragen.`);
    await recordForwardedMessages(ids.length);
    for (const msg of g.messages) {
      updateIncomingMessageStatus(String(msg.chat_id), msg.id, 'processed').catch(() => {});
    }
  } catch (e: any) { 
    addLog(`[ERROR] Album-Übertragungsfehler ${gId}: ${e.message}`);
    for (const msg of g.messages) {
      updateIncomingMessageStatus(String(msg.chat_id), msg.id, 'failed').catch(() => {});
    }
  }
}

function handleUpdate(update, config) {
  if (update._ === 'updateConnectionState') {
    const stateName = update.state?._ || 'unknown';
    addLog(`[TDLib Status] Verbindungszustand geändert: ${stateName}`);
  }

  if (update._ === 'updateNewMessage') {
    const message = update.message;
    const chatIdStr = String(message.chat_id);
    if (state.resolvedSourceChatIds.has(chatIdStr)) {
      if (message.is_outgoing) return;
      if (message.date < state.startupTime) {
        return; // Ignoriere alte Nachrichten aus der Offline-Zeit
      }
      
      const { text, type } = getMessageTextAndType(message);
      const sender = config.sourceAliases?.[chatIdStr] || chatIdStr;
      saveIncomingMessage(chatIdStr, message.id, sender, text || '', type, 'received')
        .catch(err => addLog(`[WARN] Fehler beim Speichern der Eingangsnachricht: ${err.message}`));

      addLog(`[INFO] Neues Datenpaket ${message.id} an Quell-Knoten ${chatIdStr} abgefangen.`);
      if (!shouldForward(message, config.filters, addLog, chatIdStr, config)) {
        updateIncomingMessageStatus(chatIdStr, message.id, 'filtered').catch(() => {});
        return;
      }
      if (message.media_group_id && message.media_group_id !== '0') {
        const shouldForwardToTelegram = config.forwardOptions?.forwardToTarget ?? true;
        if (shouldForwardToTelegram) {
          handleMediaGroupMessage(message, config);
        } else {
          addLog(`[INFO] Album-Paketgruppe ${message.media_group_id} übersprungen (Weiterleitung deaktiviert).`);
        }
      } else {
        enqueueSingleMessage(message, config).catch(err => {
          addLog(`[ERROR] Unbehandelter Fehler: ${err.message}`);
        });
      }
    }
  }
}

async function stopForwarding() {
  addLog("[INFO] Stoppe Weiterleitung...");
  state.isRunning = false;
  state.connectionState = 'disconnected';
  state.startupTime = null;
  state.resolvedSourceChatIds.clear();
  clearLogHistory();
  forwardQueue.clear();
  
  try {
    await stopMetricsServer();
  } catch (e) {
    addLog(`[WARN] Fehler beim Stoppen des Metrik-Servers: ${e.message}`);
  }

  try {
    await fsPromises.unlink('./session_data/.routing_active');
  } catch {
    /* ignore lockfile removal failure */
  }
  if (client) {
    try {
      await client.close();
    } catch {
      /* ignore close error */
    }
    client = null;
  }
  addLog("[SUCCESS] Weiterleitung gestoppt!");
}

async function startForwardingNonInteractive(config) {
  applyQueueSettings(config);
  
  const apiId = process.env.TELEGRAM_API_ID ? parseInt(process.env.TELEGRAM_API_ID, 10) : config.apiId;
  const apiHash = process.env.TELEGRAM_API_HASH;
  
  if (!apiId || !/^[a-f0-9]{32}$/i.test(apiHash || '') || config.sourceChannels.length === 0 || !isValidTargetChannel(config.targetChannel)) {
    addLog("[ERROR] Konfiguration unvollständig! Bitte apiId, TELEGRAM_API_HASH, sourceChannels und targetChannel prüfen.");
    process.exit(1);
  }

  try {
    addLog("[INFO] Verbinde mit Telegram Mainframe...");
    client = tdl.createClient({ apiId, apiHash, databaseDirectory: './session_data', filesDirectory: './session_files' });
    client.on('error', err => {
      state.connectionState = 'error';
      addLog(`[TDLib Fehler] ${err.message || err}`);
    });
    
    await client.login();
    state.connectionState = 'connected';
    addLog("[SUCCESS] Mainframe-Verbindung autorisiert!");
    
    for (const list of [{ _: 'chatListMain' }, { _: 'chatListArchive' }]) {
      try {
        for (let i = 0; i < 15; i++) await client.invoke({ _: 'loadChats', chat_list: list, limit: 100 });
      } catch (e) { 
        if (e.message && !e.message.includes('CHAT_LIST_LOAD')) {
          addLog(`[WARN] loadChats (${list._}): ${e.message}`); 
        }
      }
    }
    
    state.resolvedSourceChatIds.clear();
    for (const src of config.sourceChannels) {
      const id = await resolveChatId(src); 
      state.resolvedSourceChatIds.add(id);
      addLog(`[SUCCESS] Quell-Knoten geladen: ${src} -> ${id}`);
    }
    
    targetChatId = await resolveChatId(config.targetChannel);
    addLog(`[SUCCESS] Ziel-Knoten geladen: ${config.targetChannel} -> ${targetChatId}`);
    
    // Set startupTime to filter out offline messages
    state.startupTime = Math.floor(Date.now() / 1000);
    
    client.on('update', update => handleUpdate(update, config));
    state.isRunning = true; 
    addLog("[SUCCESS] Mainframe-Routing aktiv!");
    
    // Create lockfile to mark routing active
    try {
      await fsPromises.mkdir('./session_data', { recursive: true });
      await fsPromises.writeFile('./session_data/.routing_active', 'active', 'utf-8');
    } catch (e) {
      addLog(`[WARN] Konnte Lockfile nicht erstellen: ${e.message}`);
    }

    await loadPersistedTasks();
    await resumePersistedTasks(config);
    await loadAndResumeMediaGroupBuffer(config);

    // Start Prometheus metrics and healthcheck server in non-interactive/daemon mode
    try {
      startMetricsServer(Number(process.env.METRICS_PORT || 9100), {
        totalForwardedCountCallback: () => state.totalForwardedCount,
        getQueueStateCallback: () => ({
          running: forwardQueue.running,
          queued: forwardQueue.queue.length,
          maxConcurrency: forwardQueue.maxConcurrency
        })
      });
    } catch (err: any) {
      addLog(`[WARN] Konnte Metrik-Server nicht starten: ${err.message}`);
    }

    // Keep running indefinitely (the process will exit via global SIGINT/SIGTERM handlers)
    await new Promise(() => {});

  } catch (error) {
    state.connectionState = 'error';
    addLog(`[FATAL] Fehler beim Starten des Forwardings: ${error.message}`);
    try {
      await fsPromises.unlink('./session_data/.routing_active');
    } catch {
      /* ignore lockfile removal failure */
    }
    if (client) {
      try {
        await client.close();
      } catch {
        /* ignore close error */
      }
      client = null;
    }
    process.exit(1);
  }
}

async function startForwarding(config) {
  applyQueueSettings(config);
  const apiId = process.env.TELEGRAM_API_ID ? parseInt(process.env.TELEGRAM_API_ID, 10) : config.apiId;
  const apiHash = process.env.TELEGRAM_API_HASH;
  if (!apiId || !/^[a-f0-9]{32}$/i.test(apiHash || '') || config.sourceChannels.length === 0 || !isValidTargetChannel(config.targetChannel)) {
    console.log(`\n${C_RED}FEHLER: Konfiguration unvollständig!${C_RESET}\n${C_GREEN}Beliebige Taste drücken...${C_RESET}`);
    await pressAnyKey(); return 'main';
  }
  clearConsole();
  console.log(`${C_DARK_GREEN}===================================================\n Verbinde mit Telegram Mainframe... Bitte warten.\n===================================================${C_RESET}`);
  try {
    client = tdl.createClient({ apiId, apiHash, databaseDirectory: './session_data', filesDirectory: './session_files' });
    client.on('error', err => {
      state.connectionState = 'error';
      addLog(`[TDLib Fehler] ${err.message || err}`);
    });
    await client.login();
    state.connectionState = 'connected';
    clearLogHistory(); addLog("[SUCCESS] Mainframe-Verbindung autorisiert!");
    for (const list of [{ _: 'chatListMain' }, { _: 'chatListArchive' }]) {
      try {
        for (let i = 0; i < 15; i++) await client.invoke({ _: 'loadChats', chat_list: list, limit: 100 });
      } catch (e) { if (e.message && !e.message.includes('CHAT_LIST_LOAD')) addLog(`[WARN] loadChats (${list._}): ${e.message}`); }
    }
    state.resolvedSourceChatIds.clear();
    for (const src of config.sourceChannels) {
      const id = await resolveChatId(src); state.resolvedSourceChatIds.add(id);
      addLog(`[SUCCESS] Quell-Knoten geladen: ${src} -> ${id}`);
    }
    targetChatId = await resolveChatId(config.targetChannel);
    addLog(`[SUCCESS] Ziel-Knoten geladen: ${config.targetChannel} -> ${targetChatId}`);
    client.on('update', update => handleUpdate(update, config));
    state.startupTime = Math.floor(Date.now() / 1000);
    state.isRunning = true; addLog("[SUCCESS] Mainframe-Routing active!");
    
    // Create lockfile to mark routing active
    try {
      await fsPromises.mkdir('./session_data', { recursive: true });
      await fsPromises.writeFile('./session_data/.routing_active', 'active', 'utf-8');
    } catch (e) {
      addLog(`[WARN] Konnte Lockfile nicht erstellen: ${e.message}`);
    }

    await loadPersistedTasks();
    await resumePersistedTasks(config);
    await loadAndResumeMediaGroupBuffer(config);
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
  } catch (error) {
    state.connectionState = 'error';
    console.error(`\n${C_RED}Startfehler:${C_RESET}`, error.message);
    // Remove lockfile on startup errors to avoid boot crash loop
    try {
      await fsPromises.unlink('./session_data/.routing_active');
    } catch {
      /* ignore lockfile removal failure */
    }
    if (client) {
      try {
        await client.close();
      } catch {
        /* ignore close error */
      }
      client = null;
    }
    forwardQueue.clear();
    console.log(`\n${C_GREEN}Beliebige Taste drücken...${C_RESET}`); await pressAnyKey();
  }
  return 'main';
}

async function restartApp() {
  clearConsole(); console.log(`${C_GREEN}Initialisiere Neustart des Mainframes...${C_RESET}`);
  if (client) {
    try {
      await client.close();
    } catch {
      /* ignore close error */
    }
    client = null;
  }
  state.isRunning = false; state.connectionState = 'disconnected'; state.startupTime = null; state.resolvedSourceChatIds.clear(); clearLogHistory();
  await new Promise(r => setTimeout(r, 800)); await playStartupAnimation(); return 'main';
}

const shutdown = async () => {
  addLog("[INFO] System-Shutdown eingeleitet...");
  if (metricsTracker) {
    try {
      metricsTracker.stop();
    } catch {
      /* ignore stop error */
    }
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
  try {
    await fsPromises.unlink('./session_data/.routing_active');
  } catch {
    /* ignore lockfile removal failure */
  }
  if (client) {
    try { 
      await client.close(); 
    } catch (err) {
      console.warn(`[WARN] Fehler beim Schließen des TDLib Clients: ${err.message}`);
    }
  }
  process.exit(0);
};
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);

async function run() {
  loadEnv(); let config = readConfigSync();
  await initFileLogger();
  await initDb();
  state.totalForwardedCount = await getTotalForwardedCount();

  // Initialize and start Metrics Tracker
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

  // Start Web Dashboard Server (Default Port: 8080)
  const webPort = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
  try {
    startWebServer(webPort, {
      config,
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
        config = readConfigSync();
      },
      applyRuntimeConfig: (updatedConfig) => {
        applyQueueSettings(updatedConfig);
      },
      getMetricsHistory: () => {
        return metricsTracker ? metricsTracker.getHistory() : [];
      }
    });
  } catch (err: any) {
    addLog(`[WARN] Web Dashboard konnte nicht gestartet werden: ${err.message}`);
  }

  await checkCrashLoop();

  const isNonInteractive = process.env.NON_INTERACTIVE === 'true' || !process.stdout.isTTY;

  if (isNonInteractive) {
    addLog("[INFO] Starte im nicht-interaktiven Modus (Daemon-Modus)...");
    await startForwardingNonInteractive(config);
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
    if (menu === 'main') menu = await runMenuSystem(config, writeConfigSync, state);
    else if (menu === 'start') menu = await startForwarding(config);
    else if (menu === 'restart') { menu = await restartApp(); config = readConfigSync(); }
  }
  clearConsole(); console.log(`${C_GREEN}Beende Programm...${C_RESET}`);
  if (client) {
    try {
      await client.close();
    } catch {
      /* ignore close error */
    }
  }
  process.exit(0);
}
run().catch(err => { console.error("Kritischer Fehler:", err.message); process.exit(1); });
