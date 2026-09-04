import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { acquireProcessLock } from '../../src/process_lock.js';
import { initializeConfigurationGeneration } from '../../src/backup_generation.js';
import { DEFAULT_CONFIG, writeConfigSync } from '../../src/config.js';

const [directory, boundary] = process.argv.slice(2);
const root = fs.realpathSync(directory);
assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
assert.ok(path.basename(root).startsWith('tsx-generation-hard-crash-'));
const sources = { databasePath: path.join(root, 'forwarder.db'), configurationPath: path.join(root, 'config.json'),
  runtimeSettingsPath: path.join(root, 'runtime-settings.json'), templatesDirectory: path.join(root, 'templates') };
const generationRoot = path.join(root, '.config.json.tsx-generations');
const headPath = path.join(generationRoot, 'head.json');
const config = { ...structuredClone(DEFAULT_CONFIG), apiId: 17 };

fs.mkdirSync(sources.templatesDirectory);
fs.writeFileSync(path.join(sources.templatesDirectory, 'default.xml'), '<signal>fixture-only</signal>');
fs.writeFileSync(sources.runtimeSettingsPath, '{"shutdownGraceMs":30000}\n');
writeConfigSync(config, sources.configurationPath);
await acquireProcessLock(path.join(root, '.process_active')).then(async owner => {
  await initializeConfigurationGeneration(sources, owner);
});
const initialHeadSha256 = createHash('sha256').update(fs.readFileSync(headPath)).digest('hex');
const original = { open: fs.openSync, rename: fs.renameSync, sync: fs.fsyncSync, close: fs.closeSync, write: fs.writeSync };
const directories = new Map([
  [root, 'target-directory'],
  [path.join(generationRoot, 'objects'), 'objects-directory'],
  [generationRoot, 'generation-directory'],
]);
const descriptors = new Map();
const unsupported = new Set(['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM']);

function pause(actual, detail = {}) {
  if (boundary !== actual) return;
  // Synchronous pipe output is delivered before blocking the event loop. No
  // exception/finally simulates the crash: the parent kills this real process.
  original.write(1, `${JSON.stringify({ type: 'boundary', boundary, pid: process.pid, initialHeadSha256, ...detail })}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error('The crash fixture must only be resumed by process termination.');
}

function failedDirectoryAttempt(phase, error) {
  if (phase && unsupported.has(error?.code)) pause(`${phase}-after`, { syncSupported: false, syncError: error.code });
  throw error;
}

fs.renameSync = (source, destination) => {
  const phase = new Map([[sources.configurationPath, 'target'], [headPath, 'head']]).get(path.resolve(destination));
  if (phase) pause(`${phase}-before`);
  const result = original.rename(source, destination);
  if (phase) pause(`${phase}-after`);
  return result;
};

fs.openSync = (destination, ...args) => {
  const phase = typeof destination === 'string' ? directories.get(path.resolve(destination)) : undefined;
  if (phase) pause(`${phase}-before`);
  try {
    const descriptor = original.open(destination, ...args);
    if (phase) descriptors.set(descriptor, phase);
    return descriptor;
  } catch (error) { return failedDirectoryAttempt(phase, error); }
};

fs.fsyncSync = descriptor => {
  const phase = descriptors.get(descriptor);
  try {
    const result = original.sync(descriptor);
    if (phase) pause(`${phase}-after`, { syncSupported: true });
    return result;
  } catch (error) { return failedDirectoryAttempt(phase, error); }
};

fs.closeSync = descriptor => {
  descriptors.delete(descriptor);
  return original.close(descriptor);
};

writeConfigSync({ ...config, apiId: 18 }, sources.configurationPath);
throw new Error(`Expected filesystem boundary was not reached: ${boundary}`);
