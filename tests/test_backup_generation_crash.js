import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { acquireProcessLock, ProcessLockRecoveryRequiredError } from '../src/process_lock.js';
import { initializeConfigurationGeneration, withPinnedConfigurationGeneration } from '../src/backup_generation.js';

const fixture = fileURLToPath(new URL('./fixtures/backup_generation_crash_child.js', import.meta.url));
const cases = [
  { boundary: 'target-before', apiId: 17, generation: 1 },
  { boundary: 'target-after', apiId: 18, generation: 1 },
  { boundary: 'target-directory-before', apiId: 18, generation: 1 },
  { boundary: 'target-directory-after', apiId: 18, generation: 1 },
  { boundary: 'head-before', apiId: 18, generation: 1 },
  { boundary: 'head-after', apiId: 18, generation: 2 },
  { boundary: 'objects-directory-before', apiId: 18, generation: 2 },
  { boundary: 'objects-directory-after', apiId: 18, generation: 2 },
  { boundary: 'generation-directory-before', apiId: 18, generation: 2 },
  { boundary: 'generation-directory-after', apiId: 18, generation: 2 },
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const unsupportedDirectories = [];

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not finish within 15 seconds.`)), 15_000);
    })]);
  } finally { clearTimeout(timer); }
}

function launch(root, boundary) {
  const child = spawn(process.execPath, ['--import', 'tsx', fixture, root, boundary], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => {
    child.once('error', error => resolve({ error }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const ready = new Promise((resolve, reject) => {
    let output = '';
    child.stdout.setEncoding('utf8').on('data', chunk => {
      output += chunk;
      if (!output.includes('\n')) return;
      try { resolve(JSON.parse(output.slice(0, output.indexOf('\n')))); }
      catch (error) { reject(error); }
    });
    exited.then(result => reject(new Error(`Child exited before boundary ${boundary}: ${JSON.stringify(result)} ${stderr}`)));
  });
  return { child, exited, ready };
}

function sourcesFor(root) {
  return { databasePath: path.join(root, 'forwarder.db'), configurationPath: path.join(root, 'config.json'),
    runtimeSettingsPath: path.join(root, 'runtime-settings.json'), templatesDirectory: path.join(root, 'templates') };
}

async function assertImmutableHead(root, head) {
  for (const resource of Object.values(head.resources)) {
    const content = await readFile(path.join(root, '.config.json.tsx-generations', 'objects', resource.sha256));
    assert.equal(content.length, resource.size);
    assert.equal(hash(content), resource.sha256, 'Every published head refers to complete immutable bytes.');
  }
}

async function assertLocksPreserved(root, marker, pin) {
  const locks = [path.join(root, '.process_active'), path.join(root, '.config.json.tsx-generations.lock')];
  const bytes = await Promise.all(locks.map(lock => readFile(lock)));
  for (const payload of bytes) assert.equal(JSON.parse(payload).pid, marker.pid);
  await assert.rejects(acquireProcessLock(locks[0]), ProcessLockRecoveryRequiredError);
  await assert.rejects(pin(async () => assert.fail('An abandoned barrier must not authorize a snapshot.')), /barrier is busy/);
  for (let index = 0; index < locks.length; index++) assert.deepEqual(await readFile(locks[index]), bytes[index]);
  return { locks, bytes };
}

async function reviewedFixtureRecovery(root, marker, preserved) {
  // Test-only reviewed recovery after observed child exit. Production deliberately
  // has no dead-PID auto-delete. Move just these two checked fixture-owned files.
  assert.throws(() => process.kill(marker.pid, 0), { code: 'ESRCH' });
  assert.equal(path.dirname(await fs.promises.realpath(root)), await fs.promises.realpath(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('tsx-generation-hard-crash-'));
  for (let index = 0; index < preserved.locks.length; index++) {
    const lock = preserved.locks[index];
    assert.equal(path.dirname(lock), root);
    assert.deepEqual(await readFile(lock), preserved.bytes[index]);
    const reviewed = `${lock}.reviewed-${marker.pid}`;
    await rename(lock, reviewed);
    assert.deepEqual(await readFile(reviewed), preserved.bytes[index]);
  }
}

async function assertRestart(root, expected, marker, pin) {
  const sources = sourcesFor(root);
  const headPath = path.join(root, '.config.json.tsx-generations', 'head.json');
  const headBytes = await readFile(headPath);
  const head = JSON.parse(headBytes);
  assert.equal(JSON.parse(await readFile(sources.configurationPath, 'utf8')).apiId, expected.apiId);
  assert.equal(head.generation, expected.generation);
  if (expected.generation === 1) assert.equal(hash(headBytes), marker.initialHeadSha256);
  else assert.notEqual(hash(headBytes), marker.initialHeadSha256);
  await assertImmutableHead(root, head);
  const preserved = await assertLocksPreserved(root, marker, pin);
  await reviewedFixtureRecovery(root, marker, preserved);
  const owner = await acquireProcessLock(path.join(root, '.process_active'));
  try {
    if (expected.apiId === 18 && expected.generation === 1) {
      await assert.rejects(initializeConfigurationGeneration(sources, owner), /outside their committed generation/);
      await assert.rejects(pin(async () => assert.fail('Mixed generations must not publish.')), /outside their committed generation/);
    } else {
      const resumed = await initializeConfigurationGeneration(sources, owner);
      assert.equal(resumed.generation, expected.generation);
      await pin(async generation => {
        assert.equal(generation.evidence.commitId, head.commitId);
        assert.equal(JSON.parse(generation.files.get('config.json')).apiId, expected.apiId);
      });
    }
    assert.deepEqual(await readFile(headPath), headBytes, 'Restart never silently adopts staged or externally changed bytes.');
    if (expected.boundary === 'head-before') {
      const staged = (await readdir(path.dirname(headPath))).filter(name => name.startsWith('head-') && name.endsWith('.tmp'));
      assert.equal(staged.length, 1, 'Interrupted head remains reviewable, not automatically committed.');
      assert.equal(JSON.parse(await readFile(path.join(path.dirname(headPath), staged[0]), 'utf8')).generation, 2);
    }
  } finally { await owner.release(); }
}

async function crashCase(expected) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tsx-generation-hard-crash-'));
  const launched = launch(root, expected.boundary);
  try {
    const marker = await bounded(launched.ready, expected.boundary);
    assert.equal(marker.type, 'boundary');
    assert.equal(marker.boundary, expected.boundary);
    assert.equal(marker.pid, launched.child.pid);
    assert.equal(launched.child.kill('SIGKILL'), true);
    const ended = await bounded(launched.exited, `${expected.boundary} child termination`);
    assert.equal(ended.signal, 'SIGKILL', 'Termination must bypass normal cleanup/finally.');
    if (marker.syncSupported === false) unsupportedDirectories.push(`${expected.boundary}:${marker.syncError}`);
    const sources = sourcesFor(root);
    const pin = callback => withPinnedConfigurationGeneration(sources.configurationPath, sources.databasePath, callback);
    await assertRestart(root, expected, marker, pin);
  } finally {
    if (launched.child.exitCode === null && launched.child.signalCode === null) launched.child.kill('SIGKILL');
    await bounded(launched.exited, 'Fixture cleanup termination');
    await rm(root, { recursive: true, force: true });
  }
}

for (const expected of cases) await crashCase(expected);
console.log(`Configuration generation: ${cases.length} real child-kill rename/directory-sync boundaries passed; locks preserved and mixed heads refused.`);
if (unsupportedDirectories.length) console.log(`Directory-sync attempts unsupported on this host: ${unsupportedDirectories.join(', ')}. No power-loss durability claim.`);
