import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GoogleDriveBackupMirror } from '../src/google_drive_backup_mirror.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-drive-mirror-'));
const objectName = 'backup-2026-09-24-test.tgfb';
const folderId = 'folder_1234567890';
const fileId = 'drive_file_1234567890';
const bytes = Buffer.concat([Buffer.from('TGFE1\0', 'ascii'), Buffer.alloc(32, 7)]);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const sourcePath = path.join(directory, objectName);
let stored = null;
let uploads = 0;
let maliciousLocation = false;
let tamperDownload = false;

const fetchImpl = async (input, options = {}) => {
  const url = new URL(input);
  assert.equal(options.headers?.Authorization, 'Bearer token-value');
  if (url.pathname === '/drive/v3/files' && options.method === undefined) {
    return Response.json({ files: stored === null ? [] : [{ id: fileId, name: objectName }] });
  }
  if (url.pathname === '/upload/drive/v3/files' && options.method === 'POST') {
    const metadata = JSON.parse(options.body);
    assert.deepEqual(metadata.parents, [folderId]);
    assert.equal(metadata.name, objectName);
    return new Response(null, { status: 200, headers: {
      Location: maliciousLocation ? 'https://example.invalid/steal' : 'https://www.googleapis.com/upload/drive/v3/files?upload_id=test'
    } });
  }
  if (url.pathname === '/upload/drive/v3/files' && options.method === 'PUT') {
    const parts = [];
    for await (const chunk of options.body) parts.push(Buffer.from(chunk));
    stored = Buffer.concat(parts);
    uploads++;
    return Response.json({ id: fileId, name: objectName });
  }
  if (url.pathname === `/drive/v3/files/${fileId}` && url.searchParams.get('alt') === 'media') {
    const copy = Buffer.from(stored);
    if (tamperDownload) copy[copy.length - 1] ^= 1;
    return new Response(copy);
  }
  throw new Error(`Unexpected Drive request: ${url.pathname}`);
};

try {
  await writeFile(sourcePath, bytes);
  const mirror = new GoogleDriveBackupMirror({ folderId, accessToken: async () => 'token-value', fetchImpl });
  const first = await mirror.mirror(sourcePath, objectName, sha256);
  assert.deepEqual({ id: first.driveFileId, sha256: first.sha256, size: first.size, reused: first.reused },
    { id: fileId, sha256, size: bytes.length, reused: false });
  assert.ok(first.verifiedAt > 0);
  assert.equal(uploads, 1);

  const second = await mirror.mirror(sourcePath, objectName, sha256);
  assert.equal(second.reused, true);
  assert.equal(uploads, 1, 'A matching name must be verified, not uploaded twice.');

  tamperDownload = true;
  await assert.rejects(mirror.mirror(sourcePath, objectName, sha256), /did not match encrypted source bytes/);
  tamperDownload = false;
  stored = null;
  maliciousLocation = true;
  await assert.rejects(mirror.mirror(sourcePath, objectName, sha256), /untrusted upload session URL/);
  maliciousLocation = false;
  await assert.rejects(mirror.mirror(sourcePath, objectName, '0'.repeat(64)), /source SHA-256 does not match/);
  await writeFile(sourcePath, Buffer.alloc(bytes.length, 0));
  await assert.rejects(mirror.mirror(sourcePath, objectName, sha256), /encrypted backup header/);
  assert.equal(uploads, 1);
} finally {
  await rm(directory, { recursive: true, force: true });
}
