import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', 'src/migration_cli.ts', 'restore', 'snapshot.db', '--wrong-confirmation'],
  { cwd: process.cwd(), encoding: 'utf8', timeout: 15_000 }
);

assert.equal(result.status, 1, 'Migration restore CLI must fail without the exact confirmation flag.');
assert.match(result.stderr, /Usage: npm run db:migration:restore/);

console.log('Migration CLI confirmation test passed.');
