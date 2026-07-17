import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { backupDatabase } from './db.js';
import { configurationPathFromEnvironment } from './config.js';
import { validateRuntimeSettings } from './runtime_settings.js';

interface BackupReplicator {
  replicate(artifactPath: string): Promise<{
    objectName: string;
    verifiedAt: number;
  }>;
}

const DATABASE_FILE = 'forwarder.db';
const CONFIG_FILE = 'config.json';
const MANIFEST_FILE = 'manifest.json';
const RUNTIME_SETTINGS_FILE = 'runtime-settings.json';
const TEMPLATES_DIRECTORY = 'templates';
const CORE_BACKUP_FILES = [DATABASE_FILE, CONFIG_FILE] as const;
const MAX_BACKUP_STATE_FILES = 256;
const MAX_BACKUP_STATE_FILE_BYTES = 5 * 1024 * 1024;
const MAX_BACKUP_STATE_BYTES = 20 * 1024 * 1024;
const REQUIRED_TABLES = ['signals', 'pending_tasks', 'media_group_buffer', 'forwarding_stats', 'incoming_messages', 'ai_usage_daily'];
const FORBIDDEN_CONFIG_KEYS = new Set([
  'APIHASH',
  'OPENROUTERAPIKEY',
  'TELEGRAMAPIHASH',
  'DASHBOARDADMINTOKEN',
  'DASHBOARDVIEWERTOKEN',
  'BACKUPOFFSITETOKEN',
  'BACKUPENCRYPTIONKEY',
  'ALERTRELAYTOKEN',
  'ALERTWEBHOOKTOKEN',
  'PROMETHEUSTOKEN',
  'AUDITWEBHOOKTOKEN',
  'PASSWORD',
  'SECRET'
]);

interface BackupFileMetadata {
  sha256: string;
  size: number;
}

export interface BackupManifest {
  version: 1 | 2;
  createdAt: string;
  files: Record<string, BackupFileMetadata>;
  recovery?: {
    schemaVersion: 1;
    includedState: string[];
    excludedState: string[];
  };
}

export interface BackupStatus {
  lastSuccessAt: number | null;
  lastArtifact: string | null;
  lastError: string | null;
  running: boolean;
  lastOffsiteSuccessAt: number | null;
  lastOffsiteObject: string | null;
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

export function isSupportedBackupArtifactFileName(fileName: string): boolean {
  if (CORE_BACKUP_FILES.includes(fileName as typeof DATABASE_FILE | typeof CONFIG_FILE)) return true;
  if (fileName === RUNTIME_SETTINGS_FILE) return true;
  if (!fileName.startsWith(`${TEMPLATES_DIRECTORY}/`)) return false;
  const relative = fileName.slice(TEMPLATES_DIRECTORY.length + 1);
  return relative.length > 0 && relative.length <= 240 && relative.split('/').every(isSafeTemplatePathSegment);
}

function isSafeTemplatePathSegment(segment: string): boolean {
  return segment.length > 0
    && segment.length <= 128
    && segment !== '.'
    && segment !== '..'
    && segment === segment.trim()
    && !/[\\/\0<>:"|?*\x00-\x1f]/.test(segment);
}

function artifactPath(artifactRoot: string, fileName: string): string {
  if (!isSupportedBackupArtifactFileName(fileName)) throw new Error(`Backup contains an unsupported file name '${fileName}'.`);
  const destination = path.resolve(artifactRoot, fileName);
  if (destination !== artifactRoot && !destination.startsWith(`${artifactRoot}${path.sep}`)) {
    throw new Error(`Backup file path escapes artifact: ${fileName}`);
  }
  return destination;
}

function artifactDirectory(artifactRoot: string, directoryName: string): string {
  if (directoryName !== TEMPLATES_DIRECTORY) throw new Error(`Backup contains an unsupported directory '${directoryName}'.`);
  const destination = path.resolve(artifactRoot, directoryName);
  if (!destination.startsWith(`${artifactRoot}${path.sep}`)) throw new Error(`Backup directory path escapes artifact: ${directoryName}`);
  return destination;
}

async function assertRegularFile(filePath: string, description: string): Promise<void> {
  const entry = await fs.lstat(filePath);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`${description} must be a regular file, not a symbolic link.`);
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

async function readBackupManifest(artifactPath: string): Promise<BackupManifest> {
  const manifestPath = path.join(artifactPath, MANIFEST_FILE);
  const stats = await fs.stat(manifestPath);
  if (stats.size > 64 * 1024) throw new Error('Backup manifest exceeds 64 KiB.');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as BackupManifest;
  if ((manifest.version !== 1 && manifest.version !== 2) || !manifest.createdAt || !manifest.files || typeof manifest.files !== 'object') {
    throw new Error('Unsupported or malformed backup manifest.');
  }
  if (Number.isNaN(Date.parse(manifest.createdAt))) {
    throw new Error('Backup manifest has an invalid creation timestamp.');
  }
  return manifest;
}

async function verifyManifestFile(
  artifactRoot: string,
  manifest: BackupManifest,
  fileName: string
): Promise<void> {
  const expected = manifest.files[fileName];
  if (
    !expected ||
    !/^[a-f0-9]{64}$/.test(expected.sha256) ||
    !Number.isSafeInteger(expected.size) ||
    expected.size < 1
  ) {
    throw new Error(`Backup manifest metadata for '${fileName}' is invalid.`);
  }
  const target = artifactPath(artifactRoot, fileName);
  await assertRegularFile(target, `Backup file '${fileName}'`);
  const actual = await sha256File(target);
  if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) {
    throw new Error(`Backup checksum mismatch for '${fileName}'.`);
  }
}

async function verifyBackupConfig(artifactPath: string): Promise<void> {
  const configPath = path.join(artifactPath, CONFIG_FILE);
  const stats = await fs.stat(configPath);
  if (stats.size > 1024 * 1024) throw new Error('Backup configuration exceeds 1 MiB.');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Backup configuration must be a JSON object.');
  }
  if (containsForbiddenConfigKey(config)) {
    throw new Error('Backup configuration contains a forbidden secret field.');
  }
}

export async function verifyBackupArtifact(artifactPath: string): Promise<BackupManifest> {
  const resolvedArtifact = path.resolve(artifactPath);
  const artifactStats = await fs.stat(resolvedArtifact);
  if (!artifactStats.isDirectory()) throw new Error('Backup artifact must be a directory.');
  const manifest = await readBackupManifest(resolvedArtifact);
  const fileNames = Object.keys(manifest.files);
  if (fileNames.length < CORE_BACKUP_FILES.length || fileNames.length > MAX_BACKUP_STATE_FILES + CORE_BACKUP_FILES.length + 1) {
    throw new Error('Backup manifest contains an invalid number of files.');
  }
  for (const required of CORE_BACKUP_FILES) {
    if (!fileNames.includes(required)) throw new Error(`Backup is missing required file '${required}'.`);
  }
  for (const fileName of fileNames) {
    await verifyManifestFile(resolvedArtifact, manifest, fileName);
  }
  await verifyBackupConfig(resolvedArtifact);
  await verifySqliteDatabase(path.join(resolvedArtifact, DATABASE_FILE));
  return manifest;
}

/** Returns verified, path-safe artifact members for encryption or recovery tooling. */
export async function listBackupArtifactFiles(artifactPath: string): Promise<string[]> {
  const manifest = await verifyBackupArtifact(artifactPath);
  return Object.keys(manifest.files).sort();
}

function recoveryStateSources(): { runtimeSettings: string; templates: string } {
  const configPath = configurationPathFromEnvironment();
  return {
    runtimeSettings: path.resolve(process.env.RUNTIME_SETTINGS_PATH || path.join(path.dirname(configPath), RUNTIME_SETTINGS_FILE)),
    templates: defaultTemplatesDirectory(configPath)
  };
}

function defaultTemplatesDirectory(configPath: string): string {
  if (process.env.TEMPLATES_DIR) return path.resolve(process.env.TEMPLATES_DIR);
  const configDirectory = path.dirname(path.resolve(configPath));
  const appDirectory = path.basename(configDirectory) === 'config' ? path.dirname(configDirectory) : configDirectory;
  return path.join(appDirectory, TEMPLATES_DIRECTORY);
}

async function copyOptionalRuntimeSettings(source: string, artifactRoot: string, included: string[]): Promise<void> {
  const exists = await fileExists(source);
  if (!exists) return;
  await assertRegularFile(source, 'Runtime settings source');
  const stats = await fs.stat(source);
  if (stats.size > MAX_BACKUP_STATE_FILE_BYTES) throw new Error('Runtime settings exceed the backup state file limit.');
  const content = JSON.parse(await fs.readFile(source, 'utf8'));
  validateRuntimeSettings(content);
  await fs.copyFile(source, artifactPath(artifactRoot, RUNTIME_SETTINGS_FILE), fs.constants.COPYFILE_EXCL);
  await fs.chmod(artifactPath(artifactRoot, RUNTIME_SETTINGS_FILE), 0o600);
  included.push(RUNTIME_SETTINGS_FILE);
}

async function copyOptionalTemplates(source: string, artifactRoot: string, included: string[]): Promise<void> {
  const exists = await fileExists(source);
  if (!exists) return;
  const root = path.resolve(source);
  const rootEntry = await fs.lstat(root);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) throw new Error('Templates source must be a real directory, not a symbolic link.');
  let totalBytes = 0;
  const visit = async (directory: string, relative = ''): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativeName = relative ? `${relative}/${entry.name}` : entry.name;
      const sourcePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Template source contains a symbolic link: ${relativeName}`);
      if (entry.isDirectory()) {
        await visit(sourcePath, relativeName);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Template source contains a non-regular file: ${relativeName}`);
      const destinationName = `${TEMPLATES_DIRECTORY}/${relativeName.replace(/\\/g, '/')}`;
      if (!isSupportedBackupArtifactFileName(destinationName)) throw new Error(`Template path is unsupported: ${relativeName}`);
      const stats = await fs.stat(sourcePath);
      if (stats.size > MAX_BACKUP_STATE_FILE_BYTES) throw new Error(`Template exceeds the backup state file limit: ${relativeName}`);
      totalBytes += stats.size;
      if (totalBytes > MAX_BACKUP_STATE_BYTES) throw new Error('Templates exceed the total backup state size limit.');
      if (included.length >= MAX_BACKUP_STATE_FILES) throw new Error('Templates exceed the backup state file count limit.');
      const destination = artifactPath(artifactRoot, destinationName);
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fs.copyFile(sourcePath, destination, fs.constants.COPYFILE_EXCL);
      await fs.chmod(destination, 0o600);
      included.push(destinationName);
    }
  };
  await visit(root);
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
    const includedState: string[] = [];
    const stateSources = recoveryStateSources();
    await copyOptionalRuntimeSettings(stateSources.runtimeSettings, temporaryPath, includedState);
    await copyOptionalTemplates(stateSources.templates, temporaryPath, includedState);
    const files: Record<string, BackupFileMetadata> = {};
    for (const fileName of [...CORE_BACKUP_FILES, ...includedState]) {
      files[fileName] = await sha256File(artifactPath(temporaryPath, fileName));
    }
    const manifest: BackupManifest = {
      version: 2,
      createdAt: new Date(now).toISOString(),
      files,
      recovery: {
        schemaVersion: 1,
        includedState,
        // Secrets and TDLib session data intentionally remain outside any backup artifact.
        // They are identity material, not portable application state, and must be re-provisioned.
        excludedState: ['managed-secrets', 'tdlib-session-data', 'tdlib-session-files']
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

interface RestorePlan {
  artifact: string;
  targetDb: string;
  targetConfig: string;
  dbTemp: string;
  configTemp: string;
  previousDb: string | null;
  previousConfig: string | null;
  restoreId: string;
  runtimeSettings: RestoreFilePlan | null;
  templates: RestoreDirectoryPlan | null;
}

interface RestoreFilePlan {
  source: string;
  target: string;
  temporary: string;
  previous: string | null;
}

interface RestoreDirectoryPlan {
  source: string;
  target: string;
  temporary: string;
  previous: string | null;
}

export interface BackupRestoreOptions {
  runtimeSettingsPath?: string;
  templatesDirectory?: string;
  /** Only the currently running, exclusively locked control plane may bypass its own process marker. */
  allowCurrentProcessLock?: boolean;
}

interface RestoreProgress {
  installedDb: boolean;
  installedConfig: boolean;
  movedSidecars: Array<{ original: string; preserved: string }>;
  installedRuntimeSettings: boolean;
  installedTemplates: boolean;
}

async function assertRestoreInactive(stateDirectory: string, allowCurrentProcessLock = false): Promise<void> {
  for (const lockName of ['.process_active', '.routing_active']) {
    if (lockName === '.process_active' && allowCurrentProcessLock) continue;
    if (await fileExists(path.join(path.resolve(stateDirectory), lockName))) {
      throw new Error(
        `Restore refused while '${lockName}' exists. Stop the process and reconcile active work first.`
      );
    }
  }
}

async function createRestorePlan(
  sourceArtifactPath: string,
  targetDatabasePath: string,
  targetConfigPath: string,
  manifest: BackupManifest,
  options: BackupRestoreOptions
): Promise<RestorePlan> {
  const artifact = path.resolve(sourceArtifactPath);
  const targetDb = path.resolve(targetDatabasePath);
  const targetConfig = path.resolve(targetConfigPath);
  const restoreId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const runtimeTarget = path.resolve(options.runtimeSettingsPath || process.env.RUNTIME_SETTINGS_PATH || path.join(path.dirname(targetConfig), RUNTIME_SETTINGS_FILE));
  const templatesTarget = path.resolve(options.templatesDirectory || defaultTemplatesDirectory(targetConfig));
  if ([targetDb, targetConfig].includes(runtimeTarget) || [targetDb, targetConfig].includes(templatesTarget)) {
    throw new Error('Recovery state targets must not overlap database or configuration targets.');
  }
  const hasRuntimeSettings = Object.prototype.hasOwnProperty.call(manifest.files, RUNTIME_SETTINGS_FILE);
  const hasTemplates = Object.keys(manifest.files).some(fileName => fileName.startsWith(`${TEMPLATES_DIRECTORY}/`));
  return {
    artifact,
    targetDb,
    targetConfig,
    restoreId,
    dbTemp: `${targetDb}.restore-${restoreId}.tmp`,
    configTemp: `${targetConfig}.restore-${restoreId}.tmp`,
    previousDb: (await fileExists(targetDb)) ? `${targetDb}.pre-restore-${restoreId}` : null,
    previousConfig: (await fileExists(targetConfig))
      ? `${targetConfig}.pre-restore-${restoreId}`
      : null,
    runtimeSettings: hasRuntimeSettings
      ? {
        source: artifactPath(artifact, RUNTIME_SETTINGS_FILE),
        target: runtimeTarget,
        temporary: `${runtimeTarget}.restore-${restoreId}.tmp`,
        previous: (await fileExists(runtimeTarget)) ? `${runtimeTarget}.pre-restore-${restoreId}` : null
      }
      : null,
    templates: hasTemplates
      ? {
        source: artifactDirectory(artifact, TEMPLATES_DIRECTORY),
        target: templatesTarget,
        temporary: `${templatesTarget}.restore-${restoreId}.tmp`,
        previous: (await fileExists(templatesTarget)) ? `${templatesTarget}.pre-restore-${restoreId}` : null
      }
      : null
  };
}

async function stageRestore(plan: RestorePlan): Promise<void> {
  await fs.copyFile(path.join(plan.artifact, DATABASE_FILE), plan.dbTemp, fs.constants.COPYFILE_EXCL);
  await fs.copyFile(path.join(plan.artifact, CONFIG_FILE), plan.configTemp, fs.constants.COPYFILE_EXCL);
  await verifySqliteDatabase(plan.dbTemp);
  JSON.parse(await fs.readFile(plan.configTemp, 'utf8'));
  if (plan.runtimeSettings) {
    await fs.mkdir(path.dirname(plan.runtimeSettings.target), { recursive: true, mode: 0o700 });
    await fs.copyFile(plan.runtimeSettings.source, plan.runtimeSettings.temporary, fs.constants.COPYFILE_EXCL);
    const settings = JSON.parse(await fs.readFile(plan.runtimeSettings.temporary, 'utf8'));
    validateRuntimeSettings(settings);
  }
  if (plan.templates) {
    await fs.mkdir(path.dirname(plan.templates.target), { recursive: true, mode: 0o700 });
    await fs.cp(plan.templates.source, plan.templates.temporary, { recursive: true, force: false, errorOnExist: true, dereference: false });
  }
}

async function preserveCurrentFiles(plan: RestorePlan, progress: RestoreProgress): Promise<void> {
  if (plan.previousDb) await fs.rename(plan.targetDb, plan.previousDb);
  if (plan.previousConfig) await fs.rename(plan.targetConfig, plan.previousConfig);
  if (plan.runtimeSettings?.previous) {
    await assertRegularFile(plan.runtimeSettings.target, 'Existing runtime settings');
    await fs.rename(plan.runtimeSettings.target, plan.runtimeSettings.previous);
  }
  if (plan.templates?.previous) {
    const existingTemplates = await fs.lstat(plan.templates.target);
    if (!existingTemplates.isDirectory() || existingTemplates.isSymbolicLink()) {
      throw new Error('Existing templates target must be a real directory, not a symbolic link.');
    }
    await fs.rename(plan.templates.target, plan.templates.previous);
  }
  for (const suffix of ['-wal', '-shm']) {
    const original = `${plan.targetDb}${suffix}`;
    if (await fileExists(original)) {
      const preserved = `${plan.previousDb || `${plan.targetDb}.pre-restore-${plan.restoreId}`}${suffix}`;
      await fs.rename(original, preserved);
      progress.movedSidecars.push({ original, preserved });
    }
  }
}

async function installRestore(plan: RestorePlan, progress: RestoreProgress): Promise<void> {
  await fs.rename(plan.dbTemp, plan.targetDb);
  progress.installedDb = true;
  await fs.rename(plan.configTemp, plan.targetConfig);
  progress.installedConfig = true;
  if (plan.runtimeSettings) {
    await fs.rename(plan.runtimeSettings.temporary, plan.runtimeSettings.target);
    progress.installedRuntimeSettings = true;
  }
  if (plan.templates) {
    await fs.rename(plan.templates.temporary, plan.templates.target);
    progress.installedTemplates = true;
  }
}

function newRestoreProgress(): RestoreProgress {
  return {
    installedDb: false,
    installedConfig: false,
    movedSidecars: [],
    installedRuntimeSettings: false,
    installedTemplates: false,
  };
}

function restoreResult(plan: RestorePlan): {
  previousDatabase: string | null;
  previousConfig: string | null;
  previousRuntimeSettings: string | null;
  previousTemplates: string | null;
} {
  return {
    previousDatabase: plan.previousDb,
    previousConfig: plan.previousConfig,
    previousRuntimeSettings: plan.runtimeSettings?.previous || null,
    previousTemplates: plan.templates?.previous || null,
  };
}

async function removeInstalledRestoreFiles(plan: RestorePlan, progress: RestoreProgress): Promise<void> {
  if (progress.installedTemplates && plan.templates) await fs.rm(plan.templates.target, { recursive: true, force: true });
  if (progress.installedRuntimeSettings && plan.runtimeSettings) await fs.rm(plan.runtimeSettings.target, { force: true });
  if (progress.installedConfig) await fs.rm(plan.targetConfig, { force: true });
  if (progress.installedDb) await fs.rm(plan.targetDb, { force: true });
}

async function restorePreservedFiles(plan: RestorePlan, progress: RestoreProgress): Promise<void> {
  if (plan.previousConfig && (await fileExists(plan.previousConfig))) await fs.rename(plan.previousConfig, plan.targetConfig);
  if (plan.previousDb && (await fileExists(plan.previousDb))) await fs.rename(plan.previousDb, plan.targetDb);
  if (plan.runtimeSettings?.previous && (await fileExists(plan.runtimeSettings.previous))) {
    await fs.rename(plan.runtimeSettings.previous, plan.runtimeSettings.target);
  }
  if (plan.templates?.previous && (await fileExists(plan.templates.previous))) {
    await fs.rename(plan.templates.previous, plan.templates.target);
  }
  for (const sidecar of progress.movedSidecars.reverse()) {
    if (await fileExists(sidecar.preserved)) await fs.rename(sidecar.preserved, sidecar.original);
  }
}

async function removeRestoreTemporaryFiles(plan: RestorePlan): Promise<void> {
  await fs.rm(plan.dbTemp, { force: true });
  await fs.rm(plan.configTemp, { force: true });
  if (plan.runtimeSettings) await fs.rm(plan.runtimeSettings.temporary, { force: true });
  if (plan.templates) await fs.rm(plan.templates.temporary, { recursive: true, force: true });
}

async function rollbackRestore(plan: RestorePlan, progress: RestoreProgress): Promise<void> {
  await removeInstalledRestoreFiles(plan, progress);
  await restorePreservedFiles(plan, progress);
  await removeRestoreTemporaryFiles(plan);
}

export async function restoreBackupArtifact(
  artifactPath: string,
  targetDatabasePath: string,
  targetConfigPath: string,
  stateDirectory = path.dirname(path.resolve(targetDatabasePath)),
  options: BackupRestoreOptions = {}
): Promise<{ previousDatabase: string | null; previousConfig: string | null; previousRuntimeSettings: string | null; previousTemplates: string | null }> {
  await assertRestoreInactive(stateDirectory, options.allowCurrentProcessLock === true);
  const artifact = path.resolve(artifactPath);
  const manifest = await verifyBackupArtifact(artifact);
  const plan = await createRestorePlan(artifact, targetDatabasePath, targetConfigPath, manifest, options);
  await fs.mkdir(path.dirname(plan.targetDb), { recursive: true });
  await fs.mkdir(path.dirname(plan.targetConfig), { recursive: true });
  const progress = newRestoreProgress();
  try {
    await stageRestore(plan);
    await preserveCurrentFiles(plan, progress);
    await installRestore(plan, progress);
    return restoreResult(plan);
  } catch (error) {
    await rollbackRestore(plan, progress);
    throw error;
  }
}

export class BackupScheduler {
  private interval: NodeJS.Timeout | null = null;
  private activeRun: Promise<string> | null = null;
  private status: BackupStatus = {
    lastSuccessAt: null,
    lastArtifact: null,
    lastError: null,
    running: false,
    lastOffsiteSuccessAt: null,
    lastOffsiteObject: null
  };

  constructor(
    private readonly backupDirectory: string,
    private readonly configProvider: () => any,
    private readonly intervalMs = 15 * 60_000,
    private readonly retainCount = 672,
    private readonly logger: (message: string) => void = console.log,
    private readonly replicator: BackupReplicator | null = null,
    private readonly offsiteRequired = false
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000 || intervalMs > 15 * 60_000) {
      throw new Error('Backup interval must be between 1 and 15 minutes to preserve the RPO.');
    }
    if (!Number.isSafeInteger(retainCount) || retainCount < 1 || retainCount > 10_000) {
      throw new Error('Backup retention count must be between 1 and 10000.');
    }
    if (offsiteRequired && !replicator) throw new Error('Required off-site backup replication is not configured.');
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

  public getStatus(): BackupStatus & { healthy: boolean; offsiteHealthy: boolean; offsiteRequired: boolean } {
    const status = { ...this.status };
    const offsiteHealthy = !this.replicator && !this.offsiteRequired
      ? true
      : !!status.lastOffsiteSuccessAt && !status.lastError && Date.now() - status.lastOffsiteSuccessAt <= this.intervalMs * 2;
    return {
      ...status,
      healthy: !!status.lastSuccessAt && !status.lastError && Date.now() - status.lastSuccessAt <= this.intervalMs * 2 && offsiteHealthy,
      offsiteHealthy,
      offsiteRequired: this.offsiteRequired
    };
  }

  public runNow(): Promise<string> {
    if (this.activeRun) return Promise.reject(new Error('A backup is already running.'));
    this.status.running = true;
    const operation = (async () => {
      try {
        const artifact = await createBackupArtifact(this.backupDirectory, this.configProvider());
        const replication = this.replicator ? await this.replicator.replicate(artifact) : null;
        await pruneBackupArtifacts(this.backupDirectory, this.retainCount);
        this.status = {
          lastSuccessAt: Date.now(),
          lastArtifact: artifact,
          lastError: null,
          running: false,
          lastOffsiteSuccessAt: replication?.verifiedAt ?? this.status.lastOffsiteSuccessAt,
          lastOffsiteObject: replication?.objectName ?? this.status.lastOffsiteObject
        };
        this.logger(`[INFO] Verified backup created: ${artifact}`);
        if (replication) this.logger(`[INFO] Encrypted off-site backup verified: ${replication.objectName}`);
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
