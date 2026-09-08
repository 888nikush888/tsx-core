import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { copyDeclarations } from '../scripts/copy_declarations.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-declaration-artifacts-'));
try {
  const source = path.join(directory, 'src');
  const destination = path.join(directory, 'dist');
  await mkdir(path.join(source, 'nested'), { recursive: true });
  await mkdir(destination);
  const contract = 'export interface Contract { value: string }\n';
  await writeFile(path.join(source, 'root.d.ts'), contract);
  await writeFile(path.join(source, 'nested', 'contract.d.ts'), contract);
  await writeFile(path.join(source, 'nested', 'runtime.ts'), 'throw new Error("not an artifact");');
  await writeFile(path.join(destination, 'runtime.js'), 'export const ready = true;');
  await copyDeclarations(source, destination);
  assert.equal(await readFile(path.join(destination, 'root.d.ts'), 'utf8'), contract);
  assert.equal(await readFile(path.join(destination, 'nested', 'contract.d.ts'), 'utf8'), contract);
  assert.deepEqual(await readdir(path.join(destination, 'nested')), ['contract.d.ts']);
  assert.equal(await readFile(path.join(destination, 'runtime.js'), 'utf8'), 'export const ready = true;');
  await writeFile(path.join(source, 'root.d.ts'), `${contract}export type Updated = Contract;\n`);
  await copyDeclarations(source, destination);
  assert.equal(await readFile(path.join(destination, 'root.d.ts'), 'utf8'), `${contract}export type Updated = Contract;\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
console.log('Declaration artifacts preserve nested contracts, updates and emitted runtime files.');
