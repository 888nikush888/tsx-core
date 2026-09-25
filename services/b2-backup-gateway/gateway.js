import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdtemp, rm, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GetObjectCommand, GetObjectRetentionCommand, HeadObjectCommand, ListObjectVersionsCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const DAY_MS = 24 * 60 * 60 * 1000;
const NAME = /^backup-\d{4}-[A-Za-z0-9_.:-]{1,160}\.tgfb$/;
const HASH = /^[a-f0-9]{64}$/;
const MAGIC = Buffer.from('TGFE1\0', 'ascii');
const MIN_OBJECT_BYTES = MAGIC.length + 12 + 1 + 16;
// B2 standard single-request uploads are limited to 5 GB; larger objects need multipart.
const DEFAULT_MAX_BYTES = 5 * 10 ** 9;
const MAX_OPERATION_MS = 15 * 60_000;

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

async function versions(client, bucket, key, signal) {
  const found = [];
  let KeyMarker = null;
  let VersionIdMarker = null;
  for (let page = 0; page < 10; page++) {
    const result = await client.send(new ListObjectVersionsCommand({
      Bucket: bucket, Prefix: key, MaxKeys: 1000, KeyMarker, VersionIdMarker
    }), { abortSignal: signal });
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

async function verifiedRetention(client, bucket, key, versionId, minimum, signal) {
  const result = await client.send(new GetObjectRetentionCommand({ Bucket: bucket, Key: key, VersionId: versionId }),
    { abortSignal: signal });
  const retained = retentionDate(result.Retention?.RetainUntilDate);
  if (result.Retention?.Mode !== 'COMPLIANCE' || !retained || retained.getTime() < minimum) {
    throw new Error('Stored object compliance retention failed verification.');
  }
  return retained;
}

async function receiveExact(request, destination, expected, sha256, signal) {
  let received = 0;
  let header = Buffer.alloc(0);
  const digest = createHash('sha256');
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > expected) return callback(new Error('Upload exceeds declared length.'));
      if (header.length < MAGIC.length) header = Buffer.concat([header, chunk.subarray(0, MAGIC.length - header.length)]);
      digest.update(chunk);
      return callback(null, chunk);
    }
  });
  await pipeline(request, limiter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal });
  if (received !== expected || digest.digest('hex') !== sha256 || !header.equals(MAGIC)) {
    throw new Error('Upload length, SHA-256 or encrypted header mismatch.');
  }
}

async function consumeExact(body, destination, expected, sha256, signal) {
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') throw new Error('Object body is missing.');
  let received = 0;
  const digest = createHash('sha256');
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > expected) return callback(new Error('Stored object exceeds declared length.'));
      digest.update(chunk);
      return callback(null, chunk);
    }
  });
  if (destination) await pipeline(Readable.from(body), limiter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal });
  else await pipeline(Readable.from(body), limiter,
    new Writable({ write(_chunk, _encoding, callback) { callback(); } }), { signal });
  if (received !== expected || digest.digest('hex') !== sha256) throw new Error('Stored object bytes failed verification.');
}

export async function validateTemporaryRoot(tempRoot, requiredBytes = 0) {
  const info = await lstat(tempRoot);
  if (!info.isDirectory() || info.isSymbolicLink()
    || (process.platform !== 'win32' && (info.uid !== process.getuid()
      || (info.mode & 0o700) !== 0o700 || (info.mode & 0o077) !== 0))) {
    throw new Error('Backup gateway temporary directory is not private.');
  }
  const filesystem = await statfs(tempRoot);
  const free = Number(filesystem.bavail) * Number(filesystem.bsize);
  if (!Number.isSafeInteger(free) || free < requiredBytes + 64 * 1024 ** 2) {
    throw new Error('Backup gateway temporary volume has insufficient free space.');
  }
}

function invalidGatewayIdentity({ client, bucket, prefix, bearerToken, tempRoot }) {
  return !client || typeof client.send !== 'function' || !/^[a-z0-9][a-z0-9.-]{2,62}$/.test(bucket || '')
    || !/^[A-Za-z0-9/_-]+\/$/.test(prefix) || !bearerToken || bearerToken.length < 32 || /[\r\n]/.test(bearerToken)
    || typeof tempRoot !== 'string' || !path.isAbsolute(tempRoot);
}

function invalidGatewayLimits({ maxObjectBytes, maxTemporaryBytes, maxConcurrentOperations,
  retentionDays, operationTimeoutMs }) {
  return !Number.isSafeInteger(maxObjectBytes) || maxObjectBytes < MIN_OBJECT_BYTES
    || maxObjectBytes > DEFAULT_MAX_BYTES
    || !Number.isSafeInteger(maxTemporaryBytes) || maxTemporaryBytes < MIN_OBJECT_BYTES
    || maxTemporaryBytes > 10 * DEFAULT_MAX_BYTES
    || !Number.isSafeInteger(maxConcurrentOperations) || maxConcurrentOperations < 1 || maxConcurrentOperations > 32
    || !Number.isSafeInteger(retentionDays) || retentionDays < 31 || retentionDays > 3000
    || !Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 1_000 || operationTimeoutMs > MAX_OPERATION_MS;
}

function validateGatewayConfiguration(config) {
  if (invalidGatewayIdentity(config) || invalidGatewayLimits(config)) {
    throw new Error('Invalid backup gateway configuration.');
  }
}

function parsePutRequest(request, maxObjectBytes) {
  const declared = request.headers['content-length'];
  const size = declared && /^\d+$/.test(declared) ? Number(declared) : Number.NaN;
  const sha256 = request.headers['x-backup-sha256'];
  if (!Number.isSafeInteger(size) || size < MIN_OBJECT_BYTES || size > maxObjectBytes
    || request.headers['transfer-encoding'] || request.headers['content-type'] !== 'application/octet-stream'
    || typeof sha256 !== 'string' || !HASH.test(sha256)) return null;
  return { size, sha256 };
}

function retentionResponse(statusCode, retained) {
  return { statusCode, headers: { 'X-Backup-Retention-Until': retained.toISOString() } };
}

async function reserveTemporary(operation, config, size) {
  if (operation.state.reserved + size > config.maxTemporaryBytes) return false;
  // Reserve before async filesystem inspection so concurrent requests cannot overcommit.
  operation.state.reserved += size;
  operation.reservation = size;
  await validateTemporaryRoot(config.tempRoot, operation.state.reserved);
  return true;
}

async function createTemporaryObject(operation, tempRoot) {
  operation.directory = await mkdtemp(path.join(tempRoot, 'tsx-b2-gateway-'));
  return path.join(operation.directory, 'object');
}

async function readRemoteVersion(client, objectDetails, destination, signal) {
  const { bucket, key, versionId, size, sha256 } = objectDetails;
  const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }),
    { abortSignal: signal });
  if (object.VersionId !== versionId || object.ContentLength !== size) {
    object.Body?.destroy?.();
    throw new Error('Downloaded object version or size changed.');
  }
  await consumeExact(object.Body, destination, size, sha256, signal);
}

async function replayStoredObject(config, operation, upload, versionId) {
  if (!versionId) return { statusCode: 409 };
  const { client, bucket, key, now } = config;
  const objectDetails = {
    bucket, key, versionId, size: upload.size, sha256: upload.sha256,
  };
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }),
    { abortSignal: operation.signal });
  verifiedHead(head, versionId, upload.size, upload.sha256);
  const retained = await verifiedRetention(client, bucket, key, versionId, now() + 30 * DAY_MS, operation.signal);
  await readRemoteVersion(client, objectDetails, undefined, operation.signal);
  const after = await versions(client, bucket, key, operation.signal);
  if (after.length !== 1 || after[0] !== versionId) {
    throw new Error('Stored object version changed during replay verification.');
  }
  return retentionResponse(200, retained);
}

async function storeObject(config, operation, upload, file) {
  const { client, bucket, key, retentionDays, now } = config;
  const until = new Date(now() + retentionDays * DAY_MS);
  const put = await client.send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: createReadStream(file), ContentLength: upload.size,
    ContentType: 'application/octet-stream', Metadata: { sha256: upload.sha256 },
    ObjectLockMode: 'COMPLIANCE', ObjectLockRetainUntilDate: until,
    IfNoneMatch: '*'
  }), { abortSignal: operation.signal });
  if (!put.VersionId || put.VersionId === 'null') throw new Error('B2 did not return an object version.');
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key, VersionId: put.VersionId }),
    { abortSignal: operation.signal });
  verifiedHead(head, put.VersionId, upload.size, upload.sha256);
  const retained = await verifiedRetention(client, bucket, key, put.VersionId,
    now() + 30 * DAY_MS, operation.signal);
  const listed = await versions(client, bucket, key, operation.signal);
  if (listed.length !== 1 || listed[0] !== put.VersionId) throw new Error('Stored object version is not unique.');
  return retentionResponse(201, retained);
}

async function processPut(request, config, operation) {
  const upload = parsePutRequest(request, config.maxObjectBytes);
  if (!upload) return { statusCode: 400 };
  if (!(await reserveTemporary(operation, config, upload.size))) return { statusCode: 507 };
  const file = await createTemporaryObject(operation, config.tempRoot);
  await receiveExact(request, file, upload.size, upload.sha256, operation.signal);
  const before = await versions(config.client, config.bucket, config.key, operation.signal);
  if (before.length > 1) return { statusCode: 409 };
  if (before.length === 1) return replayStoredObject(config, operation, upload, before[0]);
  return storeObject(config, operation, upload, file);
}

async function processGet(response, config, operation) {
  const { client, bucket, key } = config;
  const listed = await versions(client, bucket, key, operation.signal);
  if (listed.length === 0) return { statusCode: 404 };
  if (listed.length !== 1 || !listed[0]) throw new Error('Stored object version is not unique.');
  const versionId = listed[0];
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }),
    { abortSignal: operation.signal });
  const size = head.ContentLength;
  const sha256 = head.Metadata?.sha256;
  if (!Number.isSafeInteger(size) || size < MIN_OBJECT_BYTES || size > config.maxObjectBytes
    || !HASH.test(sha256 || '')) {
    throw new Error('Stored object has invalid size or checksum metadata.');
  }
  verifiedHead(head, versionId, size, sha256);
  // Expired retention does not make a still-present immutable version unreadable.
  await verifiedRetention(client, bucket, key, versionId, 0, operation.signal);
  if (!(await reserveTemporary(operation, config, size))) return { statusCode: 507 };
  const file = await createTemporaryObject(operation, config.tempRoot);
  await readRemoteVersion(client, { bucket, key, versionId, size, sha256 }, file, operation.signal);
  const current = await versions(client, bucket, key, operation.signal);
  if (current.length !== 1 || current[0] !== versionId) {
    throw new Error('Stored object version changed during download.');
  }
  const actual = await stat(file);
  if (actual.size !== size) throw new Error('Downloaded object size changed.');
  response.writeHead(200, {
    'Content-Type': 'application/octet-stream', 'Content-Length': String(size),
    'X-Backup-SHA256': sha256, 'Cache-Control': 'no-store'
  });
  await pipeline(createReadStream(file), response, { signal: operation.signal });
  return null;
}

function processRequest(request, response, config, operation) {
  return request.method === 'PUT'
    ? processPut(request, config, operation)
    : processGet(response, config, operation);
}

async function runGatewayRequest(request, response, config, operation) {
  try {
    return { success: await processRequest(request, response, config, operation), failure: 0 };
  } catch (error) {
    // Only fixed status codes reach clients; provider errors and credentials are never logged.
    if (!response.headersSent) return { success: null, failure: status(error) === 404 ? 404 : 502 };
    response.destroy();
    return { success: null, failure: 0 };
  }
}

async function releaseGatewayOperation(operation) {
  try {
    if (operation.directory) {
      await rm(operation.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  } finally {
    operation.inflight.delete(operation.key);
    operation.state.active -= 1;
    operation.state.reserved -= operation.reservation;
  }
}

export function createGateway(options) {
  const config = {
    prefix: 'tsx-core/', maxObjectBytes: DEFAULT_MAX_BYTES, maxTemporaryBytes: DEFAULT_MAX_BYTES,
    maxConcurrentOperations: 2, retentionDays: 31, operationTimeoutMs: MAX_OPERATION_MS, now: Date.now,
    ...options,
  };
  validateGatewayConfiguration(config);
  const inflight = new Set();
  const state = { active: 0, reserved: 0 };
  return async (request, response) => {
    if (!authorized(request.headers.authorization, config.bearerToken)) return send(response, 401);
    const name = parseName(request.url);
    if (!name) return send(response, 404);
    if (request.method !== 'GET' && request.method !== 'PUT') return send(response, 405, { Allow: 'GET, PUT' });
    const key = config.prefix + name;
    if (inflight.has(key)) return send(response, 409);
    if (state.active >= config.maxConcurrentOperations) return send(response, 503);
    inflight.add(key);
    state.active += 1;
    const operation = {
      key, request, response, signal: AbortSignal.timeout(config.operationTimeoutMs),
      directory: null, reservation: 0, state, inflight,
    };
    const result = await runGatewayRequest(request, response, { ...config, key }, operation);
    await releaseGatewayOperation(operation);
    if (result.success) send(response, result.success.statusCode, result.success.headers);
    if (result.failure) send(response, result.failure);
    return undefined;
  };
}
