import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pruneBackupArtifacts } from '../src/backup.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-backup-prune-order-'));
try {
  const mixed = path.join(directory, 'mixed');
  await mkdir(mixed);
  for (const name of ['backup-2026-A-one', 'backup-2026-a-two', 'backup-2026-_', 'backup-2026-z', 'backup-2026-ä', 'unrelated']) {
    await mkdir(path.join(mixed, name));
    await writeFile(path.join(mixed, name, 'receipt.txt'), 'isolated pruning fixture');
  }
  await writeFile(path.join(mixed, 'backup-9999-file'), 'files are not backup directories');
  assert.equal(await pruneBackupArtifacts(mixed, 2), 3);
  assert.deepEqual((await readdir(mixed)).sort(), ['backup-2026-z', 'backup-2026-ä', 'backup-9999-file', 'unrelated'].sort());
  const generated = path.join(directory, 'generated');
  await mkdir(generated);
  const names = ['backup-2026-09-18T10-00-00-000Z-00000000', 'backup-2026-09-19T10-00-00-000Z-aaaaaaaa', 'backup-2026-09-20T10-00-00-000Z-ffffffff'];
  for (const name of names) await mkdir(path.join(generated, name));
  assert.equal(await pruneBackupArtifacts(generated, 2), 1);
  assert.deepEqual((await readdir(generated)).sort(), names.slice(1));
  await assert.rejects(pruneBackupArtifacts(generated, 0), /retention count/);
  assert.deepEqual((await readdir(generated)).sort(), names.slice(1));
  console.log('Backup pruning UTF-16 ordering tests passed.');
} finally {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('tsx-backup-prune-order-'));
  await rm(directory, { recursive: true, force: true });
}
