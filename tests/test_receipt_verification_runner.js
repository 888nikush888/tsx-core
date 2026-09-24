import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertExactHeadClean, assertSourceMatchesHead, parseOptions } from '../scripts/run_receipt_verification.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const temporary = realpathSync.native(os.tmpdir());
const root = mkdtempSync(path.join(temporary, 'tsx-receipt-runner-'));
function git(args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', shell: false, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

try {
  const revision = 'a'.repeat(40);
  const python = path.resolve(root, 'python');
  const valid = ['--sha', revision, '--python', python, '--group', 'backend', '--tag', 'freeze-1'];
  assert.deepEqual(parseOptions(valid), { revision, python, group: 'backend', tag: 'freeze-1' });
  for (const args of [valid.slice(0, 6), [...valid.slice(0, 6), '--group', 'python'],
    [...valid.slice(0, 1), 'not-a-sha', ...valid.slice(2)],
    [...valid.slice(0, 3), 'relative-python', ...valid.slice(4)],
    [...valid.slice(0, 5), 'unknown', ...valid.slice(6)],
    [...valid.slice(0, 7), '../escape']]) {
    assert.throws(() => parseOptions(args), /Receipt verification refused/);
  }

  git(['init', '-q']);
  git(['config', 'user.email', 'receipt-test@example.invalid']);
  git(['config', 'user.name', 'Receipt Test']);
  git(['config', 'core.autocrlf', 'false']);
  mkdirSync(path.join(root, 'src'));
  const source = path.join(root, 'src', 'sample.ts');
  writeFileSync(source, 'export const value = 1;\n');
  writeFileSync(path.join(root, '.gitignore'), 'src/ignored.ts\n');
  git(['add', '--', '.gitignore', 'src/sample.ts']);
  git(['commit', '-q', '-m', 'Frozen fixture']);
  const head = git(['rev-parse', 'HEAD']);
  const inventory = { files: [{ path: 'src/sample.ts', sha256: hash(readFileSync(source)) }] };
  assert.equal(assertExactHeadClean(root, head), head);
  assertSourceMatchesHead(root, head, inventory);
  assert.throws(() => assertExactHeadClean(root, revision), /HEAD differs/);

  writeFileSync(source, 'export const value = 2;\n');
  assert.throws(() => assertExactHeadClean(root, head), /dirty/);
  assert.throws(() => assertSourceMatchesHead(root, head,
    { files: [{ path: 'src/sample.ts', sha256: hash(readFileSync(source)) }] }), /differ from Git/);
  writeFileSync(source, 'export const value = 1;\n');
  assert.equal(assertExactHeadClean(root, head), head);

  const ignored = path.join(root, 'src', 'ignored.ts');
  writeFileSync(ignored, 'export const ignored = true;\n');
  assert.equal(assertExactHeadClean(root, head), head, 'Git status alone cannot catch an ignored source addition');
  assert.throws(() => assertSourceMatchesHead(root, head,
    { files: [...inventory.files, { path: 'src/ignored.ts', sha256: hash(readFileSync(ignored)) }] }), /missing Git blob/);
  console.log('PASS receipt evidence runner: arguments, clean SHA, tracked drift and ignored source drift');
} finally {
  assert.equal(path.dirname(realpathSync.native(root)), temporary);
  assert.match(path.basename(root), /^tsx-receipt-runner-[a-zA-Z0-9]+$/);
  rmSync(root, { recursive: true, force: true });
}
