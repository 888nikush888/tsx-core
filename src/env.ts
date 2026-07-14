import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const envPath = path.join(__dirname, '../.env');

const FILE_BACKED_SECRETS = [
  'OPENROUTER_API_KEY',
  'TELEGRAM_API_HASH',
  'DASHBOARD_ADMIN_TOKEN',
  'DASHBOARD_VIEWER_TOKEN',
  'BACKUP_OFFSITE_TOKEN',
  'BACKUP_ENCRYPTION_KEY',
  'ALERT_RELAY_TOKEN',
  'ALERT_WEBHOOK_TOKEN',
  'PROMETHEUS_TOKEN',
  'AUDIT_WEBHOOK_TOKEN'
] as const;
const MAX_SECRET_BYTES = 16 * 1024;

export function applyEnvContent(content: string, env: NodeJS.ProcessEnv = process.env): void {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || env[key] !== undefined) continue;
    env[key] = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
  }
}

export function resolveSecretFiles(env: NodeJS.ProcessEnv = process.env): void {
  for (const secretName of FILE_BACKED_SECRETS) {
    const fileVariable = `${secretName}_FILE`;
    const fileReference = env[fileVariable]?.trim();
    if (!fileReference) continue;
    if (env[secretName]?.trim()) {
      throw new Error(`${secretName} and ${fileVariable} cannot both be configured.`);
    }
    const secretPath = path.resolve(fileReference);
    const stats = fs.statSync(secretPath);
    if (!stats.isFile() || stats.size < 1 || stats.size > MAX_SECRET_BYTES) {
      throw new Error(`${fileVariable} must reference a non-empty regular file of at most ${MAX_SECRET_BYTES} bytes.`);
    }
    const value = fs.readFileSync(secretPath, 'utf8').replace(/\r?\n$/, '');
    if (!value || value.includes('\0') || /[\r\n]/.test(value)) {
      throw new Error(`${fileVariable} must contain exactly one non-empty secret line.`);
    }
    env[secretName] = value;
    delete env[fileVariable];
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
    if (!Number.isSafeInteger(parsed) || isNaN(parsed) || parsed <= 0) {
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
