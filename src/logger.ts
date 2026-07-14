import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOG_DIRECTORY = path.join(path.dirname(fileURLToPath(import.meta.url)), '../logs');
const MAX_LOG_ENTRIES = 30;
const LOG_RETENTION_DAYS = 14;

let logHistory: string[] = [];
let logFileReady = false;
let logFilePath: string | null = null;
let logWriteFailureReported = false;

type LogContextValue = string | number | boolean | null | undefined;
export type LogContext = Record<string, LogContextValue>;

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

function currentLogFilePath(now = new Date()): string {
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  return path.join(LOG_DIRECTORY, `${date}.log`);
}

export function maskPII(text: string): string;
export function maskPII<T>(text: T): T;
export function maskPII<T>(text: T): T | string {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\b0x[a-fA-F0-9]{40}\b/gi, '0x...[MASKED_EVM_ADDR]')
    .replace(/\b(1|3)[a-km-zA-HJ-NP-Z1-9]{25,34}\b/g, '[MASKED_BTC_ADDR]')
    .replace(/\bbc1[ac-hj-np-z0-9]{11,71}\b/gi, '[MASKED_BTC_ADDR]')
    .replace(/\+\d{1,4}[ \d-]{6,14}\b/g, '[MASKED_PHONE]');
}

async function removeExpiredLog(file: string, cutoff: number): Promise<void> {
  if (!file.endsWith('.log')) return;
  const timestamp = new Date(file.slice(0, 10)).getTime();
  if (Number.isFinite(timestamp) && timestamp < cutoff) {
    await fs.unlink(path.join(LOG_DIRECTORY, file));
  }
}

async function runLogRetentionCleanup(): Promise<void> {
  try {
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const files = await fs.readdir(LOG_DIRECTORY);
    await Promise.all(files.map((file) => removeExpiredLog(file, cutoff)));
  } catch (error: any) {
    console.error(`[WARN] Log retention cleanup failed: ${error.message}`);
  }
}

export async function initFileLogger(): Promise<void> {
  try {
    await fs.mkdir(LOG_DIRECTORY, { recursive: true });
    logFilePath = currentLogFilePath();
    const header = `\n${'='.repeat(70)}\n  SESSION START: ${new Date().toISOString()}\n${'='.repeat(70)}\n`;
    await fs.appendFile(logFilePath, header, 'utf8');
    logFileReady = true;
    await runLogRetentionCleanup();
  } catch (error: any) {
    console.error(`[WARN] Log file initialization failed: ${error.message}`);
    logFileReady = false;
  }
}

function reportLogWriteFailure(error: unknown): void {
  if (logWriteFailureReported) return;
  logWriteFailureReported = true;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ERROR] Persistent log write failed: ${message}`);
}

function writeToLogFile(line: string): void {
  if (!logFileReady) return;
  logFilePath = currentLogFilePath();
  void fs.appendFile(logFilePath, `${line}\n`, 'utf8').then(
    () => { logWriteFailureReported = false; },
    reportLogWriteFailure
  );
}

function sanitizeLogContext(context: LogContext): Record<string, string | number | boolean | null> {
  const sanitized: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(context)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/i.test(key) || value === undefined) continue;
    sanitized[key] = typeof value === 'string' ? maskPII(value).slice(0, 512) : value;
  }
  return sanitized;
}

function logLevel(message: string): string {
  const tag = /^\[([^\]]+)\]/.exec(message)?.[1]?.toUpperCase() || 'INFO';
  if (tag.includes('CRITICAL')) return 'CRITICAL';
  if (tag.includes('FATAL')) return 'FATAL';
  if (tag.includes('ERROR') || tag.includes('FEHLER')) return 'ERROR';
  if (tag.includes('WARN')) return 'WARN';
  if (tag.includes('DEBUG')) return 'DEBUG';
  return 'INFO';
}

export function buildStructuredLogEntry(
  isoTimestamp: string,
  message: string,
  context: LogContext = {}
): Record<string, unknown> {
  const cleanMessage = stripAnsi(maskPII(message));
  return {
    timestamp: isoTimestamp,
    level: logLevel(cleanMessage),
    message: cleanMessage.replace(/^\[[^\]]+\]\s*/, ''),
    ...sanitizeLogContext(context),
  };
}

export function addLog(message: string, context: LogContext = {}): void {
  const now = new Date();
  const cleanMessage = stripAnsi(maskPII(message));
  const displayLine = `[${now.toLocaleTimeString()}] ${cleanMessage}`;
  logHistory = [...logHistory.slice(-(MAX_LOG_ENTRIES - 1)), displayLine];
  const structured = buildStructuredLogEntry(now.toISOString(), cleanMessage, context);
  console.log(process.env.JSON_LOGGING === 'true' ? JSON.stringify(structured) : displayLine);
  const persistentLine = process.env.JSON_LOGGING === 'true'
    ? JSON.stringify(structured)
    : `[${now.toISOString()}] ${cleanMessage}${Object.keys(context).length ? ` ${JSON.stringify(sanitizeLogContext(context))}` : ''}`;
  writeToLogFile(persistentLine);
}

export function getLogHistory(): string[] {
  return [...logHistory];
}

export function clearLogHistory(): void {
  logHistory = [];
}
