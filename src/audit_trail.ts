import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
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

function validateEvent(event: AuditEvent): void {
  if (!['startup', 'authorized', 'completed'].includes(event.phase)) throw new Error('Audit phase is invalid.');
  if (!/^[a-z][a-z0-9_.:-]{0,127}$/i.test(event.action)) throw new Error('Audit action is invalid.');
  for (const value of [event.requestId, event.actorId, event.method, event.path]) {
    if (value !== undefined && (typeof value !== 'string' || value.length > 512 || /[\r\n]/.test(value))) {
      throw new Error('Audit event contains an invalid string field.');
    }
  }
  if (event.statusCode !== undefined && (!Number.isSafeInteger(event.statusCode) || event.statusCode < 100 || event.statusCode > 599)) {
    throw new Error('Audit status code is invalid.');
  }
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

async function* verifiedRecordsFromFile(filePath: string): AsyncGenerator<AuditRecord> {
  const exists = await stat(filePath).then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (!exists) return;
  const lines = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  let previousHash = ZERO_HASH;
  let sequence = 0;
  for await (const line of lines) {
    if (!line) continue;
    const record = verifiedRecord(line, previousHash, sequence);
    previousHash = record.hash;
    sequence = record.sequence;
    yield record;
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
    const currentSize = await stat(this.filePath).then(value => value.size).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return 0;
      throw error;
    });
    const unsigned: Omit<AuditRecord, 'hash'> = {
      schemaVersion: 1,
      sequence: this.sequence + 1,
      timestamp: new Date().toISOString(),
      previousHash: this.previousHash,
      event
    };
    const record: AuditRecord = { ...unsigned, hash: recordHash(unsigned) };
    const serialized = `${JSON.stringify(record)}\n`;
    if (currentSize + Buffer.byteLength(serialized) > this.maximumLocalBytes) {
      this.healthy = false;
      throw new Error('Local audit trail reached its configured capacity; archive it before further mutations.');
    }
    const handle = await open(this.filePath, 'a', 0o600);
    try {
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
