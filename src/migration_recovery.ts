import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { databaseFileIdentity, verifyDatabaseIntegrity } from './db.js';
import { assertMcpMaintenanceLease, type McpMaintenanceLease } from './mcp_maintenance.js';

interface PreservedDatabaseSet {
  previousDatabase: string | null;
  sidecars: Array<{ original: string; preserved: string }>;
}

export interface MigrationRestoreOptions { maintenanceLease?: McpMaintenanceLease }

async function pathExists(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true; } catch (error: any) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function assertMigrationFence(target: string, stateDirectory: string, lease?: McpMaintenanceLease): Promise<void> {
  await assertMcpMaintenanceLease(lease, target);
  const state = await fs.realpath(stateDirectory);
  if (state !== await fs.realpath(path.dirname(target))) throw new Error('Migration restore state directory differs from its maintenance database scope.');
  if (await pathExists(path.join(state, '.routing_active'))) throw new Error("Migration restore refused while '.routing_active' exists.");
}

async function verifySnapshot(snapshot: string, target: string, lease: McpMaintenanceLease): Promise<void> {
  if (snapshot === target) throw new Error('Migration snapshot and target database must be different files.');
  const stats = await fs.lstat(snapshot);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1) throw new Error('Migration snapshot must be a non-empty regular file.');
  if (lease.request.databaseState === 'present' && await databaseFileIdentity(snapshot) === lease.request.databaseIdentity) {
    throw new Error('Migration snapshot must not alias the operational database.');
  }
  await verifyDatabaseIntegrity(snapshot);
}

async function preserveDatabaseSet(target: string, restoreId: string, progress: PreservedDatabaseSet): Promise<void> {
  const preservationBase = `${target}.pre-migration-restore-${restoreId}`;
  if (await pathExists(target)) {
    await fs.rename(target, preservationBase);
    progress.previousDatabase = preservationBase;
  }
  for (const suffix of ['-wal', '-shm']) {
    const original = `${target}${suffix}`;
    if (await pathExists(original)) {
      const preserved = `${preservationBase}${suffix}`;
      await fs.rename(original, preserved);
      // Persist progress in the caller's record immediately; a later rename may fail.
      progress.sidecars.push({ original, preserved });
    }
  }
}

async function removeTemporaryDatabase(temporary: string): Promise<void> {
  for (const suffix of ['', '-wal', '-shm']) await fs.rm(`${temporary}${suffix}`, { force: true });
}

async function rollbackMigrationRestore(target: string, temporary: string, progress: PreservedDatabaseSet, installed: boolean): Promise<void> {
  if (installed) await fs.rm(target, { force: true });
  if (progress.previousDatabase) await fs.rename(progress.previousDatabase, target);
  for (const sidecar of progress.sidecars.slice().reverse()) await fs.rename(sidecar.preserved, sidecar.original);
  await removeTemporaryDatabase(temporary);
}

/** Physical recovery is an outer operation and always requires a genuine live maintenance capability. */
export async function restorePreMigrationSnapshot(
  snapshotPath: string,
  targetDatabasePath = process.env.FORWARDER_DB_PATH || path.join(process.cwd(), 'session_data', 'forwarder.db'),
  stateDirectory = path.dirname(path.resolve(targetDatabasePath)),
  options: MigrationRestoreOptions = {},
): Promise<{ previousDatabase: string | null }> {
  const snapshot = path.resolve(snapshotPath);
  const target = path.resolve(targetDatabasePath);
  const state = path.resolve(stateDirectory);
  await assertMigrationFence(target, state, options.maintenanceLease);
  await verifySnapshot(snapshot, target, options.maintenanceLease!);
  const restoreId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const temporary = `${target}.migration-restore-${restoreId}.tmp`;
  const progress: PreservedDatabaseSet = { previousDatabase: null, sidecars: [] };
  let installed = false;
  try {
    await fs.copyFile(snapshot, temporary, fs.constants.COPYFILE_EXCL);
    await verifyDatabaseIntegrity(temporary);
    await assertMigrationFence(target, state, options.maintenanceLease);
    await preserveDatabaseSet(target, restoreId, progress);
    await fs.rename(temporary, target);
    installed = true;
    await removeTemporaryDatabase(temporary);
    return { previousDatabase: progress.previousDatabase };
  } catch (error) {
    try { await rollbackMigrationRestore(target, temporary, progress, installed); }
    catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Migration restore and rollback failed; preserved files require explicit review.', { cause: rollbackError }); }
    throw error;
  }
}
