import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const envPath = path.join(__dirname, '../.env');

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
    const envContent = fs.readFileSync(envPath, 'utf-8');
    for (const line of envContent.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const parts = trimmed.split('=');
        if (parts.length >= 2) {
          const key = parts[0]!.trim();
          const value = parts.slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
          process.env[key] = value;
        }
      }
    }
  }
  validateTelegramApiId();
}

/**
 * Updates a value in the .env file and process.env.
 */
export function updateEnvValue(key: string, value: string): void {
  let envContent = '';
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf-8');
  }

  const lines = envContent.split(/\r?\n/);
  let found = false;
  const newLines = lines.map(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const parts = trimmed.split('=');
      if (parts[0]!.trim() === key) {
        found = true;
        return `${key}=${value}`;
      }
    }
    return line;
  });

  if (!found) {
    if (newLines.length > 0 && newLines[newLines.length - 1]!.trim() !== '') {
      newLines.push('');
    }
    newLines.push(`${key}=${value}`);
  }

  fs.writeFileSync(envPath, newLines.join('\n'), 'utf-8');
  process.env[key] = value;

  if (key === 'TELEGRAM_API_ID') {
    validateTelegramApiId();
  }
}
