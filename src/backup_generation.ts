import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { withProcessLockOwner, type ProcessLock } from './process_lock.js';
import { assertMcpMaintenanceLease, type McpMaintenanceLease } from './mcp_maintenance.js';

/** Desired configuration files share one committed generation, independently of secret stores. */
export interface ConfigurationSources {
  databasePath: string;
  configurationPath: string;
  runtimeSettingsPath: string;
  templatesDirectory: string;
}

export interface ConfigurationGenerationEvidence {
  version: 1;
  generation: number;
  commitId: string;
  committedAt: number;
  digest: string;
  files: Record<string, { sha256: string; size: number }>;
}

interface Resource {
  sourceSha256: string;
  sha256: string;
  size: number;
}

interface GenerationHead {
  version: 1;
  generation: number;
  commitId: string;
  committedAt: number;
  sources: ConfigurationSources;
  resources: Record<string, Resource>;
}

export interface PinnedConfigurationGeneration {
  evidence: ConfigurationGenerationEvidence;
  files: ReadonlyMap<string, Buffer>;
}

const FORBIDDEN_CONFIG_KEYS = new Set([
  'APIHASH', 'OPENROUTERAPIKEY', 'TELEGRAMAPIHASH', 'DASHBOARDADMINTOKEN', 'DASHBOARDVIEWERTOKEN',
  'BACKUPOFFSITETOKEN', 'BACKUPENCRYPTIONKEY', 'ALERTRELAYTOKEN', 'ALERTWEBHOOKTOKEN',
  'PROMETHEUSTOKEN', 'AUDITWEBHOOKTOKEN', 'PASSWORD', 'SECRET',
]);
const HASH = /^[a-f0-9]{64}$/;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;

function codeUnitOrder(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function sanitizeBackupConfiguration(value: any): any {
  if (Array.isArray(value)) return value.map(sanitizeBackupConfiguration);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !FORBIDDEN_CONFIG_KEYS.has(key.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()))
    .map(([key, nested]) => [key, sanitizeBackupConfiguration(nested)]));
}

function canonicalJson(value: any): string {
  const ordered = (candidate: any): any => {
    if (Array.isArray(candidate)) return candidate.map(ordered);
    if (!candidate || typeof candidate !== 'object') return candidate;
    return Object.fromEntries(Object.keys(candidate).sort(codeUnitOrder)
      .map(key => [key, ordered(candidate[key])]));
  };
  return JSON.stringify(ordered(value));
}

function hash(value: Buffer | string): string { return createHash('sha256').update(value).digest('hex'); }

export function backupConfigurationDigest(value: unknown): string {
  return hash(canonicalJson(sanitizeBackupConfiguration(value)));
}

/** Integrity/coherence evidence is not an off-site receipt or a successful restore drill. */
export function validateConfigurationGenerationEvidence(value: ConfigurationGenerationEvidence,
  files: ConfigurationGenerationEvidence['files']): void {
  if (value?.version !== 1 || !Number.isSafeInteger(value.generation) || value.generation < 1
    || !UUID.test(value.commitId) || !Number.isSafeInteger(value.committedAt) || value.committedAt < 1
    || !HASH.test(value.digest) || !value.files || Object.keys(value).length !== 6) {
    throw new Error('Backup configuration generation evidence is malformed.');
  }
  if (canonicalJson(value.files) !== canonicalJson(files) || value.digest !== hash(canonicalJson(files))) {
    throw new Error('Backup files do not match their committed configuration generation.');
  }
}

function exists(destination: string): boolean {
  try { fs.lstatSync(destination); return true; }
  catch (error: any) { if (error?.code === 'ENOENT') return false; throw error; }
}

function realDirectory(directory: string): string {
  const entry = fs.lstatSync(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Configuration generation requires a real directory.');
  return fs.realpathSync(directory);
}

function canonicalFile(destination: string): string {
  const resolved = path.resolve(destination);
  return path.join(realDirectory(path.dirname(resolved)), path.basename(resolved));
}

function generationDirectory(configurationPath: string): string {
  const file = canonicalFile(configurationPath);
  return path.join(path.dirname(file), `.${path.basename(file)}.tsx-generations`);
}

function syncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try { descriptor = fs.openSync(directory, 'r'); fs.fsyncSync(descriptor); }
  catch (error: any) { if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(error?.code)) throw error; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function exclusiveWrite(destination: string, content: Buffer | string): void {
  const descriptor = fs.openSync(destination, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, content); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

/** No stale-PID takeover. An interrupted lock is evidence requiring explicit offline recovery. */
function acquireBarrier(configurationPath: string): { root: string; release(): void } {
  const root = generationDirectory(configurationPath);
  const lock = `${root}.lock`;
  const payload = JSON.stringify({ version: 1, pid: process.pid, nonce: randomUUID() });
  try { exclusiveWrite(lock, payload); }
  catch (error: any) {
    if (error?.code === 'EEXIST') throw new Error('Configuration generation barrier is busy or requires offline recovery.', { cause: error });
    throw error;
  }
  const identity = fs.lstatSync(lock);
  let released = false;
  return { root, release() {
    if (released) return;
    const current = fs.lstatSync(lock);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino
      || fs.readFileSync(lock, 'utf8') !== payload) throw new Error('Configuration barrier ownership changed; evidence preserved.');
    fs.unlinkSync(lock);
    syncDirectory(path.dirname(lock));
    released = true;
  } };
}

function privateDirectory(directory: string): void {
  if (!exists(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  realDirectory(directory);
}

function regularBytes(source: string, maximum = MAX_FILE_BYTES): Buffer {
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum || stat.size < 1) {
    throw new Error('Configuration generation source must be a bounded, nonempty regular file.');
  }
  const content = fs.readFileSync(source);
  if (content.length > maximum || content.length < 1) throw new Error('Configuration generation source size changed.');
  return content;
}

function safeMember(name: string): boolean {
  if (['config.json', 'runtime-settings.json'].includes(name)) return true;
  if (!name.startsWith('templates/') || name.length > 250) return false;
  return name.slice(10).split('/').every(segment => segment.length > 0 && segment.length <= 128
    && segment === segment.trim() && segment !== '.' && segment !== '..' && !/[\\/<>:"|?*\x00-\x1f]/.test(segment));
}

function configurationResources(sources: ConfigurationSources): { resources: Record<string, Resource>; contents: Map<string, Buffer> } {
  const resources: Record<string, Resource> = {};
  const contents = new Map<string, Buffer>();
  let bytes = 0;
  const add = (source: string, name: string, json = false) => {
    if (!safeMember(name) || contents.size >= 258) throw new Error('Configuration generation file set exceeds its bounds.');
    const original = regularBytes(source);
    const content = json ? Buffer.from(`${canonicalJson(sanitizeBackupConfiguration(JSON.parse(original.toString('utf8'))))}\n`) : original;
    bytes += content.length;
    if (bytes > MAX_BYTES) throw new Error('Configuration generation exceeds its byte limit.');
    resources[name] = { sourceSha256: hash(original), sha256: hash(content), size: content.length };
    contents.set(name, content);
  };
  add(sources.configurationPath, 'config.json', true);
  if (exists(sources.runtimeSettingsPath)) add(sources.runtimeSettingsPath, 'runtime-settings.json', true);
  if (exists(sources.templatesDirectory)) visitTemplates(sources.templatesDirectory, add);
  return { resources, contents };
}

function visitTemplates(root: string, add: (source: string, name: string) => void): void {
  realDirectory(root);
  let visited = 0;
  const visit = (directory: string, relative: string, depth: number): void => {
    if (depth > 16) throw new Error('Configuration template depth exceeds its bound.');
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (++visited > 1024 || entry.isSymbolicLink()) throw new Error('Configuration templates contain links or too many entries.');
      const name = `${relative}/${entry.name}`;
      if (!safeMember(name)) throw new Error('Configuration template path is invalid.');
      if (entry.isDirectory()) visit(path.join(directory, entry.name), name, depth + 1);
      else add(path.join(directory, entry.name), name);
    }
  };
  visit(root, 'templates', 0);
}

function validateHead(head: GenerationHead, configurationPath: string): void {
  if (head?.version !== 1 || !Number.isSafeInteger(head.generation) || head.generation < 1 || !UUID.test(head.commitId)
    || !Number.isSafeInteger(head.committedAt) || head.committedAt < 1 || !head.sources || !head.resources) {
    throw new Error('Committed configuration generation is malformed.');
  }
  validateSourceMapping(head.sources, configurationPath);
  validateResourceContract(head.resources);
}

function validateSourceMapping(sources: ConfigurationSources, configurationPath: string): void {
  const sourceKeys = ['databasePath', 'configurationPath', 'runtimeSettingsPath', 'templatesDirectory'];
  if (Object.keys(sources).length !== sourceKeys.length || sourceKeys.some(key => {
    const value = sources[key as keyof ConfigurationSources];
    return typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0');
  }) || canonicalFile(sources.configurationPath) !== canonicalFile(configurationPath)) {
    throw new Error('Configuration generation belongs to another source scope.');
  }
}

function validateResourceContract(resources: Record<string, Resource>): void {
  const members = Object.entries(resources);
  if (!resources['config.json'] || members.length > 258 || members.some(([name, item]) => !safeMember(name)
    || !item || !HASH.test(item.sourceSha256) || !HASH.test(item.sha256)
    || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > MAX_FILE_BYTES)) {
    throw new Error('Configuration generation resource contract is invalid.');
  }
}

function readHead(root: string, configurationPath: string): GenerationHead | null {
  if (!exists(root)) return null;
  realDirectory(root);
  const destination = path.join(root, 'head.json');
  if (!exists(destination)) throw new Error('Configuration generation was interrupted before its first commit; offline recovery required.');
  const head = JSON.parse(regularBytes(destination, 128 * 1024).toString('utf8')) as GenerationHead;
  validateHead(head, configurationPath);
  return head;
}

function assertSourceCoherence(head: GenerationHead): void {
  const current = configurationResources(head.sources);
  if (canonicalJson(current.resources) !== canonicalJson(head.resources)) {
    throw new Error('Configuration sources changed outside their committed generation; maintenance enrollment is required.');
  }
}

function assertOnlyAuthorizedFileChanged(resources: Record<string, Resource>, previous: GenerationHead, destination: string, expectedSha256: string): void {
  const member = path.resolve(destination) === previous.sources.configurationPath ? 'config.json' : 'runtime-settings.json';
  if (resources[member]?.sourceSha256 !== expectedSha256) throw new Error('Managed configuration target does not match the requested bytes.');
  const without = (input: Record<string, Resource>) => Object.fromEntries(Object.entries(input).filter(([name]) => name !== member));
  if (canonicalJson(without(resources)) !== canonicalJson(without(previous.resources))) {
    throw new Error('An unrelated configuration source changed during the managed write; generation commit refused.');
  }
}

function commitGeneration(root: string, sources: ConfigurationSources, previous = 0,
  authorization?: { head: GenerationHead; destination: string; expectedSha256: string }): GenerationHead {
  if (!Number.isSafeInteger(previous + 1)) throw new Error('Configuration generation number exhausted.');
  const snapshot = configurationResources(sources);
  if (authorization) assertOnlyAuthorizedFileChanged(snapshot.resources, authorization.head, authorization.destination, authorization.expectedSha256);
  const head: GenerationHead = { version: 1, generation: previous + 1, commitId: randomUUID(), committedAt: Date.now(),
    sources, resources: snapshot.resources };
  privateDirectory(root);
  const objects = path.join(root, 'objects');
  privateDirectory(objects);
  for (const [name, content] of snapshot.contents) {
    const destination = path.join(objects, snapshot.resources[name].sha256);
    if (!exists(destination)) exclusiveWrite(destination, content);
    if (hash(regularBytes(destination)) !== snapshot.resources[name].sha256) throw new Error('Immutable configuration object was modified.');
  }
  const temporary = path.join(root, `head-${head.commitId}.tmp`);
  exclusiveWrite(temporary, `${canonicalJson(head)}\n`);
  // Recheck the live sources; neither mtime nor a successful file copy constitutes coherence.
  assertSourceCoherence(head);
  fs.renameSync(temporary, path.join(root, 'head.json'));
  syncDirectory(objects);
  syncDirectory(root);
  return head;
}

/** Initial adoption is permitted only under the application's genuine process ownership. */
export async function initializeConfigurationGeneration(sources: ConfigurationSources, owner: ProcessLock): Promise<ConfigurationGenerationEvidence> {
  const normalized = Object.fromEntries(Object.entries(sources).map(([key, value]) => [key, path.resolve(value)])) as unknown as ConfigurationSources;
  return withProcessLockOwner(owner, path.dirname(normalized.databasePath), async () => {
    const barrier = acquireBarrier(normalized.configurationPath);
    try {
      const current = readHead(barrier.root, normalized.configurationPath);
      if (current && canonicalJson(current.sources) !== canonicalJson(normalized)) throw new Error('Configuration generation source mapping changed; maintenance required.');
      if (current) assertSourceCoherence(current);
      return evidence(current || commitGeneration(barrier.root, normalized));
    } finally { barrier.release(); }
  });
}

/** Explicitly adopt restored/repaired files only under fresh database quiescence and ownership. */
export async function reenrollConfigurationGeneration(sources: ConfigurationSources, owner: ProcessLock,
  maintenanceLease: McpMaintenanceLease): Promise<ConfigurationGenerationEvidence> {
  const normalized = Object.fromEntries(Object.entries(sources).map(([key, value]) => [key, path.resolve(value)])) as unknown as ConfigurationSources;
  return withProcessLockOwner(owner, path.dirname(normalized.databasePath), async () => {
    await assertMcpMaintenanceLease(maintenanceLease, normalized.databasePath);
    const barrier = acquireBarrier(normalized.configurationPath);
    try {
      await assertMcpMaintenanceLease(maintenanceLease, normalized.databasePath);
      const previous = readHead(barrier.root, normalized.configurationPath);
      if (previous && canonicalFile(previous.sources.databasePath) !== canonicalFile(normalized.databasePath)) {
        throw new Error('Configuration recovery cannot take over another database scope.');
      }
      return evidence(commitGeneration(barrier.root, normalized, previous?.generation || 0));
    } finally { barrier.release(); }
  });
}

/** Factory reset retires this exact store before deleting sources; caller retains normal path checks. */
export async function retireConfigurationGeneration(configurationPath: string, databasePath: string, owner: ProcessLock,
  maintenanceLease: McpMaintenanceLease): Promise<string | null> {
  return withProcessLockOwner(owner, path.dirname(path.resolve(databasePath)), async () => {
    await assertMcpMaintenanceLease(maintenanceLease, databasePath);
    const barrier = acquireBarrier(configurationPath);
    try {
      await assertMcpMaintenanceLease(maintenanceLease, databasePath);
      if (!exists(barrier.root)) return null;
      realDirectory(barrier.root);
      const retired = `${barrier.root}.retired-${randomUUID()}`;
      if (exists(retired)) throw new Error('Configuration retirement destination already exists.');
      fs.renameSync(barrier.root, retired);
      syncDirectory(path.dirname(barrier.root));
      return retired;
    } finally { barrier.release(); }
  });
}

function assertWriterScope(head: GenerationHead, destination: string): void {
  const target = path.resolve(destination);
  if (![head.sources.configurationPath, head.sources.runtimeSettingsPath].includes(target)) {
    throw new Error('Managed configuration writer targets a different configuration generation scope.');
  }
}

function prepareWriter(configurationPath: string, destination: string): { root: string; head: GenerationHead | null; release(): void } {
  const barrier = acquireBarrier(configurationPath);
  try {
    const head = readHead(barrier.root, configurationPath);
    if (head) { assertWriterScope(head, destination); assertSourceCoherence(head); }
    return { ...barrier, head };
  } catch (error) { barrier.release(); throw error; }
}

/** Initial settings creation precedes enrollment; backups cannot claim coherence until enrolled. */
export async function withManagedConfigurationWrite<T>(configurationPath: string, destination: string, expected: string | Buffer, write: () => Promise<T>): Promise<T> {
  const expectedSha256 = hash(expected);
  const barrier = prepareWriter(configurationPath, destination);
  try {
    const result = await write();
    if (hash(regularBytes(destination)) !== expectedSha256) throw new Error('Managed configuration target does not match the requested bytes.');
    if (barrier.head) commitGeneration(barrier.root, barrier.head.sources, barrier.head.generation, { head: barrier.head, destination, expectedSha256 });
    return result;
  } finally { barrier.release(); }
}

export function withManagedConfigurationWriteSync<T>(configurationPath: string, destination: string, expected: string | Buffer, write: () => T): T {
  const expectedSha256 = hash(expected);
  const barrier = prepareWriter(configurationPath, destination);
  try {
    const result = write();
    if (hash(regularBytes(destination)) !== expectedSha256) throw new Error('Managed configuration target does not match the requested bytes.');
    if (barrier.head) commitGeneration(barrier.root, barrier.head.sources, barrier.head.generation, { head: barrier.head, destination, expectedSha256 });
    return result;
  } finally { barrier.release(); }
}

function evidence(head: GenerationHead): ConfigurationGenerationEvidence {
  const files = Object.fromEntries(Object.entries(head.resources).map(([name, item]) => [name, { sha256: item.sha256, size: item.size }]));
  return { version: 1, generation: head.generation, commitId: head.commitId, committedAt: head.committedAt,
    files, digest: hash(canonicalJson(files)) };
}

/** Callback is for the local SQLite snapshot only, never compression, uploads or network calls. */
export async function withPinnedConfigurationGeneration<T>(configurationPath: string, databasePath: string,
  snapshot: (generation: PinnedConfigurationGeneration) => Promise<T>): Promise<T> {
  const barrier = acquireBarrier(configurationPath);
  try {
    const head = readHead(barrier.root, configurationPath);
    if (!head) throw new Error('Configuration generation has not been enrolled; coherent backup refused.');
    if (canonicalFile(head.sources.databasePath) !== canonicalFile(databasePath)) throw new Error('Configuration generation is bound to another database.');
    assertSourceCoherence(head);
    const files = new Map<string, Buffer>();
    realDirectory(path.join(barrier.root, 'objects'));
    for (const [name, item] of Object.entries(head.resources)) {
      const content = regularBytes(path.join(barrier.root, 'objects', item.sha256));
      if (content.length !== item.size || hash(content) !== item.sha256) throw new Error('Immutable configuration object failed verification.');
      files.set(name, content);
    }
    const result = await snapshot({ evidence: evidence(head), files });
    if (canonicalJson(readHead(barrier.root, configurationPath)) !== canonicalJson(head)) throw new Error('Pinned configuration generation changed.');
    assertSourceCoherence(head);
    return result;
  } finally { barrier.release(); }
}
