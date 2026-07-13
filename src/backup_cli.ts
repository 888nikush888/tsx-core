import path from 'path';
import { stat } from 'fs/promises';
import { createBackupArtifact, restoreBackupArtifact, verifyBackupArtifact } from './backup.js';
import { configPath, readConfigSync } from './config.js';
import { closeDb, initDb } from './db.js';
import { loadEnv } from './env.js';

function usage(): never {
  throw new Error([
    'Usage:',
    '  npm run backup:create -- [backup-directory]',
    '  npm run backup:verify -- <artifact-directory>',
    '  npm run backup:restore -- <artifact-directory>'
  ].join('\n'));
}

async function run(): Promise<void> {
  loadEnv();
  const [command, argument] = process.argv.slice(2);
  const databasePath = path.resolve(process.env.FORWARDER_DB_PATH || path.join(process.cwd(), 'session_data', 'forwarder.db'));
  if (command === 'create') {
    const backupDirectory = path.resolve(argument || process.env.BACKUP_DIR || path.join(process.cwd(), 'backups'));
    const databaseExists = await stat(databasePath).then(entry => entry.isFile()).catch((error: any) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    if (!databaseExists) throw new Error(`Source database does not exist: ${databasePath}`);
    await initDb(databasePath);
    try {
      const artifact = await createBackupArtifact(backupDirectory, readConfigSync());
      console.log(`Verified backup created: ${artifact}`);
    } finally {
      await closeDb();
    }
    return;
  }
  if (command === 'verify') {
    if (!argument) usage();
    const manifest = await verifyBackupArtifact(path.resolve(argument));
    console.log(`Backup verified: created=${manifest.createdAt}`);
    return;
  }
  if (command === 'restore') {
    if (!argument) usage();
    const restored = await restoreBackupArtifact(
      path.resolve(argument),
      databasePath,
      configPath,
      path.dirname(databasePath)
    );
    console.log(`Restore verified and installed. Previous database: ${restored.previousDatabase || 'none'}; previous config: ${restored.previousConfig || 'none'}`);
    return;
  }
  usage();
}

run().catch(error => {
  console.error(`Backup command failed: ${error.message}`);
  process.exitCode = 1;
});
