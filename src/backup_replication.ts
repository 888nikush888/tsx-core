import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'crypto';
import { createReadStream, createWriteStream, promises as fs } from 'fs';
import path from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { createGunzip, createGzip } from 'zlib';
import { isSupportedBackupArtifactFileName, listBackupArtifactFiles, verifyBackupArtifact } from './backup.js';
import { enterpriseMode } from './runtime_profile.js';

const ENCRYPTED_MAGIC = Buffer.from('TGFE1\0', 'ascii');
const ARCHIVE_MAGIC = Buffer.from('TGFA1\0', 'ascii');
const MANIFEST_FILE = 'manifest.json';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_OBJECT_BYTES = 8 * 1024 ** 3;
const DEFAULT_MAX_RECOVERY_BYTES = 2 * 1024 ** 3;
const MIN_RECOVERY_BYTES = 1024 ** 2;
const RECOVERY_SAFETY_BYTES = 64 * 1024 ** 2;
const MAX_EXPANSION_RATIO = 100;
const MAX_ARCHIVE_NAME_BYTES = 256;
const CORE_BACKUP_FILES = ['manifest.json', 'config.json', 'forwarder.db'] as const;

export interface BackupReplicationResult {
  objectName: string;
  sha256: string;
  size: number;
  verifiedAt: number;
}

export interface BackupReplicator {
  replicate(artifactPath: string): Promise<BackupReplicationResult>;
  recover(objectName: string, backupDirectory: string): Promise<BackupRecoveryResult>;
}

export interface BackupRecoveryResult {
  objectName: string;
  artifactPath: string;
  sha256: string;
  size: number;
  verifiedAt: number;
}

interface HttpsBackupReplicatorOptions {
  urlTemplate: string;
  bearerToken: string;
  encryptionKey: Buffer;
  timeoutMs?: number;
  allowInsecureLoopback?: boolean;
  maxRecoveryBytes?: number;
  minRetentionDays?: number;
}

function validLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
}

function validateUrlTemplate(template: string, allowInsecureLoopback: boolean): void {
  if (template.split('{artifact}').length !== 2) {
    throw new Error('BACKUP_OFFSITE_URL_TEMPLATE must contain {artifact} exactly once.');
  }
  const candidate = new URL(template.replace('{artifact}', 'probe.tgfb'));
  if (candidate.username || candidate.password || candidate.search || candidate.hash) {
    throw new Error('Off-site backup URL must not contain credentials, query parameters or fragments.');
  }
  if (candidate.protocol !== 'https:' && !(allowInsecureLoopback && candidate.protocol === 'http:' && validLoopback(candidate.hostname))) {
    throw new Error('Off-site backup URL must use HTTPS.');
  }
}

export function parseBackupEncryptionKey(value: string): Buffer {
  const normalized = value?.trim() || '';
  if (!/^[A-Za-z0-9+/]{43}=$/.test(normalized)) {
    throw new Error('BACKUP_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  }
  const key = Buffer.from(normalized, 'base64');
  if (key.length !== 32 || key.toString('base64') !== normalized) {
    throw new Error('BACKUP_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  }
  return key;
}

async function* archiveChunks(artifactPath: string): AsyncGenerator<Buffer> {
  yield ARCHIVE_MAGIC;
  const files = await listBackupArtifactFiles(artifactPath);
  for (const fileName of [MANIFEST_FILE, ...files]) {
    const filePath = path.join(artifactPath, fileName);
    const stats = await fs.stat(filePath);
    if (!stats.isFile() || stats.size < 1 || !Number.isSafeInteger(stats.size)) {
      throw new Error(`Backup file '${fileName}' is not a non-empty regular file.`);
    }
    const name = Buffer.from(fileName, 'utf8');
    const header = Buffer.alloc(4 + name.length + 8);
    header.writeUInt32BE(name.length, 0);
    name.copy(header, 4);
    header.writeBigUInt64BE(BigInt(stats.size), 4 + name.length);
    yield header;
    for await (const chunk of createReadStream(filePath)) yield Buffer.from(chunk as Buffer);
  }
  yield Buffer.alloc(4);
}

async function encryptArtifact(artifactPath: string, destination: string, key: Buffer): Promise<void> {
  const iv = randomBytes(IV_BYTES);
  const header = Buffer.concat([ENCRYPTED_MAGIC, iv]);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);
  await fs.writeFile(destination, header, { flag: 'wx', mode: 0o600 });
  await pipeline(
    Readable.from(archiveChunks(artifactPath)),
    createGzip({ level: 6 }),
    cipher,
    createWriteStream(destination, { flags: 'a', mode: 0o600 })
  );
  await fs.appendFile(destination, cipher.getAuthTag());
}

async function readExact(file: fs.FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new Error('Encrypted backup archive is truncated.');
  return buffer;
}

interface ArchiveExtractionState {
  position: number;
  extracted: Set<string>;
  extractedBytes: number;
}

async function readArchiveMemberName(file: fs.FileHandle, state: ArchiveExtractionState): Promise<string | null> {
  const nameLength = (await readExact(file, 4, state.position)).readUInt32BE(0);
  state.position += 4;
  if (nameLength === 0) return null;
  if (nameLength > MAX_ARCHIVE_NAME_BYTES) throw new Error('Encrypted backup archive contains an invalid file name.');
  const fileName = (await readExact(file, nameLength, state.position)).toString('utf8');
  state.position += nameLength;
  return fileName;
}

function validateArchiveMemberName(fileName: string, extracted: Set<string>): void {
  const supported = fileName === MANIFEST_FILE || isSupportedBackupArtifactFileName(fileName);
  if (!supported || extracted.has(fileName)) {
    throw new Error(`Encrypted backup archive contains unexpected file '${fileName}'.`);
  }
}

async function readArchiveMemberSize(
  file: fs.FileHandle,
  state: ArchiveExtractionState,
  archiveSize: number,
  fileName: string
): Promise<number> {
  const size = Number((await readExact(file, 8, state.position)).readBigUInt64BE(0));
  state.position += 8;
  if (!Number.isSafeInteger(size) || size < 1 || state.position + size > archiveSize) {
    throw new Error(`Encrypted backup archive has an invalid size for '${fileName}'.`);
  }
  return size;
}

function reserveArchiveExtraction(state: ArchiveExtractionState, size: number, maxExpandedBytes: number): void {
  state.extractedBytes += size;
  if (state.extractedBytes > maxExpandedBytes) {
    throw new Error('Encrypted backup archive exceeds the configured recovery size limit.');
  }
}

function archiveDestination(destination: string, fileName: string): string {
  const destinationPath = path.resolve(destination, fileName);
  if (destinationPath !== destination && !destinationPath.startsWith(`${destination}${path.sep}`)) {
    throw new Error(`Encrypted backup archive path escapes destination: ${fileName}`);
  }
  return destinationPath;
}

async function extractArchiveMember(
  file: fs.FileHandle,
  archivePath: string,
  destination: string,
  archiveSize: number,
  maxExpandedBytes: number,
  state: ArchiveExtractionState
): Promise<boolean> {
  const fileName = await readArchiveMemberName(file, state);
  if (fileName === null) return false;
  validateArchiveMemberName(fileName, state.extracted);
  const size = await readArchiveMemberSize(file, state, archiveSize, fileName);
  reserveArchiveExtraction(state, size, maxExpandedBytes);
  const destinationPath = archiveDestination(destination, fileName);
  await fs.mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  await pipeline(
    createReadStream(archivePath, { start: state.position, end: state.position + size - 1 }),
    createWriteStream(destinationPath, { flags: 'wx', mode: 0o600 })
  );
  state.position += size;
  state.extracted.add(fileName);
  return true;
}

function assertArchiveComplete(state: ArchiveExtractionState, archiveSize: number): void {
  const hasRequiredFiles = CORE_BACKUP_FILES.every(fileName => state.extracted.has(fileName));
  if (state.position !== archiveSize || !hasRequiredFiles || !state.extracted.has(MANIFEST_FILE)) {
    throw new Error('Encrypted backup archive is incomplete or has trailing data.');
  }
}

async function extractArchive(archivePath: string, destination: string, maxExpandedBytes: number): Promise<void> {
  const stats = await fs.stat(archivePath);
  const file = await fs.open(archivePath, 'r');
  const destinationRoot = path.resolve(destination);
  const state: ArchiveExtractionState = { position: 0, extracted: new Set<string>(), extractedBytes: 0 };
  try {
    const magic = await readExact(file, ARCHIVE_MAGIC.length, state.position);
    state.position += magic.length;
    if (!magic.equals(ARCHIVE_MAGIC)) throw new Error('Decrypted backup archive has an invalid header.');
    await fs.mkdir(destinationRoot, { recursive: false, mode: 0o700 });
    while (await extractArchiveMember(file, archivePath, destinationRoot, stats.size, maxExpandedBytes, state)) { /* bounded by archive data */ }
    assertArchiveComplete(state, stats.size);
  } finally {
    await file.close();
  }
}

async function decryptArtifact(bundlePath: string, destination: string, key: Buffer, maxExpandedBytes: number): Promise<void> {
  const stats = await fs.stat(bundlePath);
  const minimumSize = ENCRYPTED_MAGIC.length + IV_BYTES + TAG_BYTES + 1;
  if (!stats.isFile() || stats.size < minimumSize || stats.size > MAX_OBJECT_BYTES) {
    throw new Error('Encrypted backup object has an invalid size.');
  }
  const file = await fs.open(bundlePath, 'r');
  let header: Buffer;
  let tag: Buffer;
  try {
    header = await readExact(file, ENCRYPTED_MAGIC.length + IV_BYTES, 0);
    tag = await readExact(file, TAG_BYTES, stats.size - TAG_BYTES);
  } finally {
    await file.close();
  }
  if (!header.subarray(0, ENCRYPTED_MAGIC.length).equals(ENCRYPTED_MAGIC)) {
    throw new Error('Encrypted backup object has an invalid header.');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(ENCRYPTED_MAGIC.length));
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  const archivePath = `${destination}.archive`;
  try {
    let decompressed = 0;
    const expansionLimiter = new Transform({
      transform(chunk, _encoding, callback) {
        decompressed += chunk.length;
        if (decompressed > maxExpandedBytes) callback(new Error('Encrypted backup archive exceeds the configured recovery size limit.'));
        else callback(null, chunk);
      }
    });
    await pipeline(
      createReadStream(bundlePath, {
        start: header.length,
        end: stats.size - TAG_BYTES - 1
      }),
      decipher,
      createGunzip(),
      expansionLimiter,
      createWriteStream(archivePath, { flags: 'wx', mode: 0o600 })
    );
    await extractArchive(archivePath, destination, maxExpandedBytes);
  } finally {
    await fs.rm(archivePath, { force: true });
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function downloadExactly(response: Response, destination: string, expectedBytes: number): Promise<void> {
  if (!response.body) throw new Error('Off-site backup download returned no body.');
  const declaredLength = response.headers.get('content-length');
  if (declaredLength && Number(declaredLength) !== expectedBytes) {
    throw new Error('Off-site backup download length does not match the uploaded object.');
  }
  let received = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > expectedBytes) callback(new Error('Off-site backup download exceeded the uploaded object size.'));
      else callback(null, chunk);
    }
  });
  await pipeline(
    Readable.fromWeb(response.body as any),
    limiter,
    createWriteStream(destination, { flags: 'wx', mode: 0o600 })
  );
  if (received !== expectedBytes) throw new Error('Off-site backup download is truncated.');
}

function offsiteObjectName(value: string): string {
  if (!/^backup-\d{4}-[a-zA-Z0-9_.:-]{1,160}\.tgfb$/.test(value)) {
    throw new Error('Off-site backup object name is invalid.');
  }
  return value;
}

function responseObjectSize(response: Response): number {
  const value = Number(response.headers.get('content-length'));
  if (!Number.isSafeInteger(value) || value < ENCRYPTED_MAGIC.length + IV_BYTES + TAG_BYTES + 1 || value > MAX_OBJECT_BYTES) {
    throw new Error('Off-site backup download must declare a valid bounded Content-Length.');
  }
  return value;
}

function validateRecoveryLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_MAX_RECOVERY_BYTES;
  if (!Number.isSafeInteger(limit) || limit < MIN_RECOVERY_BYTES || limit > MAX_OBJECT_BYTES) {
    throw new Error('Off-site recovery size limit must be between 1 MiB and 8 GiB.');
  }
  return limit;
}

function expandedRecoveryLimit(encryptedBytes: number, maxRecoveryBytes: number): number {
  return Math.min(maxRecoveryBytes, Math.max(MIN_RECOVERY_BYTES, encryptedBytes * MAX_EXPANSION_RATIO));
}

async function assertRecoveryCapacity(directory: string, encryptedBytes: number, maxRecoveryBytes: number): Promise<number> {
  const expansionLimit = expandedRecoveryLimit(encryptedBytes, maxRecoveryBytes);
  const requiredBytes = encryptedBytes + (expansionLimit * 2) + RECOVERY_SAFETY_BYTES;
  const filesystem = await fs.statfs(directory);
  const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  if (!Number.isSafeInteger(availableBytes) || availableBytes < requiredBytes) {
    throw new Error(`Off-site recovery requires ${requiredBytes} free bytes but only ${availableBytes} are available.`);
  }
  return expansionLimit;
}

function validateRetentionReceipt(response: Response, minimumDays: number | undefined): void {
  if (!minimumDays) return;
  const value = response.headers.get('x-backup-retention-until');
  const retentionUntil = value ? Date.parse(value) : Number.NaN;
  const minimum = Date.now() + minimumDays * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(retentionUntil) || retentionUntil < minimum) {
    throw new Error(`Off-site backup gateway did not confirm retention through at least ${minimumDays} day(s).`);
  }
}

export class HttpsBackupReplicator implements BackupReplicator {
  private readonly timeoutMs: number;
  private readonly maxRecoveryBytes: number;
  private readonly minRetentionDays: number | undefined;

  constructor(private readonly options: HttpsBackupReplicatorOptions) {
    validateUrlTemplate(options.urlTemplate, !!options.allowInsecureLoopback);
    if (!options.bearerToken || options.bearerToken.length < 32 || /[\r\n]/.test(options.bearerToken)) {
      throw new Error('BACKUP_OFFSITE_TOKEN must contain at least 32 characters without line breaks.');
    }
    if (options.encryptionKey.length !== 32) throw new Error('Off-site backup encryption key must contain 32 bytes.');
    this.timeoutMs = options.timeoutMs ?? 60_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 15 * 60_000) {
      throw new Error('Off-site backup timeout must be between 1 second and 15 minutes.');
    }
    this.maxRecoveryBytes = validateRecoveryLimit(options.maxRecoveryBytes);
    if (options.minRetentionDays !== undefined && (!Number.isSafeInteger(options.minRetentionDays) || options.minRetentionDays < 1 || options.minRetentionDays > 3650)) {
      throw new Error('Off-site backup retention must be between 1 and 3650 days.');
    }
    this.minRetentionDays = options.minRetentionDays;
  }

  async replicate(artifactPath: string): Promise<BackupReplicationResult> {
    const resolvedArtifact = path.resolve(artifactPath);
    await verifyBackupArtifact(resolvedArtifact);
    const objectName = `${path.basename(resolvedArtifact)}.tgfb`;
    const objectUrl = this.options.urlTemplate.replace('{artifact}', encodeURIComponent(objectName));
    const workingRoot = path.dirname(resolvedArtifact);
    const operationId = randomUUID();
    const encryptedPath = path.join(workingRoot, `.offsite-${operationId}.tgfb`);
    const downloadedPath = path.join(workingRoot, `.offsite-${operationId}.download`);
    const restoredPath = path.join(workingRoot, `.offsite-${operationId}.restore`);
    const headers = { Authorization: `Bearer ${this.options.bearerToken}` };
    try {
      await encryptArtifact(resolvedArtifact, encryptedPath, this.options.encryptionKey);
      const encryptedStats = await fs.stat(encryptedPath);
      const sha256 = await sha256File(encryptedPath);
      const upload = await fetch(objectUrl, {
        method: 'PUT',
        headers: {
          ...headers,
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(encryptedStats.size),
          'X-Backup-SHA256': sha256
        },
        body: createReadStream(encryptedPath),
        duplex: 'half',
        signal: AbortSignal.timeout(this.timeoutMs)
      } as unknown as RequestInit & { duplex: 'half' });
      await upload.body?.cancel();
      if (![200, 201, 204].includes(upload.status)) {
        throw new Error(`Off-site backup upload failed with HTTP ${upload.status}.`);
      }
      validateRetentionReceipt(upload, this.minRetentionDays);
      const download = await fetch(objectUrl, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      if (download.status !== 200) {
        await download.body?.cancel();
        throw new Error(`Off-site backup verification download failed with HTTP ${download.status}.`);
      }
      const expansionLimit = await assertRecoveryCapacity(workingRoot, encryptedStats.size, this.maxRecoveryBytes);
      await downloadExactly(download, downloadedPath, encryptedStats.size);
      if (await sha256File(downloadedPath) !== sha256) {
        throw new Error('Off-site backup verification checksum does not match the uploaded object.');
      }
      await decryptArtifact(downloadedPath, restoredPath, this.options.encryptionKey, expansionLimit);
      await verifyBackupArtifact(restoredPath);
      return { objectName, sha256, size: encryptedStats.size, verifiedAt: Date.now() };
    } finally {
      await Promise.all([
        fs.rm(encryptedPath, { force: true }),
        fs.rm(downloadedPath, { force: true }),
        fs.rm(restoredPath, { recursive: true, force: true })
      ]);
    }
  }

  async recover(objectName: string, backupDirectory: string): Promise<BackupRecoveryResult> {
    const validatedName = offsiteObjectName(objectName);
    const root = path.resolve(backupDirectory);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const artifactName = validatedName.slice(0, -'.tgfb'.length);
    const finalPath = path.resolve(root, artifactName);
    if (path.dirname(finalPath) !== root) throw new Error('Recovered backup path escapes the backup directory.');
    await fs.lstat(finalPath).then(() => {
      throw new Error(`Local backup artifact '${artifactName}' already exists.`);
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    const operationId = randomUUID();
    const encryptedPath = path.join(root, `.offsite-recovery-${operationId}.download`);
    const temporaryArtifact = path.join(root, `.offsite-recovery-${operationId}.artifact`);
    const objectUrl = this.options.urlTemplate.replace('{artifact}', encodeURIComponent(validatedName));
    try {
      const response = await fetch(objectUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.options.bearerToken}` },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new Error(`Off-site backup recovery download failed with HTTP ${response.status}.`);
      }
      const size = responseObjectSize(response);
      if (size > this.maxRecoveryBytes) {
        await response.body?.cancel();
        throw new Error(`Off-site backup recovery object exceeds the configured ${this.maxRecoveryBytes}-byte limit.`);
      }
      const expansionLimit = await assertRecoveryCapacity(root, size, this.maxRecoveryBytes);
      await downloadExactly(response, encryptedPath, size);
      const sha256 = await sha256File(encryptedPath);
      const expectedHash = response.headers.get('x-backup-sha256');
      if (expectedHash && (!/^[a-f0-9]{64}$/.test(expectedHash) || expectedHash !== sha256)) {
        throw new Error('Off-site backup recovery checksum does not match the remote object metadata.');
      }
      await decryptArtifact(encryptedPath, temporaryArtifact, this.options.encryptionKey, expansionLimit);
      await verifyBackupArtifact(temporaryArtifact);
      await fs.rename(temporaryArtifact, finalPath);
      return { objectName: validatedName, artifactPath: finalPath, sha256, size, verifiedAt: Date.now() };
    } finally {
      await Promise.all([
        fs.rm(encryptedPath, { force: true }),
        fs.rm(temporaryArtifact, { recursive: true, force: true }),
      ]);
    }
  }
}

function strictBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('BACKUP_OFFSITE_REQUIRED must be true or false.');
}

function optionalBoundedInteger(value: string | undefined, name: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

export function offsiteBackupFromEnvironment(env: NodeJS.ProcessEnv = process.env): {
  required: boolean;
  replicator: BackupReplicator | null;
} {
  const enterprise = enterpriseMode(env);
  if (enterprise && env.BACKUP_OFFSITE_REQUIRED === 'false') {
    throw new Error('Off-site backup cannot be disabled in enterprise mode.');
  }
  const required = strictBoolean(env.BACKUP_OFFSITE_REQUIRED, enterprise);
  const values = [env.BACKUP_OFFSITE_URL_TEMPLATE, env.BACKUP_OFFSITE_TOKEN, env.BACKUP_ENCRYPTION_KEY];
  const configured = values.some(value => !!value?.trim());
  if (!configured && !required) return { required, replicator: null };
  if (values.some(value => !value?.trim())) {
    throw new Error('Off-site backup requires BACKUP_OFFSITE_URL_TEMPLATE, BACKUP_OFFSITE_TOKEN and BACKUP_ENCRYPTION_KEY.');
  }
  const timeout = Number(env.BACKUP_OFFSITE_TIMEOUT_MS || 60_000);
  const configuredRecoveryLimit = optionalBoundedInteger(
    env.BACKUP_OFFSITE_MAX_RECOVERY_BYTES,
    'BACKUP_OFFSITE_MAX_RECOVERY_BYTES',
    MIN_RECOVERY_BYTES,
    MAX_OBJECT_BYTES
  );
  const configuredRetentionDays = optionalBoundedInteger(
    env.BACKUP_OFFSITE_RETENTION_DAYS,
    'BACKUP_OFFSITE_RETENTION_DAYS',
    0,
    3650
  );
  return {
    required,
    replicator: new HttpsBackupReplicator({
      urlTemplate: env.BACKUP_OFFSITE_URL_TEMPLATE!,
      bearerToken: env.BACKUP_OFFSITE_TOKEN!,
      encryptionKey: parseBackupEncryptionKey(env.BACKUP_ENCRYPTION_KEY!),
      timeoutMs: timeout,
      maxRecoveryBytes: configuredRecoveryLimit,
      minRetentionDays: configuredRetentionDays || (enterprise ? 30 : undefined)
    })
  };
}
