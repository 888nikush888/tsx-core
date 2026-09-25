import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, test } from 'node:test';
import { createGateway, validateTemporaryRoot } from '../gateway.js';

const servers = [];
const tempRoots = [];
const token = 't'.repeat(64);
const name = 'backup-2026-fixture.tgfb';
const fixedNow = Date.parse('2026-09-24T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const sha = data => createHash('sha256').update(data).digest('hex');
const encrypted = data => Buffer.concat([
  Buffer.from('TGFE1\0', 'ascii'), Buffer.alloc(12), Buffer.from(data), Buffer.alloc(16)
]);

class FakeB2 {
  constructor() {
    this.entries = [];
    this.calls = [];
    this.omitLock = false;
    this.wrongLock = false;
    this.wrongHash = false;
    this.wrongSize = false;
    this.tamper = false;
    this.extraVersionOnRead = false;
    this.beforePut = () => Promise.resolve();
  }

  async send(command, options = {}) {
    const { Key, VersionId } = command.input;
    const type = command.constructor.name;
    this.calls.push({ type, input: command.input });
    if (type === 'ListObjectVersionsCommand') {
      if (this.extraVersionOnRead && this.entries.length === 1) {
        this.entries.push({ ...this.entries[0], version: 'external-version' });
        this.extraVersionOnRead = false;
      }
      return { Versions: this.entries.filter(entry => entry.key.startsWith(command.input.Prefix))
        .map(entry => ({ Key: entry.key, VersionId: entry.version })), IsTruncated: false };
    }
    if (type === 'PutObjectCommand') {
      await this.beforePut(command, options);
      assert.equal(command.input.IfNoneMatch, '*');
      assert.equal(command.input.ObjectLockMode, 'COMPLIANCE');
      assert.equal(command.input.ContentType, 'application/octet-stream');
      const chunks = [];
      for await (const chunk of command.input.Body) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      assert.equal(bytes.length, command.input.ContentLength);
      const version = `version-${this.entries.length + 1}`;
      this.entries.push({
        key: Key, version, bytes, metadata: command.input.Metadata,
        until: command.input.ObjectLockRetainUntilDate
      });
      return { VersionId: version };
    }
    const entry = this.entries.find(item => item.key === Key && item.version === VersionId);
    if (!entry) throw Object.assign(new Error('not found'), { $metadata: { httpStatusCode: 404 } });
    if (type === 'HeadObjectCommand') {
      return {
        VersionId, ContentLength: entry.bytes.length + (this.wrongSize ? 1 : 0),
        Metadata: this.wrongHash ? { sha256: '0'.repeat(64) } : entry.metadata
      };
    }
    if (type === 'GetObjectRetentionCommand') {
      return { Retention: this.omitLock ? undefined : {
        Mode: this.wrongLock ? 'GOVERNANCE' : 'COMPLIANCE',
        RetainUntilDate: entry.until
      } };
    }
    if (type === 'GetObjectCommand') {
      const bytes = Buffer.from(entry.bytes);
      if (this.tamper) bytes[0] ^= 1;
      return { VersionId, ContentLength: bytes.length, Body: Readable.from([bytes]) };
    }
    throw new Error(`Unexpected command: ${type}`);
  }
}

async function fixture(options = {}) {
  const client = new FakeB2();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tsx-b2-test-'));
  tempRoots.push(tempRoot);
  const gateway = createGateway({
    client, bucket: 'test-backup-bucket', bearerToken: token,
    tempRoot, maxObjectBytes: 128, now: () => fixedNow, ...options
  });
  const server = http.createServer((request, response) => {
    gateway(request, response).catch(() => response.destroy());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  const address = server.address();
  return { client, tempRoot, url: `http://127.0.0.1:${address.port}/objects/${name}` };
}

function request(url, method = 'GET', body = undefined, extraHeaders = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body) {
    headers['Content-Type'] = 'application/octet-stream';
    headers['X-Backup-SHA256'] = sha(body);
  }
  Object.assign(headers, extraHeaders);
  // nosemgrep -- fixture URL is a loopback server on an OS-assigned port.
  return fetch(url, { method, headers, body });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

test('PUT verifies bytes, applies compliance lock, checks HEAD and returns retention only then; GET returns exact bytes', async () => {
  const { client, url } = await fixture();
  const bytes = encrypted('encrypted backup bytes');
  const put = await request(url, 'PUT', bytes);
  assert.equal(put.status, 201);
  assert.equal(put.headers.get('x-backup-retention-until'), new Date(fixedNow + 31 * DAY_MS).toISOString());
  assert.deepEqual(client.calls.map(call => call.type), [
    'ListObjectVersionsCommand', 'PutObjectCommand', 'HeadObjectCommand',
    'GetObjectRetentionCommand', 'ListObjectVersionsCommand'
  ]);
  const get = await request(url);
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('content-length'), String(bytes.length));
  assert.equal(get.headers.get('x-backup-sha256'), sha(bytes));
  assert.deepEqual(Buffer.from(await get.arrayBuffer()), bytes);
});

test('rejects missing or incorrect authorization, unsafe names and unsupported methods before provider calls', async () => {
  const { client, url } = await fixture();
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await request(url, 'GET', undefined, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await request(url.replace(name, '%2e%2e%2fescape.tgfb'))).status, 404);
  assert.equal((await request(`${url}?versionId=other`)).status, 404);
  assert.equal((await request(url, 'DELETE')).status, 405);
  assert.equal(client.calls.length, 0);
});

test('rejects over-limit, missing length, invalid hash and invalid encrypted header', async () => {
  const { client, url } = await fixture({ maxObjectBytes: 48 });
  const bytes = encrypted('safe');
  assert.equal((await request(url, 'PUT', Buffer.alloc(49))).status, 400);
  const chunked = await fetch(url, {
    method: 'PUT', duplex: 'half', body: Readable.from([bytes]),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'X-Backup-SHA256': sha(bytes) }
  });
  assert.equal(chunked.status, 400);
  assert.equal((await request(url, 'PUT', bytes, { 'X-Backup-SHA256': '0'.repeat(64) })).status, 502);
  assert.equal((await request(url, 'PUT', Buffer.alloc(bytes.length))).status, 502);
  assert.equal(client.entries.length, 0);
  assert.equal((await request(url, 'PUT', bytes)).status, 201);
  assert.equal(client.entries.length, 1);
});

test('never issues a retention receipt if provider omits or changes lock, hash, or date', async () => {
  for (const setting of ['omitLock', 'wrongLock', 'wrongHash', 'wrongSize']) {
    const { client, url } = await fixture();
    client[setting] = true;
    const put = await request(url, 'PUT', encrypted(setting));
    assert.equal(put.status, 502, setting);
    assert.equal(put.headers.get('x-backup-retention-until'), null, setting);
  }
  const { client, url } = await fixture();
  client.omitLock = false;
  const originalSend = client.send.bind(client);
  client.send = async command => {
    const result = await originalSend(command);
    if (command.constructor.name === 'GetObjectRetentionCommand') {
      result.Retention.RetainUntilDate = new Date(fixedNow + 29 * DAY_MS);
    }
    return result;
  };
  assert.equal((await request(url, 'PUT', encrypted('too short'))).status, 502);
});

test('fails closed on extra version or altered provider download', async () => {
  const { client, url } = await fixture();
  const bytes = encrypted('safe object');
  assert.equal((await request(url, 'PUT', bytes)).status, 201);
  client.tamper = true;
  const bad = await request(url);
  assert.equal(bad.status, 502);
  assert.equal(bad.headers.get('x-backup-sha256'), null);
  client.tamper = false;
  client.extraVersionOnRead = true;
  assert.equal((await request(url)).status, 502);
});

test('still reads the sole verified version after its retention period expires', async () => {
  const { client, url } = await fixture();
  const bytes = encrypted('older locked backup');
  assert.equal((await request(url, 'PUT', bytes)).status, 201);
  client.entries[0].until = new Date(fixedNow - DAY_MS);
  const get = await request(url);
  assert.equal(get.status, 200);
  assert.deepEqual(Buffer.from(await get.arrayBuffer()), bytes);
});

test('rejects external versions before upload', async () => {
  const { client, url } = await fixture();
  client.entries.push({ key: `tsx-core/${name}`, version: 'external', bytes: Buffer.from('x'), metadata: { sha256: sha('x') }, until: new Date(fixedNow + 31 * DAY_MS) });
  assert.equal((await request(url, 'PUT', encrypted('new'))).status, 502);
  assert.equal(client.entries.length, 1);
});

test('re-adopts only a byte-identical retained version after full version-pinned readback', async () => {
  const { client, url } = await fixture({ maxObjectBytes: 100000, maxTemporaryBytes: 100000 });
  const bytes = encrypted(Buffer.alloc(65536, 7));
  assert.equal((await request(url, 'PUT', bytes)).status, 201);
  const firstPutCount = client.calls.filter(call => call.type === 'PutObjectCommand').length;
  const replay = await request(url, 'PUT', bytes);
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('x-backup-retention-until'), new Date(fixedNow + 31 * DAY_MS).toISOString());
  assert.equal(client.calls.filter(call => call.type === 'PutObjectCommand').length, firstPutCount);
  assert.ok(client.calls.some(call => call.type === 'GetObjectCommand' && call.input.VersionId === 'version-1'));
  assert.equal((await request(url, 'PUT', encrypted(Buffer.alloc(65536, 8)))).status, 502);
  client.tamper = true;
  const badReplay = await request(url, 'PUT', bytes);
  assert.equal(badReplay.status, 502);
  assert.equal(badReplay.headers.get('x-backup-retention-until'), null);
  assert.equal(client.entries.length, 1);
});

test('replay fails if retention has shortened or a second version exists', async () => {
  const { client, url } = await fixture();
  const bytes = encrypted('same');
  assert.equal((await request(url, 'PUT', bytes)).status, 201);
  client.entries[0].until = new Date(fixedNow + 29 * DAY_MS);
  assert.equal((await request(url, 'PUT', bytes)).status, 502);
  client.entries[0].until = new Date(fixedNow + 31 * DAY_MS);
  client.entries.push({ ...client.entries[0], version: 'external-version' });
  assert.equal((await request(url, 'PUT', bytes)).status, 409);
});

test('global concurrency limit blocks parallel distinct keys before another provider write', async () => {
  const { client, url } = await fixture({ maxConcurrentOperations: 1 });
  const { promise: hold, resolve: release } = Promise.withResolvers();
  const { promise: started, resolve: entered } = Promise.withResolvers();
  client.beforePut = async () => { entered(); await hold; };
  const first = request(url, 'PUT', encrypted('first'));
  await started;
  const secondUrl = url.replace(name, 'backup-2026-second.tgfb');
  assert.equal((await request(secondUrl, 'PUT', encrypted('second'))).status, 503);
  release();
  assert.equal((await first).status, 201);
  assert.equal(client.entries.length, 1);
});

test('temporary disk budget blocks parallel distinct keys and is released after completion', async () => {
  const bytes = encrypted('first');
  const { client, url } = await fixture({ maxConcurrentOperations: 2, maxTemporaryBytes: bytes.length });
  const { promise: hold, resolve: release } = Promise.withResolvers();
  const { promise: started, resolve: entered } = Promise.withResolvers();
  client.beforePut = async () => { entered(); await hold; };
  const first = request(url, 'PUT', bytes);
  await started;
  const secondUrl = url.replace(name, 'backup-2026-second.tgfb');
  assert.equal((await request(secondUrl, 'PUT', encrypted('other'))).status, 507);
  release();
  assert.equal((await first).status, 201);
  client.beforePut = () => Promise.resolve();
  assert.equal((await request(secondUrl, 'PUT', encrypted('other'))).status, 201);
});

test('provider timeout aborts a stalled upload, clears staged bytes and permits a safe retry', async () => {
  const { client, tempRoot, url } = await fixture({ operationTimeoutMs: 1_000 });
  const bytes = encrypted('timeout-then-retry');
  let aborted = false;
  client.beforePut = (_command, options) => new Promise((_resolve, reject) => {
    options.abortSignal.addEventListener('abort', () => {
      aborted = true;
      reject(new Error('provider operation aborted'));
    }, { once: true });
  });
  assert.equal((await request(url, 'PUT', bytes)).status, 502);
  assert.equal(aborted, true);
  assert.equal(client.entries.length, 0);
  client.beforePut = () => Promise.resolve();
  assert.equal((await request(url, 'PUT', bytes)).status, 201);
  assert.deepEqual(await readdir(tempRoot), []);
  assert.equal(client.entries.length, 1);
});

test('protected temporary storage rejects a regular file and relative path', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tsx-b2-root-test-'));
  tempRoots.push(root);
  const file = path.join(root, 'not-a-directory');
  await writeFile(file, 'x');
  await assert.rejects(validateTemporaryRoot(file), /not private/);
  assert.throws(() => createGateway({
    client: new FakeB2(), bucket: 'test-backup-bucket', bearerToken: token,
    tempRoot: 'relative/path'
  }), /Invalid backup gateway configuration/);
});
