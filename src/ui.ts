import readline from 'readline';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseRegex } from './filters.js';
import { isValidTargetChannel, mergeConfigDefaults } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, '../logs');

import { C_RESET, C_BOLD, C_DIM, C_GREEN, C_BRIGHT_GREEN, C_DARK_GREEN, C_WHITE, C_WHITE_BOLD, C_RED, C_YELLOW, C_GRAY } from './ui/colors.js';
export { C_RESET, C_BOLD, C_DIM, C_GREEN, C_BRIGHT_GREEN, C_DARK_GREEN, C_WHITE, C_WHITE_BOLD, C_RED, C_YELLOW, C_GRAY };

// Global state in the UI module
const MAX_LOG_ENTRIES = 30;
let logHistory = [];
const spinnerChars = ['¥', 'Ұ', 'Y', '│', 'Y', 'Ұ'];

// --- Persistent File Logger ---
let logFileReady = false;
let logFilePath = null;
let logWriteFailureReported = false;

type LogContextValue = string | number | boolean | null | undefined;
export type LogContext = Record<string, LogContextValue>;

/**
 * Strips ANSI escape codes from a string so log files contain clean plain text.
 */
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Returns the log file path for today (logs/YYYY-MM-DD.log).
 */
function getTodayLogFilePath() {
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return path.join(LOG_DIR, `${dateStr}.log`);
}

/**
 * Mask PII (Personal Identifiable Information) such as EVM/BTC addresses
 * and phone numbers before they are logged or persisted.
 */
export function maskPII(text) {
  if (typeof text !== 'string') return text;
  return text
    // Mask EVM Addresses (0x followed by 40 hex chars)
    .replace(/\b0x[a-fA-F0-9]{40}\b/gi, '0x...[MASKED_EVM_ADDR]')
    // Mask Bitcoin Addresses (base58 starting with 1 or 3, or bech32 starting with bc1, length 26-62)
    .replace(/\b(1|3)[a-km-zA-HJ-NP-Z1-9]{25,34}\b/g, '[MASKED_BTC_ADDR]')
    .replace(/\bbc1[ac-hj-np-z0-9]{11,71}\b/gi, '[MASKED_BTC_ADDR]')
    // Mask Phone numbers in international formats (+ followed by digits, spaces, dashes)
    .replace(/\+\d{1,4}[ \d-]{6,14}\b/g, '[MASKED_PHONE]');
}

/**
 * Deletes log files in the log directory that are older than the specified retention days.
 */
async function runLogRetentionCleanup(retentionDays = 14) {
  try {
    const files = await fsPromises.readdir(LOG_DIR);
    const logFiles = files.filter(f => f.endsWith('.log'));
    const now = Date.now();
    const limitMs = retentionDays * 24 * 60 * 60 * 1000;
    
    for (const file of logFiles) {
      const datePart = file.slice(0, 10);
      const fileDate = new Date(datePart);
      if (isNaN(fileDate.getTime())) continue;
      
      const ageMs = now - fileDate.getTime();
      if (ageMs > limitMs) {
        const filePath = path.join(LOG_DIR, file);
        await fsPromises.unlink(filePath);
      }
    }
  } catch (error: any) {
    console.error(`[WARN] Log retention cleanup failed: ${error.message}`);
  }
}

/**
 * Initializes the persistent file logger. Creates the logs/ directory if needed
 * and writes a session start marker. Call once at application startup.
 */
export async function initFileLogger() {
  try {
    await fsPromises.mkdir(LOG_DIR, { recursive: true });
    logFilePath = getTodayLogFilePath();
    const sessionHeader = `\n${'='.repeat(70)}\n  SESSION START: ${new Date().toISOString()}\n${'='.repeat(70)}\n`;
    await fsPromises.appendFile(logFilePath, sessionHeader, 'utf-8');
    logFileReady = true;

    // GDPR requirement: Auto-clean logs older than 14 days
    await runLogRetentionCleanup(14);
  } catch (err: any) {
    console.error(`[WARN] Logbuch konnte nicht initialisiert werden: ${err.message}`);
    logFileReady = false;
  }
}

/**
 * Appends a line to the persistent log file (fire-and-forget, non-blocking).
 */
function writeToLogFile(line) {
  if (!logFileReady) return;
  // Rotate to new file at midnight
  const todayPath = getTodayLogFilePath();
  if (todayPath !== logFilePath) {
    logFilePath = todayPath;
  }
  fsPromises.appendFile(logFilePath, line + '\n', 'utf-8').then(() => {
    logWriteFailureReported = false;
  }).catch((error: any) => {
    if (!logWriteFailureReported) {
      logWriteFailureReported = true;
      console.error(`[ERROR] Persistent log write failed: ${error.message}`);
    }
  });
}

function sanitizeLogContext(context: LogContext): Record<string, string | number | boolean | null> {
  const sanitized: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(context)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/i.test(key) || value === undefined) continue;
    sanitized[key] = typeof value === 'string' ? maskPII(value).slice(0, 512) : value;
  }
  return sanitized;
}

export function buildStructuredLogEntry(isoTimestamp: string, message: string, context: LogContext = {}) {
  const cleanMessage = stripAnsi(maskPII(message));
  const tag = /^\[([^\]]+)\]/.exec(cleanMessage)?.[1]?.toUpperCase() || 'INFO';
  let level = 'INFO';
  if (tag.includes('CRITICAL')) level = 'CRITICAL';
  else if (tag.includes('FATAL')) level = 'FATAL';
  else if (tag.includes('ERROR') || tag.includes('FEHLER')) level = 'ERROR';
  else if (tag.includes('WARN')) level = 'WARN';
  else if (tag.includes('DEBUG')) level = 'DEBUG';
  return {
    timestamp: isoTimestamp,
    level,
    message: cleanMessage.replace(/^\[[^\]]+\]\s*/, ''),
    ...sanitizeLogContext(context)
  };
}

export function addLog(msg: string, context: LogContext = {}) {
  const now = new Date();
  const timestamp = now.toLocaleTimeString();
  const maskedMsg = maskPII(msg);
  const displayLine = `[${timestamp}] ${maskedMsg}`;
  logHistory.push(displayLine);
  if (logHistory.length > MAX_LOG_ENTRIES) {
    logHistory.shift();
  }
  
  const isoTimestamp = now.toISOString();
  const cleanMsg = stripAnsi(maskedMsg);
  const structuredEntry = buildStructuredLogEntry(isoTimestamp, cleanMsg, context);

  // Print to console in non-interactive/daemon mode
  if (process.env.NON_INTERACTIVE === 'true' || !process.stdout.isTTY) {
    if (process.env.JSON_LOGGING === 'true') {
      console.log(JSON.stringify(structuredEntry));
    } else {
      console.log(stripAnsi(displayLine));
    }
  }
  // Write to persistent log file with full ISO timestamp and stripped ANSI codes
  const persistentLine = process.env.JSON_LOGGING === 'true'
    ? JSON.stringify(structuredEntry)
    : `[${isoTimestamp}] ${cleanMsg}${Object.keys(context).length > 0 ? ` ${JSON.stringify(sanitizeLogContext(context))}` : ''}`;
  writeToLogFile(persistentLine);
}

export function getLogHistory() {
  return logHistory;
}

export function clearLogHistory() {
  logHistory = [];
}

export function clearConsole() {
  process.stdout.write('\x1Bc');
}

export function promptUser(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise<string>(resolve => rl.question(query, answer => {
    rl.close();
    resolve(answer);
  }));
}

export function pressAnyKey(): Promise<void> {
  return new Promise<void>(resolve => {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.once('data', () => {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      resolve();
    });
  });
}

/**
 * Renders a stylized message box (e.g. for errors or success dialogs)
 * conforming to the TUI border style.
 */
export function drawMessageBox(title, message, color = C_RED) {
  const lines = String(message).split('\n');
  const maxLineLen = Math.max(title.length, ...lines.map(l => l.length));
  const borderLen = maxLineLen + 4;
  
  let output = `\n${color}┌${'─'.repeat(borderLen)}┐\n`;
  output += `│  ${C_BOLD}${title.padEnd(maxLineLen)}${C_RESET}${color}  │\n`;
  output += `├${'─'.repeat(borderLen)}┤\n`;
  for (const line of lines) {
    output += `│  ${line.padEnd(maxLineLen)}  │\n`;
  }
  output += `└${'─'.repeat(borderLen)}┘${C_RESET}\n`;
  console.log(output);
}


function readMenuKeypress(validKeys = null) {
  return new Promise(resolve => {
    const handleKey = (str, key) => {
      if (key && key.ctrl && key.name === 'c') {
        process.exit(0);
      }
      if (str) {
        const lower = str.toLowerCase();
        if (validKeys) {
          if (validKeys.includes(lower) || validKeys.includes(str)) {
            cleanup();
            resolve(lower);
          }
        } else if (str >= '1' && str <= '9') {
          cleanup();
          resolve(str);
        }
      }
    };

    const cleanup = () => {
      process.stdin.removeListener('keypress', handleKey);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
    };

    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.on('keypress', handleKey);
  });
}

/**
 * Draws the Main Menu into a single string buffer and prints it to prevent terminal flickering.
 */
function animatedStreamSegment(stream: string, start: number, highlightedIndex: number): string {
  let output = '';
  for (let index = 0; index < 16; index++) {
    const character = stream[(start + index) % stream.length];
    output += index === highlightedIndex ? `${C_WHITE}${character}${C_RESET}${C_GREEN}` : character;
  }
  return output;
}

function apiConnectionStatus(config: any): string {
  const apiId = process.env.TELEGRAM_API_ID ? parseInt(process.env.TELEGRAM_API_ID, 10) : config.apiId;
  const configured = apiId !== 0 && /^[a-f0-9]{32}$/i.test(process.env.TELEGRAM_API_HASH || '');
  return configured
    ? `${C_GREEN}RESOLVED (Knoten-ID: ${apiId})${C_RESET}`
    : `${C_RED}UNRESOLVED (Mainframe API-Credentials fehlen - Option [2])${C_RESET}`;
}

function sourceConnectionStatus(config: any, resolvedSourceChatIds: Set<string>): string {
  return config.sourceChannels.length > 0
    ? `${C_GREEN}${config.sourceChannels.length} Quell-Knoten${C_RESET} ${C_DARK_GREEN}(aktiv: ${resolvedSourceChatIds.size})${C_RESET}`
    : `${C_RED}[ Keine Quell-Knoten konfiguriert ]${C_RESET}`;
}

function routingModeStatus(config: any): string {
  if (config.forwardOptions?.forwardToTarget === false) {
    return `${C_RED}DEAKTIVIERT (Nur lokale Signal-Speicherung)${C_RESET}`;
  }
  return config.forwardOptions?.sendCopy
    ? `${C_GREEN}KOPY-MODUS (Original-Absender entfernen)${C_RESET}`
    : `${C_DARK_GREEN}FORWARD-MODUS (Direkte Weiterleitung)${C_RESET}`;
}

function configuredFilterStatus(config: any): string {
  const sourceFilterCount = config.sourceFilters
    ? Object.keys(config.sourceFilters).filter(key => config.sourceFilters[key]?.regexPatterns?.length > 0).length
    : 0;
  const allowedTypes = config.filters?.allowedTypes?.length > 0 ? config.filters.allowedTypes.join(', ') : 'Alle';
  return `Blacklist: ${config.filters?.blockedKeywords?.length || 0} | Regex: ${config.filters?.regexPatterns?.length || 0} (${sourceFilterCount} quellspez.) | Typen: ${allowedTypes}`;
}

function xmlParserStatus(config: any): string {
  const primaryModel = config.xmlParsing?.primaryModel || 'google/gemini-flash-1.5';
  const fallbackModel = config.xmlParsing?.fallbackModel || 'anthropic/claude-3-haiku';
  const status = config.xmlParsing?.enabled ? `${C_GREEN}AKTIV` : `${C_RED}DEAKTIVIERT`;
  return `${status}${C_RESET} ${C_DARK_GREEN}(Primär: ${primaryModel} | Fallback: ${fallbackModel})${C_RESET}`;
}

function dupeBlockerStatus(config: any): string {
  return config.dupeBlocker?.enabled
    ? `${C_GREEN}AKTIV${C_RESET} ${C_DARK_GREEN}(Cooldown: ${config.dupeBlocker?.cooldownHours ?? 24}h)${C_RESET}`
    : `${C_RED}DEAKTIVIERT${C_RESET}`;
}

export function drawMainMenuBuffered(config, state, spinnerFrame, resolvedSourceChatIds, totalForwardedCount) {
  let output = '\x1B[H\x1B[J'; // Move cursor to top-left and clear screen below

  const spinChar = spinnerChars[spinnerFrame];
  const streamText = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ#@$%&*()[]{}<>-+=/";
  
  const leftCode = animatedStreamSegment(streamText, spinnerFrame % streamText.length, 0);
  const rightCode = animatedStreamSegment(streamText, (streamText.length - spinnerFrame) % streamText.length, 15);

  output += `${C_DARK_GREEN}┌──────────────────────────────────────────────────────────────────┐\n`;
  output += `│  ${C_GREEN}${leftCode}${C_RESET}${C_DARK_GREEN}              ${C_BRIGHT_GREEN}${C_BOLD}${spinChar}${C_RESET}${C_DARK_GREEN}               ${C_GREEN}${rightCode}${C_RESET}${C_DARK_GREEN}  │\n`;
  output += `└──────────────────────────────────────────────────────────────────┘${C_RESET}\n`;

  const statusBadge = state.isRunning 
    ? `${C_BRIGHT_GREEN}[ RUNNING / INTERCEPT-ACTIVE ]${C_RESET}` 
    : `${C_RED}[ STANDBY / INTERCEPT-OFF ]${C_RESET}`;
    
  const apiStatus = apiConnectionStatus(config);
  const sourceStatus = sourceConnectionStatus(config, resolvedSourceChatIds);

  const targetStatus = config.targetChannel 
    ? `${C_GREEN}${config.targetChannel}${C_RESET}`
    : `${C_RED}[ Kein Ziel-Knoten konfiguriert ]${C_RESET}`;

  const copyStatus = routingModeStatus(config);

  const removeCapStatus = config.forwardOptions?.removeCaption 
    ? `${C_GREEN}BILDUNTERSCHRIFT STRIPPEN${C_RESET}`
    : `${C_DARK_GREEN}BILDUNTERSCHRIFT BEIBEHALTEN${C_RESET}`;

  const filterStatus = configuredFilterStatus(config);

  output += `${C_BOLD}${C_DARK_GREEN}┌─ MAINFRAME STATUS ────────────────────────────────────────────────${C_RESET}\n`;
  output += `${C_BOLD}${C_DARK_GREEN}│${C_RESET} System-Zustand:  ${statusBadge}\n`;
  output += `${C_BOLD}${C_DARK_GREEN}│${C_RESET} API-Verbindung:  ${apiStatus}\n`;
  output += `${C_BOLD}${C_DARK_GREEN}│${C_RESET} Quell-Knoten:    ${sourceStatus}\n`;
  output += `${C_BOLD}${C_DARK_GREEN}│${C_RESET} Ziel-Knoten:     ${targetStatus}\n`;
  
  const xmlStatus = xmlParserStatus(config);
    
  output += `${C_BOLD}${C_DARK_GREEN}│${C_RESET} XML-Signal-KI:   ${xmlStatus}\n`;

  const dupeStatus = dupeBlockerStatus(config);
  output += `${C_BOLD}${C_DARK_GREEN}│${C_RESET} Dupe-Blocker:    ${dupeStatus}\n`;

  output += `${C_BOLD}${C_DARK_GREEN}│${C_RESET} Übertragen:      ${C_BOLD}${C_BRIGHT_GREEN}${totalForwardedCount} Pakete${C_RESET}\n`;
  output += `${C_BOLD}${C_DARK_GREEN}│${C_RESET} Routing-Modus:   ${copyStatus}\n`;
  output += `${C_BOLD}${C_DARK_GREEN}│${C_RESET} Captions:        ${removeCapStatus}\n`;
  output += `${C_BOLD}${C_DARK_GREEN}│${C_RESET} Concurrency:     ${C_GREEN}${config.forwardOptions?.maxConcurrency ?? 2} (parallele Prozesse)${C_RESET}\n`;
  output += `${C_BOLD}${C_DARK_GREEN}│${C_RESET} Filter:          ${C_GREEN}${filterStatus}${C_RESET}\n`;
  output += `${C_BOLD}${C_DARK_GREEN}├─ CONSOLE AKTIONEN ────────────────────────────────────────────────${C_RESET}\n`;
  output += `${C_BOLD}${C_DARK_GREEN}│${C_RESET}  ${C_BOLD}${C_BRIGHT_GREEN}[1]${C_RESET} ${state.isRunning ? `${C_RED}ROUTING TERMINIEREN (STOPP)${C_RESET}` : `${C_BRIGHT_GREEN}ROUTING INITIALISIEREN (START)${C_RESET}`}\n`;
  output += `${C_BOLD}${C_DARK_GREEN}│${C_RESET}  ${C_BOLD}${C_BRIGHT_GREEN}[2]${C_RESET} Mainframe API-ID konfigurieren / Secret-Status prüfen\n`;
  output += `${C_BOLD}${C_DARK_GREEN}│${C_RESET}  ${C_BOLD}${C_BRIGHT_GREEN}[3]${C_RESET} Quell-Knoten verwalten (Hinzufügen / Entfernen)\n`;
  output += `${C_BOLD}${C_DARK_GREEN}│${C_RESET}  ${C_BOLD}${C_BRIGHT_GREEN}[4]${C_RESET} Ziel-Knoten umleiten\n`;
  output += `${C_BOLD}${C_DARK_GREEN}│${C_RESET}  ${C_BOLD}${C_BRIGHT_GREEN}[5]${C_RESET} Transceiver-Routing-Modus umschalten\n`;
  output += `${C_BOLD}${C_DARK_GREEN}│${C_RESET}  ${C_BOLD}${C_BRIGHT_GREEN}[6]${C_RESET} Nachrichten-Filter modifizieren\n`;
  output += `${C_BOLD}${C_DARK_GREEN}│${C_RESET}  ${C_BOLD}${C_BRIGHT_GREEN}[7]${C_RESET} XML-Signal-Parser (KI-Modell, Status) konfigurieren\n`;
  output += `${C_BOLD}${C_DARK_GREEN}│${C_RESET}  ${C_BOLD}${C_BRIGHT_GREEN}[D]${C_RESET} Duplikat-Blocker konfigurieren\n`;
  output += `${C_BOLD}${C_DARK_GREEN}├─ SYSTEM ─────────────────────────────────────────────────────────${C_RESET}\n`;
  output += `${C_BOLD}${C_DARK_GREEN}│${C_RESET}  ${C_BOLD}${C_BRIGHT_GREEN}[E]${C_RESET} Konfiguration exportieren / importieren\n`;
  output += `${C_BOLD}${C_DARK_GREEN}│${C_RESET}  ${C_BOLD}${C_BRIGHT_GREEN}[8]${C_RESET} Mainframe neu starten (Neustart)\n`;
  output += `${C_BOLD}${C_DARK_GREEN}│${C_RESET}  ${C_BOLD}${C_BRIGHT_GREEN}[9]${C_RESET} Konsole herunterfahren (Beenden)\n`;
  output += `${C_BOLD}${C_DARK_GREEN}│${C_RESET}  ${C_BOLD}${C_RED}[R]${C_RESET} ${C_RED}Werkseinstellungen zurücksetzen${C_RESET}\n`;
  output += `${C_BOLD}${C_DARK_GREEN}└───────────────────────────────────────────────────────────────────${C_RESET}\n`;
  output += `${C_BOLD}${C_GREEN}Aktion ausführen (1-9/D/E/R): ${C_RESET}`;

  process.stdout.write(output);
}

async function mainMenu(config, state) {
  clearConsole();
  const spinnerFrame = 0;
  drawMainMenuBuffered(config, state, spinnerFrame, state.resolvedSourceChatIds, state.totalForwardedCount);

  const choice = await readMenuKeypress(['1','2','3','4','5','6','7','8','9','d','e','r']);

  switch (choice) {
    case '1': return 'start';
    case '2': return 'apiCredentials';
    case '3': return 'sources';
    case '4': return 'target';
    case '5': return 'forwardOptions';
    case '6': return 'filters';
    case '7': return 'xmlParsing';
    case 'd': return 'dupeBlocker';
    case 'e': return 'exportImport';
    case 'r': return 'factoryReset';
    case '8': return 'restart';
    case '9': return 'exit';
    default:
      console.log(`${C_RED}Ungültige Auswahl.${C_RESET} Beliebige Taste drücken...`);
      await pressAnyKey();
      return 'main';
  }
}

// API Credentials Menu
async function configureApiCredentials(config, saveConfig) {
  clearConsole();
  console.log(`${C_DARK_GREEN}===================================================`);
  console.log(`${C_BRIGHT_GREEN}           API-ZUGANGSDATEN BEARBEITEN             `);
  console.log(`${C_DARK_GREEN}===================================================`);
  const apiId = process.env.TELEGRAM_API_ID ? parseInt(process.env.TELEGRAM_API_ID, 10) : config.apiId;
  console.log(`${C_GREEN}Aktuelle API-ID:   ${C_WHITE}${apiId}${C_RESET}`);
  console.log(`${C_GREEN}API-Hash:          ${C_WHITE}${process.env.TELEGRAM_API_HASH ? 'über TELEGRAM_API_HASH konfiguriert' : 'NICHT KONFIGURIERT'}${C_RESET}`);
  console.log(`${C_DARK_GREEN}===================================================`);
  
  const apiIdInput = await promptUser(`${C_GREEN}Neue API-ID eingeben (leer lassen um beizubehalten): ${C_WHITE}`);
  if (apiIdInput.trim() !== '') {
    const parsed = parseInt(apiIdInput.trim(), 10);
    if (!isNaN(parsed) && Number.isSafeInteger(parsed) && parsed > 0) {
      config.apiId = parsed;
    } else {
      drawMessageBox("EINGABE-FEHLER", "Ungültige API-ID\n(Muss eine gültige safe positive Ganzzahl sein).");
    }
  }

  saveConfig(config);
  console.log(`\n${C_BRIGHT_GREEN}API-ID gespeichert. Secrets werden ausschließlich über die Prozessumgebung gesetzt.${C_RESET}`);
  await pressAnyKey();
  return 'main';
}

function selectedIndex(value: string, length: number): number | null {
  const index = parseInt(value.trim(), 10) - 1;
  return Number.isInteger(index) && index >= 0 && index < length ? index : null;
}

async function addConfiguredSource(config: any, saveConfig: any): Promise<string> {
  const source = (await promptUser(`${C_GREEN}Username (z.B. @mein_kanal) oder ID des Quell-Knotens eingeben: ${C_WHITE}`)).trim();
  if (!source) return 'sources';
  if (!isValidTargetChannel(source)) {
    console.log(`${C_RED}Ungültiges Format. Erlaubt: @username (5-32 Zeichen) oder numerische ID.${C_RESET}`);
    return 'sources';
  }
  config.sourceChannels.push(source);
  saveConfig(config);
  console.log(`${C_BRIGHT_GREEN}Quell-Knoten hinzugefügt!${C_RESET}`);
  return 'sources';
}

async function removeConfiguredSource(config: any, saveConfig: any): Promise<string> {
  if (config.sourceChannels.length === 0) {
    console.log(`${C_RED}Keine Knoten zum Entfernen vorhanden. Beliebige Taste drücken...${C_RESET}`);
    await pressAnyKey();
    return 'sources';
  }
  const input = await promptUser(`${C_GREEN}Nummer des zu entfernenden Knotens eingeben (1-${config.sourceChannels.length}): ${C_WHITE}`);
  const index = selectedIndex(input, config.sourceChannels.length);
  if (index === null) console.log(`${C_RED}Ungültige Nummer.${C_RESET}`);
  else {
    const [removedSource] = config.sourceChannels.splice(index, 1);
    if (config.sourceAliases?.[removedSource]) delete config.sourceAliases[removedSource];
    saveConfig(config);
    console.log(`${C_BRIGHT_GREEN}Quell-Knoten '${removedSource}' entfernt!${C_RESET}`);
  }
  await pressAnyKey();
  return 'sources';
}

async function renameConfiguredSource(config: any, saveConfig: any): Promise<string> {
  if (config.sourceChannels.length === 0) {
    console.log(`${C_RED}Keine Knoten zum Benennen vorhanden. Beliebige Taste drücken...${C_RESET}`);
    await pressAnyKey();
    return 'sources';
  }
  const input = await promptUser(`${C_GREEN}Nummer des zu benennenden Knotens eingeben (1-${config.sourceChannels.length}): ${C_WHITE}`);
  const index = selectedIndex(input, config.sourceChannels.length);
  if (index === null) console.log(`${C_RED}Ungültige Nummer.${C_RESET}`);
  else {
    const source = config.sourceChannels[index];
    console.log(`\n${C_GREEN}Aktueller Nickname für ${C_WHITE}${source}${C_RESET}${C_GREEN}: ${C_WHITE}${config.sourceAliases?.[source] || '[ Keiner ]'}${C_RESET}`);
    const alias = (await promptUser(`${C_GREEN}Neuen Nickname eingeben (leer lassen zum Löschen): ${C_WHITE}`)).trim();
    config.sourceAliases ??= {};
    if (alias) config.sourceAliases[source] = alias;
    else delete config.sourceAliases[source];
    saveConfig(config);
    console.log(`${C_BRIGHT_GREEN}Nickname für '${source}' ${alias ? `auf '${alias}' gesetzt` : 'entfernt'}!${C_RESET}`);
  }
  await pressAnyKey();
  return 'sources';
}

// Sources Menu
async function configureSources(config, saveConfig) {
  clearConsole();
  console.log(`${C_DARK_GREEN}===================================================`);
  console.log(`${C_BRIGHT_GREEN}              QUELL-KNOTEN VERWALTEN               `);
  console.log(`${C_DARK_GREEN}===================================================`);
  console.log(`${C_GREEN}Aktuelle Quell-Knoten:`);
  config.sourceChannels.forEach((ch, idx) => {
    const alias = config.sourceAliases?.[ch] ? ` (${config.sourceAliases[ch]})` : '';
    console.log(`  ${idx + 1}. ${C_WHITE}${ch}${C_RESET}${C_GREEN}${alias}${C_RESET}`);
  });
  console.log(`${C_DARK_GREEN}===================================================`);
  console.log(` ${C_GREEN}1. Quell-Knoten hinzufügen`);
  console.log(` 2. Quell-Knoten entfernen`);
  console.log(` 3. Quell-Knoten-Nickname (Alias) verwalten`);
  console.log(` 4. Zurück zum Hauptmenü`);
  console.log(`${C_DARK_GREEN}===================================================`);

  const choice = (await promptUser(`${C_GREEN}Wähle eine Option (1-4): ${C_WHITE}`)).trim();
  const actions: Record<string, () => Promise<string>> = {
    '1': () => addConfiguredSource(config, saveConfig),
    '2': () => removeConfiguredSource(config, saveConfig),
    '3': () => renameConfiguredSource(config, saveConfig)
  };
  return actions[choice] ? actions[choice]() : 'main';
}

// Target Menu
async function configureTarget(config, saveConfig) {
  clearConsole();
  console.log(`${C_DARK_GREEN}===================================================`);
  console.log(`${C_BRIGHT_GREEN}                 ZIEL-KNOTEN ÄNDERN                `);
  console.log(`${C_DARK_GREEN}===================================================`);
  console.log(`${C_GREEN}Aktueller Ziel-Knoten: ${C_WHITE}${config.targetChannel || '[ KEINER ]'}${C_RESET}`);
  console.log(`${C_DARK_GREEN}===================================================`);
  
  const newTarget = await promptUser(`${C_GREEN}Neuen Username (z.B. @ziel_kanal) oder ID eingeben: ${C_WHITE}`);
  if (newTarget.trim() !== '') {
    config.targetChannel = newTarget.trim();
    saveConfig(config);
    console.log(`${C_BRIGHT_GREEN}Ziel-Knoten aktualisiert!${C_RESET}`);
  }
  
  console.log(`${C_GREEN}Beliebige Taste drücken...${C_RESET}`);
  await pressAnyKey();
  return 'main';
}

// Forward Options Menu
async function configureForwardOptions(config, saveConfig) {
  clearConsole();
  console.log(`${C_DARK_GREEN}===================================================`);
  console.log(`${C_BRIGHT_GREEN}             WEITERLEITUNGS-OPTIONEN               `);
  console.log(`${C_DARK_GREEN}===================================================`);
  console.log(` ${C_GREEN}1. Kopieren-Modus (Original-Absender entfernen)`);
  console.log(`    Aktuell: ${config.forwardOptions?.sendCopy ? `${C_BRIGHT_GREEN}AKTIVIERT (Kopie)` : `${C_DARK_GREEN}DEAKTIVIERT (Weiterleitung)`}${C_RESET}`);
  console.log(` ${C_GREEN}2. Caption entfernen (nur wirksam im Kopieren-Modus)`);
  console.log(`    Aktuell: ${config.forwardOptions?.removeCaption ? `${C_BRIGHT_GREEN}AKTIVIERT` : `${C_DARK_GREEN}DEAKTIVIERT`}${C_RESET}`);
  console.log(` ${C_GREEN}3. Maximale Parallelität (Concurrency)`);
  console.log(`    Aktuell: ${C_WHITE}${config.forwardOptions?.maxConcurrency ?? 2} parallele(r) Prozess(e)${C_RESET}`);
  console.log(` ${C_GREEN}4. Weiterleitung an Ziel-Knoten`);
  console.log(`    Aktuell: ${config.forwardOptions?.forwardToTarget !== false ? `${C_BRIGHT_GREEN}AKTIVIERT` : `${C_RED}DEAKTIVIERT (Nur lokal speichern)`}${C_RESET}`);
  console.log(` ${C_GREEN}5. Queue Task-Timeout (Sekunden)`);
  console.log(`    Aktuell: ${C_WHITE}${config.forwardOptions?.queueTimeoutSeconds ?? 60} Sek. (0 = kein Timeout)${C_RESET}`);
  console.log(` ${C_GREEN}6. Zurück zum Hauptmenü`);
  console.log(`${C_DARK_GREEN}===================================================`);

  const choice = (await promptUser(`${C_GREEN}Wähle eine Option (1-6): ${C_WHITE}`)).trim();
  const actions: Record<string, () => Promise<string>> = {
    '1': async () => {
      config.forwardOptions.sendCopy = !config.forwardOptions.sendCopy;
      saveConfig(config);
      return 'forwardOptions';
    },
    '2': async () => {
      config.forwardOptions.removeCaption = !config.forwardOptions.removeCaption;
      saveConfig(config);
      return 'forwardOptions';
    },
    '3': async () => {
      const parsed = parseInt((await promptUser(`${C_GREEN}Maximale Concurrency eingeben (1 = komplett seriell, empfohlen bei Dupe-Blocker): ${C_WHITE}`)).trim(), 10);
      if (!isNaN(parsed) && parsed >= 1) {
        config.forwardOptions.maxConcurrency = parsed;
        saveConfig(config);
        console.log(`\n${C_BRIGHT_GREEN}Concurrency auf ${parsed} gesetzt!${C_RESET}`);
      } else console.log(`\n${C_RED}Ungültiger Wert (Muss eine Ganzzahl >= 1 sein).${C_RESET}`);
      await pressAnyKey();
      return 'forwardOptions';
    },
    '4': async () => {
      const currentlyEnabled = config.forwardOptions.forwardToTarget ?? true;
      config.forwardOptions.forwardToTarget = !currentlyEnabled;
      saveConfig(config);
      console.log(`\n${C_BRIGHT_GREEN}Weiterleitung an Ziel-Knoten ${config.forwardOptions.forwardToTarget ? 'AKTIVIERT' : 'DEAKTIVIERT'}!${C_RESET}`);
      await pressAnyKey();
      return 'forwardOptions';
    },
    '5': async () => {
      const parsed = parseInt((await promptUser(`${C_GREEN}Timeout für Queue-Tasks in Sekunden eingeben (z.B. 60, 0 = deaktiviert): ${C_WHITE}`)).trim(), 10);
      if (!isNaN(parsed) && parsed >= 0) {
        config.forwardOptions.queueTimeoutSeconds = parsed;
        saveConfig(config);
        console.log(`\n${C_BRIGHT_GREEN}Queue Task-Timeout auf ${parsed} Sekunden gesetzt!${C_RESET}`);
      } else console.log(`\n${C_RED}Ungültiger Wert (Muss eine Ganzzahl >= 0 sein).${C_RESET}`);
      await pressAnyKey();
      return 'forwardOptions';
    }
  };
  return actions[choice] ? actions[choice]() : 'main';
}

// Filters Menu
async function configureFilters(config, saveConfig) {
  clearConsole();
  console.log(`${C_DARK_GREEN}===================================================`);
  console.log(`${C_BRIGHT_GREEN}                 FILTER BEARBEITEN                 `);
  console.log(`${C_DARK_GREEN}===================================================`);
  console.log(` ${C_GREEN}Blacklist-Keywords (blockedKeywords):`);
  console.log(`   ${config.filters?.blockedKeywords?.length > 0 ? C_WHITE + config.filters.blockedKeywords.join(', ') : `${C_DARK_GREEN}[ Keine ]`}${C_RESET}`);
  console.log(` ${C_GREEN}Regex-Muster (regexPatterns - Standard/Fallback):`);
  console.log(`   ${config.filters?.regexPatterns?.length > 0 ? C_WHITE + config.filters.regexPatterns.map(p => p.startsWith('/') ? p : `/${p}/i`).join(', ') : `${C_DARK_GREEN}[ Keine ]`}${C_RESET}`);
  const sourceFilterCount = config.sourceFilters ? Object.keys(config.sourceFilters).filter(k => config.sourceFilters[k]?.regexPatterns?.length > 0).length : 0;
  console.log(` ${C_GREEN}Quell-spezifische Regex: ${sourceFilterCount > 0 ? `${C_WHITE}${sourceFilterCount} Quellen konfiguriert` : `${C_DARK_GREEN}[ Keine ]`}${C_RESET}`);
  console.log(` ${C_GREEN}Erlaubte Medientypen (allowedTypes):`);
  console.log(`   ${config.filters?.allowedTypes?.length > 0 ? C_WHITE + config.filters.allowedTypes.join(', ') : `${C_DARK_GREEN}[ Alle Typen erlaubt ]`}${C_RESET}`);
  console.log(`${C_DARK_GREEN}===================================================`);
  console.log(` 1. Blacklist-Keywords bearbeiten (Kommagetrennt eingeben)`);
  console.log(` 2. Standard-Regex-Muster verwalten (Fallback)`);
  console.log(` 3. Quell-spezifische Regex-Muster verwalten`);
  console.log(` 4. Erlaubte Medientypen bearbeiten (Kommagetrennt eingeben)`);
  console.log(`    (Erlaubt: text, photo, video, document, audio, voice, animation, sticker)`);
  console.log(` 5. Zurück zum Hauptmenü`);
  console.log(`${C_DARK_GREEN}===================================================`);

  const choice = (await promptUser(`${C_GREEN}Wähle eine Option (1-5): ${C_WHITE}`)).trim();
  const editList = async (prompt: string, normalize: (value: string) => string): Promise<string[]> => {
    const input = (await promptUser(prompt)).trim();
    return input ? input.split(',').map(value => normalize(value.trim())).filter(Boolean) : [];
  };
  const actions: Record<string, () => Promise<string>> = {
    '1': async () => {
      config.filters.blockedKeywords = await editList(`${C_GREEN}Blacklist-Keywords eingeben (mit Komma getrennt, leer zum Löschen): ${C_WHITE}`, value => value);
      saveConfig(config);
      return 'filters';
    },
    '2': async () => 'regexFilters',
    '3': async () => 'sourceRegexSelect',
    '4': async () => {
      config.filters.allowedTypes = await editList(`${C_GREEN}Erlaubte Typen eingeben (z.B. text, photo - leer für alle): ${C_WHITE}`, value => value.toLowerCase());
      saveConfig(config);
      return 'filters';
    }
  };
  return actions[choice] ? actions[choice]() : 'main';
}

// Regex Filters Menu
async function configureRegexFilters(config, saveConfig) {
  clearConsole();
  console.log(`${C_DARK_GREEN}===================================================`);
  console.log(`${C_BRIGHT_GREEN}               REGEX-MUSTER VERWALTEN              `);
  console.log(`${C_DARK_GREEN}===================================================`);
  console.log(`${C_GREEN}Aktuelle Regex-Muster (alle müssen matchen):`);
  if (!config.filters.regexPatterns || config.filters.regexPatterns.length === 0) {
    console.log(`  ${C_DARK_GREEN}[ Keine Regex-Muster konfiguriert ]${C_RESET}`);
  } else {
    config.filters.regexPatterns.forEach((rx, idx) => {
      const displayStr = rx.startsWith('/') ? rx : `/${rx}/i`;
      console.log(`  ${idx + 1}. ${C_WHITE}${displayStr}${C_RESET}`);
    });
  }
  console.log(`${C_DARK_GREEN}===================================================`);
  console.log(` ${C_GREEN}1. Regex-Muster hinzufügen`);
  console.log(` 2. Regex-Muster entfernen`);
  console.log(` 3. Zurück`);
  console.log(`${C_DARK_GREEN}===================================================`);

  const choice = await promptUser(`${C_GREEN}Wähle eine Option (1-3): ${C_WHITE}`);
  if (choice.trim() === '1') {
    const newRx = await promptUser(`${C_GREEN}Regex-Ausdruck eingeben (z.B. wort1, \\bwort2\\b oder /wort3/i): ${C_WHITE}`);
    if (newRx.trim() !== '') {
      try {
        // Zentrale Validierung über filters.js (ReDoS, Syntax, Längenlimit)
        parseRegex(newRx.trim());
        config.filters.regexPatterns.push(newRx.trim());
        saveConfig(config);
        console.log(`${C_BRIGHT_GREEN}Regex-Muster hinzugefügt!${C_RESET}`);
      } catch (e: any) {
        console.log(`${C_RED}Ungültiger Regex-Ausdruck: ${e.message}${C_RESET}`);
      }
    }
    console.log(`${C_GREEN}Beliebige Taste drücken...${C_RESET}`);
    await pressAnyKey();
    return 'regexFilters';
  } else if (choice.trim() === '2') {
    if (!config.filters.regexPatterns || config.filters.regexPatterns.length === 0) {
      console.log(`${C_RED}Keine Muster zum Entfernen vorhanden. Beliebige Taste drücken...${C_RESET}`);
      await pressAnyKey();
      return 'regexFilters';
    }
    const idxInput = await promptUser(`${C_GREEN}Nummer des zu entfernenden Musters eingeben (1-${config.filters.regexPatterns.length}): ${C_WHITE}`);
    const idx = parseInt(idxInput.trim(), 10) - 1;
    if (!isNaN(idx) && idx >= 0 && idx < config.filters.regexPatterns.length) {
      const removed = config.filters.regexPatterns.splice(idx, 1);
      saveConfig(config);
      console.log(`${C_BRIGHT_GREEN}Regex-Muster '${removed}' entfernt!${C_RESET}`);
    } else {
      console.log(`${C_RED}Ungültige Nummer.${C_RESET}`);
    }
    console.log(`${C_GREEN}Beliebige Taste drücken...${C_RESET}`);
    await pressAnyKey();
    return 'regexFilters';
  } else {
    return 'filters';
  }
}

// Source Regex Selection Menu - choose which source to configure
async function configureSourceRegexSelect(config) {
  clearConsole();
  console.log(`${C_DARK_GREEN}===================================================`);
  console.log(`${C_BRIGHT_GREEN}        QUELL-SPEZIFISCHE REGEX-MUSTER             `);
  console.log(`${C_DARK_GREEN}===================================================`);
  console.log(`${C_GREEN}Wähle einen Quell-Knoten, für den du Regex-Muster`);
  console.log(`konfigurieren möchtest. Quellen ohne eigene Regex`);
  console.log(`verwenden die Standard-Regex (Fallback).`);
  console.log(`${C_DARK_GREEN}---------------------------------------------------${C_RESET}`);

  if (config.sourceChannels.length === 0) {
    console.log(`  ${C_RED}[ Keine Quell-Knoten konfiguriert ]${C_RESET}`);
    console.log(`${C_GREEN}Beliebige Taste drücken...${C_RESET}`);
    await pressAnyKey();
    return 'filters';
  }

  config.sourceChannels.forEach((ch, idx) => {
    const sf = config.sourceFilters?.[ch];
    const count = sf?.regexPatterns?.length || 0;
    const status = count > 0
      ? `${C_BRIGHT_GREEN}${count} Muster${C_RESET}`
      : `${C_DARK_GREEN}Standard-Regex (Fallback)${C_RESET}`;
    const alias = config.sourceAliases?.[ch] ? ` (${config.sourceAliases[ch]})` : '';
    console.log(`  ${idx + 1}. ${C_WHITE}${ch}${C_RESET}${C_GREEN}${alias}${C_RESET} → ${status}`);
  });

  console.log(`${C_DARK_GREEN}---------------------------------------------------${C_RESET}`);
  console.log(`  ${config.sourceChannels.length + 1}. Zurück`);
  console.log(`${C_DARK_GREEN}===================================================`);

  const choice = await promptUser(`${C_GREEN}Quell-Knoten wählen (1-${config.sourceChannels.length + 1}): ${C_WHITE}`);
  const idx = parseInt(choice.trim(), 10) - 1;
  if (!isNaN(idx) && idx >= 0 && idx < config.sourceChannels.length) {
    // Store selected source for the sub-menu
    config._selectedSourceForRegex = config.sourceChannels[idx];
    return 'sourceRegexFilters';
  }
  return 'filters';
}

function sourceRegexPatterns(config: any, sourceId: string): string[] {
  config.sourceFilters ??= {};
  config.sourceFilters[sourceId] ??= { regexPatterns: [] };
  config.sourceFilters[sourceId].regexPatterns ??= [];
  return config.sourceFilters[sourceId].regexPatterns;
}

async function addSourceRegex(config: any, saveConfig: any, sourceId: string): Promise<string> {
  const pattern = (await promptUser(`${C_GREEN}Regex-Ausdruck eingeben (z.B. wort1, \\bwort2\\b oder /wort3/i): ${C_WHITE}`)).trim();
  if (pattern) {
    try {
      parseRegex(pattern);
      sourceRegexPatterns(config, sourceId).push(pattern);
      saveConfig(config);
      console.log(`${C_BRIGHT_GREEN}Regex-Muster hinzugefügt!${C_RESET}`);
    } catch (error: any) {
      console.log(`${C_RED}Ungültiger Regex-Ausdruck: ${error.message}${C_RESET}`);
    }
  }
  await pressAnyKey();
  return 'sourceRegexFilters';
}

async function removeSourceRegex(config: any, saveConfig: any, sourceId: string): Promise<string> {
  const patterns = sourceRegexPatterns(config, sourceId);
  if (patterns.length === 0) {
    console.log(`${C_RED}Keine Muster zum Entfernen vorhanden. Beliebige Taste drücken...${C_RESET}`);
    await pressAnyKey();
    return 'sourceRegexFilters';
  }
  const input = await promptUser(`${C_GREEN}Nummer des zu entfernenden Musters eingeben (1-${patterns.length}): ${C_WHITE}`);
  const index = selectedIndex(input, patterns.length);
  if (index === null) console.log(`${C_RED}Ungültige Nummer.${C_RESET}`);
  else {
    const [removed] = patterns.splice(index, 1);
    if (patterns.length === 0) delete config.sourceFilters[sourceId];
    saveConfig(config);
    console.log(`${C_BRIGHT_GREEN}Regex-Muster '${removed}' entfernt!${C_RESET}`);
  }
  await pressAnyKey();
  return 'sourceRegexFilters';
}

async function clearSourceRegex(config: any, saveConfig: any, sourceId: string): Promise<string> {
  delete config.sourceFilters[sourceId];
  saveConfig(config);
  console.log(`${C_BRIGHT_GREEN}Quell-spezifische Muster gelöscht. Standard-Regex wird verwendet.${C_RESET}`);
  await pressAnyKey();
  return 'sourceRegexFilters';
}

async function copyGlobalSourceRegex(config: any, saveConfig: any, sourceId: string, globalPatterns: string[]): Promise<string> {
  if (globalPatterns.length === 0) console.log(`${C_RED}Keine Standard-Regex vorhanden zum Kopieren.${C_RESET}`);
  else {
    sourceRegexPatterns(config, sourceId).splice(0, Infinity, ...globalPatterns);
    saveConfig(config);
    console.log(`${C_BRIGHT_GREEN}${globalPatterns.length} Standard-Regex-Muster als Vorlage kopiert!${C_RESET}`);
  }
  await pressAnyKey();
  return 'sourceRegexFilters';
}

// Source-specific Regex Filters Menu - manage regex for a specific source
async function configureSourceRegexFilters(config, saveConfig) {
  const sourceId = config._selectedSourceForRegex;
  if (!sourceId) return 'sourceRegexSelect';

  const patterns = sourceRegexPatterns(config, sourceId);
  const globalPatterns = config.filters?.regexPatterns || [];

  clearConsole();
  console.log(`${C_DARK_GREEN}===================================================`);
  const sourceAlias = config.sourceAliases?.[sourceId] ? ` (${config.sourceAliases[sourceId]})` : '';
  console.log(`${C_BRIGHT_GREEN}     REGEX-MUSTER FÜR QUELLE: ${C_WHITE}${sourceId}${C_RESET}${C_GREEN}${sourceAlias}${C_RESET}`);
  console.log(`${C_DARK_GREEN}===================================================`);

  if (patterns.length > 0) {
    console.log(`${C_GREEN}Quell-spezifische Regex-Muster (alle müssen matchen):`);
    patterns.forEach((rx, idx) => {
      const displayStr = rx.startsWith('/') ? rx : `/${rx}/i`;
      console.log(`  ${idx + 1}. ${C_WHITE}${displayStr}${C_RESET}`);
    });
  } else {
    console.log(`  ${C_DARK_GREEN}[ Keine quell-spezifischen Muster ]${C_RESET}`);
    if (globalPatterns.length > 0) {
      console.log(`  ${C_GREEN}→ Verwendet Standard-Regex (Fallback):`);
      globalPatterns.forEach((rx) => {
        const displayStr = rx.startsWith('/') ? rx : `/${rx}/i`;
        console.log(`    ${C_DARK_GREEN}${displayStr}${C_RESET}`);
      });
    } else {
      console.log(`  ${C_DARK_GREEN}→ Kein Regex-Filter aktiv (kein Fallback)${C_RESET}`);
    }
  }

  console.log(`${C_DARK_GREEN}===================================================`);
  console.log(` ${C_GREEN}1. Regex-Muster hinzufügen`);
  console.log(` 2. Regex-Muster entfernen`);
  console.log(` 3. Alle quell-spezifischen Muster löschen (zurück zu Fallback)`);
  console.log(` 4. Standard-Regex als Vorlage kopieren`);
  console.log(` 5. Zurück zur Quell-Auswahl`);
  console.log(`${C_DARK_GREEN}===================================================`);

  const choice = (await promptUser(`${C_GREEN}Wähle eine Option (1-5): ${C_WHITE}`)).trim();
  const actions: Record<string, () => Promise<string>> = {
    '1': () => addSourceRegex(config, saveConfig, sourceId),
    '2': () => removeSourceRegex(config, saveConfig, sourceId),
    '3': () => clearSourceRegex(config, saveConfig, sourceId),
    '4': () => copyGlobalSourceRegex(config, saveConfig, sourceId, globalPatterns)
  };
  if (actions[choice]) return actions[choice]();
  delete config._selectedSourceForRegex;
  return 'sourceRegexSelect';
}

function openRouterApiKeyConfigured(): boolean {
  const key = process.env.OPENROUTER_API_KEY;
  return Boolean(key && key.trim() !== '' && key !== 'your_openrouter_api_key_here');
}

function drawXmlParsingMenu(config: any): void {
  clearConsole();
  console.log(`${C_DARK_GREEN}===================================================`);
  console.log(`${C_BRIGHT_GREEN}            XML-SIGNAL-PARSER KONFIGURIEREN        `);
  console.log(`${C_DARK_GREEN}===================================================`);
  console.log(` ${C_GREEN}1. XML-Parser Status`);
  console.log(`    Aktuell: ${config.xmlParsing?.enabled ? `${C_BRIGHT_GREEN}AKTIVIERT` : `${C_RED}DEAKTIVIERT`}${C_RESET}`);
  console.log(` ${C_GREEN}2. XML-Signale an Ziel-Knoten senden (Ersetzt normales Forwarding)`);
  console.log(`    Aktuell: ${config.xmlParsing?.forwardXmlToTarget ? `${C_BRIGHT_GREEN}AKTIVIERT` : `${C_DARK_GREEN}DEAKTIVIERT (Original senden)`}${C_RESET}`);
  console.log(` ${C_GREEN}3. XML-Signale in Datei speichern`);
  console.log(`    Aktuell: ${config.xmlParsing?.saveToFile ? `${C_BRIGHT_GREEN}AKTIVIERT` : `${C_DARK_GREEN}DEAKTIVIERT`}${C_RESET}`);
  console.log(` ${C_GREEN}4. OpenRouter KI-Modell wechseln`);
  console.log(`    Aktuell: ${C_WHITE}${config.xmlParsing?.primaryModel || 'google/gemini-flash-1.5'}${C_RESET}`);
  console.log(` ${C_GREEN}5. Fallback KI-Modell wechseln`);
  console.log(`    Aktuell: ${C_WHITE}${config.xmlParsing?.fallbackModel || 'anthropic/claude-3-haiku'}${C_RESET}`);
  console.log(` ${C_GREEN}6. OpenRouter API-Key Status`);
  console.log(`    Status:  ${openRouterApiKeyConfigured() ? `${C_GREEN}KONFIGURIERT` : `${C_RED}NICHT KONFIGURIERT`}${C_RESET}`);
  console.log(` ${C_GREEN}7. Parser-Timeout ändern`);
  console.log(`    Aktuell: ${C_WHITE}${config.xmlParsing?.timeout || 60000}ms${C_RESET}`);
  console.log(` ${C_GREEN}8. Quell-spezifische XML-Muster verwalten`);
  console.log(` 9. Zurück zum Hauptmenü`);
  console.log(`${C_DARK_GREEN}===================================================`);
}

async function configureAiModel(
  config: any,
  saveConfig: any,
  field: 'primaryModel' | 'fallbackModel',
  label: string,
  defaultModel: string
): Promise<string> {
  clearConsole();
  console.log(`${C_DARK_GREEN}===================================================`);
  console.log(`${C_BRIGHT_GREEN}              ${label.toUpperCase()} AUSWÄHLEN                  `);
  console.log(`${C_DARK_GREEN}===================================================`);
  console.log(`Aktuelles ${label}: ${C_WHITE}${config.xmlParsing?.[field] || defaultModel}${C_RESET}`);
  console.log(`${C_DARK_GREEN}---------------------------------------------------${C_RESET}`);
  console.log(` ${C_GREEN}Schnellauswahl:`);
  console.log(`   ${C_BOLD}${C_BRIGHT_GREEN}[1]${C_RESET} google/gemini-flash-1.5`);
  console.log(`   ${C_BOLD}${C_BRIGHT_GREEN}[2]${C_RESET} anthropic/claude-3-haiku`);
  console.log(`${C_DARK_GREEN}---------------------------------------------------${C_RESET}`);
  const input = (await promptUser(`${C_GREEN}${label} (1/2/Name, leer = beibehalten): ${C_WHITE}`)).trim();
  if (!input) return 'xmlParsing';
  const shortcuts: Record<string, string> = {
    '1': 'google/gemini-flash-1.5',
    '2': 'anthropic/claude-3-haiku'
  };
  const model = shortcuts[input] ?? input;
  if (!/^[a-zA-Z0-9._:/-]{1,128}$/.test(model)) {
    console.log(`\n${C_RED}Ungültiger Modellname.${C_RESET}`);
  } else {
    config.xmlParsing[field] = model;
    saveConfig(config);
    console.log(`\n${C_BRIGHT_GREEN}${label} geändert zu ${model}!${C_RESET}`);
  }
  await pressAnyKey();
  return 'xmlParsing';
}

async function showOpenRouterKeyStatus(): Promise<string> {
  const message = openRouterApiKeyConfigured()
    ? `${C_BRIGHT_GREEN}OPENROUTER_API_KEY ist über die Prozessumgebung konfiguriert.`
    : `${C_RED}OPENROUTER_API_KEY fehlt in der Prozessumgebung.`;
  console.log(`\n${message}${C_RESET}`);
  console.log(`${C_GREEN}Secrets können nicht über die Anwendung geändert werden.${C_RESET}`);
  await pressAnyKey();
  return 'xmlParsing';
}

async function configureParserTimeout(config: any, saveConfig: any): Promise<string> {
  const value = (await promptUser(`${C_GREEN}Gib das Timeout in Millisekunden ein [Standard: 60000]: ${C_WHITE}`)).trim();
  if (!value) return 'xmlParsing';
  const timeout = parseInt(value, 10);
  if (!isNaN(timeout) && timeout >= 1000) {
    config.xmlParsing.timeout = timeout;
    saveConfig(config);
    console.log(`\n${C_BRIGHT_GREEN}Timeout auf ${timeout}ms gesetzt!${C_RESET}`);
  } else console.log(`\n${C_RED}Ungültiger Timeout-Wert (Muss eine Zahl >= 1000 sein).${C_RESET}`);
  await pressAnyKey();
  return 'xmlParsing';
}

// XML Parsing Menu
async function configureXmlParsing(config, saveConfig) {
  drawXmlParsingMenu(config);
  const toggle = async (field: 'enabled' | 'forwardXmlToTarget' | 'saveToFile'): Promise<string> => {
    config.xmlParsing[field] = !config.xmlParsing[field];
    saveConfig(config);
    return 'xmlParsing';
  };
  const actions: Record<string, () => Promise<string>> = {
    '1': () => toggle('enabled'),
    '2': () => toggle('forwardXmlToTarget'),
    '3': () => toggle('saveToFile'),
    '4': () => configureAiModel(config, saveConfig, 'primaryModel', 'Primär-Modell', 'google/gemini-flash-1.5'),
    '5': () => configureAiModel(config, saveConfig, 'fallbackModel', 'Fallback-Modell', 'anthropic/claude-3-haiku'),
    '6': showOpenRouterKeyStatus,
    '7': () => configureParserTimeout(config, saveConfig),
    '8': async () => 'sourceXmlTemplates'
  };
  const choice = (await promptUser(`${C_GREEN}Wähle eine Option (1-9): ${C_WHITE}`)).trim();
  return actions[choice] ? actions[choice]() : 'main';
}

async function availableXmlTemplates(): Promise<string[]> {
  const templatesDirectory = path.join(__dirname, '../templates');
  try {
    const files = await fsPromises.readdir(templatesDirectory);
    const customTemplates = files
      .filter(file => file.endsWith('.txt') && file !== 'default.txt')
      .map(file => file.slice(0, -4));
    return ['default', ...customTemplates];
  } catch {
    try {
      await fsPromises.mkdir(templatesDirectory, { recursive: true });
    } catch {
      /* ignore directory creation failure */
    }
    return ['default'];
  }
}

// Source-specific XML Templates Menu - choose which template to assign to each source channel
async function configureSourceXmlTemplates(config, saveConfig) {
  clearConsole();
  console.log(`${C_DARK_GREEN}===================================================`);
  console.log(`${C_BRIGHT_GREEN}        QUELL-SPEZIFISCHE XML-MUSTER (TEMPLATES)   `);
  console.log(`${C_DARK_GREEN}===================================================`);
  console.log(`${C_GREEN}Wähle einen Quell-Knoten, um ihm ein spezifisches`);
  console.log(`XML-Muster zuzuweisen.`);
  console.log(`${C_DARK_GREEN}---------------------------------------------------${C_RESET}`);

  if (config.sourceChannels.length === 0) {
    console.log(`  ${C_RED}[ Keine Quell-Knoten konfiguriert ]${C_RESET}`);
    console.log(`${C_GREEN}Beliebige Taste drücken...${C_RESET}`);
    await pressAnyKey();
    return 'xmlParsing';
  }

  // Ensure sourceTemplates object exists
  if (!config.xmlParsing) config.xmlParsing = {};
  if (!config.xmlParsing.sourceTemplates) config.xmlParsing.sourceTemplates = {};

  config.sourceChannels.forEach((ch, idx) => {
    const assignedTemplate = config.xmlParsing.sourceTemplates[ch] || 'default (Standard)';
    const alias = config.sourceAliases?.[ch] ? ` (${config.sourceAliases[ch]})` : '';
    console.log(`  ${idx + 1}. ${C_WHITE}${ch}${C_RESET}${C_GREEN}${alias}${C_RESET} → ${C_BRIGHT_GREEN}${assignedTemplate}${C_RESET}`);
  });

  console.log(`${C_DARK_GREEN}---------------------------------------------------${C_RESET}`);
  console.log(`  ${config.sourceChannels.length + 1}. Zurück`);
  console.log(`${C_DARK_GREEN}===================================================`);

  const choice = await promptUser(`${C_GREEN}Quell-Knoten wählen (1-${config.sourceChannels.length + 1}): ${C_WHITE}`);
  const idx = parseInt(choice.trim(), 10) - 1;
  if (isNaN(idx) || idx < 0 || idx > config.sourceChannels.length) {
    return 'xmlParsing';
  }

  if (idx === config.sourceChannels.length) {
    return 'xmlParsing';
  }

  const selectedSource = config.sourceChannels[idx];

  const templatesList = await availableXmlTemplates();

  clearConsole();
  console.log(`${C_DARK_GREEN}===================================================`);
  const selectedAlias = config.sourceAliases?.[selectedSource] ? ` (${config.sourceAliases[selectedSource]})` : '';
  console.log(`${C_BRIGHT_GREEN}     MUSTER FÜR QUELLE: ${C_WHITE}${selectedSource}${C_RESET}${C_GREEN}${selectedAlias}${C_RESET}`);
  console.log(`${C_DARK_GREEN}===================================================`);
  console.log(`${C_GREEN}Verfügbare XML-Muster (aus /templates Ordner):`);
  templatesList.forEach((tpl, tIdx) => {
    const isCurrent = (config.xmlParsing.sourceTemplates[selectedSource] || 'default') === tpl;
    const marker = isCurrent ? ` ${C_BRIGHT_GREEN}[AKTIV]${C_RESET}` : '';
    console.log(`  ${tIdx + 1}. ${C_WHITE}${tpl}${C_RESET}${marker}`);
  });
  console.log(`  ${templatesList.length + 1}. Zurücksetzen (auf Standard)`);
  console.log(`  ${templatesList.length + 2}. Abbrechen`);
  console.log(`${C_DARK_GREEN}===================================================`);

  const tplChoiceInput = await promptUser(`${C_GREEN}Muster wählen (1-${templatesList.length + 2}): ${C_WHITE}`);
  const tplIdx = parseInt(tplChoiceInput.trim(), 10) - 1;

  if (isNaN(tplIdx) || tplIdx < 0 || tplIdx > templatesList.length + 1) {
    return 'sourceXmlTemplates';
  }

  if (tplIdx === templatesList.length + 1) {
    // Cancel
    return 'sourceXmlTemplates';
  }

  if (tplIdx === templatesList.length) {
    // Reset to default
    delete config.xmlParsing.sourceTemplates[selectedSource];
    saveConfig(config);
    console.log(`\n${C_BRIGHT_GREEN}Erfolgreich auf Standard zurückgesetzt!${C_RESET}`);
    await pressAnyKey();
  } else {
    // Set selected template
    const selectedTemplate = templatesList[tplIdx];
    config.xmlParsing.sourceTemplates[selectedSource] = selectedTemplate;
    saveConfig(config);
    console.log(`\n${C_BRIGHT_GREEN}Muster für Quelle ${selectedSource} auf '${selectedTemplate}' gesetzt!${C_RESET}`);
    await pressAnyKey();
  }

  return 'sourceXmlTemplates';
}

// --- Duplikat-Blocker Configuration ---

async function configureDupeBlocker(config, saveConfig) {
  clearConsole();
  console.log(`${C_DARK_GREEN}===================================================`);
  console.log(`${C_BRIGHT_GREEN}          DUPLIKAT-BLOCKER KONFIGURIEREN            `);
  console.log(`${C_DARK_GREEN}===================================================`);
  console.log(` ${C_GREEN}Verhindert das Speichern und Weiterleiten von`);
  console.log(` identischen Signalen innerhalb eines Cooldowns.`);
  console.log(`${C_DARK_GREEN}===================================================`);
  console.log(` ${C_GREEN}1. Dupe-Blocker Status`);
  console.log(`    Aktuell: ${config.dupeBlocker?.enabled ? `${C_BRIGHT_GREEN}AKTIVIERT` : `${C_RED}DEAKTIVIERT`}${C_RESET}`);
  console.log(` ${C_GREEN}2. Cooldown-Dauer ändern`);
  console.log(`    Aktuell: ${C_WHITE}${config.dupeBlocker?.cooldownHours ?? 24} Stunden${C_RESET}`);
  console.log(` ${C_GREEN}3. Zurück zum Hauptmenü`);
  console.log(`${C_DARK_GREEN}===================================================`);

  const choice = await promptUser(`${C_GREEN}Wähle eine Option (1-3): ${C_WHITE}`);
  switch (choice.trim()) {
    case '1': {
      if (!config.dupeBlocker) config.dupeBlocker = { enabled: false, cooldownHours: 24 };
      config.dupeBlocker.enabled = !config.dupeBlocker.enabled;
      saveConfig(config);
      console.log(`\n${C_BRIGHT_GREEN}Dupe-Blocker ${config.dupeBlocker.enabled ? 'AKTIVIERT' : 'DEAKTIVIERT'}!${C_RESET}`);
      await pressAnyKey();
      return 'dupeBlocker';
    }
    case '2': {
      const newCooldown = await promptUser(`${C_GREEN}Cooldown in Stunden eingeben (0 = immer blockieren) [Standard: 24]: ${C_WHITE}`);
      if (newCooldown.trim() !== '') {
        const parsed = parseInt(newCooldown.trim(), 10);
        if (!isNaN(parsed) && parsed >= 0) {
          if (!config.dupeBlocker) config.dupeBlocker = { enabled: false, cooldownHours: 24 };
          config.dupeBlocker.cooldownHours = parsed;
          saveConfig(config);
          if (parsed === 0) {
            console.log(`\n${C_BRIGHT_GREEN}Cooldown deaktiviert — identische Signale werden immer blockiert!${C_RESET}`);
          } else {
            console.log(`\n${C_BRIGHT_GREEN}Cooldown auf ${parsed} Stunden gesetzt!${C_RESET}`);
          }
        } else {
          console.log(`\n${C_RED}Ungültiger Wert (Muss eine Ganzzahl >= 0 sein).${C_RESET}`);
        }
        await pressAnyKey();
      }
      return 'dupeBlocker';
    }
    case '3': {
      return 'main';
    }
    default: {
      return 'main';
    }
  }
}

// --- Export / Import Configuration ---

/**
 * Builds a portable export bundle containing non-secret configuration only.
 */
function buildExportBundle(config) {
  // Clone config without internal temp keys
  const cleanConfig = { ...config };
  delete cleanConfig._selectedSourceForRegex;

  return {
    _exportVersion: 2,
    _exportedAt: new Date().toISOString(),
    config: cleanConfig
  };
}

/**
 * Applies an imported non-secret configuration bundle.
 * Returns the newly merged config object.
 */
function applyImportBundle(bundle, saveConfig) {
  if (bundle.env !== undefined) {
    throw new Error('Import-Dateien dürfen keine Umgebungsvariablen oder Secrets enthalten.');
  }
  const importedConfig = mergeConfigDefaults(bundle.config || {});
  saveConfig(importedConfig);
  return importedConfig;
}

interface ConfigTransferResult {
  nextMenu: string;
  reloadConfig: boolean;
  newConfig?: any;
}

async function exportConfiguration(config: any): Promise<ConfigTransferResult> {
  const defaultFile = `cb2_backup_${new Date().toISOString().slice(0, 10)}.json`;
  const fileInput = await promptUser(`${C_GREEN}Dateiname/Pfad für Export [${C_WHITE}${defaultFile}${C_GREEN}]: ${C_WHITE}`);
  const exportPath = fileInput.trim() || defaultFile;
  try {
    const resolvedPath = path.resolve(exportPath);
    await fsPromises.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fsPromises.writeFile(resolvedPath, JSON.stringify(buildExportBundle(config), null, 2), 'utf-8');
    console.log(`\n${C_BRIGHT_GREEN}Konfiguration erfolgreich exportiert nach:${C_RESET}`);
    console.log(`  ${C_WHITE}${resolvedPath}${C_RESET}`);
  } catch (error: any) {
    console.log(`\n${C_RED}Export fehlgeschlagen: ${error.message}${C_RESET}`);
  }
  console.log(`\n${C_GREEN}Beliebige Taste drücken...${C_RESET}`);
  await pressAnyKey();
  return { nextMenu: 'main', reloadConfig: false };
}

function printImportPreview(bundle: any): void {
  console.log(`\n${C_DARK_GREEN}───────────────────────────────────────────────────${C_RESET}`);
  console.log(`${C_BRIGHT_GREEN}  IMPORT-VORSCHAU${C_RESET}`);
  console.log(`${C_DARK_GREEN}───────────────────────────────────────────────────${C_RESET}`);
  if (bundle._exportedAt) console.log(`  ${C_GREEN}Exportiert am: ${C_WHITE}${bundle._exportedAt}${C_RESET}`);
  const importSources = (bundle.config.sourceChannels || []).map(ch => {
    const alias = bundle.config.sourceAliases?.[ch];
    return alias ? `${ch} (${alias})` : ch;
  }).join(', ');
  console.log(`  ${C_GREEN}Quell-Knoten:  ${C_WHITE}${importSources || '[ Keine ]'}${C_RESET}`);
  console.log(`  ${C_GREEN}Ziel-Knoten:   ${C_WHITE}${bundle.config.targetChannel || '[ Keiner ]'}${C_RESET}`);
  console.log(`  ${C_GREEN}XML-Parser:    ${C_WHITE}${bundle.config.xmlParsing?.enabled ? 'AKTIVIERT' : 'DEAKTIVIERT'}${C_RESET}`);
  console.log(`  ${C_GREEN}Dupe-Blocker:  ${C_WHITE}${bundle.config.dupeBlocker?.enabled ? `AKTIVIERT (Cooldown: ${bundle.config.dupeBlocker?.cooldownHours ?? 24}h)` : 'DEAKTIVIERT'}${C_RESET}`);
  console.log(`  ${C_GREEN}Concurrency:   ${C_WHITE}${bundle.config.forwardOptions?.maxConcurrency ?? 2} parallel${C_RESET}`);
  console.log(`  ${C_GREEN}Weiterleitung: ${C_WHITE}${bundle.config.forwardOptions?.forwardToTarget !== false ? 'AKTIVIERT' : 'DEAKTIVIERT (Nur lokal)'}${C_RESET}`);
  console.log(`  ${C_GREEN}Secrets:        ${C_WHITE}[ werden nie importiert ]${C_RESET}`);
  console.log(`${C_DARK_GREEN}───────────────────────────────────────────────────${C_RESET}`);
}

async function importConfiguration(saveConfig: any): Promise<ConfigTransferResult> {
  const importPath = (await promptUser(`${C_GREEN}Pfad zur Import-Datei eingeben: ${C_WHITE}`)).trim();
  if (!importPath) {
    console.log(`${C_RED}Kein Pfad angegeben.${C_RESET}`);
    await pressAnyKey();
    return { nextMenu: 'exportImport', reloadConfig: false };
  }
  try {
    const bundle = JSON.parse(await fsPromises.readFile(path.resolve(importPath), 'utf-8'));
    if (!bundle.config || typeof bundle.config !== 'object') {
      throw new Error('Import-Datei enthält keine gültige "config"-Sektion.');
    }
    printImportPreview(bundle);
    const confirm = (await promptUser(`\n${C_YELLOW}WARNUNG: Alle aktuellen Einstellungen werden überschrieben!${C_RESET}\n${C_GREEN}Fortfahren? (j/n): ${C_WHITE}`)).trim().toLowerCase();
    if (confirm !== 'j' && confirm !== 'y') {
      console.log(`\n${C_GREEN}Import abgebrochen. Beliebige Taste drücken...${C_RESET}`);
      await pressAnyKey();
      return { nextMenu: 'main', reloadConfig: false };
    }
    const newConfig = applyImportBundle(bundle, saveConfig);
    console.log(`\n${C_BRIGHT_GREEN}Konfiguration erfolgreich importiert!${C_RESET}`);
    await pressAnyKey();
    return { nextMenu: 'main', reloadConfig: true, newConfig };
  } catch (error: any) {
    console.log(`\n${C_RED}Import fehlgeschlagen: ${error.message}${C_RESET}`);
    await pressAnyKey();
    return { nextMenu: 'exportImport', reloadConfig: false };
  }
}

async function configureExportImport(config, saveConfig): Promise<ConfigTransferResult> {
  clearConsole();
  console.log(`${C_DARK_GREEN}===================================================`);
  console.log(`${C_BRIGHT_GREEN}        KONFIGURATION EXPORTIEREN / IMPORTIEREN     `);
  console.log(`${C_DARK_GREEN}===================================================`);
  console.log(` ${C_GREEN}Exportiert die nicht-geheime config.json-Konfiguration`);
  console.log(` in eine einzige Datei, die auf einem anderen System`);
  console.log(` oder nach einem Reset importiert werden kann.`);
  console.log(`${C_DARK_GREEN}===================================================`);
  console.log(` ${C_GREEN}1. Konfiguration exportieren`);
  console.log(` 2. Konfiguration importieren`);
  console.log(` 3. Zurück zum Hauptmenü`);
  console.log(`${C_DARK_GREEN}===================================================`);

  const choice = (await promptUser(`${C_GREEN}Wähle eine Option (1-3): ${C_WHITE}`)).trim();
  if (choice === '1') return exportConfiguration(config);
  if (choice === '2') return importConfiguration(saveConfig);
  return { nextMenu: 'main', reloadConfig: false };
}

// ── FACTORY RESET ────────────────────────────────────────────────────────────
async function configureFactoryReset(config, saveConfig) {
  clearConsole();
  const confirmations = [
    'RESET',
    'RESET',
    'WIRKLICH RESET',
    'ALLE DATEN LÖSCHEN',
    'JA WERKSEINSTELLUNGEN',
  ];
  const prompts = [
    `Schritt 1/5 – Tippe exakt "${confirmations[0]}" um fortzufahren`,
    `Schritt 2/5 – Tippe erneut "${confirmations[1]}" zur Bestätigung`,
    `Schritt 3/5 – Tippe "${confirmations[2]}" um fortzufahren`,
    `Schritt 4/5 – Tippe "${confirmations[3]}" zur vierten Bestätigung`,
    `Schritt 5/5 – Letzter Schritt: Tippe "${confirmations[4]}" zum endgültigen Reset`,
  ];

  console.log(`\n${C_RED}${C_BOLD}╔══════════════════════════════════════════════════════════════════╗${C_RESET}`);
  console.log(`${C_RED}${C_BOLD}║          ⚠  WERKSEINSTELLUNGEN ZURÜCKSETZEN  ⚠                  ║${C_RESET}`);
  console.log(`${C_RED}${C_BOLD}╚══════════════════════════════════════════════════════════════════╝${C_RESET}`);
  console.log(`\n${C_RED}  WARNUNG: Alle gespeicherten Einstellungen werden unwiderruflich${C_RESET}`);
  console.log(`${C_RED}  gelöscht (Quellen, Ziel, API-Daten, Filter, XML-Muster, Nicknames).${C_RESET}`);
  console.log(`${C_RED}  Diese Aktion kann NICHT rückgängig gemacht werden!${C_RESET}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (prompt: string): Promise<string> => new Promise<string>(resolve => rl.question(prompt, resolve));

  for (let i = 0; i < 5; i++) {
    const answer = (await ask(`${C_YELLOW}  ${prompts[i]}: ${C_RESET}`)).trim();
    if (answer !== confirmations[i]) {
      rl.close();
      console.log(`\n${C_GREEN}  Abgebrochen. Keine Änderungen vorgenommen.${C_RESET}`);
      await pressAnyKey();
      return 'main';
    }
  }
  rl.close();

  // ── Perform reset ──
  const { DEFAULT_CONFIG } = await import('./config.js');
  Object.assign(config, JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
  await saveConfig(config);

  console.log(`\n${C_BRIGHT_GREEN}  ✔ Werkseinstellungen erfolgreich wiederhergestellt.${C_RESET}`);
  console.log(`${C_GREEN}  Das System wird jetzt neu gestartet...${C_RESET}\n`);
  await pressAnyKey();
  return 'restart';
}

async function runExportImportMenu(config: any, saveConfig: any): Promise<string> {
  const result = await configureExportImport(config, saveConfig);
  if (result.reloadConfig && result.newConfig) Object.assign(config, result.newConfig);
  return result.nextMenu;
}

async function executeMenu(currentMenu: string, config: any, saveConfig: any, state: any): Promise<string> {
  const handlers: Record<string, () => Promise<string>> = {
    main: () => mainMenu(config, state),
    apiCredentials: () => configureApiCredentials(config, saveConfig),
    sources: () => configureSources(config, saveConfig),
    target: () => configureTarget(config, saveConfig),
    forwardOptions: () => configureForwardOptions(config, saveConfig),
    filters: () => configureFilters(config, saveConfig),
    regexFilters: () => configureRegexFilters(config, saveConfig),
    sourceRegexSelect: () => configureSourceRegexSelect(config),
    sourceRegexFilters: () => configureSourceRegexFilters(config, saveConfig),
    xmlParsing: () => configureXmlParsing(config, saveConfig),
    sourceXmlTemplates: () => configureSourceXmlTemplates(config, saveConfig),
    dupeBlocker: () => configureDupeBlocker(config, saveConfig),
    exportImport: () => runExportImportMenu(config, saveConfig),
    factoryReset: () => configureFactoryReset(config, saveConfig)
  };
  return handlers[currentMenu] ? handlers[currentMenu]() : 'main';
}

export async function runMenuSystem(config, saveConfig, state) {
  const terminalMenus = new Set(['start', 'restart', 'exit']);
  let currentMenu = 'main';
  while (!terminalMenus.has(currentMenu)) {
    currentMenu = await executeMenu(currentMenu, config, saveConfig, state);
  }
  return currentMenu;
}

export function renderLiveLogs(config, totalForwardedCount, isPaused = false, queueState = { running: 0, queued: 0, maxConcurrency: 2 }) {
  let output = '\x1B[H\x1B[J'; // Move cursor to top-left and clear from cursor down
  output += `${C_BOLD}${C_DARK_GREEN}┌─ MAINFRAME ROUTING IN PROGRESS (LIVE STREAM) ────────────────────${C_RESET}\n`;
  const formattedSources = config.sourceChannels.map(ch => {
    const alias = config.sourceAliases?.[ch];
    return alias ? `${ch} (${alias})` : ch;
  }).join(', ');
  output += `${C_BOLD}${C_DARK_GREEN}│${C_RESET} Quell-Knoten:   ${C_GREEN}${formattedSources}${C_RESET}\n`;
  output += `${C_BOLD}${C_DARK_GREEN}│${C_RESET} Ziel-Knoten:    ${C_GREEN}${config.targetChannel}${C_RESET}\n`;
  
  const statusStr = isPaused 
    ? `${C_YELLOW}● PAUSIERT (Nachrichten werden gesammelt...)${C_RESET}`
    : `${C_BRIGHT_GREEN}● ONLINE (Datenstrom wird überwacht...)${C_RESET}`;
  output += `${C_BOLD}${C_DARK_GREEN}│${C_RESET} System-Status:  ${statusStr}\n`;
  
  output += `${C_BOLD}${C_DARK_GREEN}│${C_RESET} Pakete:         ${C_BOLD}${C_BRIGHT_GREEN}${totalForwardedCount} weitergeleitet${C_RESET}\n`;
  output += `${C_BOLD}${C_DARK_GREEN}│${C_RESET} Queue-Aktiv:    ${C_WHITE}${queueState.running} / ${queueState.maxConcurrency} in Arbeit${C_RESET}\n`;
  output += `${C_BOLD}${C_DARK_GREEN}│${C_RESET} Queue-Wartend:  ${C_WHITE}${queueState.queued} ausstehend${C_RESET}\n`;
  output += `${C_BOLD}${C_DARK_GREEN}├─ KONTROLLE & BEFEHLE ─────────────────────────────────────────────${C_RESET}\n`;
  output += `${C_BOLD}${C_DARK_GREEN}│${C_RESET}  ${C_BOLD}${C_BRIGHT_GREEN}p + ENTER${C_RESET}: Weiterleitung PAUSIEREN  |  ${C_BOLD}${C_BRIGHT_GREEN}r + ENTER${C_RESET}: FORTSETZEN\n`;
  output += `${C_BOLD}${C_DARK_GREEN}│${C_RESET}  ${C_BOLD}${C_BRIGHT_GREEN}ENTER / s${C_RESET}: Routing BEENDEN & Hauptmenü\n`;
  output += `${C_BOLD}${C_DARK_GREEN}├─ DATENSTROM-PROTOKOLL (LIVE-LOG) ─────────────────────────────────${C_RESET}\n`;

  // Get current logs (last N entries that fit the terminal)
  const terminalHeight = process.stdout.rows || 24;
  const headerHeight = 11; // Number of lines printed above the logs
  const maxLogs = Math.max(5, terminalHeight - headerHeight - 2);

  const startIdx = Math.max(0, logHistory.length - maxLogs);
  for (let i = startIdx; i < logHistory.length; i++) {
    const line = logHistory[i];
    if (line.includes('[ERROR]')) {
      output += ` ${C_RED}${line}${C_RESET}\n`;
    } else if (line.includes('[SUCCESS]')) {
      output += ` ${C_BRIGHT_GREEN}${line}${C_RESET}\n`;
    } else {
      output += ` ${C_GREEN}${line}${C_RESET}\n`;
    }
  }

  process.stdout.write(output);
}

export async function runLiveLogScreen(
  config: any,
  client: any,
  totalForwardedCountCallback: () => number,
  stopCallback: () => Promise<void>,
  commandCallback: (cmd: string) => void = () => {},
  checkPausedCallback: () => boolean = () => false,
  getQueueStateCallback: () => { running: number; queued: number; maxConcurrency: number } = () => ({ running: 0, queued: 0, maxConcurrency: 2 })
) {
  renderLiveLogs(config, totalForwardedCountCallback(), checkPausedCallback(), getQueueStateCallback());

  const logInterval = setInterval(() => {
    renderLiveLogs(config, totalForwardedCountCallback(), checkPausedCallback(), getQueueStateCallback());
  }, 200);

  const wasRaw = process.stdin.isRaw;
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  readline.emitKeypressEvents(process.stdin);

  await new Promise<void>(resolve => {
    const handleKey = (str, key) => {
      if (key && key.ctrl && key.name === 'c') {
        clearInterval(logInterval);
        cleanup();
        process.exit(0);
      }
      if (str) {
        const cmd = str.trim().toLowerCase();
        if (cmd === 'p') {
          commandCallback('p');
        } else if (cmd === 'r') {
          commandCallback('r');
        } else if (cmd === 's' || cmd === 'x' || key.name === 'return' || key.name === 'escape') {
          clearInterval(logInterval);
          cleanup();
          resolve();
        }
      }
    };

    const cleanup = () => {
      process.stdin.removeListener('keypress', handleKey);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(wasRaw);
      }
      process.stdin.pause();
    };

    process.stdin.on('keypress', handleKey);
  });

  await stopCallback();
}


// Startup-Animation ASCII Art (Fixed Width)
const STARTUP_ASCII = `
                                 +.                           :,                                    
                                ???,: .  ;+:;+;.,   .;,+*?;.;:;;;;;                                 
                                SS%%     ;%?      +?*****S**++*+*#++                                 
               ?**?*********?%@#%   ?*?*%%S?*??%%%%%%%%++++;;;;;;:;;+?:                             
              ?*******+*+++++*SS%+++++;+;;;++++++++++;;;;;;;;;;:;::;:??*+;*%%%*;,...............;;  
    ##SS?+*?%S#%%SSSS#S?S*++++++++++++++++?%%S%S%SSSS%%??**%?????%%SS++?*%++*??;             ?#;+*  
             #@SS%%%%???????????????%%%%##@###SSSSSSSSSS%%?%@@@@@??%S@?@?     ,+             *S+*   
             ;@+..;. +,S@@S####S@@S%SS?S, +#@#S#SSSSS#SSS%%#@SSS###%SSS@S?SS%%+?,.           *S*?   
              S:                            .########@@@;,?@@##@S@.                 ,.S#?++ ??#?*   
                                             ,@@#####@@%   .,.@##?+                       ?%???%?   
                                             .@?*@@@@:S;+. *:::###?*                        #??S%   
                                             ++?@##S@          :#@S%%                        @?#%   
                                             @S?%#*S;           +#@#?+                       ,%S%   
                                            .@@#@%%%             ?@##%                         ...  
                                            #@S@@@@?             *+                                 
                                           .@@###@@                                                 
                                            SS+@@@@                                                 
                                                :*,                                                 
`;

interface MatrixDrop {
  col: number;
  row: number;
  speed: number;
  length: number;
}

interface MatrixAnimationState {
  width: number;
  height: number;
  targetArt: string[];
  revealed: boolean[][];
  drops: MatrixDrop[];
  frame: number;
  totalFrames: number;
}

const MATRIX_CHARS = "日ﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘｱﾎﾏｹﾒｴｶｷﾑﾕﾗｾﾈｽﾀﾇﾍｦｲｸｺｿﾁﾄﾉﾌﾔﾖﾙﾚﾛﾝ0123456789$+-*=%#@&";

function startupArtLines(): string[] {
  const lines = STARTUP_ASCII.split('\n');
  return lines.filter((line, index) => !(
    (index === 0 || index === lines.length - 1) && line.trim() === ''
  ));
}

function createMatrixDrops(width: number, height: number): MatrixDrop[] {
  return Array.from({ length: Math.floor(width / 2.5) }, () => ({
    col: Math.floor(Math.random() * width),
    row: -Math.floor(Math.random() * height * 1.5),
    speed: 0.35 + Math.random() * 0.5,
    length: 5 + Math.floor(Math.random() * 8)
  }));
}

function advanceMatrixDrops(state: MatrixAnimationState, progress: number): void {
  const maxRevealRow = Math.floor(progress * state.height);
  for (const drop of state.drops) {
    drop.row += drop.speed;
    const currentRow = Math.floor(drop.row);
    if (currentRow >= 0 && currentRow < state.height && drop.col < state.width) {
      for (let row = 0; row <= currentRow; row++) {
        if (row < maxRevealRow || Math.random() < 0.25) state.revealed[row]![drop.col] = true;
      }
    }
    if (drop.row - drop.length > state.height) {
      drop.row = -Math.floor(Math.random() * 10);
      drop.col = Math.floor(Math.random() * state.width);
      drop.speed = 0.35 + Math.random() * 0.5;
    }
  }
}

function advanceMatrixReveal(state: MatrixAnimationState, progress: number): void {
  for (let row = 0; row < Math.floor(progress * state.height); row++) {
    for (let col = 0; col < state.width; col++) {
      if (Math.random() < 0.25) state.revealed[row]![col] = true;
    }
  }
  if (state.frame >= state.totalFrames) state.revealed.forEach(row => row.fill(true));
}

function dropsByColumn(drops: MatrixDrop[]): Map<number, MatrixDrop[]> {
  const grouped = new Map<number, MatrixDrop[]>();
  for (const drop of drops) {
    const column = grouped.get(drop.col) ?? [];
    column.push(drop);
    grouped.set(drop.col, column);
  }
  return grouped;
}

function rainState(row: number, drops: MatrixDrop[] | undefined): { inRain: boolean; isHead: boolean } {
  for (const drop of drops ?? []) {
    const head = Math.floor(drop.row);
    if (row <= head && row >= head - drop.length) return { inRain: true, isHead: row === head };
  }
  return { inRain: false, isHead: false };
}

function randomMatrixCharacter(): string {
  return MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)]!;
}

function renderMatrixCell(character: string, revealed: boolean, inRain: boolean, isHead: boolean): string {
  if (!revealed) {
    if (isHead) return `${C_WHITE_BOLD}${randomMatrixCharacter()}${C_RESET}`;
    if (inRain) return `${C_GREEN}${randomMatrixCharacter()}${C_RESET}`;
    return ' ';
  }
  if (isHead && character !== ' ') return `${C_WHITE_BOLD}${character}${C_RESET}`;
  if (inRain && character !== ' ') return `${C_BRIGHT_GREEN}${character}${C_RESET}`;
  return `${C_GREEN}${character}${C_RESET}`;
}

function animationStatus(percent: number): string {
  if (percent < 25) return "BOOTING SECURE NETWORK SHELL...";
  if (percent < 50) return "ESTABLISHING SECURE INTERCEPT ROUTING...";
  if (percent < 75) return "SYNCHRONIZING MATRIX INTERFACE NODES...";
  if (percent < 100) return "FINALIZING COMPILATION...";
  return "CONSOLE PORTAL READY.";
}

function renderMatrixFrame(state: MatrixAnimationState): string {
  const groupedDrops = dropsByColumn(state.drops);
  let output = '\x1B[H';
  for (let row = 0; row < state.height; row++) {
    for (let col = 0; col < state.width; col++) {
      const rain = rainState(row, groupedDrops.get(col));
      output += renderMatrixCell(state.targetArt[row]![col]!, state.revealed[row]![col]!, rain.inRain, rain.isHead);
    }
    output += '\n';
  }
  const progress = Math.min(1, state.frame / state.totalFrames);
  const percent = Math.floor(progress * 100);
  const filledWidth = Math.floor(progress * 30);
  const bar = `${C_BRIGHT_GREEN}${"█".repeat(filledWidth)}${C_DARK_GREEN}${"░".repeat(30 - filledWidth)}`;
  return `${output}\n${" ".repeat(15)}${C_DARK_GREEN}[${bar}] ${C_BRIGHT_GREEN}${percent}%${C_RESET} ${C_GREEN}${animationStatus(percent)}${C_RESET}\n`;
}

function advanceAndRenderMatrixFrame(state: MatrixAnimationState): boolean {
  state.frame++;
  const revealProgress = Math.min(1, state.frame / (state.totalFrames * 0.8));
  advanceMatrixDrops(state, revealProgress);
  advanceMatrixReveal(state, revealProgress);
  process.stdout.write(renderMatrixFrame(state));
  return state.frame >= state.totalFrames;
}

async function runMatrixAnimation(state: MatrixAnimationState): Promise<void> {
  await new Promise<void>(resolve => {
    const interval = setInterval(() => {
      if (!advanceAndRenderMatrixFrame(state)) return;
      clearInterval(interval);
      process.stdout.write('\x1B[?25h');
      resolve();
    }, 25);
  });
}

export async function playStartupAnimation() {
  clearConsole();
  const lines = startupArtLines();
  const width = Math.max(...lines.map(line => line.length));
  if (!process.stdout.isTTY || (process.stdout.columns || 80) < width) {
    console.log(`${C_GREEN}===================================================\n BOOTING SECURE NETWORK SHELL...\n===================================================${C_RESET}`);
    console.log(lines.join('\n'));
    console.log(`\n${C_GREEN}CONSOLE PORTAL READY.${C_RESET}\n`);
    await new Promise<void>(resolve => setTimeout(resolve, 800));
    return;
  }
  process.stdout.write('\x1B[?25l');
  const height = lines.length;
  await runMatrixAnimation({
    width,
    height,
    targetArt: lines.map(line => line.padEnd(width, ' ')),
    revealed: Array.from({ length: height }, () => Array(width).fill(false)),
    drops: createMatrixDrops(width, height),
    frame: 0,
    totalFrames: 2_000 / 25
  });
  await new Promise<void>(resolve => setTimeout(resolve, 600));
}
