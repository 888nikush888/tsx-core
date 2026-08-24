import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

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
const output = stripVTControlCharacters(result.stdout);
const files = output.match(/Test Files\s+(\d+) passed \((\d+)\)/);
const tests = output.match(/Tests\s+(\d+) passed \((\d+)\)/);
assert.ok(files, `Frontend test-file result missing:\n${result.stdout}`);
assert.ok(tests, `Frontend test-count result missing:\n${result.stdout}`);
assert.equal(files[1], files[2], 'Every discovered frontend test file must pass.');
assert.equal(tests[1], tests[2], 'Every discovered frontend test must pass.');
assert.ok(Number(files[1]) >= 5, 'Frontend test-file coverage must not regress below five files.');
assert.ok(Number(tests[1]) >= 14, 'Frontend behavioral coverage must not regress below fourteen tests.');
console.log('Frontend enterprise behavior tests passed.');
