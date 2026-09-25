import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { afterEach, test } from 'node:test';
import { createAuditReceiver, parseAuditRecord, AuditConflictError } from '../audit-core.mjs';

const TOKEN = 'a'.repeat(40);
const servers = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

function auditBody(sequence = 1, action = 'test') {
  const unsigned = {
    schemaVersion: 1,
    sequence,
    timestamp: '2026-09-24T00:00:00.000Z',
    previousHash: sequence === 1 ? '0'.repeat(64) : 'f'.repeat(64),
    event: { phase: 'authorized', action }
  };
  return Buffer.from(JSON.stringify({
    ...unsigned,
    hash: createHash('sha256').update(JSON.stringify(unsigned)).digest('hex')
  }));
}

async function serve(store, bodyTimeoutMs) {
  const server = http.createServer(createAuditReceiver({ bearerToken: TOKEN, store, bodyTimeoutMs }));
  servers.push(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}/v1/records`;
}

function post(url, body, signal, headers = {}) {
  // nosemgrep -- fixture URL is a loopback server on an OS-assigned port.
  return fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers },
    body,
    signal
  });
}

function incompleteRequestStatus(url) {
  const endpoint = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(endpoint.port), endpoint.hostname);
    let response = '';
    socket.setTimeout(1_000, () => socket.destroy(new Error('fixture response timed out')));
    socket.on('data', chunk => { response += chunk.toString(); });
    socket.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
    socket.on('close', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(response)?.[1])));
    socket.on('connect', () => socket.write(`POST /v1/records HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{`));
  });
}

test('accepts exactly the sender serialization and its hash', () => {
  assert.equal(parseAuditRecord(auditBody()).event.action, 'test');
  const duplicate = auditBody().toString().replace('"sequence":1', '"sequence":1,"sequence":1');
  assert.throws(() => parseAuditRecord(Buffer.from(duplicate)), /sender serialization/);
  assert.throws(() => parseAuditRecord(Buffer.from(auditBody().toString().replace('"test"', '"other"'))), /hash mismatch/);
  assert.throws(() => parseAuditRecord(Buffer.from('not JSON')), SyntaxError);
});

test('rejects unauthorized, malformed, oversized and non-JSON requests before storage', async () => {
  let stored = 0;
  const url = await serve({ persist: () => { stored += 1; return Promise.resolve('stored'); } });
  assert.equal((await post(url, auditBody(), undefined, { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await post(url, auditBody(), undefined, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post(url, Buffer.alloc(256 * 1024 + 1, 120))).status, 413);
  assert.equal((await post(url, Buffer.from('{}'))).status, 400);
  assert.equal(stored, 0);
});

test('returns success only after store confirms durable persistence; replay is idempotent', async () => {
  const { promise: pending, resolve: resolvePersistence } = Promise.withResolvers();
  let count = 0;
  const url = await serve({ persist: async () => { count += 1; await pending; return count === 1 ? 'stored' : 'replayed'; } });
  const first = post(url, auditBody());
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(count, 1);
  resolvePersistence();
  assert.equal((await first).status, 201);
  assert.equal((await post(url, auditBody())).status, 200);
  assert.equal(count, 2);
});

test('conflicting duplicate and storage failure fail closed', async () => {
  let error = new AuditConflictError('different');
  const url = await serve({ persist: () => Promise.reject(error) });
  assert.equal((await post(url, auditBody())).status, 409);
  error = new Error('B2 unavailable');
  assert.equal((await post(url, auditBody())).status, 503);
});

test('an unrecognized store result is not a persistence receipt', async () => {
  const url = await serve({ persist: () => Promise.resolve() });
  assert.equal((await post(url, auditBody())).status, 503);
});

test('a failed storage operation releases the serialized receiver for a retry', async () => {
  let calls = 0;
  const { promise: firstStarted, resolve: markStarted } = Promise.withResolvers();
  const url = await serve({ persist: async () => {
    calls += 1;
    if (calls === 1) {
      markStarted();
      await new Promise(resolve => setTimeout(resolve, 20));
      throw new Error('B2 timed out');
    }
    return 'stored';
  } });
  const first = post(url, auditBody());
  await firstStarted;
  const second = post(url, auditBody());
  assert.equal((await first).status, 503);
  assert.equal((await second).status, 201);
  assert.equal(calls, 2);
});

test('invalid bodies and failed stores release every reserved slot', async () => {
  let fail = true;
  const url = await serve({ persist: () => fail
    ? Promise.reject(new Error('B2 unavailable'))
    : Promise.resolve('stored') });
  for (let index = 0; index < 5; index += 1) {
    assert.equal((await post(url, Buffer.from('{}'))).status, 400);
    assert.equal((await post(url, auditBody())).status, 503);
  }
  fail = false;
  assert.equal((await post(url, auditBody())).status, 201);
});

test('an incomplete incoming body is closed by its absolute deadline without blocking the next record', async () => {
  let count = 0;
  const url = await serve({ persist: () => { count += 1; return Promise.resolve('stored'); } }, 50);
  const endpoint = new URL(url);
  let received = '';
  await new Promise((resolve, reject) => {
    const socket = net.connect(Number(endpoint.port), endpoint.hostname);
    socket.setTimeout(1_000, () => socket.destroy(new Error('fixture socket stayed open')));
    socket.on('data', chunk => { received += chunk.toString(); });
    socket.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
    socket.on('close', resolve);
    socket.on('connect', () => socket.write(`POST /v1/records HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{`));
  });
  assert.doesNotMatch(received, /201 Created/);
  assert.equal(count, 0);
  assert.equal((await post(url, auditBody())).status, 201);
});

test('a held store caps authenticated bodies before reading and disconnect frees a queued slot', async () => {
  const { promise: held, resolve: releaseStore } = Promise.withResolvers();
  const { promise: began, resolve: firstStarted } = Promise.withResolvers();
  let calls = 0;
  const url = await serve({ persist: async () => {
    calls += 1;
    if (calls === 1) { firstStarted(); await held; }
    return 'stored';
  } });
  const first = post(url, auditBody());
  await began;
  const cancelled = new AbortController();
  let queuedOne = null;
  let queuedTwo = null;
  let queuedThree = null;
  let replacement = null;
  try {
    queuedOne = post(url, auditBody(), cancelled.signal);
    await new Promise(resolve => setTimeout(resolve, 15));
    queuedTwo = post(url, auditBody());
    await new Promise(resolve => setTimeout(resolve, 15));
    queuedThree = post(url, auditBody());
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(await incompleteRequestStatus(url), 503, 'saturated receiver must reject before the body completes');
    cancelled.abort();
    await assert.rejects(queuedOne, /abort/i);
    await new Promise(resolve => setTimeout(resolve, 25));
    replacement = post(url, auditBody());
    releaseStore();
    const statuses = await Promise.all([first, queuedTwo, queuedThree, replacement].map(async request => (await request).status));
    assert.deepEqual(statuses, [201, 201, 201, 201]);
    assert.equal(calls, 4, 'disconnected queued request must not reach the store');
    assert.equal((await post(url, auditBody())).status, 201, 'successful requests must release all reservations');
  } finally {
    releaseStore();
    cancelled.abort();
    await Promise.allSettled([first, queuedOne, queuedTwo, queuedThree, replacement].filter(Boolean));
  }
});
