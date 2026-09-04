import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireProcessLock } from '../src/process_lock.js';
import { initializeConfigurationGeneration, withPinnedConfigurationGeneration } from '../src/backup_generation.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded(promise, label, milliseconds = 10_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out.`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

const root = await mkdtemp(path.join(os.tmpdir(), 'tsx-generation-owner-race-'));
const sources = { databasePath: path.join(root, 'forwarder.db'), configurationPath: path.join(root, 'config.json'),
  runtimeSettingsPath: path.join(root, 'runtime-settings.json'), templatesDirectory: path.join(root, 'templates') };
const reached = deferred();
const continueRead = deferred();
const originalRead = fs.promises.readFile;
let owner;
let enrollment;
let release;
try {
  await mkdir(sources.templatesDirectory);
  await writeFile(path.join(sources.templatesDirectory, 'default.xml'), '<signal>owner-race-fixture</signal>');
  await writeFile(sources.configurationPath, '{"apiId":17}\n');
  owner = await acquireProcessLock(path.join(root, '.process_active'));
  let paused = false;
  fs.promises.readFile = async (...parameters) => {
    const result = await originalRead(...parameters);
    if (!paused && parameters[0] === owner.path) {
      paused = true;
      reached.resolve();
      await continueRead.promise;
    }
    return result;
  };
  // Hold real ownership validation after its real native read, before commit.
  // A validation-only implementation lets release overtake this async gap.
  enrollment = initializeConfigurationGeneration(sources, owner);
  enrollment.catch(() => undefined);
  await bounded(reached.promise, 'Enrollment ownership validation');
  let released = false;
  release = owner.release().then(() => { released = true; });
  release.catch(() => undefined);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(released, false, 'Actual owner.release must remain queued behind enrollment, not revoke its authority mid-commit.');
  assert.equal(JSON.parse(await originalRead(owner.path, 'utf8')).pid, process.pid);
  assert.equal(fs.existsSync(path.join(root, '.config.json.tsx-generations', 'head.json')), false);
  continueRead.resolve();
  const evidence = await bounded(enrollment, 'Enrollment completion');
  await bounded(release, 'Queued ownership release');
  assert.equal(evidence.generation, 1);
  assert.equal(released, true);
  await assert.rejects(readFile(owner.path), { code: 'ENOENT' });
  await assert.rejects(initializeConfigurationGeneration(sources, owner), /released/);
  await withPinnedConfigurationGeneration(sources.configurationPath, sources.databasePath, async generation => {
    assert.equal(generation.evidence.commitId, evidence.commitId);
    assert.equal(JSON.parse(generation.files.get('config.json')).apiId, 17);
  });
  console.log('Configuration generation: genuine enrollment-vs-owner.release race serialized through the complete commit.');
} finally {
  continueRead.resolve();
  fs.promises.readFile = originalRead;
  await bounded(Promise.allSettled([enrollment, release]), 'Ownership fixture settlement');
  await owner?.release();
  await rm(root, { recursive: true, force: true });
}
