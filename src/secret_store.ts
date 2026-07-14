import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export type ManagedSecretName = 'telegramApiHash' | 'openRouterApiKey' | 'dashboardAdminToken';
export type ManagedSecretSource = 'managed' | 'external' | 'missing';

interface SecretDefinition {
  environmentName: 'TELEGRAM_API_HASH' | 'OPENROUTER_API_KEY' | 'DASHBOARD_ADMIN_TOKEN';
  fileName: string;
  validate(value: string): boolean;
  error: string;
}

const DEFINITIONS: Record<ManagedSecretName, SecretDefinition> = {
  telegramApiHash: {
    environmentName: 'TELEGRAM_API_HASH',
    fileName: 'telegram_api_hash',
    validate: (value) => /^[a-f0-9]{32}$/i.test(value),
    error: 'Telegram API hash must contain exactly 32 hexadecimal characters.',
  },
  openRouterApiKey: {
    environmentName: 'OPENROUTER_API_KEY',
    fileName: 'openrouter_api_key',
    validate: (value) => value.length >= 16 && value.length <= 512 && !/^(example|placeholder|your_)/i.test(value),
    error: 'OpenRouter API key must contain between 16 and 512 non-placeholder characters.',
  },
  dashboardAdminToken: {
    environmentName: 'DASHBOARD_ADMIN_TOKEN',
    fileName: 'dashboard_admin_token',
    validate: (value) => value.length >= 32 && value.length <= 512 && !/^(replace_|change-?me|example|placeholder)/i.test(value),
    error: 'Dashboard administrator token must contain between 32 and 512 random characters.',
  },
};

export interface ManagedSecretStatus {
  configured: boolean;
  editable: boolean;
  source: ManagedSecretSource;
}

function validSingleLine(value: string): boolean {
  return Boolean(value) && !value.includes('\0') && !/[\r\n]/.test(value);
}

function validateSecret(name: ManagedSecretName, value: unknown): string {
  if (typeof value !== 'string' || !validSingleLine(value)) throw new Error(DEFINITIONS[name].error);
  const normalized = value.trim();
  if (!DEFINITIONS[name].validate(normalized)) throw new Error(DEFINITIONS[name].error);
  return normalized;
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

export class ManagedSecretStore {
  private readonly directory: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly sources = new Map<ManagedSecretName, ManagedSecretSource>();
  private creatingDashboardToken = false;

  constructor(directory: string, env: NodeJS.ProcessEnv = process.env) {
    this.directory = path.resolve(directory);
    this.env = env;
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stats = await fs.lstat(this.directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('Managed secret directory must be a real directory, not a symbolic link.');
    }
    for (const name of Object.keys(DEFINITIONS) as ManagedSecretName[]) await this.load(name);
  }

  status(): Record<ManagedSecretName, ManagedSecretStatus> {
    return Object.fromEntries(
      (Object.keys(DEFINITIONS) as ManagedSecretName[]).map((name) => {
        const source = this.sources.get(name) ?? 'missing';
        return [name, { configured: source !== 'missing', editable: source !== 'external', source }];
      })
    ) as Record<ManagedSecretName, ManagedSecretStatus>;
  }

  async set(updates: Partial<Record<ManagedSecretName, unknown>>): Promise<void> {
    const entries = Object.entries(updates) as Array<[ManagedSecretName, unknown]>;
    if (entries.length === 0) throw new Error('At least one managed secret is required.');
    const validated = entries.map(([name, value]) => {
      if (!(name in DEFINITIONS)) throw new Error(`Unknown managed secret: ${name}.`);
      if (this.sources.get(name) === 'external') {
        throw new Error(`${DEFINITIONS[name].environmentName} is externally managed and cannot be changed in the dashboard.`);
      }
      return [name, validateSecret(name, value)] as const;
    });
    for (const [name, value] of validated) await this.write(name, value);
  }

  async createDashboardAdminToken(): Promise<string> {
    if (this.creatingDashboardToken) {
      throw new Error('Dashboard authentication bootstrap is already in progress.');
    }
    if (this.status().dashboardAdminToken.configured) {
      throw new Error('Dashboard authentication is already configured.');
    }
    this.creatingDashboardToken = true;
    try {
      const token = randomBytes(32).toString('hex');
      await this.set({ dashboardAdminToken: token });
      return token;
    } finally {
      this.creatingDashboardToken = false;
    }
  }

  private secretPath(name: ManagedSecretName): string {
    return path.join(this.directory, DEFINITIONS[name].fileName);
  }

  private async load(name: ManagedSecretName): Promise<void> {
    const definition = DEFINITIONS[name];
    if (this.env[definition.environmentName]?.trim()) {
      validateSecret(name, this.env[definition.environmentName]);
      this.sources.set(name, 'external');
      return;
    }
    try {
      const filePath = this.secretPath(name);
      const stats = await fs.lstat(filePath);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 16 * 1024) {
        throw new Error(`${definition.fileName} must be a small regular file.`);
      }
      const value = validateSecret(name, (await fs.readFile(filePath, 'utf8')).replace(/\r?\n$/, ''));
      this.env[definition.environmentName] = value;
      this.sources.set(name, 'managed');
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      this.sources.set(name, 'missing');
    }
  }

  private async write(name: ManagedSecretName, value: string): Promise<void> {
    const destination = this.secretPath(name);
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(`${value}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, destination);
      await syncDirectory(this.directory);
      this.env[DEFINITIONS[name].environmentName] = value;
      this.sources.set(name, 'managed');
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

export function managedSecretStoreFromEnvironment(env: NodeJS.ProcessEnv = process.env): ManagedSecretStore {
  return new ManagedSecretStore(env.MANAGED_SECRET_DIR || path.join(process.cwd(), 'secrets'), env);
}
