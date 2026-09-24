import { createHash } from 'node:crypto';
import {
  GetObjectCommand,
  GetObjectRetentionCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { AuditConflictError } from './audit-core.mjs';

const DAY_MS = 86_400_000;
const MAX_BODY_BYTES = 256 * 1024;

function objectKey(sourceId, sequence) {
  return `${sourceId}/v1/${String(sequence).padStart(16, '0')}.json`;
}

async function bytesFromStream(stream) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error('Stored audit body exceeds the receiver limit.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total);
}

export class B2AuditStore {
  constructor({ client, bucket, sourceId, retentionDays = 90, now = () => Date.now() }) {
    if (!client || typeof client.send !== 'function') throw new Error('S3 client is required.');
    if (!/^[a-z0-9][a-z0-9.-]{5,62}$/.test(bucket || '')) throw new Error('B2 bucket name is invalid.');
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(sourceId || '')) throw new Error('Audit source ID is invalid.');
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 30 || retentionDays > 3000) {
      throw new Error('Audit retention must be between 30 and 3000 days.');
    }
    this.client = client;
    this.bucket = bucket;
    this.sourceId = sourceId;
    this.retentionDays = retentionDays;
    this.now = now;
  }

  async versions(key) {
    const result = await this.client.send(new ListObjectVersionsCommand({
      Bucket: this.bucket,
      Prefix: key,
      MaxKeys: 2
    }));
    if (result.IsTruncated || result.NextKeyMarker || result.NextVersionIdMarker ||
        (result.DeleteMarkers || []).some(marker => marker.Key === key)) {
      throw new Error('Audit object version listing is ambiguous.');
    }
    const versions = (result.Versions || []).filter(version => version.Key === key);
    if (versions.length > 1 || versions.some(version => !version.VersionId)) {
      throw new Error('Audit object has multiple or unidentified versions.');
    }
    return versions;
  }

  async verifyVersion(key, versionId, expectedBody, minimumRetention) {
    if (!versionId) throw new Error('B2 did not return an object version ID.');
    const [retention, object] = await Promise.all([
      this.client.send(new GetObjectRetentionCommand({ Bucket: this.bucket, Key: key, VersionId: versionId })),
      this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, VersionId: versionId }))
    ]);
    const until = retention.Retention?.RetainUntilDate;
    if (retention.Retention?.Mode !== 'COMPLIANCE' || !(until instanceof Date) ||
        !Number.isFinite(until.getTime()) || until.getTime() < minimumRetention) {
      throw new Error('Audit version has insufficient COMPLIANCE retention.');
    }
    if (object.VersionId !== versionId || !object.Body) throw new Error('Audit version read-back is unbound.');
    const stored = await bytesFromStream(object.Body);
    const storedHash = createHash('sha256').update(stored).digest();
    const suppliedHash = createHash('sha256').update(expectedBody).digest();
    if (stored.length !== expectedBody.length || !storedHash.equals(suppliedHash) || !stored.equals(expectedBody)) {
      throw new AuditConflictError('Audit sequence already contains different bytes.');
    }
  }

  async persist(record, body) {
    const key = objectKey(this.sourceId, record.sequence);
    const minimumRetention = this.now() + 30 * DAY_MS;
    const existing = await this.versions(key);
    if (existing.length === 1) {
      await this.verifyVersion(key, existing[0].VersionId, body, minimumRetention);
      return 'replayed';
    }
    // B2's published S3 Put Object contract does not guarantee If-None-Match.
    // Treat a rejected condition as fail-closed; a live disposable-bucket test is required.
    const uploaded = await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ContentType: 'application/json',
      ContentLength: body.length,
      IfNoneMatch: '*',
      ObjectLockMode: 'COMPLIANCE',
      ObjectLockRetainUntilDate: new Date(this.now() + (this.retentionDays * DAY_MS))
    }));
    const versionId = uploaded.VersionId;
    await this.verifyVersion(key, versionId, body, minimumRetention);
    const after = await this.versions(key);
    if (after.length !== 1 || after[0].VersionId !== versionId) {
      throw new Error('Audit object version changed during persistence.');
    }
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
  return new S3Client({
    region,
    endpoint,
    forcePathStyle: true,
    maxAttempts: 1,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: environment.B2_AUDIT_KEY_ID,
      secretAccessKey: environment.B2_AUDIT_APPLICATION_KEY
    }
  });
}
