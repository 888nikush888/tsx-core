import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GetObjectCommand, GetObjectRetentionCommand, HeadObjectCommand, ListObjectVersionsCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const DAY_MS = 24 * 60 * 60 * 1000;
const NAME = /^backup-\d{4}-[A-Za-z0-9_.:-]{1,160}\.tgfb$/;
const HASH = /^[a-f0-9]{64}$/;
// B2 standard single-request uploads are limited to 5 GB; larger objects need multipart.
const DEFAULT_MAX_BYTES = 5_000_000_000;
const inflight = new Set();

function status(error) {
  return error && typeof error === 'object' && '$metadata' in error ? error.$metadata?.httpStatusCode : undefined;
}

function authorized(value, token) {
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return false;
  const provided = value.slice(7);
  const expectedHash = createHash('sha256').update(token).digest();
  const providedHash = createHash('sha256').update(provided).digest();
  return timingSafeEqual(expectedHash, providedHash);
}

function parseName(url) {
  const match = /^\/objects\/([^/?#]+)$/.exec(url || '');
  return match && NAME.test(match[1]) ? match[1] : null;
}

function send(response, statusCode, headers = {}) {
  response.writeHead(statusCode, { 'Cache-Control': 'no-store', ...headers });
  response.end();
}

function retentionDate(value) {
  const date = value instanceof Date ? value : new Date(value || '');
  return Number.isFinite(date.getTime()) ? date : null;
}

async function versions(client, bucket, key) {
  const found = [];
  let KeyMarker;
  let VersionIdMarker;
  for (let page = 0; page < 10; page++) {
    const result = await client.send(new ListObjectVersionsCommand({
      Bucket: bucket, Prefix: key, MaxKeys: 1000, KeyMarker, VersionIdMarker
    }));
    for (const entry of [...(result.Versions || []), ...(result.DeleteMarkers || [])]) {
      if (entry.Key === key) found.push(entry.VersionId);
      if (found.length > 1) return found;
    }
    if (!result.IsTruncated) return found;
    if (!result.NextKeyMarker || (result.NextKeyMarker === KeyMarker && result.NextVersionIdMarker === VersionIdMarker)) {
      throw new Error('Object version listing did not advance.');
    }
    KeyMarker = result.NextKeyMarker;
    VersionIdMarker = result.NextVersionIdMarker;
  }
  throw new Error('Object version listing exceeded its safety limit.');
}

function verifiedHead(head, versionId, size, sha256) {
  if (head.VersionId !== versionId || head.ContentLength !== size
    || head.Metadata?.sha256 !== sha256) {
    throw new Error('Stored object metadata failed verification.');
  }
}

async function verifiedRetention(client, bucket, key, versionId, minimum) {
  const result = await client.send(new GetObjectRetentionCommand({ Bucket: bucket, Key: key, VersionId: versionId }));
  const retained = retentionDate(result.Retention?.RetainUntilDate);
  if (result.Retention?.Mode !== 'COMPLIANCE' || !retained || retained.getTime() < minimum) {
    throw new Error('Stored object compliance retention failed verification.');
  }
  return retained;
}

async function receiveExact(request, destination, expected, sha256) {
  let received = 0;
  const digest = createHash('sha256');
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > expected) return callback(new Error('Upload exceeds declared length.'));
      digest.update(chunk);
      callback(null, chunk);
    }
  });
  await pipeline(request, limiter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  if (received !== expected || digest.digest('hex') !== sha256) {
    throw new Error('Upload length or SHA-256 mismatch.');
  }
}

async function downloadExact(body, destination, expected, sha256) {
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') throw new Error('Object body is missing.');
  let received = 0;
  const digest = createHash('sha256');
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > expected) return callback(new Error('Stored object exceeds declared length.'));
      digest.update(chunk);
      callback(null, chunk);
    }
  });
  await pipeline(Readable.from(body), limiter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  if (received !== expected || digest.digest('hex') !== sha256) throw new Error('Stored object bytes failed verification.');
}

export function createGateway({ client, bucket, prefix = 'tsx-core/', bearerToken, maxObjectBytes = DEFAULT_MAX_BYTES, retentionDays = 31, now = Date.now }) {
  if (!client || typeof client.send !== 'function' || !/^[a-z0-9][a-z0-9.-]{2,62}$/.test(bucket || '')
    || !/^[A-Za-z0-9/_-]+\/$/.test(prefix) || !bearerToken || bearerToken.length < 32 || /[\r\n]/.test(bearerToken)
    || !Number.isSafeInteger(maxObjectBytes) || maxObjectBytes < 1 || maxObjectBytes > DEFAULT_MAX_BYTES
    || !Number.isSafeInteger(retentionDays) || retentionDays < 31 || retentionDays > 3000) {
    throw new Error('Invalid backup gateway configuration.');
  }
  return async (request, response) => {
    if (!authorized(request.headers.authorization, bearerToken)) return send(response, 401);
    const name = parseName(request.url);
    if (!name) return send(response, 404);
    if (request.method !== 'GET' && request.method !== 'PUT') return send(response, 405, { Allow: 'GET, PUT' });
    const key = prefix + name;
    if (inflight.has(key)) return send(response, 409);
    inflight.add(key);
    let directory;
    try {
      if (request.method === 'PUT') {
        const declared = request.headers['content-length'];
        const size = declared && /^\d+$/.test(declared) ? Number(declared) : NaN;
        const sha256 = request.headers['x-backup-sha256'];
        if (!Number.isSafeInteger(size) || size < 1 || size > maxObjectBytes
          || request.headers['transfer-encoding'] || request.headers['content-type'] !== 'application/octet-stream'
          || typeof sha256 !== 'string' || !HASH.test(sha256)) return send(response, 400);
        if ((await versions(client, bucket, key)).length !== 0) return send(response, 409);
        directory = await mkdtemp(path.join(tmpdir(), 'tsx-b2-gateway-'));
        const file = path.join(directory, 'object');
        await receiveExact(request, file, size, sha256);
        const until = new Date(now() + retentionDays * DAY_MS);
        const put = await client.send(new PutObjectCommand({
          Bucket: bucket, Key: key, Body: createReadStream(file), ContentLength: size,
          ContentType: 'application/octet-stream', Metadata: { sha256 },
          ObjectLockMode: 'COMPLIANCE', ObjectLockRetainUntilDate: until,
          IfNoneMatch: '*'
        }));
        if (!put.VersionId || put.VersionId === 'null') throw new Error('B2 did not return an object version.');
        const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key, VersionId: put.VersionId }));
        verifiedHead(head, put.VersionId, size, sha256);
        const retained = await verifiedRetention(client, bucket, key, put.VersionId, now() + 30 * DAY_MS);
        const listed = await versions(client, bucket, key);
        if (listed.length !== 1 || listed[0] !== put.VersionId) throw new Error('Stored object version is not unique.');
        return send(response, 201, { 'X-Backup-Retention-Until': retained.toISOString() });
      }
      const listed = await versions(client, bucket, key);
      if (listed.length === 0) return send(response, 404);
      if (listed.length !== 1 || !listed[0]) throw new Error('Stored object version is not unique.');
      const versionId = listed[0];
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }));
      const size = head.ContentLength;
      const sha256 = head.Metadata?.sha256;
      if (!Number.isSafeInteger(size) || size < 1 || size > maxObjectBytes || !HASH.test(sha256 || '')) {
        throw new Error('Stored object has invalid size or checksum metadata.');
      }
      verifiedHead(head, versionId, size, sha256);
      // Expired retention does not make a still-present immutable version unreadable.
      await verifiedRetention(client, bucket, key, versionId, 0);
      const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }));
      if (object.VersionId !== versionId || object.ContentLength !== size) throw new Error('Downloaded object version or size changed.');
      directory = await mkdtemp(path.join(tmpdir(), 'tsx-b2-gateway-'));
      const file = path.join(directory, 'object');
      await downloadExact(object.Body, file, size, sha256);
      const current = await versions(client, bucket, key);
      if (current.length !== 1 || current[0] !== versionId) throw new Error('Stored object version changed during download.');
      const actual = await stat(file);
      if (actual.size !== size) throw new Error('Downloaded object size changed.');
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream', 'Content-Length': String(size),
        'X-Backup-SHA256': sha256, 'Cache-Control': 'no-store'
      });
      await pipeline(createReadStream(file), response);
    } catch (error) {
      // Only fixed status codes reach clients; provider errors and credentials are never logged.
      if (!response.headersSent) send(response, status(error) === 404 ? 404 : 502);
      else response.destroy();
    } finally {
      inflight.delete(key);
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  };
}
