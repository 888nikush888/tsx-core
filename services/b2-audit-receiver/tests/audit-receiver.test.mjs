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

async function post(url, body, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers },
    body
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
  const url = await serve({ persist: async () => { stored += 1; return 'stored'; } });
  assert.equal((await post(url, auditBody(), { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await post(url, auditBody(), { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post(url, Buffer.alloc(256 * 1024 + 1, 120))).status, 413);
  assert.equal((await post(url, Buffer.from('{}'))).status, 400);
  assert.equal(stored, 0);
});

test('returns success only after store confirms durable persistence; replay is idempotent', async () => {
  let resolvePersistence;
  const pending = new Promise(resolve => { resolvePersistence = resolve; });
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
  const url = await serve({ persist: async () => { throw error; } });
  assert.equal((await post(url, auditBody())).status, 409);
  error = new Error('B2 unavailable');
  assert.equal((await post(url, auditBody())).status, 503);
});

test('an unrecognized store result is not a persistence receipt', async () => {
  const url = await serve({ persist: async () => undefined });
  assert.equal((await post(url, auditBody())).status, 503);
});

test('a failed storage operation releases the serialized receiver for a retry', async () => {
  let calls = 0;
  let markStarted;
  const firstStarted = new Promise(resolve => { markStarted = resolve; });
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

test('an incomplete incoming body is closed by its absolute deadline without blocking the next record', async () => {
  let count = 0;
  const url = await serve({ persist: async () => { count += 1; return 'stored'; } }, 50);
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
