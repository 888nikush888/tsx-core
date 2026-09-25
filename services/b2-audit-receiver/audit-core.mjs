import { createHash, timingSafeEqual } from 'node:crypto';

const HASH = /^[a-f0-9]{64}$/;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_PENDING_RECORDS = 4;
const MAX_RESERVED_BYTES = 1024 * 1024;

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
  if (length !== undefined && (!/^(0|[1-9]\d*)$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
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

function serialWorkQueue() {
  const waiting = [];
  let active = false;
  function drain() {
    if (active) return;
    const item = waiting.shift();
    if (!item) return;
    active = true;
    item.started = true;
    const finish = outcome => {
      active = false;
      item.resolve(outcome);
      drain();
    };
    Promise.resolve().then(item.run).then(
      result => finish({ result }),
      error => finish({ error })
    );
  }
  return run => {
    let item;
    const completion = new Promise(resolve => {
      item = { run, resolve, started: false };
      waiting.push(item);
    });
    drain();
    return {
      completion,
      get started() { return item.started; },
      cancel() {
        if (item.started) return false;
        const index = waiting.indexOf(item);
        if (index < 0) return false;
        waiting.splice(index, 1);
        item.resolve({ cancelled: true });
        return true;
      }
    };
  };
}

function boundaryFailure(request, response, bearerToken) {
  if (request.url !== '/v1/records') {
    reply(response, 404, 'not_found');
    return true;
  }
  if (request.method !== 'POST') {
    reply(response, 405, 'method_not_allowed');
    return true;
  }
  if (!fixedTokenMatch(request.headers.authorization, `Bearer ${bearerToken}`)) {
    reply(response, 401, 'unauthorized');
    return true;
  }
  if (request.headers['content-type'] !== 'application/json' || request.headers['content-encoding']) {
    reply(response, 415, 'unsupported_media_type');
    return true;
  }
  return false;
}

async function readAuditRecord(request, response, bodyTimeoutMs, isDisconnected) {
  try {
    const body = await boundedBody(request, bodyTimeoutMs);
    return { body, record: parseAuditRecord(body) };
  } catch (error) {
    if (request.aborted || isDisconnected() || response.destroyed) return null;
    reply(response, error instanceof RangeError ? 413 : 400, 'invalid_record');
    return null;
  }
}

function verifiedPersistenceResult(outcome) {
  if (outcome.error) throw outcome.error;
  const result = outcome.result;
  if (result !== 'stored' && result !== 'replayed') {
    throw new Error('Audit store returned no verified receipt.');
  }
  return result;
}

function replyPersistenceResult(response, result) {
  if (result === 'replayed') {
    reply(response, 200, 'replayed');
    return;
  }
  reply(response, 201, 'stored');
}

function replyPersistenceFailure(response, error) {
  if (error instanceof AuditConflictError) {
    reply(response, 409, 'conflict');
    return;
  }
  reply(response, 503, 'storage_unavailable');
}

export function createAuditReceiver({ bearerToken, store, bodyTimeoutMs = 8_000 }) {
  if (typeof bearerToken !== 'string' || bearerToken.length < 32) throw new Error('Audit bearer token must contain at least 32 characters.');
  if (!store || typeof store.persist !== 'function') throw new Error('Audit store is required.');
  if (!Number.isSafeInteger(bodyTimeoutMs) || bodyTimeoutMs < 10 || bodyTimeoutMs > 10_000) {
    throw new Error('Audit request body timeout must be between 10 and 10000 ms.');
  }
  const enqueue = serialWorkQueue();
  let pendingRecords = 0;
  let reservedBytes = 0;
  return async (request, response) => {
    if (boundaryFailure(request, response, bearerToken)) return;
    if (pendingRecords >= MAX_PENDING_RECORDS || reservedBytes + MAX_BODY_BYTES > MAX_RESERVED_BYTES) {
      response.setHeader('connection', 'close');
      return reply(response, 503, 'busy');
    }
    pendingRecords += 1;
    reservedBytes += MAX_BODY_BYTES;
    let released = false;
    let disconnected = false;
    let queued = null;
    const release = () => {
      if (released) return;
      released = true;
      pendingRecords -= 1;
      reservedBytes -= MAX_BODY_BYTES;
    };
    const onClose = () => {
      if (response.writableEnded) return;
      disconnected = true;
      if (queued?.cancel()) release();
      else if (!queued) request.destroy();
    };
    response.once('close', onClose);
    try {
      const parsed = await readAuditRecord(request, response, bodyTimeoutMs, () => disconnected);
      if (!parsed) return;
      if (disconnected) return;
      queued = enqueue(() => store.persist(parsed.record, parsed.body));
      const outcome = await queued.completion;
      if (disconnected || outcome.cancelled) return;
      replyPersistenceResult(response, verifiedPersistenceResult(outcome));
    } catch (error) {
      if (!disconnected && !response.destroyed) {
        replyPersistenceFailure(response, error);
      }
    } finally {
      response.off('close', onClose);
      release();
    }
  };
}
