import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ManagedSecretName =
  | 'telegramApiHash'
  | 'openRouterApiKey'
  | 'dashboardAdminToken'
  | 'dashboardViewerToken'
  | 'auditWebhookToken'
  | 'alertRelayToken'
  | 'alertWebhookToken'
  | 'backupOffsiteToken'
  | 'backupEncryptionKey';
export type ManagedSecretSource = 'managed' | 'external' | 'missing';

interface SecretDefinition {
  environmentName:
    | 'TELEGRAM_API_HASH'
    | 'OPENROUTER_API_KEY'
    | 'DASHBOARD_ADMIN_TOKEN'
    | 'DASHBOARD_VIEWER_TOKEN'
    | 'AUDIT_WEBHOOK_TOKEN'
    | 'ALERT_RELAY_TOKEN'
    | 'ALERT_WEBHOOK_TOKEN'
    | 'BACKUP_OFFSITE_TOKEN'
    | 'BACKUP_ENCRYPTION_KEY';
  fileName: string;
  validate(value: string): boolean;
  error: string;
}

interface SecretTransaction {
  version: 1;
  updates: Partial<Record<ManagedSecretName, string>>;
}

export interface ManagedSecretRecoveryIssue {
  name?: ManagedSecretName;
  fileName: string;
  reason: string;
}

export interface ManagedSecretStoreOptions {
  recoverInvalidManagedFiles?: boolean;
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
  dashboardViewerToken: {
    environmentName: 'DASHBOARD_VIEWER_TOKEN',
    fileName: 'dashboard_viewer_token',
    validate: (value) => value.length >= 32 && value.length <= 512 && !/^(replace_|change-?me|example|placeholder)/i.test(value),
    error: 'Dashboard viewer token must contain between 32 and 512 random characters.',
  },
  auditWebhookToken: {
    environmentName: 'AUDIT_WEBHOOK_TOKEN',
    fileName: 'audit_webhook_token',
    validate: (value) => value.length >= 32 && value.length <= 512 && !/^(replace_|change-?me|example|placeholder)/i.test(value),
    error: 'Audit webhook token must contain between 32 and 512 random characters.',
  },
  alertRelayToken: {
    environmentName: 'ALERT_RELAY_TOKEN',
    fileName: 'alert_relay_token',
    validate: (value) => value.length >= 32 && value.length <= 512 && !/^(replace_|change-?me|example|placeholder)/i.test(value),
    error: 'Alert relay token must contain between 32 and 512 random characters.',
  },
  alertWebhookToken: {
    environmentName: 'ALERT_WEBHOOK_TOKEN',
    fileName: 'alert_webhook_token',
    validate: (value) => value.length >= 32 && value.length <= 512 && !/^(replace_|change-?me|example|placeholder)/i.test(value),
    error: 'Alert webhook token must contain between 32 and 512 random characters.',
  },
  backupOffsiteToken: {
    environmentName: 'BACKUP_OFFSITE_TOKEN',
    fileName: 'backup_offsite_token',
    validate: (value) => value.length >= 32 && value.length <= 512 && !/^(replace_|change-?me|example|placeholder)/i.test(value),
    error: 'Off-site backup token must contain between 32 and 512 random characters.',
  },
  backupEncryptionKey: {
    environmentName: 'BACKUP_ENCRYPTION_KEY',
    fileName: 'backup_encryption_key',
    validate: (value) => {
      try {
        return Buffer.from(value, 'base64').length === 32 && Buffer.from(value, 'base64').toString('base64') === value;
      } catch {
        return false;
      }
    },
    error: 'Backup encryption key must be a canonical base64-encoded 32-byte key.',
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
  private readonly generatingTokens = new Set<ManagedSecretName>();
  private readonly recoveryIssues: ManagedSecretRecoveryIssue[] = [];
  private writing = false;

  constructor(directory: string, env: NodeJS.ProcessEnv = process.env) {
    this.directory = path.resolve(directory);
    this.env = env;
  }

  rootPath(): string {
    return this.directory;
  }

  async initialize(options: ManagedSecretStoreOptions = {}): Promise<void> {
    await this.initializeDirectory();
    await this.initializeTransactionRecovery(options);
    await this.initializeSecrets(options);
  }

  private async initializeDirectory(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    let stats = await fs.lstat(this.directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('Managed secret directory must be a real directory, not a symbolic link.');
    }
    if (process.platform !== 'win32') {
      await fs.chmod(this.directory, 0o700);
      stats = await fs.lstat(this.directory);
    }
    if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
      throw new Error('Managed secret directory must not be accessible by group or other users.');
    }
  }

  private async initializeTransactionRecovery(options: ManagedSecretStoreOptions): Promise<void> {
    try {
      await this.recoverPendingTransaction();
    } catch (error) {
      if (!options.recoverInvalidManagedFiles) throw error;
      this.recoveryIssues.push({
        fileName: path.basename(this.transactionPath()),
        reason: error instanceof Error ? error.message : 'Managed secret transaction could not be read.',
      });
    }
  }

  private async initializeSecrets(options: ManagedSecretStoreOptions): Promise<void> {
    for (const name of Object.keys(DEFINITIONS) as ManagedSecretName[]) {
      try {
        await this.load(name);
      } catch (error) {
        if (!options.recoverInvalidManagedFiles || this.env[DEFINITIONS[name].environmentName]?.trim()) throw error;
        this.sources.set(name, 'missing');
        this.recoveryIssues.push({
          name,
          fileName: DEFINITIONS[name].fileName,
          reason: error instanceof Error ? error.message : 'Managed secret could not be read.',
        });
      }
    }
  }

  status(): Record<ManagedSecretName, ManagedSecretStatus> {
    return Object.fromEntries(
      (Object.keys(DEFINITIONS) as ManagedSecretName[]).map((name) => {
        const source = this.sources.get(name) ?? 'missing';
        const immutableBackupKey = name === 'backupEncryptionKey' && source === 'managed';
        return [name, { configured: source !== 'missing', editable: source !== 'external' && !immutableBackupKey, source }];
      })
    ) as Record<ManagedSecretName, ManagedSecretStatus>;
  }

  recoveryStatus(): ManagedSecretRecoveryIssue[] {
    return this.recoveryIssues.map((issue) => ({ ...issue }));
  }

  async set(updates: Partial<Record<ManagedSecretName, unknown>>): Promise<void> {
    if (this.writing) throw new Error('Managed secret update is already in progress.');
    this.writing = true;
    try {
      await this.setAtomically(updates);
    } finally {
      this.writing = false;
    }
  }

  private async setAtomically(updates: Partial<Record<ManagedSecretName, unknown>>): Promise<void> {
    const entries = Object.entries(updates) as Array<[ManagedSecretName, unknown]>;
    if (entries.length === 0) throw new Error('At least one managed secret is required.');
    const validated = entries.map(([name, value]) => {
      if (!(name in DEFINITIONS)) throw new Error(`Unknown managed secret: ${name}.`);
      if (this.sources.get(name) === 'external') {
        throw new Error(`${DEFINITIONS[name].environmentName} is externally managed and cannot be changed in the dashboard.`);
      }
      const normalized = validateSecret(name, value);
      if (name === 'backupEncryptionKey' && this.sources.get(name) === 'managed') {
        const current = this.env.BACKUP_ENCRYPTION_KEY?.trim();
        if (current !== normalized) {
          throw new Error('BACKUP_ENCRYPTION_KEY is immutable because rotating it would make existing off-site backups unrecoverable. Use factory reset only when those backups are intentionally abandoned.');
        }
      }
      return [name, normalized] as const;
    });
    await this.writeTransaction(Object.fromEntries(validated));
    for (let index = this.recoveryIssues.length - 1; index >= 0; index--) {
      if (!this.recoveryIssues[index].name) this.recoveryIssues.splice(index, 1);
    }
    for (const [name, value] of validated) {
      this.env[DEFINITIONS[name].environmentName] = value;
      this.sources.set(name, 'managed');
      const issueIndex = this.recoveryIssues.findIndex((issue) => issue.name === name);
      if (issueIndex >= 0) this.recoveryIssues.splice(issueIndex, 1);
    }
  }

  async createDashboardAdminToken(): Promise<string> {
    if (this.generatingTokens.has('dashboardAdminToken')) {
      throw new Error('Dashboard authentication bootstrap is already in progress.');
    }
    if (this.status().dashboardAdminToken.configured) {
      throw new Error('Dashboard authentication is already configured.');
    }
    this.generatingTokens.add('dashboardAdminToken');
    try {
      return await this.generateDashboardToken('dashboardAdminToken');
    } finally {
      this.generatingTokens.delete('dashboardAdminToken');
    }
  }

  async rotateDashboardToken(role: 'admin' | 'viewer'): Promise<string> {
    const name = role === 'admin' ? 'dashboardAdminToken' : 'dashboardViewerToken';
    if (this.generatingTokens.has(name)) throw new Error(`Dashboard ${role} token generation is already in progress.`);
    if (this.sources.get(name) === 'external') {
      throw new Error(`${DEFINITIONS[name].environmentName} is externally managed and cannot be rotated in the dashboard.`);
    }
    this.generatingTokens.add(name);
    try {
      return await this.generateDashboardToken(name);
    } finally {
      this.generatingTokens.delete(name);
    }
  }

  async removeDashboardViewerToken(): Promise<void> {
    await this.remove('dashboardViewerToken');
  }

  async clear(): Promise<void> {
    this.assertClearable();
    for (const name of Object.keys(DEFINITIONS) as ManagedSecretName[]) await this.remove(name);
  }

  assertClearable(): void {
    const external = (Object.keys(DEFINITIONS) as ManagedSecretName[])
      .filter((name) => this.sources.get(name) === 'external');
    if (external.length > 0) {
      throw new Error(`Factory reset cannot remove externally managed secrets: ${external.map((name) => DEFINITIONS[name].environmentName).join(', ')}.`);
    }
  }

  private async generateDashboardToken(name: 'dashboardAdminToken' | 'dashboardViewerToken'): Promise<string> {
    const token = randomBytes(32).toString('hex');
    await this.set({ [name]: token });
    return token;
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
      if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
        throw new Error(`${definition.fileName} must not be accessible by group or other users.`);
      }
      const value = validateSecret(name, (await fs.readFile(filePath, 'utf8')).replace(/\r?\n$/, ''));
      this.env[definition.environmentName] = value;
      this.sources.set(name, 'managed');
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      this.sources.set(name, 'missing');
    }
  }

  private transactionPath(): string {
    return path.join(this.directory, '.managed-secret-transaction.json');
  }

  private async writeTransaction(updates: Partial<Record<ManagedSecretName, string>>): Promise<void> {
    const transaction: SecretTransaction = { version: 1, updates };
    await this.writeFileAtomically(this.transactionPath(), `${JSON.stringify(transaction)}\n`);
    // If publishing any member fails, this durable journal remains in place. The
    // next initialize() completes every member instead of retaining a partial update.
    for (const [name, value] of Object.entries(updates) as Array<[ManagedSecretName, string]>) {
      await this.writeSecretFile(name, value);
    }
    await fs.unlink(this.transactionPath());
    await syncDirectory(this.directory);
  }

  private async recoverPendingTransaction(): Promise<void> {
    const entries = await this.readPendingTransactionEntries();
    if (!entries) return;
    await this.applyRecoveredSecretTransaction(entries);
    await fs.unlink(this.transactionPath());
    await syncDirectory(this.directory);
  }

  private async readPendingTransactionEntries(): Promise<Array<[ManagedSecretName, unknown]> | null> {
    const transactionPath = this.transactionPath();
    let parsed: unknown;
    try {
      const stats = await fs.lstat(transactionPath);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 128 * 1024) {
        throw new Error('Managed secret transaction must be a small regular file.');
      }
      if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
        throw new Error('Managed secret transaction must not be accessible by group or other users.');
      }
      parsed = JSON.parse(await fs.readFile(transactionPath, 'utf8'));
    } catch (error: any) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    return this.validatePendingTransaction(parsed);
  }

  private validatePendingTransaction(parsed: unknown): Array<[ManagedSecretName, unknown]> {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Managed secret transaction is invalid.');
    }
    const transaction = parsed as Partial<SecretTransaction>;
    if (transaction.version !== 1 || !transaction.updates || typeof transaction.updates !== 'object' || Array.isArray(transaction.updates)) {
      throw new Error('Managed secret transaction is invalid.');
    }
    const entries = Object.entries(transaction.updates) as Array<[ManagedSecretName, unknown]>;
    if (entries.length === 0) throw new Error('Managed secret transaction is empty.');
    return entries;
  }

  private async applyRecoveredSecretTransaction(entries: Array<[ManagedSecretName, unknown]>): Promise<void> {
    for (const [name, value] of entries) {
      if (!(name in DEFINITIONS)) throw new Error(`Managed secret transaction contains an unknown secret: ${name}.`);
      if (this.env[DEFINITIONS[name].environmentName]?.trim()) {
        throw new Error(`Managed secret transaction cannot overwrite externally managed ${DEFINITIONS[name].environmentName}.`);
      }
      await this.writeSecretFile(name, validateSecret(name, value));
    }
  }

  private async writeSecretFile(name: ManagedSecretName, value: string): Promise<void> {
    await this.writeFileAtomically(this.secretPath(name), `${value}\n`);
  }

  private async writeFileAtomically(destination: string, content: string): Promise<void> {
    const temporary = `${destination}.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}.tmp`;
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, destination);
      await syncDirectory(this.directory);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async remove(name: ManagedSecretName): Promise<void> {
    if (this.sources.get(name) === 'external') {
      throw new Error(`${DEFINITIONS[name].environmentName} is externally managed and cannot be removed in the dashboard.`);
    }
    await fs.unlink(this.secretPath(name)).catch((error: any) => {
      if (error?.code !== 'ENOENT') throw error;
    });
    delete this.env[DEFINITIONS[name].environmentName];
    this.sources.set(name, 'missing');
    await syncDirectory(this.directory);
  }
}

export function managedSecretStoreFromEnvironment(env: NodeJS.ProcessEnv = process.env): ManagedSecretStore {
  const configuredStateRoot = env.XDG_STATE_HOME?.trim()
    || (process.platform === 'win32' ? env.LOCALAPPDATA?.trim() : '');
  const stateRoot = configuredStateRoot && path.isAbsolute(configuredStateRoot)
    ? configuredStateRoot
    : path.join(os.homedir(), '.local', 'state');
  const directory = path.resolve(env.MANAGED_SECRET_DIR?.trim() || path.join(stateRoot, 'telegram-tdlib-forwarder', 'secrets'));
  // Publish the resolved root so every credential store in this process uses
  // the same out-of-worktree boundary without independently falling back to cwd.
  env.MANAGED_SECRET_DIR = directory;
  return new ManagedSecretStore(directory, env);
}
