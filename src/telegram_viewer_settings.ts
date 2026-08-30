import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { TelegramViewerSettings } from './viewer_types.js';

const TOP_LEVEL_KEYS = new Set([
  'enabled', 'allowedUserIds', 'timezone', 'locale', 'eventPollingIntervalMs', 'notifications', 'display',
]);
const NOTIFICATION_KEYS = new Set([
  'positionOpened', 'takeProfitFilled', 'stopLossFilled', 'positionClosed', 'executionFailed',
  'accountIncidentOpened', 'accountIncidentResolved', 'exchangeStreamDegraded', 'exchangeStreamRecovered',
  'killSwitchActivated', 'signalReceived', 'signalValidated', 'intentCreated', 'exchangeAcknowledged',
]);
const DISPLAY_KEYS = new Set(['detailLevel', 'pnlMode', 'timeFormat']);
const MAXIMUM_SETTINGS_BYTES = 128 * 1024;

export const DEFAULT_TELEGRAM_VIEWER_SETTINGS: TelegramViewerSettings = {
  enabled: false,
  allowedUserIds: [],
  timezone: 'UTC',
  locale: 'de-DE',
  eventPollingIntervalMs: 2_000,
  notifications: {
    positionOpened: true,
    takeProfitFilled: true,
    stopLossFilled: true,
    positionClosed: true,
    executionFailed: true,
    accountIncidentOpened: true,
    accountIncidentResolved: true,
    exchangeStreamDegraded: true,
    exchangeStreamRecovered: true,
    killSwitchActivated: true,
    signalReceived: false,
    signalValidated: false,
    intentCreated: false,
    exchangeAcknowledged: false,
  },
  display: {
    detailLevel: 'normal',
    pnlMode: 'absolute_and_percent',
    timeFormat: '24h',
  },
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown setting(s): ${unknown.join(', ')}.`);
  const missing = [...allowed].filter(key => !(key in value));
  if (missing.length > 0) throw new Error(`${label} is missing setting(s): ${missing.join(', ')}.`);
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be true or false.`);
  return value;
}

function validTimezone(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 100 || /[\0\r\n]/.test(value)) {
    throw new Error('Telegram viewer timezone is invalid.');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
  } catch {
    throw new Error('Telegram viewer timezone is invalid.');
  }
  return value;
}

function validLocale(value: unknown): string {
  if (typeof value !== 'string' || value.length < 2 || value.length > 35 || /[\0\r\n]/.test(value)) {
    throw new Error('Telegram viewer locale is invalid.');
  }
  try {
    return new Intl.Locale(value).toString();
  } catch {
    throw new Error('Telegram viewer locale is invalid.');
  }
}

function validAllowedUsers(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Telegram viewer allowed user IDs are invalid.');
  const users = value.map(user => {
    if (typeof user !== 'string' || !/^[1-9][0-9]{0,19}$/.test(user)) {
      throw new Error('Telegram viewer allowed user ID must be a numeric Telegram user ID.');
    }
    return user;
  });
  if (new Set(users).size !== users.length) throw new Error('Telegram viewer allowed user IDs contain a duplicate.');
  return users;
}

function validatedNotifications(value: unknown): TelegramViewerSettings['notifications'] {
  const source = record(value, 'Telegram viewer notifications');
  exactKeys(source, NOTIFICATION_KEYS, 'Telegram viewer notifications');
  return Object.fromEntries([...NOTIFICATION_KEYS].map(key => [
    key,
    boolean(source[key], `Telegram viewer notification ${key}`),
  ])) as unknown as TelegramViewerSettings['notifications'];
}

function validatedDisplay(value: unknown): TelegramViewerSettings['display'] {
  const source = record(value, 'Telegram viewer display settings');
  exactKeys(source, DISPLAY_KEYS, 'Telegram viewer display settings');
  if (!['compact', 'normal', 'detailed'].includes(String(source.detailLevel))) {
    throw new Error('Telegram viewer detail level is invalid.');
  }
  if (!['absolute', 'absolute_and_percent'].includes(String(source.pnlMode))) {
    throw new Error('Telegram viewer PnL mode is invalid.');
  }
  if (source.timeFormat !== '24h') throw new Error('Telegram viewer time format must be 24h.');
  return {
    detailLevel: source.detailLevel as TelegramViewerSettings['display']['detailLevel'],
    pnlMode: source.pnlMode as TelegramViewerSettings['display']['pnlMode'],
    timeFormat: '24h',
  };
}

export function validateTelegramViewerSettings(input: unknown): TelegramViewerSettings {
  const source = record(input, 'Telegram viewer settings');
  exactKeys(source, TOP_LEVEL_KEYS, 'Telegram viewer settings');
  const polling = Number(source.eventPollingIntervalMs);
  if (!Number.isSafeInteger(polling) || polling < 1_000 || polling > 60_000) {
    throw new Error('Telegram viewer polling interval must be between 1000 and 60000 milliseconds.');
  }
  return {
    enabled: boolean(source.enabled, 'Telegram viewer enabled state'),
    allowedUserIds: validAllowedUsers(source.allowedUserIds),
    timezone: validTimezone(source.timezone),
    locale: validLocale(source.locale),
    eventPollingIntervalMs: polling,
    notifications: validatedNotifications(source.notifications),
    display: validatedDisplay(source.display),
  };
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r');
  try {
    await handle.sync();
  } catch (error: any) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(error?.code)) throw error;
  } finally {
    await handle.close();
  }
}

export class ManagedTelegramViewerSettingsStore {
  private settings = structuredClone(DEFAULT_TELEGRAM_VIEWER_SETTINGS);
  private recoveryReason: string | null = null;

  constructor(private readonly filePath: string) {}

  async initialize(options: { recoverInvalidFile?: boolean } = {}): Promise<void> {
    const destination = path.resolve(this.filePath);
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    try {
      const stats = await fs.lstat(destination);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAXIMUM_SETTINGS_BYTES) {
        throw new Error('Telegram viewer settings must be a small regular file.');
      }
      this.settings = validateTelegramViewerSettings(JSON.parse(await fs.readFile(destination, 'utf8')));
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        await this.write(DEFAULT_TELEGRAM_VIEWER_SETTINGS);
        return;
      }
      if (!options.recoverInvalidFile) throw error;
      this.settings = structuredClone(DEFAULT_TELEGRAM_VIEWER_SETTINGS);
      this.recoveryReason = error instanceof Error ? error.message : 'Telegram viewer settings could not be read.';
    }
  }

  snapshot(): TelegramViewerSettings {
    return structuredClone(this.settings);
  }

  recoveryStatus(): { active: boolean; reason: string | null } {
    return { active: this.recoveryReason !== null, reason: this.recoveryReason };
  }

  async set(input: unknown): Promise<TelegramViewerSettings> {
    const settings = validateTelegramViewerSettings(input);
    await this.write(settings);
    this.recoveryReason = null;
    return this.snapshot();
  }

  async reset(): Promise<void> {
    await this.write(DEFAULT_TELEGRAM_VIEWER_SETTINGS);
    this.recoveryReason = null;
  }

  private async write(settings: TelegramViewerSettings): Promise<void> {
    const destination = path.resolve(this.filePath);
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(settings, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, destination);
      await syncDirectory(path.dirname(destination));
      this.settings = structuredClone(settings);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

export function telegramViewerSettingsFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ManagedTelegramViewerSettingsStore {
  return new ManagedTelegramViewerSettingsStore(
    env.TELEGRAM_VIEWER_SETTINGS_PATH || path.join(process.cwd(), 'config', 'telegram-viewer-settings.json'),
  );
}

