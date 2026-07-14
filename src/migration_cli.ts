import path from 'path';
import { loadEnv } from './env.js';
import { restorePreMigrationSnapshot } from './db.js';

async function main(): Promise<void> {
  loadEnv();
  const [command, snapshot, confirmation] = process.argv.slice(2);
  if (command !== 'restore' || !snapshot || confirmation !== '--confirm-restore-pre-migration') {
    throw new Error('Usage: npm run db:migration:restore -- <snapshot.db> --confirm-restore-pre-migration');
  }
  const target = path.resolve(
    process.env.FORWARDER_DB_PATH || path.join(process.cwd(), 'session_data', 'forwarder.db')
  );
  const result = await restorePreMigrationSnapshot(snapshot, target, path.dirname(target));
  console.log(`Pre-migration snapshot restored to ${target}.`);
  if (result.previousDatabase) console.log(`Previous database preserved at ${result.previousDatabase}.`);
  console.log('Start only the matching rollback image, then verify schema compatibility, outbox and readiness.');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
