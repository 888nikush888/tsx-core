import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', 'src/audit_cli.ts', 'replay'],
  { cwd: process.cwd(), encoding: 'utf8', timeout: 15_000 }
);

assert.equal(result.status, 1, 'Audit replay CLI must fail without explicit confirmation.');
assert.match(result.stderr, /requires --confirm-audit-replay/);

console.log('Audit CLI confirmation test passed.');
