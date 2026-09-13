import { auditTrailFromEnvironment } from './audit_trail.js';
import { loadEnv } from './env.js';

function parseAuditCommand(args: string[]): { command: 'verify' | 'replay'; confirmation: string | undefined } {
  const [command, confirmation] = args;
  if (command !== 'verify' && command !== 'replay') {
    throw new Error('Usage: npm run audit:verify OR npm run audit:replay -- --confirm-audit-replay');
  }
  if (command === 'replay' && confirmation !== '--confirm-audit-replay') {
    throw new Error('Audit replay requires --confirm-audit-replay.');
  }
  return { command, confirmation };
}

async function main(): Promise<void> {
  loadEnv();
  const { command } = parseAuditCommand(process.argv.slice(2));
  const auditTrail = auditTrailFromEnvironment();
  await auditTrail.initialize();
  if (command === 'verify') {
    console.log(`Audit chain verified. records=${auditTrail.snapshot().recordCount}`);
    return;
  }
  const replayed = await auditTrail.replayRemote();
  console.log(`Audit replay completed. records=${replayed}`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
