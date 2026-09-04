import path from 'node:path';
import { stat } from 'node:fs/promises';
import { backupConfigurationSources, createBackupArtifact, inspectBackupArtifact, restoreBackupArtifact } from './backup.js';
import { runIsolatedBackupRestoreDrill } from './backup_restore_drill.js';
import { configPath, readConfigSync, writeConfigSync } from './config.js';
import { initializeConfigurationGeneration, reenrollConfigurationGeneration } from './backup_generation.js';
import { closeDb, initDb } from './db.js';
import { loadEnv } from './env.js';
import { acquireProcessLock } from './process_lock.js';
import { beginMcpOfflineMaintenance, type McpMaintenanceLease } from './mcp_maintenance.js';

function usage(): never {
  throw new Error([
    'Usage:',
    '  node dist/backup_cli.js create [backup-directory]',
    '  node dist/backup_cli.js verify <artifact-directory>',
    '  node dist/backup_cli.js drill <artifact-directory>  (isolated local restore; no runtime startup)',
    '  node dist/backup_cli.js restore <artifact-directory>'
  ].join('\n'));
}

async function restoreOfflineBackup(artifactPath: string, databasePath: string): Promise<void> {
  const stateDirectory = path.dirname(databasePath);
  const owner = await acquireProcessLock(path.join(stateDirectory, '.process_active'));
  let maintenanceLease: McpMaintenanceLease | undefined;
  try {
    maintenanceLease = await beginMcpOfflineMaintenance('offline backup restore', databasePath, owner);
    await maintenanceLease.waitForQuiescence();
    const restored = await restoreBackupArtifact(artifactPath, databasePath, configPath, stateDirectory, { maintenanceLease });
    await maintenanceLease.release();
    maintenanceLease = await beginMcpOfflineMaintenance('restored configuration generation', databasePath, owner);
    await maintenanceLease.waitForQuiescence();
    await reenrollConfigurationGeneration(backupConfigurationSources(databasePath), owner, maintenanceLease);
    console.log(`Restore verified and installed. Previous database: ${restored.previousDatabase || 'none'}; previous config: ${restored.previousConfig || 'none'}`);
  } finally {
    try { await maintenanceLease?.release(); } finally { await owner.release(); }
  }
}

async function run(): Promise<void> {
  const [command, argument] = process.argv.slice(2);
  if (command === 'verify' || command === 'drill') {
    if (!argument) usage();
    const evidence = await inspectBackupArtifact(path.resolve(argument));
    if (command === 'drill') evidence.restoreDrill = await runIsolatedBackupRestoreDrill(path.resolve(argument));
    console.log(JSON.stringify(evidence, null, 2));
    return;
  }
  loadEnv();
  const databasePath = path.resolve(process.env.FORWARDER_DB_PATH || path.join(process.cwd(), 'session_data', 'forwarder.db'));
  if (command === 'create') {
    const backupDirectory = path.resolve(argument || process.env.BACKUP_DIR || path.join(process.cwd(), 'backups'));
    const databaseExists = await stat(databasePath).then(entry => entry.isFile()).catch((error: any) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    if (!databaseExists) throw new Error(`Source database does not exist: ${databasePath}`);
    const owner = await acquireProcessLock(path.join(path.dirname(databasePath), '.process_active'));
    try {
      const config = readConfigSync();
      writeConfigSync(config);
      await initializeConfigurationGeneration(backupConfigurationSources(databasePath), owner);
      await initDb(databasePath);
      const artifact = await createBackupArtifact(backupDirectory, config);
      console.log(`Verified backup created: ${artifact}`);
      console.log(JSON.stringify(await inspectBackupArtifact(artifact), null, 2));
    } finally {
      await closeDb();
      await owner.release();
    }
    return;
  }
  if (command === 'restore') {
    if (!argument) usage();
    await restoreOfflineBackup(path.resolve(argument), databasePath);
    return;
  }
  usage();
}

try {
  await run();
} catch (error: any) {
  console.error(`Backup command failed: ${error.message}`);
  process.exitCode = 1;
}
