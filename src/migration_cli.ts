import path from 'node:path';
import { loadEnv } from './env.js';
import { restorePreMigrationSnapshot } from './migration_recovery.js';
import { acquireProcessLock } from './process_lock.js';
import { beginMcpOfflineMaintenance, type McpMaintenanceLease } from './mcp_maintenance.js';

async function restoreOfflineSnapshot(snapshot: string, target: string): Promise<{ previousDatabase: string | null }> {
  const state = path.dirname(target);
  const owner = await acquireProcessLock(path.join(state, '.process_active'));
  let maintenanceLease: McpMaintenanceLease | undefined;
  try {
    maintenanceLease = await beginMcpOfflineMaintenance('offline pre-migration restore', target, owner);
    await maintenanceLease.waitForQuiescence();
    return await restorePreMigrationSnapshot(snapshot, target, state, { maintenanceLease });
  } finally {
    try { await maintenanceLease?.release(); } finally { await owner.release(); }
  }
}

function parsedRestoreArguments(args: string[]): { snapshot: string } {
  const [command, snapshot, confirmation] = args;
  if (command !== 'restore' || !snapshot || confirmation !== '--confirm-restore-pre-migration') {
    throw new Error('Usage: node dist/migration_cli.js restore <snapshot.db> --confirm-restore-pre-migration');
  }
  return { snapshot };
}

function restoreTarget(): string {
  return path.resolve(
    process.env.FORWARDER_DB_PATH || path.join(process.cwd(), 'session_data', 'forwarder.db'),
  );
}

function reportRestoreResult(target: string, result: { previousDatabase: string | null }): void {
  console.log(`Pre-migration snapshot restored to ${target}.`);
  if (result.previousDatabase) console.log(`Previous database preserved at ${result.previousDatabase}.`);
  console.log('Start only the matching rollback image, then verify schema compatibility, outbox and readiness.');
}

async function main(): Promise<void> {
  loadEnv();
  const { snapshot } = parsedRestoreArguments(process.argv.slice(2));
  const target = restoreTarget();
  const result = await restoreOfflineSnapshot(snapshot, target);
  reportRestoreResult(target, result);
}

try {
  await main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
