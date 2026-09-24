import { createHash, timingSafeEqual } from 'node:crypto';

const HASH = /^[a-f0-9]{64}$/;
const MAX_BODY_BYTES = 256 * 1024;

export class AuditConflictError extends Error {}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fixedTokenMatch(actual, expected) {
  const supplied = Buffer.from(typeof actual === 'string' ? actual : '');
  const configured = Buffer.from(expected);
  return supplied.length === configured.length && timingSafeEqual(supplied, configured);
}

export function parseAuditRecord(body) {
  const text = body.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(body)) throw new Error('Audit body is not valid UTF-8.');
  const record = JSON.parse(text);
  if (!record || Array.isArray(record) || typeof record !== 'object') throw new Error('Audit record must be an object.');
  const keys = Object.keys(record);
  if (keys.length !== 6 || keys.join(',') !== 'schemaVersion,sequence,timestamp,previousHash,event,hash') {
    throw new Error('Audit record shape is invalid.');
  }
  if (JSON.stringify(record) !== text) throw new Error('Audit record must use the sender serialization.');
  if (record.schemaVersion !== 1 || !Number.isSafeInteger(record.sequence) || record.sequence < 1) {
    throw new Error('Audit record version or sequence is invalid.');
  }
  if (typeof record.timestamp !== 'string' || new Date(record.timestamp).toISOString() !== record.timestamp) {
    throw new Error('Audit timestamp is invalid.');
  }
  if (!HASH.test(record.previousHash) || !HASH.test(record.hash)) throw new Error('Audit hash is invalid.');
  if (record.sequence === 1 && record.previousHash !== '0'.repeat(64)) throw new Error('Initial audit hash is invalid.');
  const event = record.event;
  if (!event || Array.isArray(event) || typeof event !== 'object' ||
      !['startup', 'authorized', 'completed'].includes(event.phase) ||
      typeof event.action !== 'string' || !/^[a-z][a-z0-9_.:-]{0,127}$/i.test(event.action)) {
    throw new Error('Audit event is invalid.');
  }
  const unsigned = {
    schemaVersion: record.schemaVersion,
    sequence: record.sequence,
    timestamp: record.timestamp,
    previousHash: record.previousHash,
    event
  };
  if (sha256(JSON.stringify(unsigned)) !== record.hash) throw new Error('Audit record hash mismatch.');
  return record;
}

async function boundedBody(request, timeoutMs) {
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
    throw new RangeError('Audit body exceeds its limit.');
  }
  const timer = setTimeout(() => request.destroy(new Error('Audit request body timed out.')), timeoutMs);
  const parts = [];
  let count = 0;
  try {
    for await (const part of request) {
      count += part.length;
      if (count > MAX_BODY_BYTES) throw new RangeError('Audit body exceeds its limit.');
      parts.push(part);
    }
  } finally {
    clearTimeout(timer);
  }
  if (length !== undefined && count !== Number(length)) throw new Error('Audit body length mismatch.');
  return Buffer.concat(parts, count);
}

function reply(response, status, message) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  response.end(JSON.stringify({ status: message }));
}

export function createAuditReceiver({ bearerToken, store, bodyTimeoutMs = 8_000 }) {
  if (typeof bearerToken !== 'string' || bearerToken.length < 32) throw new Error('Audit bearer token must contain at least 32 characters.');
  if (!store || typeof store.persist !== 'function') throw new Error('Audit store is required.');
  if (!Number.isSafeInteger(bodyTimeoutMs) || bodyTimeoutMs < 10 || bodyTimeoutMs > 10_000) {
    throw new Error('Audit request body timeout must be between 10 and 10000 ms.');
  }
  let serial = Promise.resolve();
  return async (request, response) => {
    if (request.url !== '/v1/records') return reply(response, 404, 'not_found');
    if (request.method !== 'POST') return reply(response, 405, 'method_not_allowed');
    if (!fixedTokenMatch(request.headers.authorization, `Bearer ${bearerToken}`)) return reply(response, 401, 'unauthorized');
    if (request.headers['content-type'] !== 'application/json' || request.headers['content-encoding']) {
      return reply(response, 415, 'unsupported_media_type');
    }
    let body;
    let record;
    try {
      body = await boundedBody(request, bodyTimeoutMs);
      record = parseAuditRecord(body);
    } catch (error) {
      if (request.aborted || response.destroyed) return;
      return reply(response, error instanceof RangeError ? 413 : 400, 'invalid_record');
    }
    const operation = serial.then(() => store.persist(record, body));
    serial = operation.catch(() => undefined);
    try {
      const result = await operation;
      if (result !== 'stored' && result !== 'replayed') throw new Error('Audit store returned no verified receipt.');
      reply(response, result === 'replayed' ? 200 : 201, result === 'replayed' ? 'replayed' : 'stored');
    } catch (error) {
      reply(response, error instanceof AuditConflictError ? 409 : 503, error instanceof AuditConflictError ? 'conflict' : 'storage_unavailable');
    }
  };
}
