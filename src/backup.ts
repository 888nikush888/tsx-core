import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { backupDatabase } from './db.js';

const DATABASE_FILE = 'forwarder.db';
const CONFIG_FILE = 'config.json';
const MANIFEST_FILE = 'manifest.json';
const REQUIRED_TABLES = ['signals', 'pending_tasks', 'media_group_buffer', 'forwarding_stats', 'incoming_messages', 'ai_usage_daily'];
const FORBIDDEN_CONFIG_KEYS = new Set([
  'APIHASH',
  'OPENROUTERAPIKEY',
  'TELEGRAMAPIHASH',
  'DASHBOARDADMINTOKEN',
  'DASHBOARDVIEWERTOKEN',
  'PASSWORD',
  'SECRET'
]);

interface BackupFileMetadata {
  sha256: string;
  size: number;
}

export interface BackupManifest {
  version: 1;
  createdAt: string;
  files: Record<typeof DATABASE_FILE | typeof CONFIG_FILE, BackupFileMetadata>;
}

export interface BackupStatus {
  lastSuccessAt: number | null;
  lastArtifact: string | null;
  lastError: string | null;
  running: boolean;
}

function normalizedConfigKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

function sanitizeConfig(value: any): any {
  if (Array.isArray(value)) return value.map(sanitizeConfig);
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, any> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_CONFIG_KEYS.has(normalizedConfigKey(key))) continue;
    result[key] = sanitizeConfig(nested);
  }
  return result;
}

function containsForbiddenConfigKey(value: any): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenConfigKey);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, nested]) =>
    FORBIDDEN_CONFIG_KEYS.has(normalizedConfigKey(key)) || containsForbiddenConfigKey(nested)
  );
}

async function sha256File(filePath: string): Promise<BackupFileMetadata> {
  const content = await fs.readFile(filePath);
  return {
    sha256: createHash('sha256').update(content).digest('hex'),
    size: content.length
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  return fs.stat(filePath).then(() => true).catch((error: any) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

export async function verifySqliteDatabase(databasePath: string): Promise<void> {
  const database = await open({
    filename: path.resolve(databasePath),
    driver: sqlite3.Database,
    mode: sqlite3.OPEN_READONLY
  });
  try {
    const integrity = await database.get<{ integrity_check: string }>('PRAGMA integrity_check;');
    if (integrity?.integrity_check !== 'ok') throw new Error(`SQLite integrity_check failed: ${integrity?.integrity_check || 'no result'}`);
    const rows = await database.all<Array<{ name: string }>>(
      `SELECT name FROM sqlite_master WHERE type = 'table'`
    );
    const tables = new Set(rows.map(row => row.name));
    const missing = REQUIRED_TABLES.filter(table => !tables.has(table));
    if (missing.length > 0) throw new Error(`Backup is missing required tables: ${missing.join(', ')}`);
  } finally {
    await database.close();
  }
}

export async function verifyBackupArtifact(artifactPath: string): Promise<BackupManifest> {
  const resolvedArtifact = path.resolve(artifactPath);
  const artifactStats = await fs.stat(resolvedArtifact);
  if (!artifactStats.isDirectory()) throw new Error('Backup artifact must be a directory.');
  const manifestPath = path.join(resolvedArtifact, MANIFEST_FILE);
  const manifestStats = await fs.stat(manifestPath);
  if (manifestStats.size > 64 * 1024) throw new Error('Backup manifest exceeds 64 KiB.');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as BackupManifest;
  if (manifest.version !== 1 || !manifest.createdAt || !manifest.files) throw new Error('Unsupported or malformed backup manifest.');
  if (Number.isNaN(Date.parse(manifest.createdAt))) throw new Error('Backup manifest has an invalid creation timestamp.');

  for (const fileName of [DATABASE_FILE, CONFIG_FILE] as const) {
    const expected = manifest.files[fileName];
    if (!expected || !/^[a-f0-9]{64}$/.test(expected.sha256) || !Number.isSafeInteger(expected.size) || expected.size < 1) {
      throw new Error(`Backup manifest metadata for '${fileName}' is invalid.`);
    }
    const actual = await sha256File(path.join(resolvedArtifact, fileName));
    if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) {
      throw new Error(`Backup checksum mismatch for '${fileName}'.`);
    }
  }

  const configStats = await fs.stat(path.join(resolvedArtifact, CONFIG_FILE));
  if (configStats.size > 1024 * 1024) throw new Error('Backup configuration exceeds 1 MiB.');
  const config = JSON.parse(await fs.readFile(path.join(resolvedArtifact, CONFIG_FILE), 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Backup configuration must be a JSON object.');
  if (containsForbiddenConfigKey(config)) throw new Error('Backup configuration contains a forbidden secret field.');
  await verifySqliteDatabase(path.join(resolvedArtifact, DATABASE_FILE));
  return manifest;
}

export async function createBackupArtifact(
  backupDirectory: string,
  config: any,
  now = Date.now()
): Promise<string> {
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error('Backup timestamp is invalid.');
  const root = path.resolve(backupDirectory);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const suffix = randomUUID().slice(0, 8);
  const timestamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const artifactName = `backup-${timestamp}-${suffix}`;
  const temporaryPath = path.join(root, `.tmp-${artifactName}`);
  const finalPath = path.join(root, artifactName);
  await fs.mkdir(temporaryPath, { mode: 0o700 });
  try {
    const databasePath = path.join(temporaryPath, DATABASE_FILE);
    const configPath = path.join(temporaryPath, CONFIG_FILE);
    await backupDatabase(databasePath);
    await fs.chmod(databasePath, 0o600);
    const safeConfig = sanitizeConfig(config || {});
    await fs.writeFile(configPath, JSON.stringify(safeConfig, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const manifest: BackupManifest = {
      version: 1,
      createdAt: new Date(now).toISOString(),
      files: {
        [DATABASE_FILE]: await sha256File(databasePath),
        [CONFIG_FILE]: await sha256File(configPath)
      }
    };
    await fs.writeFile(path.join(temporaryPath, MANIFEST_FILE), JSON.stringify(manifest, null, 2), {
      encoding: 'utf8', mode: 0o600, flag: 'wx'
    });
    await verifyBackupArtifact(temporaryPath);
    await fs.rename(temporaryPath, finalPath);
    return finalPath;
  } catch (error) {
    await fs.rm(temporaryPath, { recursive: true, force: true });
    throw error;
  }
}

export async function pruneBackupArtifacts(backupDirectory: string, retainCount: number): Promise<number> {
  if (!Number.isSafeInteger(retainCount) || retainCount < 1 || retainCount > 10_000) {
    throw new Error('Backup retention count must be between 1 and 10000.');
  }
  const root = path.resolve(backupDirectory);
  const entries = await fs.readdir(root, { withFileTypes: true });
  const artifacts = entries
    .filter(entry => entry.isDirectory() && /^backup-\d{4}-/.test(entry.name))
    .map(entry => entry.name)
    .sort()
    .reverse();
  let removed = 0;
  for (const artifact of artifacts.slice(retainCount)) {
    const target = path.resolve(root, artifact);
    if (path.dirname(target) !== root) throw new Error(`Refusing to prune path outside backup root: ${target}`);
    await fs.rm(target, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

export async function restoreBackupArtifact(
  artifactPath: string,
  targetDatabasePath: string,
  targetConfigPath: string,
  stateDirectory = path.dirname(path.resolve(targetDatabasePath))
): Promise<{ previousDatabase: string | null; previousConfig: string | null }> {
  const resolvedArtifact = path.resolve(artifactPath);
  const targetDb = path.resolve(targetDatabasePath);
  const targetConfig = path.resolve(targetConfigPath);
  for (const lockName of ['.process_active', '.routing_active']) {
    if (await fileExists(path.join(path.resolve(stateDirectory), lockName))) {
      throw new Error(`Restore refused while '${lockName}' exists. Stop the process and reconcile active work first.`);
    }
  }
  await verifyBackupArtifact(resolvedArtifact);
  await fs.mkdir(path.dirname(targetDb), { recursive: true });
  await fs.mkdir(path.dirname(targetConfig), { recursive: true });
  const restoreId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const dbTemp = `${targetDb}.restore-${restoreId}.tmp`;
  const configTemp = `${targetConfig}.restore-${restoreId}.tmp`;
  const previousDb = await fileExists(targetDb) ? `${targetDb}.pre-restore-${restoreId}` : null;
  const previousConfig = await fileExists(targetConfig) ? `${targetConfig}.pre-restore-${restoreId}` : null;
  const movedSidecars: Array<{ original: string; preserved: string }> = [];
  let installedDb = false;
  let installedConfig = false;
  try {
    await fs.copyFile(path.join(resolvedArtifact, DATABASE_FILE), dbTemp, fs.constants.COPYFILE_EXCL);
    await fs.copyFile(path.join(resolvedArtifact, CONFIG_FILE), configTemp, fs.constants.COPYFILE_EXCL);
    await verifySqliteDatabase(dbTemp);
    JSON.parse(await fs.readFile(configTemp, 'utf8'));
    if (previousDb) await fs.rename(targetDb, previousDb);
    if (previousConfig) await fs.rename(targetConfig, previousConfig);
    for (const suffix of ['-wal', '-shm']) {
      const original = `${targetDb}${suffix}`;
      if (await fileExists(original)) {
        const preserved = `${previousDb || `${targetDb}.pre-restore-${restoreId}`}${suffix}`;
        await fs.rename(original, preserved);
        movedSidecars.push({ original, preserved });
      }
    }
    await fs.rename(dbTemp, targetDb);
    installedDb = true;
    await fs.rename(configTemp, targetConfig);
    installedConfig = true;
    return { previousDatabase: previousDb, previousConfig };
  } catch (error) {
    if (installedConfig) await fs.rm(targetConfig, { force: true });
    if (installedDb) await fs.rm(targetDb, { force: true });
    if (previousConfig && await fileExists(previousConfig)) await fs.rename(previousConfig, targetConfig);
    if (previousDb && await fileExists(previousDb)) await fs.rename(previousDb, targetDb);
    for (const sidecar of movedSidecars.reverse()) {
      if (await fileExists(sidecar.preserved)) await fs.rename(sidecar.preserved, sidecar.original);
    }
    await fs.rm(dbTemp, { force: true });
    await fs.rm(configTemp, { force: true });
    throw error;
  }
}

export class BackupScheduler {
  private interval: NodeJS.Timeout | null = null;
  private activeRun: Promise<string> | null = null;
  private status: BackupStatus = { lastSuccessAt: null, lastArtifact: null, lastError: null, running: false };

  constructor(
    private readonly backupDirectory: string,
    private readonly configProvider: () => any,
    private readonly intervalMs = 15 * 60_000,
    private readonly retainCount = 672,
    private readonly logger: (message: string) => void = console.log
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000 || intervalMs > 15 * 60_000) {
      throw new Error('Backup interval must be between 1 and 15 minutes to preserve the RPO.');
    }
    if (!Number.isSafeInteger(retainCount) || retainCount < 1 || retainCount > 10_000) {
      throw new Error('Backup retention count must be between 1 and 10000.');
    }
  }

  public async start(): Promise<void> {
    if (this.interval) return;
    await this.runNow();
    this.interval = setInterval(() => {
      void this.runNow().catch(error => this.logger(`[ERROR] Scheduled backup failed: ${error.message}`));
    }, this.intervalMs);
    this.interval.unref();
  }

  public async stop(): Promise<void> {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    if (this.activeRun) await this.activeRun;
  }

  public getStatus(): BackupStatus & { healthy: boolean } {
    const status = { ...this.status };
    return {
      ...status,
      healthy: !!status.lastSuccessAt && !status.lastError && Date.now() - status.lastSuccessAt <= this.intervalMs * 2
    };
  }

  public runNow(): Promise<string> {
    if (this.activeRun) return Promise.reject(new Error('A backup is already running.'));
    this.status.running = true;
    const operation = (async () => {
      try {
        const artifact = await createBackupArtifact(this.backupDirectory, this.configProvider());
        await pruneBackupArtifacts(this.backupDirectory, this.retainCount);
        this.status = { lastSuccessAt: Date.now(), lastArtifact: artifact, lastError: null, running: false };
        this.logger(`[INFO] Verified backup created: ${artifact}`);
        return artifact;
      } catch (error: any) {
        this.status = { ...this.status, lastError: error.message, running: false };
        throw error;
      }
    })();
    this.activeRun = operation;
    void operation.finally(() => {
      if (this.activeRun === operation) this.activeRun = null;
    }).catch(() => {});
    return operation;
  }
}
