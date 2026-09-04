import { createHash } from 'node:crypto';
import { mkdir, lstat, open, rm, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { finished } from 'node:stream/promises';
import { enterpriseMode } from './runtime_profile.js';

export type AuditPhase = 'startup' | 'authorized' | 'completed';

export interface AuditEvent {
  phase: AuditPhase;
  action: string;
  requestId?: string;
  actorId?: string;
  actorRole?: 'viewer' | 'admin' | 'system';
  method?: string;
  path?: string;
  statusCode?: number;
  target?: unknown;
  before?: unknown;
  after?: unknown;
  outcome?: 'succeeded' | 'rejected' | 'failed';
}

interface AuditRecord {
  schemaVersion: 1;
  sequence: number;
  timestamp: string;
  previousHash: string;
  event: AuditEvent;
  hash: string;
}

export interface AuditTrailSnapshot {
  healthy: boolean;
  remoteRequired: boolean;
  lastRemoteSuccessAt: number | null;
  recordCount: number;
}

export interface AuditTrailOptions {
  filePath: string;
  remoteUrl?: string;
  bearerToken?: string;
  remoteRequired: boolean;
  timeoutMs?: number;
  maximumLocalBytes?: number;
  allowHttpLoopback?: boolean;
}

const ZERO_HASH = '0'.repeat(64);
const DEFAULT_MAXIMUM_LOCAL_BYTES = 64 * 1024 * 1024;

function validatedRemoteUrl(value: string | undefined, allowHttpLoopback: boolean): URL | null {
  if (!value) return null;
  const url = new URL(value);
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(url.hostname);
  if (url.username || url.password || url.hash) throw new Error('AUDIT_WEBHOOK_URL must not contain credentials or a fragment.');
  if (url.protocol !== 'https:' && !(allowHttpLoopback && url.protocol === 'http:' && loopback)) {
    throw new Error('AUDIT_WEBHOOK_URL must use HTTPS.');
  }
  return url;
}

function recordHash(record: Omit<AuditRecord, 'hash'>): string {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

function assertAuditStringFields(event: AuditEvent): void {
  for (const value of [event.requestId, event.actorId, event.method, event.path]) {
    if (value !== undefined && (typeof value !== 'string' || value.length > 512 || /[\r\n]/.test(value))) {
      throw new Error('Audit event contains an invalid string field.');
    }
  }
}

function assertAuditStateFields(event: AuditEvent): void {
  for (const value of [event.target, event.before, event.after]) {
    if (value === undefined) continue;
    const serialized = JSON.stringify(value);
    if (!serialized || Buffer.byteLength(serialized) > 64 * 1024) {
      throw new Error('Audit state must be JSON-serializable and no larger than 64 KiB.');
    }
  }
}

function validateEvent(event: AuditEvent): void {
  if (!['startup', 'authorized', 'completed'].includes(event.phase)) throw new Error('Audit phase is invalid.');
  if (!/^[a-z][a-z0-9_.:-]{0,127}$/i.test(event.action)) throw new Error('Audit action is invalid.');
  assertAuditStringFields(event);
  if (event.statusCode !== undefined && (!Number.isSafeInteger(event.statusCode) || event.statusCode < 100 || event.statusCode > 599)) {
    throw new Error('Audit status code is invalid.');
  }
  if (event.outcome !== undefined && !['succeeded', 'rejected', 'failed'].includes(event.outcome)) {
    throw new Error('Audit outcome is invalid.');
  }
  assertAuditStateFields(event);
}

function verifiedRecord(line: string, previousHash: string, sequence: number): AuditRecord {
  const parsed = JSON.parse(line) as AuditRecord;
  const { hash, ...unsigned } = parsed;
  if (parsed.schemaVersion !== 1 || parsed.sequence !== sequence + 1 || parsed.previousHash !== previousHash || hash !== recordHash(unsigned)) {
    throw new Error(`Audit chain verification failed at record ${sequence + 1}.`);
  }
  validateEvent(parsed.event);
  return parsed;
}

async function verifiedRegularFileStats(filePath: string, handle: FileHandle) {
  const [pathStats, handleStats] = await Promise.all([lstat(filePath), handle.stat()]);
  const sameFile = pathStats.dev === handleStats.dev && pathStats.ino === handleStats.ino;
  if (!pathStats.isFile() || pathStats.isSymbolicLink() || !handleStats.isFile() || !sameFile) {
    throw new Error('Audit log path must reference the opened regular file, not a symbolic link.');
  }
  return handleStats;
}

async function* verifiedRecordsFromFile(filePath: string): AsyncGenerator<AuditRecord> {
  const handle = await open(filePath, 'r').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!handle) return;
  let input: ReturnType<FileHandle['createReadStream']> | null = null;
  let lines: ReturnType<typeof createInterface> | null = null;
  try {
    await verifiedRegularFileStats(filePath, handle);
    input = handle.createReadStream({ autoClose: true, encoding: 'utf8' });
    lines = createInterface({ input, crlfDelay: Infinity });
    let previousHash = ZERO_HASH;
    let sequence = 0;
    for await (const line of lines) {
      if (!line) continue;
      const record = verifiedRecord(line, previousHash, sequence);
      previousHash = record.hash;
      sequence = record.sequence;
      yield record;
    }
  } finally {
    lines?.close();
    if (input) {
      if (!input.destroyed) input.destroy();
      await finished(input, { cleanup: true }).catch(() => undefined);
    } else {
      await handle.close();
    }
  }
}

export class EnterpriseAuditTrail {
  private readonly filePath: string;
  private readonly remoteUrl: URL | null;
  private readonly bearerToken: string;
  private readonly remoteRequired: boolean;
  private readonly timeoutMs: number;
  private readonly maximumLocalBytes: number;
  private writeChain: Promise<void> = Promise.resolve();
  private previousHash = ZERO_HASH;
  private sequence = 0;
  private healthy = false;
  private lastRemoteSuccessAt: number | null = null;

  constructor(options: AuditTrailOptions) {
    this.filePath = path.resolve(options.filePath);
    this.remoteUrl = validatedRemoteUrl(options.remoteUrl, options.allowHttpLoopback === true);
    this.bearerToken = options.bearerToken?.trim() || '';
    this.remoteRequired = options.remoteRequired;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maximumLocalBytes = options.maximumLocalBytes ?? DEFAULT_MAXIMUM_LOCAL_BYTES;
    if (this.remoteRequired && !this.remoteUrl) throw new Error('Production audit delivery requires AUDIT_WEBHOOK_URL.');
    if (this.remoteUrl && this.bearerToken.length < 32) throw new Error('AUDIT_WEBHOOK_TOKEN must contain at least 32 characters.');
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 30_000) throw new Error('Audit timeout must be between 1000 and 30000 ms.');
    if (!Number.isSafeInteger(this.maximumLocalBytes) || this.maximumLocalBytes < 1024 * 1024 || this.maximumLocalBytes > 1024 * 1024 * 1024) {
      throw new Error('Audit local size limit must be between 1 MiB and 1 GiB.');
    }
  }

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    this.previousHash = ZERO_HASH;
    this.sequence = 0;
    for await (const record of verifiedRecordsFromFile(this.filePath)) {
      this.previousHash = record.hash;
      this.sequence = record.sequence;
    }
    this.healthy = true;
  }

  record(event: AuditEvent): Promise<void> {
    const operation = this.writeChain.then(() => this.recordSerial(event));
    this.writeChain = operation.catch(() => undefined);
    return operation;
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  async resetLocal(): Promise<void> {
    await this.flush();
    await rm(this.filePath, { force: true });
    this.previousHash = ZERO_HASH;
    this.sequence = 0;
    this.healthy = true;
    this.lastRemoteSuccessAt = null;
  }

  snapshot(): AuditTrailSnapshot {
    return {
      healthy: this.healthy,
      remoteRequired: this.remoteRequired,
      lastRemoteSuccessAt: this.lastRemoteSuccessAt,
      recordCount: this.sequence
    };
  }

  async replayRemote(): Promise<number> {
    if (!this.remoteUrl) throw new Error('Audit replay requires AUDIT_WEBHOOK_URL.');
    let replayed = 0;
    for await (const record of verifiedRecordsFromFile(this.filePath)) {
      await this.deliverRemote(record);
      replayed += 1;
    }
    this.healthy = true;
    return replayed;
  }

  private async recordSerial(event: AuditEvent): Promise<void> {
    validateEvent(event);
    const unsigned: Omit<AuditRecord, 'hash'> = {
      schemaVersion: 1,
      sequence: this.sequence + 1,
      timestamp: new Date().toISOString(),
      previousHash: this.previousHash,
      event
    };
    const record: AuditRecord = { ...unsigned, hash: recordHash(unsigned) };
    const serialized = `${JSON.stringify(record)}\n`;
    const handle = await open(this.filePath, 'a', 0o600);
    try {
      const currentSize = (await verifiedRegularFileStats(this.filePath, handle)).size;
      if (currentSize + Buffer.byteLength(serialized) > this.maximumLocalBytes) {
        this.healthy = false;
        throw new Error('Local audit trail reached its configured capacity; archive it before further mutations.');
      }
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.sequence = record.sequence;
    this.previousHash = record.hash;
    try {
      await this.deliverRemote(record);
      this.healthy = true;
    } catch (error) {
      this.healthy = false;
      throw error;
    }
  }

  private async deliverRemote(record: AuditRecord): Promise<void> {
    if (!this.remoteUrl) return;
    const response = await fetch(this.remoteUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.bearerToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(record),
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) throw new Error(`Audit gateway rejected the record with HTTP ${response.status}.`);
    this.lastRemoteSuccessAt = Date.now();
  }
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

export function auditTrailFromEnvironment(): EnterpriseAuditTrail {
  return new EnterpriseAuditTrail({
    filePath: process.env.AUDIT_LOG_PATH || path.join(process.cwd(), 'logs', 'audit-chain.jsonl'),
    remoteUrl: process.env.AUDIT_WEBHOOK_URL?.trim(),
    bearerToken: process.env.AUDIT_WEBHOOK_TOKEN,
    remoteRequired: enterpriseMode() && process.env.AUDIT_REMOTE_REQUIRED !== 'false',
    timeoutMs: boundedInteger(process.env.AUDIT_WEBHOOK_TIMEOUT_MS, 10_000, 1_000, 30_000, 'AUDIT_WEBHOOK_TIMEOUT_MS'),
    maximumLocalBytes: boundedInteger(process.env.AUDIT_LOCAL_MAX_BYTES, DEFAULT_MAXIMUM_LOCAL_BYTES, 1024 * 1024, 1024 * 1024 * 1024, 'AUDIT_LOCAL_MAX_BYTES')
  });
}
