import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, test } from 'node:test';
import { createGateway } from '../gateway.js';

const servers = [];
const token = 't'.repeat(64);
const name = 'backup-2026-fixture.tgfb';
const fixedNow = Date.parse('2026-09-24T00:00:00.000Z');
const sha = data => createHash('sha256').update(data).digest('hex');

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
  }

  async send(command) {
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
  const gateway = createGateway({
    client, bucket: 'test-backup-bucket', bearerToken: token,
    maxObjectBytes: 128, now: () => fixedNow, ...options
  });
  const server = http.createServer((request, response) => {
    gateway(request, response).catch(() => response.destroy());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  const address = server.address();
  return { client, url: `http://127.0.0.1:${address.port}/objects/${name}` };
}

function request(url, method = 'GET', body, extraHeaders = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body) {
    headers['Content-Type'] = 'application/octet-stream';
    headers['X-Backup-SHA256'] = sha(body);
  }
  Object.assign(headers, extraHeaders);
  return fetch(url, { method, headers, body });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

test('PUT verifies bytes, applies compliance lock, checks HEAD and returns retention only then; GET returns exact bytes', async () => {
  const { client, url } = await fixture();
  const bytes = Buffer.from('encrypted backup bytes');
  const put = await request(url, 'PUT', bytes);
  assert.equal(put.status, 201);
  assert.equal(put.headers.get('x-backup-retention-until'), new Date(fixedNow + 31 * 86400000).toISOString());
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
  assert.equal((await request(url + '?versionId=other')).status, 404);
  assert.equal((await request(url, 'DELETE')).status, 405);
  assert.equal(client.calls.length, 0);
});

test('rejects over-limit, invalid hash and replay without storing another version', async () => {
  const { client, url } = await fixture({ maxObjectBytes: 32 });
  const bytes = Buffer.from('safe');
  assert.equal((await request(url, 'PUT', Buffer.alloc(33))).status, 400);
  const chunked = await fetch(url, {
    method: 'PUT', duplex: 'half', body: Readable.from([bytes]),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'X-Backup-SHA256': sha(bytes) }
  });
  assert.equal(chunked.status, 400);
  assert.equal((await request(url, 'PUT', bytes, { 'X-Backup-SHA256': '0'.repeat(64) })).status, 502);
  assert.equal(client.entries.length, 0);
  assert.equal((await request(url, 'PUT', bytes)).status, 201);
  assert.equal((await request(url, 'PUT', bytes)).status, 409);
  assert.equal(client.entries.length, 1);
});

test('never issues a retention receipt if provider omits or changes lock, hash, or date', async () => {
  for (const setting of ['omitLock', 'wrongLock', 'wrongHash', 'wrongSize']) {
    const { client, url } = await fixture();
    client[setting] = true;
    const put = await request(url, 'PUT', Buffer.from(setting));
    assert.equal(put.status, 502, setting);
    assert.equal(put.headers.get('x-backup-retention-until'), null, setting);
  }
  const { client, url } = await fixture();
  client.omitLock = false;
  const originalSend = client.send.bind(client);
  client.send = async command => {
    const result = await originalSend(command);
    if (command.constructor.name === 'GetObjectRetentionCommand') {
      result.Retention.RetainUntilDate = new Date(fixedNow + 29 * 86400000);
    }
    return result;
  };
  assert.equal((await request(url, 'PUT', Buffer.from('too short'))).status, 502);
});

test('fails closed on extra version or altered provider download', async () => {
  const { client, url } = await fixture();
  const bytes = Buffer.from('safe object');
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
  const bytes = Buffer.from('older locked backup');
  assert.equal((await request(url, 'PUT', bytes)).status, 201);
  client.entries[0].until = new Date(fixedNow - 86400000);
  const get = await request(url);
  assert.equal(get.status, 200);
  assert.deepEqual(Buffer.from(await get.arrayBuffer()), bytes);
});

test('rejects external versions before upload', async () => {
  const { client, url } = await fixture();
  client.entries.push({ key: `tsx-core/${name}`, version: 'external', bytes: Buffer.from('x'), metadata: { sha256: sha('x') }, until: new Date(fixedNow + 31 * 86400000) });
  assert.equal((await request(url, 'PUT', Buffer.from('new'))).status, 409);
  assert.equal(client.entries.length, 1);
});
