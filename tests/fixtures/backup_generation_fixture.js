import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { backupConfigurationSources } from '../../src/backup.js';
import { initializeConfigurationGeneration } from '../../src/backup_generation.js';
import { acquireProcessLock } from '../../src/process_lock.js';

/** Enroll only newly created temporary test scopes, with real application ownership. */
export async function enrollBackupFixture(config, databasePath) {
  const sources = backupConfigurationSources(databasePath);
  await mkdir(path.dirname(sources.configurationPath), { recursive: true });
  await writeFile(sources.configurationPath, JSON.stringify(config));
  const owner = await acquireProcessLock(path.join(path.dirname(databasePath), '.process_active'));
  try { return await initializeConfigurationGeneration(sources, owner); }
  finally { await owner.release(); }
}
