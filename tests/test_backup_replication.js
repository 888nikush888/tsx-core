import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBackupArtifact } from '../src/backup.js';
import {
  HttpsBackupReplicator,
  offsiteBackupFromEnvironment,
  parseBackupEncryptionKey
} from '../src/backup_replication.js';
import { closeDb, initDb } from '../src/db.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'forwarder-offsite-test-'));
const token = 't'.repeat(64);
const key = Buffer.alloc(32, 7);
const objects = new Map();
let tamperDownloads = false;
const server = http.createServer(async (request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401).end();
    return;
  }
  if (request.method === 'PUT') {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    if (request.headers['x-backup-sha256']?.length !== 64) {
      response.writeHead(400).end();
      return;
    }
    objects.set(request.url, body);
    response.writeHead(201).end();
    return;
  }
  if (request.method === 'GET' && objects.has(request.url)) {
    const stored = Buffer.from(objects.get(request.url));
    if (tamperDownloads) stored[Math.floor(stored.length / 2)] ^= 1;
    response.writeHead(200, { 'Content-Length': stored.length }).end(stored);
    return;
  }
  response.writeHead(404).end();
});

try {
  await initDb(path.join(root, 'state', 'forwarder.db'));
  const artifact = await createBackupArtifact(path.join(root, 'backups'), { apiId: 123 });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const replicator = new HttpsBackupReplicator({
    urlTemplate: `http://127.0.0.1:${address.port}/objects/{artifact}`,
    bearerToken: token,
    encryptionKey: key,
    allowInsecureLoopback: true
  });

  const result = await replicator.replicate(artifact);
  assert.match(result.objectName, /^backup-.*\.tgfb$/);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.ok(result.size > 0);
  assert.equal(objects.size, 1);

  tamperDownloads = true;
  await assert.rejects(replicator.replicate(artifact), /checksum does not match/);

  const encodedKey = key.toString('base64');
  assert.deepEqual(parseBackupEncryptionKey(encodedKey), key);
  assert.throws(() => parseBackupEncryptionKey('not-a-key'), /base64-encoded 32-byte key/);
  assert.deepEqual(offsiteBackupFromEnvironment({ NODE_ENV: 'development' }), {
    required: false,
    replicator: null
  });
  assert.deepEqual(offsiteBackupFromEnvironment({ NODE_ENV: 'production' }), {
    required: false,
    replicator: null
  });
  assert.throws(
    () => offsiteBackupFromEnvironment({ ENTERPRISE_MODE: 'true' }),
    /Off-site backup requires/
  );
  assert.throws(
    () => offsiteBackupFromEnvironment({ ENTERPRISE_MODE: 'true', BACKUP_OFFSITE_REQUIRED: 'false' }),
    /cannot be disabled in enterprise mode/
  );
  assert.throws(
    () => new HttpsBackupReplicator({
      urlTemplate: 'http://backup.example/{artifact}',
      bearerToken: token,
      encryptionKey: key
    }),
    /must use HTTPS/
  );

  console.log('ALL ENCRYPTED OFF-SITE BACKUP TESTS PASSED!');
} finally {
  server.close();
  await closeDb();
  await rm(root, { recursive: true, force: true });
}
