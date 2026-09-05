import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import {
  backupDatabase,
  getDatabase,
  DATABASE_FEATURE_SET,
  expectedDatabaseMigrations,
  LATEST_SCHEMA_VERSION,
  REQUIRED_DATABASE_TABLES,
  type DatabaseMigrationDescriptor,
} from './db.js';
import { configurationPathFromEnvironment } from './config.js';
import { signalTemplatesDirectoryFromEnvironment } from './configuration_paths.js';
import { managedRuntimeSettingsPathFromEnvironment, validateRuntimeSettings } from './runtime_settings.js';
import {
  backupConfigurationDigest,
  withPinnedConfigurationGeneration,
  validateConfigurationGenerationEvidence,
  type ConfigurationGenerationEvidence,
  type ConfigurationSources,
  type PinnedConfigurationGeneration,
} from './backup_generation.js';
import { constantTimeStringEqual } from './secure_compare.js';
import { assertMcpMaintenanceLease, type McpMaintenanceLease } from './mcp_maintenance.js';
import {
  assessRestoreEligibility, boundedBackupManifestBytes, requireRestoreEligibility, validateBackupCreationEvidence,
  type BackupCreationEvidence, type BackupVerificationEvidence, type RestoreEligibility,
  type BackupProof, type BackupOffsiteProof, type BackupRestoreDrillProof,
} from './backup_evidence.js';
import { runIsolatedBackupRestoreDrill } from './backup_restore_drill.js';

interface BackupReplicator {
  replicate(artifactPath: string): Promise<{
    objectName: string;
    verifiedAt: number;
    artifactSha256: string;
    artifactCreatedAt: string;
    sha256: string;
  }>;
}

const DATABASE_FILE = 'forwarder.db';
const CONFIG_FILE = 'config.json';
const MANIFEST_FILE = 'manifest.json';
const RUNTIME_SETTINGS_FILE = 'runtime-settings.json';
const TEMPLATES_DIRECTORY = 'templates';
const CORE_BACKUP_FILES = [DATABASE_FILE, CONFIG_FILE] as const;
const MAX_BACKUP_STATE_FILES = 256;
const BACKUP_APPLICATION_ID = 'tsx-core';
const SUPPORTED_BACKUP_APPLICATION_IDS = new Set<string>([
  BACKUP_APPLICATION_ID,
  'telegram-tdlib-forwarder',
]);
const BACKUP_APPLICATION_RELEASE = '2.0.0';
const BACKUP_DATA_MODEL = 'integrated-trading';
const FORBIDDEN_CONFIG_KEYS = new Set([
  'APIHASH',
  'OPENROUTERAPIKEY',
  'TELEGRAMAPIHASH',
  'DASHBOARDADMINTOKEN',
  'DASHBOARDVIEWERTOKEN',
  'DASHBOARDBOOTSTRAPPROOF',
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

/** v2 omits the duplicate file map; its digest binds manifest.files minus the DB. */
interface CompactConfigurationEvidence extends Omit<ConfigurationGenerationEvidence, 'version' | 'files'> {
  version: 2;
}

export interface BackupManifest {
  version: 2;
  createdAt: string;
  files: Record<string, BackupFileMetadata>;
  configuration?: ConfigurationGenerationEvidence | CompactConfigurationEvidence;
  evidence?: BackupCreationEvidence;
  compatibility: {
    application: {
      id: typeof BACKUP_APPLICATION_ID;
      releaseVersion: string;
      dataModel: typeof BACKUP_DATA_MODEL;
    };
    database: {
      schemaVersion: number;
      migrations: DatabaseMigrationDescriptor[];
    };
    features: string[];
  };
  recovery?: {
    schemaVersion: 1;
    includedState: string[];
    excludedState: string[];
  };
}

export interface BackupStatus {
  /** Compatibility alias: local snapshot integrity time, not restore eligibility or a drill. */
  lastSuccessAt: number | null;
  lastArtifact: string | null;
  lastError: string | null;
  running: boolean;
  lastOffsiteSuccessAt: number | null;
  lastOffsiteObject: string | null;
  integrityVerified: BackupProof | null;
  configurationCoherent: BackupProof | null;
  offsiteVerified: BackupOffsiteProof | null;
  restoreEligibility: (RestoreEligibility & { artifactSha256: string }) | null;
  lastRestoreEligible: BackupProof | null;
  restoreDrill: BackupRestoreDrillProof | null;
}

function normalizedConfigKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

function containsForbiddenConfigKey(value: any): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenConfigKey);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, nested]) =>
    FORBIDDEN_CONFIG_KEYS.has(normalizedConfigKey(key)) || containsForbiddenConfigKey(nested)
  );
}

async function sha256File(filePath: string): Promise<BackupFileMetadata> {
  await assertRegularFile(filePath, 'Backup checksum input');
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
    && !/[\\/<>:"|?*\x00-\x1f]/.test(segment);
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

function expectedCompatibility(): BackupManifest['compatibility'] {
  return {
    application: {
      id: BACKUP_APPLICATION_ID,
      releaseVersion: BACKUP_APPLICATION_RELEASE,
      dataModel: BACKUP_DATA_MODEL,
    },
    database: {
      schemaVersion: LATEST_SCHEMA_VERSION,
      migrations: expectedDatabaseMigrations(),
    },
    features: [...DATABASE_FEATURE_SET],
  };
}

function assertBackupApplicationCompatibility(
  compatibility: BackupManifest['compatibility'],
  expected: BackupManifest['compatibility'],
): void {
  if (
    !compatibility
    || !SUPPORTED_BACKUP_APPLICATION_IDS.has(compatibility.application?.id || '')
    || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(compatibility.application?.releaseVersion || '')
    || compatibility.application?.dataModel !== expected.application.dataModel
  ) {
    throw new Error('Backup belongs to an unsupported application or data model.');
  }
}

function assertBackupDatabaseCompatibility(
  compatibility: BackupManifest['compatibility'],
  expected: BackupManifest['compatibility'],
): void {
  if (compatibility.database?.schemaVersion !== expected.database.schemaVersion) {
    throw new Error(
      `Backup schema version ${compatibility.database?.schemaVersion ?? 'missing'} is incompatible; expected ${expected.database.schemaVersion}.`
    );
  }
  if (JSON.stringify(compatibility.database.migrations) !== JSON.stringify(expected.database.migrations)) {
    throw new Error('Backup migration history does not match this application binary.');
  }
}

function assertBackupFeatureCompatibility(
  compatibility: BackupManifest['compatibility'],
  expected: BackupManifest['compatibility'],
): void {
  const actualFeatures = [...(compatibility.features || [])].sort((left, right) => left.localeCompare(right));
  const requiredFeatures = [...expected.features].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(actualFeatures) !== JSON.stringify(requiredFeatures)) {
    throw new Error(`Backup feature set is incompatible; required features: ${requiredFeatures.join(', ')}.`);
  }
}

function assertManifestCompatibility(manifest: BackupManifest): void {
  const compatibility = manifest.compatibility;
  const expected = expectedCompatibility();
  assertBackupApplicationCompatibility(compatibility, expected);
  assertBackupDatabaseCompatibility(compatibility, expected);
  assertBackupFeatureCompatibility(compatibility, expected);
}

async function verifyCoreDatabaseSchema(database: Database): Promise<void> {
  const integrity = await database.get<{ integrity_check: string }>('PRAGMA integrity_check;');
  if (integrity?.integrity_check !== 'ok') {
    throw new Error(`SQLite integrity_check failed: ${integrity?.integrity_check || 'no result'}`);
  }
  const rows = await database.all<Array<{ name: string }>>(`SELECT name FROM sqlite_master WHERE type = 'table'`);
  const tables = new Set(rows.map(row => row.name));
  const missing = REQUIRED_DATABASE_TABLES.filter(table => !tables.has(table));
  if (missing.length > 0) throw new Error(`Backup is missing required tables: ${missing.join(', ')}`);
  const foreignKeyFailures = await database.all<Array<Record<string, unknown>>>('PRAGMA foreign_key_check;');
  if (foreignKeyFailures.length > 0) throw new Error(`Backup contains ${foreignKeyFailures.length} foreign-key violation(s).`);
  const appliedMigrations = await database.all<DatabaseMigrationDescriptor[]>(
    'SELECT version, name, checksum FROM schema_migrations ORDER BY version'
  );
  if (JSON.stringify(appliedMigrations) !== JSON.stringify(expectedDatabaseMigrations())) {
    throw new Error('Backup database migration history does not match this application binary.');
  }
}

async function verifyTradingDatabaseSchema(database: Database): Promise<void> {
  const tradingAccountColumns = await database.all<Array<{ name: string }>>('PRAGMA table_info(trading_accounts);');
  if (!tradingAccountColumns.some(column => column.name === 'external_account_id')) {
    throw new Error('Backup trading account schema is missing external account identity binding.');
  }
  const runtimeState = await database.get<{ count: number; minimum: number; maximum: number }>(
    `SELECT COUNT(*) AS count, MIN(singleton_id) AS minimum, MAX(singleton_id) AS maximum FROM trading_runtime_state`
  );
  if (Number(runtimeState?.count) !== 1 || Number(runtimeState?.minimum) !== 1 || Number(runtimeState?.maximum) !== 1) {
    throw new Error('Backup trading runtime singleton is missing or malformed.');
  }
  const immutableTrigger = await database.get<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_trading_strategy_immutable'`
  );
  if (!immutableTrigger) throw new Error('Backup is missing the published-strategy immutability trigger.');
  const identityIndex = await database.get<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'uq_trading_external_account_identity'`
  );
  if (!identityIndex) throw new Error('Backup is missing the external account identity uniqueness constraint.');
}

async function verifyStrategyConfigurationHashes(database: Database): Promise<void> {
  const strategies = await database.all<Array<{ id: string; configuration_json: string; configuration_sha256: string }>>(
    'SELECT id, configuration_json, configuration_sha256 FROM trading_strategy_versions'
  );
  for (const strategy of strategies) {
    let normalized: string;
    try {
      normalized = JSON.stringify(JSON.parse(strategy.configuration_json));
    } catch (error) {
      throw new Error(`Backup strategy ${strategy.id} contains invalid configuration JSON.`, { cause: error });
    }
    const hash = createHash('sha256').update(normalized).digest('hex');
    if (!constantTimeStringEqual(hash, strategy.configuration_sha256)) {
      throw new Error(`Backup strategy ${strategy.id} failed its configuration integrity check.`);
    }
  }
}

export async function verifySqliteDatabase(databasePath: string): Promise<void> {
  const database = await open({
    filename: path.resolve(databasePath),
    driver: sqlite3.Database,
    mode: sqlite3.OPEN_READONLY
  });
  try {
    await verifyCoreDatabaseSchema(database);
    await verifyTradingDatabaseSchema(database);
    await verifyStrategyConfigurationHashes(database);
  } finally {
    await database.close();
  }
}

async function readBackupManifest(artifactPath: string): Promise<BackupManifest> {
  const manifestPath = path.join(artifactPath, MANIFEST_FILE);
  const manifest = JSON.parse((await boundedBackupManifestBytes(manifestPath)).toString('utf8')) as BackupManifest;
  if (manifest.version !== 2 || !manifest.createdAt || !manifest.files || typeof manifest.files !== 'object') {
    throw new Error('Unsupported or malformed backup manifest.');
  }
  if (Number.isNaN(Date.parse(manifest.createdAt))) {
    throw new TypeError('Backup manifest has an invalid creation timestamp.');
  }
  assertManifestCompatibility(manifest);
  if (manifest.evidence) validateBackupCreationEvidence(manifest.evidence);
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
  await assertArtifactParents(artifactRoot, target);
  await assertRegularFile(target, `Backup file '${fileName}'`);
  const actual = await sha256File(target);
  if (!constantTimeStringEqual(actual.sha256, expected.sha256) || actual.size !== expected.size) {
    throw new Error(`Backup checksum mismatch for '${fileName}'.`);
  }
}

async function assertArtifactParents(root: string, target: string): Promise<void> {
  let directory = path.dirname(target);
  while (directory !== root) {
    const entry = await fs.lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Backup file has a non-directory or symbolic-link parent.');
    directory = path.dirname(directory);
  }
}

function verifyConfigurationEvidence(manifest: BackupManifest): void {
  if (!manifest.configuration) return;
  const files = Object.fromEntries(Object.entries(manifest.files).filter(([name]) => name !== DATABASE_FILE));
  const compact = manifest.configuration;
  if (compact.version === 2) {
    if (Object.keys(compact).length !== 5) throw new Error('Compact configuration generation evidence is malformed.');
    validateConfigurationGenerationEvidence({ ...compact, version: 1, files }, files);
  } else validateConfigurationGenerationEvidence(compact, files);
}

async function verifyBackupConfig(artifactPath: string): Promise<void> {
  const configPath = path.join(artifactPath, CONFIG_FILE);
  await assertRegularFile(configPath, 'Backup configuration');
  const stats = await fs.lstat(configPath);
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
  const artifactStats = await fs.lstat(resolvedArtifact);
  if (!artifactStats.isDirectory() || artifactStats.isSymbolicLink()) {
    throw new Error('Backup artifact must be a directory and must not be a symbolic link.');
  }
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
  verifyConfigurationEvidence(manifest);
  await verifyBackupConfig(resolvedArtifact);
  await verifySqliteDatabase(path.join(resolvedArtifact, DATABASE_FILE));
  return manifest;
}

async function artifactRestoreEligibility(databasePath: string): Promise<RestoreEligibility> {
  const database = await open({ filename: databasePath, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
  try { return await assessRestoreEligibility(database); }
  finally { await database.close(); }
}

/** Fresh local checks; embedded creation claims never authorize restore or create later receipts. */
export async function inspectBackupArtifact(artifactPath: string): Promise<BackupVerificationEvidence> {
  const root = path.resolve(artifactPath);
  const before = createHash('sha256').update(await boundedBackupManifestBytes(path.join(root, MANIFEST_FILE))).digest('hex');
  const manifest = await verifyBackupArtifact(root);
  const eligibility = await artifactRestoreEligibility(path.join(root, DATABASE_FILE));
  const after = createHash('sha256').update(await boundedBackupManifestBytes(path.join(root, MANIFEST_FILE))).digest('hex');
  if (before !== after) throw new Error('Backup manifest changed during evidence verification.');
  const proof = { verifiedAt: Date.now(), artifactSha256: before, artifactCreatedAt: manifest.createdAt };
  return {
    artifactSha256: before,
    artifactCreatedAt: manifest.createdAt,
    integrityVerified: proof,
    configurationCoherent: manifest.configuration ? { ...proof } : null,
    configurationCoherenceReason: manifest.configuration ? null : 'Legacy artifact has no committed configuration generation evidence.',
    offsiteVerified: null,
    restoreEligibility: { ...eligibility, artifactSha256: before },
    restoreDrill: null,
  };
}

/** Returns verified, path-safe artifact members for encryption or recovery tooling. */
export async function listBackupArtifactFiles(artifactPath: string): Promise<string[]> {
  const manifest = await verifyBackupArtifact(artifactPath);
  return Object.keys(manifest.files).sort((left, right) => left.localeCompare(right));
}

export function backupConfigurationSources(databasePath: string, env: NodeJS.ProcessEnv = process.env): ConfigurationSources {
  const configPath = configurationPathFromEnvironment(env);
  return {
    databasePath: path.resolve(databasePath),
    configurationPath: configPath,
    runtimeSettingsPath: managedRuntimeSettingsPathFromEnvironment(env),
    templatesDirectory: signalTemplatesDirectoryFromEnvironment(env),
  };
}

async function snapshotPinnedDatabase(destination: string, config: unknown): Promise<PinnedConfigurationGeneration> {
  const databases = await getDatabase().all<Array<{ name: string; file: string }>>('PRAGMA database_list');
  const source = databases.find(database => database.name === 'main')?.file;
  if (!source || !path.isAbsolute(source)) throw new Error('Backup requires a proven operational database file.');
  return withPinnedConfigurationGeneration(configurationPathFromEnvironment(), source, async generation => {
    const pinnedConfig = JSON.parse(generation.files.get(CONFIG_FILE)!.toString('utf8'));
    if (backupConfigurationDigest(pinnedConfig) !== backupConfigurationDigest(config || {})) {
      throw new Error('Backup configuration provider does not match the committed generation.');
    }
    const runtime = generation.files.get(RUNTIME_SETTINGS_FILE);
    if (runtime) validateRuntimeSettings(JSON.parse(runtime.toString('utf8')));
    await backupDatabase(destination);
    return generation;
  });
}

async function installPinnedConfiguration(artifactRoot: string, generation: PinnedConfigurationGeneration): Promise<string[]> {
  const included: string[] = [];
  for (const [name, content] of generation.files) {
    const destination = artifactPath(artifactRoot, name);
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.writeFile(destination, content, { flag: 'wx', mode: 0o600 });
    if (name !== CONFIG_FILE) included.push(name);
  }
  return included;
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
    const generation = await snapshotPinnedDatabase(databasePath, config);
    await fs.chmod(databasePath, 0o600);
    const includedState = await installPinnedConfiguration(temporaryPath, generation);
    const files: Record<string, BackupFileMetadata> = {};
    for (const fileName of [...CORE_BACKUP_FILES, ...includedState]) {
      files[fileName] = await sha256File(artifactPath(temporaryPath, fileName));
    }
    const manifest: BackupManifest = {
      version: 2,
      createdAt: new Date(now).toISOString(),
      files,
      configuration: { version: 2, generation: generation.evidence.generation, commitId: generation.evidence.commitId,
        committedAt: generation.evidence.committedAt, digest: generation.evidence.digest },
      compatibility: expectedCompatibility(),
      recovery: {
        schemaVersion: 1,
        includedState,
        // Secrets and TDLib session data intentionally remain outside any backup artifact.
        // They are identity material, not portable application state, and must be re-provisioned.
        excludedState: ['managed-secrets', 'tdlib-session-data', 'tdlib-session-files']
      }
    };
    await verifyBackupConfig(temporaryPath);
    await verifySqliteDatabase(databasePath);
    verifyConfigurationEvidence(manifest);
    const verifiedAt = Date.now();
    manifest.evidence = { version: 1, integrityVerified: { verifiedAt }, configurationCoherent: { verifiedAt },
      restoreEligibility: await artifactRestoreEligibility(databasePath), offsiteVerified: null, restoreDrill: null };
    const serializedManifest = JSON.stringify(manifest, null, 2);
    if (Buffer.byteLength(serializedManifest) > 64 * 1024) throw new Error('Backup manifest exceeds 64 KiB.');
    await fs.writeFile(path.join(temporaryPath, MANIFEST_FILE), serializedManifest, {
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
    .sort((left, right) => left.localeCompare(right))
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
  files: Record<string, BackupFileMetadata>;
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
  /** Genuine scoped capability after every registered native DB handle has closed. */
  maintenanceLease?: McpMaintenanceLease;
}

interface RestoreProgress {
  installedDb: boolean;
  installedConfig: boolean;
  movedSidecars: Array<{ original: string; preserved: string }>;
  installedRuntimeSettings: boolean;
  installedTemplates: boolean;
}

async function assertRestoreInactive(targetDatabasePath: string, stateDirectory: string, lease?: McpMaintenanceLease): Promise<void> {
  await assertMcpMaintenanceLease(lease, targetDatabasePath);
  const state = await fs.realpath(path.resolve(stateDirectory));
  if (state !== await fs.realpath(path.dirname(path.resolve(targetDatabasePath)))) {
    throw new Error('Restore state directory differs from its maintenance database scope.');
  }
  const routingActive = await fs.lstat(path.join(state, '.routing_active')).then(() => true).catch((error: any) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (routingActive) {
    throw new Error("Restore refused while '.routing_active' exists. Stop routing and reconcile active work first.");
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
  const templatesTarget = path.resolve(options.templatesDirectory || signalTemplatesDirectoryFromEnvironment());
  if ([targetDb, targetConfig].includes(runtimeTarget) || [targetDb, targetConfig].includes(templatesTarget)) {
    throw new Error('Recovery state targets must not overlap database or configuration targets.');
  }
  const hasRuntimeSettings = Object.hasOwn(manifest.files, RUNTIME_SETTINGS_FILE);
  const hasTemplates = Object.keys(manifest.files).some(fileName => fileName.startsWith(`${TEMPLATES_DIRECTORY}/`));
  return {
    artifact,
    files: manifest.files,
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
  await verifyStagedMember(plan.dbTemp, plan.files[DATABASE_FILE]);
  await verifyStagedMember(plan.configTemp, plan.files[CONFIG_FILE]);
  await verifySqliteDatabase(plan.dbTemp);
  const stagedDatabase = await open({ filename: plan.dbTemp, driver: sqlite3.Database });
  try {
    requireRestoreEligibility(await assessRestoreEligibility(stagedDatabase));
    const runtimeUpdate = await stagedDatabase.run(
      `UPDATE trading_runtime_state
       SET execution_enabled = 0,
           live_trading_enabled = 0,
           kill_switch_active = 1,
           kill_switch_reason = 'Backup restored; operator reconciliation required',
           updated_at = ?
       WHERE singleton_id = 1`,
      [Date.now()],
    );
    if (Number(runtimeUpdate.changes || 0) !== 1) {
      throw new Error('Restore could not put the staged trading runtime into a fail-closed state.');
    }
  } finally {
    await stagedDatabase.close();
  }
  await verifySqliteDatabase(plan.dbTemp);
  JSON.parse(await fs.readFile(plan.configTemp, 'utf8'));
  if (plan.runtimeSettings) {
    await fs.mkdir(path.dirname(plan.runtimeSettings.target), { recursive: true, mode: 0o700 });
    await fs.copyFile(plan.runtimeSettings.source, plan.runtimeSettings.temporary, fs.constants.COPYFILE_EXCL);
    await verifyStagedMember(plan.runtimeSettings.temporary, plan.files[RUNTIME_SETTINGS_FILE]);
    const settings = JSON.parse(await fs.readFile(plan.runtimeSettings.temporary, 'utf8'));
    validateRuntimeSettings(settings);
  }
  if (plan.templates) {
    await fs.mkdir(path.dirname(plan.templates.target), { recursive: true, mode: 0o700 });
    await stageTemplates(plan);
  }
}

async function verifyStagedMember(destination: string, expected: BackupFileMetadata): Promise<void> {
  const actual = await sha256File(destination);
  if (actual.sha256 !== expected.sha256 || actual.size !== expected.size) throw new Error('Staged restore member no longer matches the verified artifact.');
}

async function stageTemplates(plan: RestorePlan): Promise<void> {
  await fs.mkdir(plan.templates!.temporary, { mode: 0o700 });
  for (const [member, expected] of Object.entries(plan.files)) {
    if (!member.startsWith(`${TEMPLATES_DIRECTORY}/`)) continue;
    const source = artifactPath(plan.artifact, member);
    await assertArtifactParents(plan.artifact, source);
    const destination = path.join(plan.templates!.temporary, member.slice(TEMPLATES_DIRECTORY.length + 1));
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    await verifyStagedMember(destination, expected);
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
      const preservationBase = plan.previousDb || `${plan.targetDb}.pre-restore-${plan.restoreId}`;
      const preserved = `${preservationBase}${suffix}`;
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
  for (const sidecar of progress.movedSidecars.slice().reverse()) {
    if (await fileExists(sidecar.preserved)) await fs.rename(sidecar.preserved, sidecar.original);
  }
}

async function removeRestoreTemporaryFiles(plan: RestorePlan): Promise<void> {
  await fs.rm(plan.dbTemp, { force: true });
  await fs.rm(`${plan.dbTemp}-wal`, { force: true });
  await fs.rm(`${plan.dbTemp}-shm`, { force: true });
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
  await assertRestoreInactive(targetDatabasePath, stateDirectory, options.maintenanceLease);
  const artifact = path.resolve(artifactPath);
  const manifest = await verifyBackupArtifact(artifact);
  const plan = await createRestorePlan(artifact, targetDatabasePath, targetConfigPath, manifest, options);
  await fs.mkdir(path.dirname(plan.targetDb), { recursive: true });
  await fs.mkdir(path.dirname(plan.targetConfig), { recursive: true });
  const progress = newRestoreProgress();
  try {
    await stageRestore(plan);
    // Staging can be slow: revalidate live ownership, deadline and every close proof before the first rename.
    await assertRestoreInactive(targetDatabasePath, stateDirectory, options.maintenanceLease);
    await preserveCurrentFiles(plan, progress);
    await installRestore(plan, progress);
    await removeRestoreTemporaryFiles(plan);
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
    lastOffsiteObject: null,
    integrityVerified: null,
    configurationCoherent: null,
    offsiteVerified: null,
    restoreEligibility: null,
    lastRestoreEligible: null,
    restoreDrill: null,
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
      throw new Error('Backup interval must be between 1 and 15 minutes for the local snapshot target.');
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
    if (this.activeRun !== null) await this.activeRun;
  }

  public getStatus(): BackupStatus & { healthy: boolean; offsiteHealthy: boolean; offsiteRequired: boolean } {
    const status = structuredClone(this.status);
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

  /** Never called automatically by scheduling, integrity verification or replication. */
  public async runRestoreDrill(artifactPath = this.status.lastArtifact): Promise<BackupRestoreDrillProof> {
    if (!artifactPath) throw new Error('No backup artifact is available for an explicit restore drill.');
    const proof = await runIsolatedBackupRestoreDrill(artifactPath);
    this.status.restoreDrill = proof;
    return structuredClone(proof);
  }

  private recordLocalEvidence(artifact: string, evidence: BackupVerificationEvidence): void {
    this.status = { ...this.status,
      lastSuccessAt: evidence.integrityVerified.verifiedAt, lastArtifact: artifact, lastError: null,
      integrityVerified: evidence.integrityVerified,
      configurationCoherent: evidence.configurationCoherent ?? this.status.configurationCoherent,
      restoreEligibility: evidence.restoreEligibility,
      lastRestoreEligible: evidence.restoreEligibility.status === 'eligible'
        ? { verifiedAt: evidence.restoreEligibility.checkedAt, artifactSha256: evidence.artifactSha256, artifactCreatedAt: evidence.artifactCreatedAt } : this.status.lastRestoreEligible,
    };
  }

  private recordOffsiteEvidence(replication: Awaited<ReturnType<BackupReplicator['replicate']>>, localSha256: string): void {
    if (replication.artifactSha256 !== localSha256 || replication.artifactCreatedAt !== this.status.integrityVerified?.artifactCreatedAt
      || !/^[a-f0-9]{64}$/.test(replication.sha256)
      || !Number.isSafeInteger(replication.verifiedAt) || replication.verifiedAt <= 0 || replication.verifiedAt > Date.now()) {
      throw new Error('Off-site receipt does not bind the verified local backup artifact.');
    }
    this.status = { ...this.status, lastOffsiteSuccessAt: replication.verifiedAt, lastOffsiteObject: replication.objectName,
      offsiteVerified: { verifiedAt: replication.verifiedAt, artifactSha256: replication.artifactSha256,
        artifactCreatedAt: replication.artifactCreatedAt, objectName: replication.objectName, encryptedObjectSha256: replication.sha256 } };
  }

  public runNow(): Promise<string> {
    if (this.activeRun !== null) return Promise.reject(new Error('A backup is already running.'));
    this.status.running = true;
    const operation = (async () => {
      try {
        const artifact = await createBackupArtifact(this.backupDirectory, this.configProvider());
        const local = await inspectBackupArtifact(artifact);
        this.recordLocalEvidence(artifact, local);
        const replication = this.replicator ? await this.replicator.replicate(artifact) : null;
        if (replication) this.recordOffsiteEvidence(replication, local.artifactSha256);
        await pruneBackupArtifacts(this.backupDirectory, this.retainCount);
        this.status = { ...this.status, lastError: null, running: false };
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
