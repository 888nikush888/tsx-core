import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BackupScheduler, createBackupArtifact } from '../src/backup.js';
import {
  HttpsBackupReplicator,
  offsiteBackupFromEnvironment,
  parseBackupEncryptionKey
} from '../src/backup_replication.js';
import { closeDb, initDb } from '../src/db.js';
import { ManagedSecretStore } from '../src/secret_store.js';
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
let beforeDownload = () => Promise.resolve();
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
  let mirrorCalls = 0;
  const mirror = { mirror: async (filePath, objectName, sha256) => {
    mirrorCalls++;
    const bytes = await readFile(filePath);
    assert.deepEqual(bytes, objects.get(`/objects/${objectName}`), 'Primary and Drive must receive identical encrypted bytes.');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256);
    return { objectName, driveFileId: 'drive-file-id-1', sha256, size: bytes.length, verifiedAt: Date.now(), reused: false };
  } };
  const mirroredReplicator = new HttpsBackupReplicator({
    urlTemplate: `http://127.0.0.1:${address.port}/objects/{artifact}`,
    bearerToken: token, encryptionKey: key, allowInsecureLoopback: true,
    minRetentionDays: 30, driveMirror: mirror
  });
  const mirrored = await mirroredReplicator.replicate(artifact);
  assert.equal(mirrorCalls, 1);
  assert.equal(mirrored.driveMirror?.sha256, mirrored.sha256);
  assert.equal(mirrored.driveMirrorError, null);
  const driveEnv = {
    ENTERPRISE_MODE: 'false', BACKUP_OFFSITE_REQUIRED: 'true',
    BACKUP_OFFSITE_URL_TEMPLATE: `http://127.0.0.1:${address.port}/objects/{artifact}`,
    BACKUP_OFFSITE_TOKEN: token, BACKUP_ENCRYPTION_KEY: key.toString('base64'),
    BACKUP_OFFSITE_RETENTION_DAYS: '30', BACKUP_DRIVE_REQUIRED: 'true',
    BACKUP_DRIVE_FOLDER_ID: 'folder_1234567890',
    BACKUP_DRIVE_TIMEOUT_MS: '60000'
  };
  const driveSecrets = new ManagedSecretStore(path.join(root, 'runtime-drive-managed-secrets'), driveEnv);
  await driveSecrets.initialize();
  await driveSecrets.set({ backupDriveAccessToken: 'staging-access-token-0123456789' });
  let driveName = '';
  let driveBytes = null;
  let driveUploads = 0;
  const driveFetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    assert.equal(options.headers.Authorization, `Bearer ${driveEnv.BACKUP_DRIVE_ACCESS_TOKEN}`);
    if (url.pathname === '/drive/v3/files' && options.method === undefined) {
      return Response.json({ files: [] });
    }
    if (url.pathname === '/upload/drive/v3/files' && options.method === 'POST') {
      driveName = JSON.parse(options.body).name;
      return new Response(null, { status: 200, headers: {
        Location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=staging'
      } });
    }
    if (url.pathname === '/upload/drive/v3/files' && options.method === 'PUT') {
      const chunks = [];
      for await (const chunk of options.body) chunks.push(Buffer.from(chunk));
      driveBytes = Buffer.concat(chunks);
      driveUploads++;
      return Response.json({ id: 'drive_file_1234567890', name: driveName });
    }
    if (url.pathname === '/drive/v3/files/drive_file_1234567890') return new Response(driveBytes);
    throw new Error(`Unexpected Drive request: ${url.pathname}`);
  };
  const runtimeBackup = offsiteBackupFromEnvironment(driveEnv, { allowInsecureLoopback: true, driveFetchImpl });
  assert.equal(runtimeBackup.required, true);
  assert.equal(runtimeBackup.driveRequired, true);
  const scheduler = new BackupScheduler(path.join(root, 'runtime-drive-backups'), () => ({ apiId: 123 }),
    60_000, 2, () => undefined, runtimeBackup.replicator, runtimeBackup.required, runtimeBackup.driveRequired);
  await scheduler.runNow();
  const runtimeProof = scheduler.getStatus();
  assert.equal(runtimeProof.healthy, true);
  assert.equal(runtimeProof.offsiteHealthy, true);
  assert.equal(runtimeProof.driveMirrorHealthy, true);
  assert.equal(runtimeProof.driveMirrorConfigured, true);
  assert.equal(runtimeProof.driveMirrorRequired, true);
  assert.equal(runtimeProof.driveMirrorVerified.artifactSha256, runtimeProof.offsiteVerified.artifactSha256);
  assert.deepEqual(driveBytes, objects.get(`/objects/${runtimeProof.lastOffsiteObject}`));
  assert.equal(driveUploads, 1);
  assert.ok(!JSON.stringify(runtimeProof).includes(driveEnv.BACKUP_DRIVE_ACCESS_TOKEN));
  await driveSecrets.set({ backupDriveAccessToken: 'rotated-access-token-0123456789' });
  await scheduler.runNow();
  assert.equal(driveUploads, 2, 'Managed secret-store rotation reaches the running mirror on the next backup run.');
  delete driveEnv.BACKUP_DRIVE_ACCESS_TOKEN;
  await assert.rejects(scheduler.runNow(), /Drive mirror upload or verification failed/);
  assert.equal(scheduler.getStatus().healthy, false, 'A removed required Drive token must revoke backup health.');
  assert.equal(scheduler.getStatus().driveMirrorHealthy, false);
  await driveSecrets.set({ backupDriveAccessToken: 'restored-access-token-0123456789' });
  const badMirrorReplicator = new HttpsBackupReplicator({
    urlTemplate: `http://127.0.0.1:${address.port}/objects/{artifact}`,
    bearerToken: token, encryptionKey: key, allowInsecureLoopback: true,
    minRetentionDays: 30,
    driveMirror: { mirror: () => Promise.reject(new Error('sensitive-provider-token')) }
  });
  const degraded = await badMirrorReplicator.replicate(artifact);
  assert.equal(degraded.driveMirror, null);
  assert.equal(degraded.driveMirrorError, 'Drive mirror upload or verification failed.');
  assert.ok(!JSON.stringify(degraded).includes('sensitive-provider-token'));
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
  } finally { beforeDownload = () => Promise.resolve(); await writeFile(manifestPath, originalManifest); }

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
  await assert.rejects(mirroredReplicator.replicate(artifact), /checksum does not match/);
  assert.equal(mirrorCalls, 1, 'Drive upload must wait for primary readback and decryption.');
  tamperDownloads = false;
  const invalidMirrorReplicator = new HttpsBackupReplicator({
    urlTemplate: `http://127.0.0.1:${address.port}/objects/{artifact}`,
    bearerToken: token, encryptionKey: key, allowInsecureLoopback: true,
    driveMirror: { mirror: (_file, objectName, sha256) => Promise.resolve({
      objectName, driveFileId: 'drive-file-id-1', sha256: `${sha256.slice(0, -1)}0`,
      size: 1, verifiedAt: Date.now(), reused: false
    }) }
  });
  const invalidMirror = await invalidMirrorReplicator.replicate(artifact);
  assert.equal(invalidMirror.driveMirror, null);
  assert.equal(invalidMirror.driveMirrorError, 'Drive mirror upload or verification failed.');

  const encodedKey = key.toString('base64');
  assert.deepEqual(parseBackupEncryptionKey(encodedKey), key);
  assert.throws(() => parseBackupEncryptionKey('not-a-key'), /base64-encoded 32-byte key/);
  assert.deepEqual(offsiteBackupFromEnvironment({ NODE_ENV: 'development' }), {
    required: false,
    driveRequired: false,
    replicator: null
  });
  assert.deepEqual(offsiteBackupFromEnvironment({ NODE_ENV: 'production' }), {
    required: false,
    driveRequired: false,
    replicator: null
  });
  assert.throws(() => offsiteBackupFromEnvironment({ BACKUP_DRIVE_REQUIRED: 'true' }), /primary off-site/);
  assert.throws(() => offsiteBackupFromEnvironment({ ...driveEnv, BACKUP_DRIVE_FOLDER_ID: '' }), /BACKUP_DRIVE_FOLDER_ID/);
  assert.throws(() => offsiteBackupFromEnvironment({ ...driveEnv, BACKUP_DRIVE_ACCESS_TOKEN: '' }), /BACKUP_DRIVE_ACCESS_TOKEN/);
  assert.throws(() => offsiteBackupFromEnvironment({ ...driveEnv, BACKUP_DRIVE_REQUIRED: 'false',
    BACKUP_DRIVE_ACCESS_TOKEN: '' }), /BACKUP_DRIVE_ACCESS_TOKEN/, 'Optional configured mirrors also fail closed without a token.');
  assert.throws(() => offsiteBackupFromEnvironment({ ...driveEnv, BACKUP_DRIVE_TIMEOUT_MS: '900001' }), /Drive mirror timeout/);
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
  await assert.rejects(mirroredReplicator.replicate(artifact), /did not confirm retention/);
  assert.equal(mirrorCalls, 1, 'A Drive receipt cannot replace missing primary retention proof.');
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
