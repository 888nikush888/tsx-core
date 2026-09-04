import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertTestRegistry } from '../scripts/test_registry.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-test-registry-'));
try {
  await writeFile(path.join(directory, 'test_first.js'), 'throw new Error("Registry checks must not execute tests.");\n');
  await writeFile(path.join(directory, 'test_second.js'), '// second test\n');
  await writeFile(path.join(directory, 'fixture.js'), '// not a runnable test\n');
  await mkdir(path.join(directory, 'fixtures'));
  await writeFile(path.join(directory, 'fixtures', 'test_nested.js'), '// nested fixture, not a root test\n');
  const complete = ['test_first.js', 'test_second.js'];
  assert.throws(() => assertTestRegistry(directory, []), /nonempty test registry/i);
  assert.throws(() => assertTestRegistry(directory, null), /nonempty test registry/i);
  assert.doesNotThrow(() => assertTestRegistry(directory, complete));
  assert.doesNotThrow(() => assertTestRegistry(directory, [...complete].reverse()));
  assert.throws(() => assertTestRegistry(directory, ['test_first.js']), /unregistered.*test_second\.js/i);
  assert.throws(() => assertTestRegistry(directory, [...complete, 'test_absent.js']), /missing.*test_absent\.js/i);
  assert.throws(() => assertTestRegistry(directory, [...complete, 'test_first.js']), /duplicate.*test_first\.js/i);
  for (const entry of ['../test_escape.js', 'test_upper.JS', 'test_future.mjs', '', null]) {
    assert.throws(() => assertTestRegistry(directory, [...complete, entry]), /invalid.*test.*name/i);
  }
  const empty = path.join(directory, 'empty');
  await mkdir(empty);
  assert.throws(() => assertTestRegistry(empty, ['test_first.js']), /missing.*test_first\.js/i);
  await mkdir(path.join(directory, 'test_directory.js'));
  assert.throws(() => assertTestRegistry(directory, complete), /not a regular file.*test_directory\.js/i);
  console.log('Complete test registration: omissions, duplicates, missing files and unsafe entries are rejected before execution.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
