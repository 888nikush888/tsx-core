import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '../.env');

const FILE_BACKED_SECRETS = [
  'OPENROUTER_API_KEY',
  'TELEGRAM_API_HASH',
  'DASHBOARD_ADMIN_TOKEN',
  'DASHBOARD_VIEWER_TOKEN',
  'DASHBOARD_BOOTSTRAP_PROOF',
  'BACKUP_OFFSITE_TOKEN',
  'BACKUP_ENCRYPTION_KEY',
  'ALERT_RELAY_TOKEN',
  'ALERT_WEBHOOK_TOKEN',
  'PROMETHEUS_TOKEN',
  'AUDIT_WEBHOOK_TOKEN'
] as const;
const MAX_SECRET_BYTES = 16 * 1024;

function parsedEnvEntry(trimmed: string): { key: string; value: string } | null {
  if (!trimmed || trimmed.startsWith('#')) return null;
  const separator = trimmed.indexOf('=');
  if (separator <= 0) return null;
  const key = trimmed.slice(0, separator).trim();
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) return null;
  const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
  return { key, value };
}

export function applyEnvContent(content: string, env: NodeJS.ProcessEnv = process.env): void {
  for (const line of content.split(/\r?\n/)) {
    const entry = parsedEnvEntry(line.trim());
    if (!entry || env[entry.key] !== undefined) continue;
    env[entry.key] = entry.value;
  }
}

function secretFileReference(env: NodeJS.ProcessEnv, fileVariable: string): string | null {
  const fileReference = env[fileVariable]?.trim();
  return fileReference ? fileReference : null;
}

function assertSecretNotDoubled(env: NodeJS.ProcessEnv, secretName: string, fileVariable: string): void {
  if (env[secretName]?.trim()) {
    throw new Error(`${secretName} and ${fileVariable} cannot both be configured.`);
  }
}

function assertSecretFileSize(secretPath: string, fileVariable: string): void {
  const resolved = path.resolve(secretPath);
  const stats = fs.statSync(resolved);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1 || stats.size > MAX_SECRET_BYTES) {
    throw new Error(`${fileVariable} must reference a non-empty regular file of at most ${MAX_SECRET_BYTES} bytes.`);
  }
}

function readSecretLine(secretPath: string, fileVariable: string): string {
  const value = fs.readFileSync(secretPath, 'utf8').replace(/\r?\n$/, '');
  if (!value || value.includes('\0') || /[\r\n]/.test(value)) {
    throw new Error(`${fileVariable} must contain exactly one non-empty secret line.`);
  }
  return value;
}

function resolveSecretFile(env: NodeJS.ProcessEnv, secretName: string): void {
  const fileVariable = `${secretName}_FILE`;
  const fileReference = secretFileReference(env, fileVariable);
  if (!fileReference) return;
  assertSecretNotDoubled(env, secretName, fileVariable);
  const secretPath = path.resolve(fileReference);
  assertSecretFileSize(secretPath, fileVariable);
  env[secretName] = readSecretLine(secretPath, fileVariable);
  Reflect.deleteProperty(env, fileVariable);
}

export function resolveSecretFiles(env: NodeJS.ProcessEnv = process.env): void {
  for (const secretName of FILE_BACKED_SECRETS) {
    resolveSecretFile(env, secretName);
  }
}

/**
 * Validates TELEGRAM_API_ID in process.env to ensure it is a safe, positive integer.
 * Clears the environment variable if invalid to prevent unexpected behavior.
 */
export function validateTelegramApiId(): void {
  if (process.env['TELEGRAM_API_ID']) {
    const apiIdStr = process.env['TELEGRAM_API_ID'].trim();
    const parsed = Number(apiIdStr);
    if (!Number.isSafeInteger(parsed) || Number.isNaN(parsed) || parsed <= 0) {
      console.warn(`[WARN] TELEGRAM_API_ID in .env ("${apiIdStr}") is not a valid safe positive integer. Clearing from process.env.`);
      delete process.env['TELEGRAM_API_ID'];
    } else {
      process.env['TELEGRAM_API_ID'] = String(parsed);
    }
  }
}

/**
 * Safely reads the .env file, parses keys, and validates TELEGRAM_API_ID.
 */
export function loadEnv(): void {
  if (fs.existsSync(envPath)) {
    applyEnvContent(fs.readFileSync(envPath, 'utf-8'));
  }
  resolveSecretFiles();
  validateTelegramApiId();
}
