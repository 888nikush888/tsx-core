import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const frontend = path.resolve('frontend');
const vitest = path.join(frontend, 'node_modules', 'vitest', 'vitest.mjs');
const result = spawnSync(process.execPath, [vitest, 'run', '--configLoader', 'runner', '--environment', 'jsdom', 'tests'], {
  cwd: frontend,
  env: process.env,
  encoding: 'utf8',
  shell: false,
  timeout: 120_000,
  windowsHide: true,
});

assert.ifError(result.error);
assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
assert.match(result.stdout, /20 passed/);
console.log('Frontend enterprise behavior tests passed.');
