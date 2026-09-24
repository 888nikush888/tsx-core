import { createHash } from 'node:crypto';
import {
  GetObjectCommand,
  GetObjectRetentionCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { AuditConflictError, parseAuditRecord } from './audit-core.mjs';

const DAY_MS = 86_400_000;
const MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_OPERATION_TIMEOUT_MS = 3_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 8_000;

function boundedMilliseconds(value, fallback, minimum, maximum, name) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum} ms.`);
  }
  return parsed;
}

async function withDeadline(timeoutMs, parentSignal, operation) {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parentSignal?.reason || new Error('Audit B2 operation cancelled.'));
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  let onAbort;
  const interrupted = new Promise((_, reject) => {
    onAbort = () => reject(controller.signal.reason || new Error('Audit B2 operation cancelled.'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const timer = setTimeout(() => controller.abort(new Error('Audit B2 operation timed out.')), timeoutMs);
  if (controller.signal.aborted) onAbort();
  try {
    return await Promise.race([Promise.resolve().then(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
      return operation(controller.signal);
    }), interrupted]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onParentAbort);
    controller.signal.removeEventListener('abort', onAbort);
    controller.abort(new Error('Audit B2 operation finished.'));
  }
}

function objectKey(sourceId, sequence) {
  return `${sourceId}/v1/${String(sequence).padStart(16, '0')}.json`;
}

async function bytesFromStream(stream, signal) {
  if (!stream || typeof stream.destroy !== 'function') throw new Error('B2 object stream is not cancellable.');
  const onAbort = () => stream.destroy(signal.reason || new Error('Audit B2 read cancelled.'));
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      if (total > MAX_BODY_BYTES) throw new Error('Stored audit body exceeds the receiver limit.');
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, total);
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (!stream.destroyed) stream.destroy();
  }
}

export class B2AuditStore {
  constructor({ client, bucket, sourceId, retentionDays = 90, now = () => Date.now(),
    operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS, totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS }) {
    if (!client || typeof client.send !== 'function') throw new Error('S3 client is required.');
    if (!/^[a-z0-9][a-z0-9.-]{5,62}$/.test(bucket || '')) throw new Error('B2 bucket name is invalid.');
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(sourceId || '')) throw new Error('Audit source ID is invalid.');
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 31 || retentionDays > 3000) {
      throw new Error('Audit retention must be between 31 and 3000 days.');
    }
    this.operationTimeoutMs = boundedMilliseconds(operationTimeoutMs, DEFAULT_OPERATION_TIMEOUT_MS, 100, 10_000, 'B2 audit operation timeout');
    this.totalTimeoutMs = boundedMilliseconds(totalTimeoutMs, DEFAULT_TOTAL_TIMEOUT_MS,
      this.operationTimeoutMs, 25_000, 'B2 audit total timeout');
    this.client = client;
    this.bucket = bucket;
    this.sourceId = sourceId;
    this.retentionDays = retentionDays;
    this.now = now;
  }

  send(command, signal, consume = result => result) {
    return withDeadline(this.operationTimeoutMs, signal,
      async operationSignal => consume(await this.client.send(command, { abortSignal: operationSignal }), operationSignal));
  }

  async versions(key, signal) {
    const result = await this.send(new ListObjectVersionsCommand({
      Bucket: this.bucket,
      Prefix: key,
      MaxKeys: 2
    }), signal);
    if (result.IsTruncated || result.NextKeyMarker || result.NextVersionIdMarker ||
        (result.DeleteMarkers || []).some(marker => marker.Key === key)) {
      throw new Error('Audit object version listing is ambiguous.');
    }
    const versions = (result.Versions || []).filter(version => version.Key === key);
    if (versions.length > 1 || versions.some(version => !version.VersionId || !(version.LastModified instanceof Date) ||
        !Number.isFinite(version.LastModified.getTime()))) {
      throw new Error('Audit object has multiple or unidentified versions or timestamps.');
    }
    return versions;
  }

  async readVersion(key, version, requireFreshRetention, signal) {
    const versionId = version.VersionId;
    if (!versionId) throw new Error('B2 did not return an object version ID.');
    const [retention, object] = await Promise.all([
      this.send(new GetObjectRetentionCommand({ Bucket: this.bucket, Key: key, VersionId: versionId }), signal),
      this.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, VersionId: versionId }), signal,
        async (response, operationSignal) => ({ ...response, Body: await bytesFromStream(response.Body, operationSignal) }))
    ]);
    if (object.VersionId !== versionId || !Buffer.isBuffer(object.Body)) throw new Error('Audit version read-back is unbound.');
    const stored = object.Body;
    const until = retention.Retention?.RetainUntilDate;
    const minimumFromCreation = version.LastModified.getTime() + 30 * DAY_MS;
    const minimumFromNow = this.now() + (requireFreshRetention ? 30 * DAY_MS : 0);
    if (retention.Retention?.Mode !== 'COMPLIANCE' || !(until instanceof Date) ||
        !Number.isFinite(until.getTime()) || until.getTime() < minimumFromCreation ||
        until.getTime() <= minimumFromNow) {
      throw new Error('Audit version has insufficient COMPLIANCE retention.');
    }
    return stored;
  }

  async verifyVersion(key, version, expectedBody, requireFreshRetention, signal) {
    const stored = await this.readVersion(key, version, requireFreshRetention, signal);
    const storedHash = createHash('sha256').update(stored).digest();
    const suppliedHash = createHash('sha256').update(expectedBody).digest();
    if (stored.length !== expectedBody.length || !storedHash.equals(suppliedHash) || !stored.equals(expectedBody)) {
      throw new AuditConflictError('Audit sequence already contains different bytes.');
    }
  }

  async verifyPredecessor(record, signal) {
    if (record.sequence === 1) return;
    const predecessorKey = objectKey(this.sourceId, record.sequence - 1);
    const predecessor = await this.versions(predecessorKey, signal);
    if (predecessor.length !== 1) throw new Error('Audit predecessor is missing or ambiguous.');
    const body = await this.readVersion(predecessorKey, predecessor[0], false, signal);
    const previous = parseAuditRecord(body);
    if (previous.sequence !== record.sequence - 1 || previous.hash !== record.previousHash) {
      throw new AuditConflictError('Audit previousHash does not match the immutable predecessor.');
    }
  }

  async persist(record, body) {
    return withDeadline(this.totalTimeoutMs, null, signal => this.persistBounded(record, body, signal));
  }

  async persistBounded(record, body, signal) {
    const key = objectKey(this.sourceId, record.sequence);
    await this.verifyPredecessor(record, signal);
    const existing = await this.versions(key, signal);
    if (existing.length === 1) {
      await this.verifyVersion(key, existing[0], body, false, signal);
      return 'replayed';
    }
    // B2's published S3 Put Object contract does not guarantee If-None-Match.
    // Treat a rejected condition as fail-closed; a live disposable-bucket test is required.
    let uploaded;
    try {
      uploaded = await this.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/json',
        ContentLength: body.length,
        IfNoneMatch: '*',
        ObjectLockMode: 'COMPLIANCE',
        ObjectLockRetainUntilDate: new Date(this.now() + (this.retentionDays * DAY_MS))
      }), signal);
    } catch (error) {
      // A lost response may follow a durable write. A conditional race may
      // have stored the same record. Reconcile only a single verified version.
      const afterError = await this.versions(key, signal);
      if (afterError.length === 1) {
        await this.verifyVersion(key, afterError[0], body, false, signal);
        return 'replayed';
      }
      throw error;
    }
    const versionId = uploaded.VersionId;
    const after = await this.versions(key, signal);
    if (after.length !== 1 || after[0].VersionId !== versionId) {
      throw new Error('Audit object version changed during persistence.');
    }
    await this.verifyVersion(key, after[0], body, true, signal);
    return 'stored';
  }
}

export function b2ClientFromEnvironment(environment = process.env) {
  const region = environment.B2_AUDIT_REGION;
  const endpoint = environment.B2_AUDIT_ENDPOINT;
  if (!/^[a-z0-9-]+$/.test(region || '') || endpoint !== `https://s3.${region}.backblazeb2.com`) {
    throw new Error('B2 audit endpoint must match the configured Backblaze region over HTTPS.');
  }
  if (!environment.B2_AUDIT_KEY_ID || !environment.B2_AUDIT_APPLICATION_KEY) {
    throw new Error('Dedicated B2 audit credentials are required.');
  }
  const operationTimeoutMs = boundedMilliseconds(environment.B2_AUDIT_OPERATION_TIMEOUT_MS,
    DEFAULT_OPERATION_TIMEOUT_MS, 100, 10_000, 'B2 audit operation timeout');
  return new S3Client({
    region,
    endpoint,
    forcePathStyle: true,
    maxAttempts: 1,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: Math.min(1_000, operationTimeoutMs),
      requestTimeout: operationTimeoutMs,
      throwOnRequestTimeout: true
    }),
    requestChecksumCalculation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: environment.B2_AUDIT_KEY_ID,
      secretAccessKey: environment.B2_AUDIT_APPLICATION_KEY
    }
  });
}
