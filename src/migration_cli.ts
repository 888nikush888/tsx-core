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

async function main(): Promise<void> {
  loadEnv();
  const [command, snapshot, confirmation] = process.argv.slice(2);
  if (command !== 'restore' || !snapshot || confirmation !== '--confirm-restore-pre-migration') {
    throw new Error('Usage: node dist/migration_cli.js restore <snapshot.db> --confirm-restore-pre-migration');
  }
  const target = path.resolve(
    process.env.FORWARDER_DB_PATH || path.join(process.cwd(), 'session_data', 'forwarder.db')
  );
  const result = await restoreOfflineSnapshot(snapshot, target);
  console.log(`Pre-migration snapshot restored to ${target}.`);
  if (result.previousDatabase) console.log(`Previous database preserved at ${result.previousDatabase}.`);
  console.log('Start only the matching rollback image, then verify schema compatibility, outbox and readiness.');
}

try {
  await main();
} catch (error: any) {
  console.error(error.message);
  process.exitCode = 1;
}
