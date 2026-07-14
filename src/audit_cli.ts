import { auditTrailFromEnvironment } from './audit_trail.js';
import { loadEnv } from './env.js';

async function main(): Promise<void> {
  loadEnv();
  const [command, confirmation] = process.argv.slice(2);
  if (!['verify', 'replay'].includes(command || '')) {
    throw new Error('Usage: npm run audit:verify OR npm run audit:replay -- --confirm-audit-replay');
  }
  if (command === 'replay' && confirmation !== '--confirm-audit-replay') {
    throw new Error('Audit replay requires --confirm-audit-replay.');
  }
  const auditTrail = auditTrailFromEnvironment();
  await auditTrail.initialize();
  if (command === 'verify') {
    console.log(`Audit chain verified. records=${auditTrail.snapshot().recordCount}`);
    return;
  }
  const replayed = await auditTrail.replayRemote();
  console.log(`Audit replay completed. records=${replayed}`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
