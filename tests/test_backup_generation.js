import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initializeConfigurationGeneration, reenrollConfigurationGeneration, retireConfigurationGeneration, withManagedConfigurationWrite, withPinnedConfigurationGeneration } from '../src/backup_generation.js';
import { beginMcpSharedMaintenance } from '../src/mcp_maintenance.js';
import { DEFAULT_CONFIG, writeConfig, writeConfigSync } from '../src/config.js';
import { DEFAULT_RUNTIME_SETTINGS, ManagedRuntimeSettingsStore } from '../src/runtime_settings.js';
import { acquireProcessLock } from '../src/process_lock.js';
import { backupDatabase, closeDb, getDatabase, initDb } from '../src/db.js';
import { createBackupArtifact, verifyBackupArtifact } from '../src/backup.js';
import { signalTemplatesDirectoryFromEnvironment } from '../src/configuration_paths.js';
import { backupConfigurationSources } from '../src/backup.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'backup-generation-'));
const previousConfigPath = process.env.CONFIG_PATH;
const sources = { databasePath: path.join(root, 'forwarder.db'), configurationPath: path.join(root, 'config.json'),
  runtimeSettingsPath: path.join(root, 'runtime-settings.json'), templatesDirectory: path.join(root, 'templates') };
const env = { CONFIG_PATH: sources.configurationPath, RUNTIME_SETTINGS_PATH: sources.runtimeSettingsPath };
const settings = new ManagedRuntimeSettingsStore(sources.runtimeSettingsPath, env);
const config = { ...structuredClone(DEFAULT_CONFIG), apiId: 17 };
const template = path.join(sources.templatesDirectory, 'default.xml');
const generationRoot = path.join(root, '.config.json.tsx-generations');
const pin = callback => withPinnedConfigurationGeneration(sources.configurationPath, sources.databasePath, callback);
let owner;

async function initialization() {
  await mkdir(sources.templatesDirectory);
  await writeFile(template, '<signal>original</signal>');
  await writeConfig(config, sources.configurationPath);
  await settings.initialize();
  await assert.rejects(pin(async () => {}), /has not been enrolled/);
  await assert.rejects(initializeConfigurationGeneration(sources, { path: path.join(root, '.process_active') }), /ownership|capability/i);
  owner = await acquireProcessLock(path.join(root, '.process_active'));
  const first = await initializeConfigurationGeneration(sources, owner);
  assert.equal(first.generation, 1);
  assert.deepEqual(Object.keys(first.files).sort(), ['config.json', 'runtime-settings.json', 'templates/default.xml']);
  assert.ok(!JSON.stringify(first).includes(root), 'Portable generation evidence contains no local source paths.');
  assert.deepEqual(await initializeConfigurationGeneration(sources, owner), first, 'Restart reuses the exact committed generation.');
  await initDb(sources.databasePath);
  return first;
}

async function writerAndSnapshot(first) {
  const next = { ...config, apiId: 18, apiHash: 'must-not-be-exported' };
  writeConfigSync(next, sources.configurationPath);
  await settings.set({ ...DEFAULT_RUNTIME_SETTINGS, shutdownGraceMs: 45_000 });
  await pin(async generation => {
    assert.equal(generation.evidence.generation, first.generation + 2);
    assert.equal(JSON.parse(generation.files.get('config.json')).apiId, 18);
    assert.ok(!generation.files.get('config.json').toString().includes('must-not-be-exported'));
    assert.equal(JSON.parse(generation.files.get('runtime-settings.json')).shutdownGraceMs, 45_000);
    assert.throws(() => writeConfigSync(config, sources.configurationPath), /barrier is busy/);
    await assert.rejects(settings.set(DEFAULT_RUNTIME_SETTINGS), /barrier is busy/);
    assert.equal(settings.snapshot().shutdownGraceMs, 45_000, 'Failed writer must not publish an in-memory setting.');
    await backupDatabase(path.join(root, 'pinned.sqlite'));
    assert.equal(JSON.parse(await readFile(sources.configurationPath, 'utf8')).apiId, 18);
  });
  await assert.rejects(withPinnedConfigurationGeneration(sources.configurationPath, path.join(root, 'different.db'), async () => {}), /another database/);
}

async function externalChanges() {
  const original = await readFile(template);
  await writeFile(template, '<signal>external</signal>');
  await assert.rejects(pin(async () => {}), /outside their committed generation/);
  await assert.rejects(initializeConfigurationGeneration(sources, owner), /outside their committed generation/,
    'Ordinary startup ownership is not permission to silently adopt external edits.');
  await writeFile(template, original);
  await assert.rejects(pin(async () => { await writeFile(template, '<signal>changed-during-snapshot</signal>'); }), /outside their committed generation/);
  await writeFile(template, original);
  await pin(async () => {});
  const foreign = path.join(root, 'different-runtime.json');
  await assert.rejects(withManagedConfigurationWrite(sources.configurationPath, foreign, '{}', async () => { throw new Error('must not run'); }), /different.*scope/);
  const originalConfig = await readFile(sources.configurationPath);
  await assert.rejects(withManagedConfigurationWrite(sources.configurationPath, sources.configurationPath, JSON.stringify({ ...config, apiId: 19 }), async () => {
    await writeFile(sources.configurationPath, JSON.stringify({ ...config, apiId: 19 }));
    await writeFile(template, '<signal>unrelated-change-during-config-write</signal>');
  }), /unrelated configuration source changed/);
  await assert.rejects(pin(async () => {}), /outside their committed generation/);
  // Exact fixture rollback; production requires an explicit maintenance recovery.
  await writeFile(template, original);
  await writeFile(sources.configurationPath, originalConfig);
}

async function interruptedWriteAndObjects() {
  const headBefore = await readFile(path.join(generationRoot, 'head.json'));
  const originalConfig = await readFile(sources.configurationPath);
  await assert.rejects(withManagedConfigurationWrite(sources.configurationPath, sources.configurationPath, JSON.stringify({ ...config, apiId: 20 }), async () => {
    await writeFile(sources.configurationPath, JSON.stringify({ ...config, apiId: 20 }));
    throw new Error('simulated crash after file rename');
  }), /simulated crash/);
  assert.deepEqual(await readFile(path.join(generationRoot, 'head.json')), headBefore);
  await assert.rejects(pin(async () => {}), /outside their committed generation/);
  await writeFile(sources.configurationPath, originalConfig);
  const head = JSON.parse(headBefore);
  const objectPath = path.join(generationRoot, 'objects', head.resources['templates/default.xml'].sha256);
  const originalObject = await readFile(objectPath);
  await writeFile(objectPath, 'tampered immutable object');
  await assert.rejects(pin(async () => {}), /Immutable configuration object failed verification/);
  await writeFile(objectPath, originalObject);
  await pin(async () => {});
  await writeFile(`${generationRoot}.lock`, 'unknown-owner', { flag: 'wx' });
  await assert.rejects(pin(async () => {}), /barrier is busy/);
  assert.equal(await readFile(`${generationRoot}.lock`, 'utf8'), 'unknown-owner', 'Unproven locks are preserved, never adopted by PID.');
  await rm(`${generationRoot}.lock`);
}

async function realBackupCoherence() {
  process.env.CONFIG_PATH = sources.configurationPath;
  const currentConfig = JSON.parse(await readFile(sources.configurationPath, 'utf8'));
  const backupRoot = path.join(root, 'backups');
  const artifact = await createBackupArtifact(backupRoot, currentConfig);
  const manifest = await verifyBackupArtifact(artifact);
  assert.equal(manifest.configuration.generation, 3);
  assert.deepEqual(JSON.parse(await readFile(path.join(artifact, 'config.json'), 'utf8')), currentConfig);
  await assert.rejects(createBackupArtifact(backupRoot, { ...currentConfig, apiId: 99 }), /provider does not match/);
  const native = getDatabase().getDatabaseInstance();
  const backup = native.backup;
  const originalTemplate = await readFile(template);
  let hit = false;
  try {
    native.backup = function (...parameters) {
      hit = true;
      fs.writeFileSync(template, '<changed-exactly-at-sqlite-snapshot/>');
      return backup.apply(this, parameters);
    };
    await assert.rejects(createBackupArtifact(backupRoot, currentConfig), /outside their committed generation/);
    assert.equal(hit, true);
    assert.deepEqual(await readdir(backupRoot), [path.basename(artifact)], 'Mixed-generation or stale-provider snapshots never publish and leave no temporary artifact.');
  } finally { native.backup = backup; await writeFile(template, originalTemplate); }
  const manifestPath = path.join(artifact, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify({ ...manifest, configuration: { ...manifest.configuration, digest: '0'.repeat(64) } }));
  await assert.rejects(verifyBackupArtifact(artifact), /committed configuration generation/);
  await writeFile(manifestPath, JSON.stringify(manifest));
  await verifyBackupArtifact(artifact);
}

async function requestedTargetBytes() {
  const originalRuntime = await readFile(sources.runtimeSettingsPath);
  const headBefore = await readFile(path.join(generationRoot, 'head.json'));
  const rename = fs.promises.rename;
  let changed = false;
  try {
    fs.promises.rename = async (...parameters) => {
      const result = await rename(...parameters);
      if (parameters[1] === sources.runtimeSettingsPath) {
        changed = true;
        await writeFile(sources.runtimeSettingsPath, JSON.stringify({ ...DEFAULT_RUNTIME_SETTINGS, shutdownGraceMs: 90_000 }));
      }
      return result;
    };
    await assert.rejects(settings.set({ ...DEFAULT_RUNTIME_SETTINGS, shutdownGraceMs: 60_000 }), /does not match the requested bytes/);
    assert.equal(changed, true);
    assert.equal(settings.snapshot().shutdownGraceMs, 45_000);
    assert.deepEqual(await readFile(path.join(generationRoot, 'head.json')), headBefore);
  } finally { fs.promises.rename = rename; await writeFile(sources.runtimeSettingsPath, originalRuntime); }
  const relocated = { CONFIG_PATH: path.join(root, 'relocated', 'config.json') };
  assert.equal(backupConfigurationSources(sources.databasePath, relocated).templatesDirectory,
    signalTemplatesDirectoryFromEnvironment(relocated), 'Backup follows the actual parser, not the unrelated configuration directory.');
  assert.equal(signalTemplatesDirectoryFromEnvironment(relocated), signalTemplatesDirectoryFromEnvironment({}));
}

async function maintenanceRecovery() {
  await closeDb();
  await assert.rejects(reenrollConfigurationGeneration(sources, owner, { assertQuiescent: async () => {} }), /genuine.*lease/);
  const lease = await beginMcpSharedMaintenance('configuration recovery fixture', sources.databasePath, owner);
  try {
    await lease.waitForQuiescence();
    await writeFile(sources.runtimeSettingsPath, JSON.stringify({ ...DEFAULT_RUNTIME_SETTINGS, shutdownGraceMs: 75_000 }));
    await assert.rejects(initializeConfigurationGeneration(sources, owner), /outside their committed generation/);
    const recovered = await reenrollConfigurationGeneration(sources, owner, lease);
    assert.equal(recovered.generation, 4);
    const retired = await retireConfigurationGeneration(sources.configurationPath, sources.databasePath, owner, lease);
    assert.equal(fs.existsSync(generationRoot), false);
    assert.equal(JSON.parse(await readFile(path.join(retired, 'head.json'), 'utf8')).generation, 4);
    writeConfigSync(config, sources.configurationPath);
    const reset = await initializeConfigurationGeneration(sources, owner);
    assert.equal(reset.generation, 1, 'Factory reset starts a new store with a distinct identity, never reuses the old commit ID.');
    assert.notEqual(reset.commitId, recovered.commitId);
  } finally { await lease.release(); }
  await pin(async generation => {
    assert.equal(JSON.parse(generation.files.get('runtime-settings.json')).shutdownGraceMs, 75_000);
  });
}

try {
  const first = await initialization();
  await writerAndSnapshot(first);
  await externalChanges();
  await interruptedWriteAndObjects();
  await requestedTargetBytes();
  await realBackupCoherence();
  await maintenanceRecovery();
  assert.ok(fs.existsSync(path.join(root, 'pinned.sqlite')));
  assert.equal((await readdir(root)).filter(name => name.endsWith('.lock')).length, 0);
  console.log('Configuration generation: shared real writers, pinned SQLite snapshot, external drift, interrupted commit and immutable-object tamper passed.');
} finally {
  await closeDb();
  await owner?.release();
  await rm(root, { recursive: true, force: true });
  if (previousConfigPath === undefined) delete process.env.CONFIG_PATH;
  else process.env.CONFIG_PATH = previousConfigPath;
}
