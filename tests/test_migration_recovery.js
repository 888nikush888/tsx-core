import assert from 'node:assert/strict';
import { promises as fixtureFileSystem } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { acquireProcessLock } from '../src/process_lock.js';
import { beginMcpOfflineMaintenance } from '../src/mcp_maintenance.js';
import { restorePreMigrationSnapshot } from '../src/migration_recovery.js';

async function seed(file, value) {
  const database = await open({ filename: file, driver: sqlite3.Database });
  try { await database.exec('CREATE TABLE proof (value TEXT)'); await database.run('INSERT INTO proof VALUES (?)', value); }
  finally { await database.close(); }
}

async function fixture(test, absent = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'migration-recovery-fixture-'));
  const target = path.join(directory, 'operational.db');
  const snapshot = path.join(directory, 'snapshot.db');
  await seed(snapshot, 'restored');
  if (!absent) await seed(target, 'original');
  const owner = await acquireProcessLock(path.join(directory, '.process_active'));
  let lease;
  try {
    lease = await beginMcpOfflineMaintenance('isolated migration restore', target, owner);
    await lease.waitForQuiescence();
    await test({ directory, target, snapshot, lease });
  } finally { await lease?.release(); await owner.release(); await rm(directory, { recursive: true, force: true }); }
}

await fixture(async ({ directory, target, snapshot, lease }) => {
  const original = await readFile(target);
  await assert.rejects(restorePreMigrationSnapshot(snapshot, target, directory), /genuine.*lease/i);
  await assert.rejects(restorePreMigrationSnapshot(snapshot, target, directory, { maintenanceLease: { ...lease } }), /genuine.*lease/i);
  assert.deepEqual(await readFile(target), original);
  const result = await restorePreMigrationSnapshot(snapshot, target, directory, { maintenanceLease: lease });
  assert.deepEqual(await readFile(result.previousDatabase), original);
  assert.deepEqual(await readFile(target), await readFile(snapshot));
});

await fixture(async ({ directory, target, snapshot, lease }) => {
  assert.equal(lease.request.databaseState, 'absent');
  const result = await restorePreMigrationSnapshot(snapshot, target, directory, { maintenanceLease: lease });
  assert.equal(result.previousDatabase, null);
  assert.deepEqual(await readFile(target), await readFile(snapshot));
}, true);

await fixture(async ({ directory, target, snapshot, lease }) => {
  const originalCopy = fixtureFileSystem.copyFile;
  const original = await readFile(target);
  fixtureFileSystem.copyFile = async (...parameters) => { const result = await originalCopy(...parameters); await lease.release(); return result; };
  try {
    await assert.rejects(restorePreMigrationSnapshot(snapshot, target, directory, { maintenanceLease: lease }), /released/);
    assert.deepEqual(await readFile(target), original);
    assert.ok(!(await readdir(directory)).some(file => file.includes('.migration-restore-')));
  } finally { fixtureFileSystem.copyFile = originalCopy; }
});

await fixture(async ({ directory, target, snapshot, lease }) => {
  const originalRename = fixtureFileSystem.rename;
  const original = await readFile(target);
  await writeFile(`${target}-wal`, 'fixture WAL ownership');
  await writeFile(`${target}-shm`, 'fixture SHM ownership');
  let failed = false;
  fixtureFileSystem.rename = async (source, destination) => {
    if (!failed && source === `${target}-shm`) { failed = true; throw new Error('fixture third preserve rename failed'); }
    return originalRename(source, destination);
  };
  try {
    await assert.rejects(restorePreMigrationSnapshot(snapshot, target, directory, { maintenanceLease: lease }), /third preserve rename/);
    assert.equal(failed, true);
    assert.deepEqual(await readFile(target), original, 'Rollback must know the DB rename even when a later sidecar rename failed.');
    assert.equal(await readFile(`${target}-wal`, 'utf8'), 'fixture WAL ownership');
    assert.equal(await readFile(`${target}-shm`, 'utf8'), 'fixture SHM ownership');
    assert.ok(!(await readdir(directory)).some(file => file.includes('.migration-restore-')));
  } finally { fixtureFileSystem.rename = originalRename; }
});

console.log('Migration restore: genuine maintenance capability, absent target, final fence and partial-rename rollback passed.');
