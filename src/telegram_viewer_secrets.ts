import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const BOT_TOKEN_FILE = 'bot_token';
const SERVICE_TOKEN_FILE = 'viewer_service_token';
const SERVICE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BOT_TOKEN_PATTERN = /^[1-9][0-9]{4,19}:[A-Za-z0-9_-]{20,128}$/;

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

function validSecret(value: string, pattern: RegExp, label: string): string {
  const normalized = value.trim();
  if (!pattern.test(normalized) || /[\0\r\n]/.test(normalized)) throw new Error(`${label} is invalid.`);
  return normalized;
}

export interface TelegramViewerSecretStatus {
  botToken: { configured: boolean; updatedAt: number | null };
  serviceToken: { configured: true; updatedAt: number | null };
}

export class TelegramViewerSecretStore {
  private botTokenValue: string | null = null;
  private serviceTokenValue = '';
  private botTokenUpdatedAt: number | null = null;
  private serviceTokenUpdatedAt: number | null = null;

  constructor(private readonly directory: string) {}

  rootPath(): string {
    return path.resolve(this.directory);
  }

  async initialize(options: { recoverInvalidBotToken?: boolean } = {}): Promise<void> {
    await this.initializeDirectory();
    this.serviceTokenValue = await this.loadOrCreateServiceToken();
    try {
      this.botTokenValue = await this.readOptionalSecret(BOT_TOKEN_FILE, BOT_TOKEN_PATTERN, 'Telegram bot token');
    } catch (error) {
      if (!options.recoverInvalidBotToken) throw error;
      this.botTokenValue = null;
      this.botTokenUpdatedAt = null;
    }
  }

  private async initializeDirectory(): Promise<void> {
    const directory = this.rootPath();
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stats = await fs.lstat(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('Telegram viewer secret directory must be a real directory.');
    }
    if (process.platform !== 'win32') await fs.chmod(directory, 0o700);
  }

  private secretPath(fileName: string): string {
    return path.join(this.rootPath(), fileName);
  }

  private async readOptionalSecret(fileName: string, pattern: RegExp, label: string): Promise<string | null> {
    const filePath = this.secretPath(fileName);
    try {
      const stats = await fs.lstat(filePath);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 512) {
        throw new Error(`${label} must be a small regular file.`);
      }
      const value = validSecret(await fs.readFile(filePath, 'utf8'), pattern, label);
      if (fileName === BOT_TOKEN_FILE) this.botTokenUpdatedAt = Math.floor(stats.mtimeMs);
      else this.serviceTokenUpdatedAt = Math.floor(stats.mtimeMs);
      return value;
    } catch (error: any) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  private async loadOrCreateServiceToken(): Promise<string> {
    const existing = await this.readOptionalSecret(SERVICE_TOKEN_FILE, SERVICE_TOKEN_PATTERN, 'Telegram viewer service token');
    if (existing) return existing;
    const generated = randomBytes(32).toString('base64url');
    await this.writeSecret(SERVICE_TOKEN_FILE, generated);
    return generated;
  }

  private async writeSecret(fileName: string, value: string): Promise<void> {
    const destination = this.secretPath(fileName);
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(`${value}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, destination);
      await syncDirectory(this.rootPath());
      const updatedAt = Math.floor((await fs.stat(destination)).mtimeMs);
      if (fileName === BOT_TOKEN_FILE) this.botTokenUpdatedAt = updatedAt;
      else this.serviceTokenUpdatedAt = updatedAt;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  status(): TelegramViewerSecretStatus {
    return {
      botToken: { configured: this.botTokenValue !== null, updatedAt: this.botTokenUpdatedAt },
      serviceToken: { configured: true, updatedAt: this.serviceTokenUpdatedAt },
    };
  }

  async readBotToken(): Promise<string | null> {
    return this.botTokenValue;
  }

  async setBotToken(value: unknown): Promise<void> {
    if (typeof value !== 'string') throw new Error('Telegram bot token is invalid.');
    const token = validSecret(value, BOT_TOKEN_PATTERN, 'Telegram bot token');
    await this.writeSecret(BOT_TOKEN_FILE, token);
    this.botTokenValue = token;
  }

  async deleteBotToken(): Promise<void> {
    await fs.unlink(this.secretPath(BOT_TOKEN_FILE)).catch((error: any) => {
      if (error?.code !== 'ENOENT') throw error;
    });
    await syncDirectory(this.rootPath());
    this.botTokenValue = null;
    this.botTokenUpdatedAt = null;
  }

  async serviceToken(): Promise<string> {
    return this.serviceTokenValue;
  }

  async rotateServiceToken(): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.writeSecret(SERVICE_TOKEN_FILE, token);
    this.serviceTokenValue = token;
    return token;
  }

  async clear(): Promise<void> {
    await this.deleteBotToken();
    await fs.unlink(this.secretPath(SERVICE_TOKEN_FILE)).catch((error: any) => {
      if (error?.code !== 'ENOENT') throw error;
    });
    this.serviceTokenValue = '';
    this.serviceTokenUpdatedAt = null;
  }
}

export function telegramViewerSecretStoreFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): TelegramViewerSecretStore {
  return new TelegramViewerSecretStore(
    env.TELEGRAM_VIEWER_SECRET_DIR || path.join(process.cwd(), 'telegram_viewer_secrets'),
  );
}

