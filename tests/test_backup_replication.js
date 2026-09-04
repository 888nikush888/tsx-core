import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBackupArtifact } from '../src/backup.js';
import {
  HttpsBackupReplicator,
  offsiteBackupFromEnvironment,
  parseBackupEncryptionKey
} from '../src/backup_replication.js';
import { closeDb, initDb } from '../src/db.js';
import { enrollBackupFixture } from './fixtures/backup_generation_fixture.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'forwarder-offsite-test-'));
const previousConfigPath = process.env.CONFIG_PATH;
const previousRuntimeSettingsPath = process.env.RUNTIME_SETTINGS_PATH;
const previousTemplatesDirectory = process.env.TEMPLATES_DIR;
const token = 't'.repeat(64);
const key = Buffer.alloc(32, 7);
const longTemplateName = `${'t'.repeat(120)}.txt`;
const objects = new Map();
const objectHashes = new Map();
let tamperDownloads = false;
let includeRetentionReceipt = true;
let beforeDownload = async () => {};
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
    objectHashes.set(request.url, request.headers['x-backup-sha256']);
    response.writeHead(201, includeRetentionReceipt ? {
      'X-Backup-Retention-Until': new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString()
    } : undefined).end();
    return;
  }
  if (request.method === 'GET' && objects.has(request.url)) {
    await beforeDownload();
    const stored = Buffer.from(objects.get(request.url));
    if (tamperDownloads) stored[Math.floor(stored.length / 2)] ^= 1;
    response.writeHead(200, {
      'Content-Length': stored.length,
      'X-Backup-SHA256': objectHashes.get(request.url),
    }).end(stored);
    return;
  }
  response.writeHead(404).end();
});

try {
  process.env.CONFIG_PATH = path.join(root, 'config', 'config.json');
  process.env.RUNTIME_SETTINGS_PATH = path.join(root, 'config', 'runtime-settings.json');
  process.env.TEMPLATES_DIR = path.join(root, 'templates');
  await initDb(path.join(root, 'state', 'forwarder.db'));
  await mkdir(path.join(root, 'config'), { recursive: true });
  await mkdir(path.join(root, 'templates'), { recursive: true });
  await writeFile(path.join(root, 'config', 'runtime-settings.json'), JSON.stringify({ backupIntervalMs: 60_000 }), 'utf8');
  await writeFile(path.join(root, 'templates', 'default.xml'), '<template/>', 'utf8');
  await writeFile(path.join(root, 'templates', longTemplateName), '<long-template/>', 'utf8');
  await enrollBackupFixture({ apiId: 123 }, path.join(root, 'state', 'forwarder.db'));
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
  const manifestPath = path.join(artifact, 'manifest.json');
  const originalManifest = await readFile(manifestPath);
  const { createHash } = await import('node:crypto');
  const originalArtifactSha = createHash('sha256').update(originalManifest).digest('hex');
  assert.equal(result.artifactSha256, originalArtifactSha);
  assert.equal(result.restoreDrill, null, 'Remote round-trip verification is not an actual restore drill.');
  let currentEncryptedSha = result.sha256;
  try {
    beforeDownload = async () => {
      const changed = JSON.parse(originalManifest);
      changed.createdAt = new Date(Date.parse(changed.createdAt) - 1000).toISOString();
      await writeFile(manifestPath, JSON.stringify(changed));
    };
    const changedDuringDownload = await replicator.replicate(artifact);
    currentEncryptedSha = changedDuringDownload.sha256;
    assert.equal(changedDuringDownload.artifactSha256, originalArtifactSha, 'Off-site proof comes from the downloaded/decrypted manifest, not the subsequently changed local artifact.');
    assert.notEqual(createHash('sha256').update(await readFile(manifestPath)).digest('hex'), originalArtifactSha);
  } finally { beforeDownload = async () => {}; await writeFile(manifestPath, originalManifest); }

  const recovered = await replicator.recover(result.objectName, path.join(root, 'recovered'));
  assert.equal(path.basename(recovered.artifactPath), result.objectName.replace(/\.tgfb$/, ''));
  assert.equal(recovered.sha256, currentEncryptedSha);
  assert.equal(recovered.artifactSha256, originalArtifactSha);
  assert.equal(recovered.restoreDrill, null);
  assert.deepEqual(JSON.parse(await readFile(path.join(recovered.artifactPath, 'runtime-settings.json'), 'utf8')), { backupIntervalMs: 60_000 });
  assert.equal(await readFile(path.join(recovered.artifactPath, 'templates', 'default.xml'), 'utf8'), '<template/>');
  assert.equal(await readFile(path.join(recovered.artifactPath, 'templates', longTemplateName), 'utf8'), '<long-template/>');
  await assert.rejects(replicator.recover('../escape.tgfb', path.join(root, 'recovered')), /object name is invalid/);
  await assert.rejects(replicator.recover(result.objectName, path.join(root, 'recovered')), /already exists/);

  tamperDownloads = true;
  await assert.rejects(
    replicator.recover(result.objectName, path.join(root, 'tampered-recovery')),
    /checksum does not match/
  );
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
  assert.throws(
    () => new HttpsBackupReplicator({
      urlTemplate: `http://127.0.0.1:${address.port}/objects/{artifact}`,
      bearerToken: token,
      encryptionKey: key,
      allowInsecureLoopback: true,
      maxRecoveryBytes: 1024
    }),
    /size limit/
  );
  includeRetentionReceipt = false;
  const retentionReplicator = new HttpsBackupReplicator({
    urlTemplate: `http://127.0.0.1:${address.port}/objects/{artifact}`,
    bearerToken: token,
    encryptionKey: key,
    allowInsecureLoopback: true,
    minRetentionDays: 30
  });
  await assert.rejects(retentionReplicator.replicate(artifact), /did not confirm retention/);
  includeRetentionReceipt = true;

  console.log('ALL ENCRYPTED OFF-SITE BACKUP TESTS PASSED!');
} finally {
  server.close();
  await closeDb();
  await rm(root, { recursive: true, force: true });
  if (previousConfigPath === undefined) delete process.env.CONFIG_PATH;
  else process.env.CONFIG_PATH = previousConfigPath;
  if (previousRuntimeSettingsPath === undefined) delete process.env.RUNTIME_SETTINGS_PATH;
  else process.env.RUNTIME_SETTINGS_PATH = previousRuntimeSettingsPath;
  if (previousTemplatesDirectory === undefined) delete process.env.TEMPLATES_DIR;
  else process.env.TEMPLATES_DIR = previousTemplatesDirectory;
}
