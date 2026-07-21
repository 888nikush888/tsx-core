import assert from 'assert';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  BackupScheduler,
  createBackupArtifact,
  isSupportedBackupArtifactFileName,
  pruneBackupArtifacts,
  restoreBackupArtifact,
  verifyBackupArtifact
} from '../src/backup.js';
import { DEFAULT_RUNTIME_SETTINGS } from '../src/runtime_settings.js';
import {
  closeDb,
  enqueueOutboxTask,
  getOutboxTask,
  initDb,
  saveSignal
} from '../src/db.js';

async function createVerifiedArtifact(root, databasePath, backupRoot) {
  await initDb(databasePath);
  await enqueueOutboxTask({ id: 'before-backup', type: 'single', chatId: '-1001', messageId: 1, addedAt: 1 });
  await saveSignal('signal-before', '-1001', 1, '<signal/>', '<signal/>');
  await mkdir(path.join(root, 'templates', 'nested'), { recursive: true });
  await writeFile(path.join(root, 'runtime-settings.json'), JSON.stringify({ ...DEFAULT_RUNTIME_SETTINGS, shutdownGraceMs: 120_000 }), 'utf8');
  await writeFile(path.join(root, 'templates', 'default - alt.txt'), '<alternate-template/>', 'utf8');
  await writeFile(path.join(root, 'templates', 'default.xml'), '<template/>', 'utf8');
  await writeFile(path.join(root, 'templates', 'nested', 'source.xml'), '<source/>', 'utf8');
  const artifact = await createBackupArtifact(backupRoot, {
    apiId: 123,
    apiHash: 'must-not-be-backed-up',
    nested: { DASHBOARD_ADMIN_TOKEN: 'must-not-be-backed-up' },
    list: [{ password: 'must-not-be-backed-up' }, { value: 'retained' }],
    xmlParsing: { aiLimits: { dailyTokenLimit: 5000 } }
  }, 1_700_000_000_000);
  const manifest = await verifyBackupArtifact(artifact);
  assert.strictEqual(manifest.version, 2);
  assert.strictEqual(manifest.compatibility.application.id, 'telegram-tdlib-forwarder');
  assert.match(manifest.compatibility.application.releaseVersion, /^\d+\.\d+\.\d+/);
  assert.strictEqual(manifest.compatibility.application.dataModel, 'forwarding-core');
  assert.ok(manifest.compatibility.database.schemaVersion >= 3);
  assert.strictEqual(
    manifest.compatibility.database.migrations.length,
    manifest.compatibility.database.schemaVersion,
    'The manifest must bind every applied migration.',
  );
  assert.deepStrictEqual(
    [...manifest.compatibility.features].sort(),
    ['ai-provenance', 'core-forwarding', 'durable-outbox'],
  );
  assert.deepStrictEqual(manifest.recovery?.includedState, ['runtime-settings.json', 'templates/default - alt.txt', 'templates/default.xml', 'templates/nested/source.xml']);
  assert.deepStrictEqual(manifest.recovery?.excludedState, ['managed-secrets', 'tdlib-session-data', 'tdlib-session-files']);
  const backedUpConfig = JSON.parse(await readFile(path.join(artifact, 'config.json'), 'utf8'));
  assert.strictEqual(backedUpConfig.apiHash, undefined);
  assert.strictEqual(backedUpConfig.nested.DASHBOARD_ADMIN_TOKEN, undefined);
  assert.strictEqual(backedUpConfig.list[0].password, undefined);
  assert.strictEqual(backedUpConfig.list[1].value, 'retained');
  assert.strictEqual(backedUpConfig.xmlParsing.aiLimits.dailyTokenLimit, 5000, 'Non-secret token limits must be retained');
  return { artifact, manifest };
}

async function assertRestoredState(root, artifact, databasePath, configPath, stateDir) {
  await enqueueOutboxTask({ id: 'after-backup', type: 'single', chatId: '-1001', messageId: 2, addedAt: 2 });
  await closeDb();
  await writeFile(configPath, JSON.stringify({ old: true }), 'utf8');
  await writeFile(path.join(stateDir, '.process_active'), 'active', 'utf8');
  await assert.rejects(
    restoreBackupArtifact(artifact, databasePath, configPath, stateDir),
    /Restore refused.*process_active/
  );
  const recoveryRoot = path.join(root, 'recovery-state');
  await mkdir(path.join(recoveryRoot, 'templates'), { recursive: true });
  await writeFile(path.join(recoveryRoot, 'runtime-settings.json'), JSON.stringify({ old: true }), 'utf8');
  await writeFile(path.join(recoveryRoot, 'templates', 'old.xml'), '<old/>', 'utf8');
  const restored = await restoreBackupArtifact(artifact, databasePath, configPath, stateDir, {
    runtimeSettingsPath: path.join(recoveryRoot, 'runtime-settings.json'),
    templatesDirectory: path.join(recoveryRoot, 'templates'),
    allowCurrentProcessLock: true,
  });
  assert.ok(restored.previousDatabase);
  assert.ok(restored.previousConfig);
  await initDb(databasePath);
  assert.ok(await getOutboxTask('before-backup'));
  assert.strictEqual(await getOutboxTask('after-backup'), null, 'Restore must replace post-backup state');
  await closeDb();
  const restoredConfig = JSON.parse(await readFile(configPath, 'utf8'));
  assert.strictEqual(restoredConfig.apiId, 123);
  assert.strictEqual(restoredConfig.apiHash, undefined);
  assert.ok(restored.previousRuntimeSettings);
  assert.ok(restored.previousTemplates);
  assert.equal(JSON.parse(await readFile(path.join(recoveryRoot, 'runtime-settings.json'), 'utf8')).shutdownGraceMs, 120_000);
  assert.strictEqual(await readFile(path.join(recoveryRoot, 'templates', 'default - alt.txt'), 'utf8'), '<alternate-template/>');
  assert.strictEqual(await readFile(path.join(recoveryRoot, 'templates', 'default.xml'), 'utf8'), '<template/>');
  await assert.rejects(readFile(path.join(recoveryRoot, 'templates', 'old.xml')), /ENOENT/);
}

function invalidManifestCases() {
  return [
    ['unsupported', manifest => { manifest.version = 3; }, /Unsupported or malformed/],
    ['legacy', manifest => { manifest.version = 1; delete manifest.compatibility; }, /Unsupported or malformed/],
    ['bad-date', manifest => { manifest.createdAt = 'not-a-date'; }, /invalid creation timestamp/],
    ['invalid-count', manifest => { manifest.files = {}; }, /invalid number of files/],
    ['bad-metadata', manifest => { delete manifest.files['config.json']; }, /missing required file 'config.json'/],
    ['wrong-app', manifest => { manifest.compatibility.application.id = 'different-application'; }, /unsupported application/],
    ['bad-release', manifest => { manifest.compatibility.application.releaseVersion = 'not-semver'; }, /unsupported application/],
    ['wrong-data-model', manifest => { manifest.compatibility.application.dataModel = 'integrated-trading'; }, /unsupported application/],
    ['wrong-schema', manifest => { manifest.compatibility.database.schemaVersion += 1; }, /schema version .* incompatible/],
    ['wrong-features', manifest => { manifest.compatibility.features = ['core-forwarding']; }, /feature set is incompatible/],
    ['wrong-migrations', manifest => { manifest.compatibility.database.migrations[0].checksum = '0'.repeat(64); }, /migration history does not match/]
  ];
}

async function assertInvalidArtifacts(root, artifact, manifest, configPath, backupRoot) {
  const corruptArtifact = path.join(root, 'corrupt-backup');
  await cp(artifact, corruptArtifact, { recursive: true });
  await writeFile(path.join(corruptArtifact, 'config.json'), '{"tampered":true}', 'utf8');
  await assert.rejects(verifyBackupArtifact(corruptArtifact), /checksum mismatch/);
  await assert.rejects(verifyBackupArtifact(configPath), /must be a directory/);
  await assert.rejects(createBackupArtifact(backupRoot, {}, 0), /timestamp is invalid/);
  await assert.rejects(pruneBackupArtifacts(backupRoot, 0), /between 1 and 10000/);
  for (const [name, mutate, expected] of invalidManifestCases()) {
    const invalidArtifact = path.join(root, `invalid-${name}`);
    await cp(artifact, invalidArtifact, { recursive: true });
    const manifestPath = path.join(invalidArtifact, 'manifest.json');
    const invalidManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    mutate(invalidManifest);
    await writeFile(manifestPath, JSON.stringify(invalidManifest), 'utf8');
    await assert.rejects(verifyBackupArtifact(invalidArtifact), expected);
  }
  const oversizedManifestArtifact = path.join(root, 'oversized-manifest');
  await cp(artifact, oversizedManifestArtifact, { recursive: true });
  await writeFile(path.join(oversizedManifestArtifact, 'manifest.json'), 'x'.repeat(64 * 1024 + 1), 'utf8');
  await assert.rejects(verifyBackupArtifact(oversizedManifestArtifact), /exceeds 64 KiB/);

}

async function assertArtifactNameValidation(root, artifact) {
  assert.strictEqual(isSupportedBackupArtifactFileName('forwarder.db'), true);
  assert.strictEqual(isSupportedBackupArtifactFileName('runtime-settings.json'), true);
  assert.strictEqual(isSupportedBackupArtifactFileName('templates/default - alt.txt'), true);
  assert.strictEqual(isSupportedBackupArtifactFileName('templates/default.txt'), true);
  assert.strictEqual(isSupportedBackupArtifactFileName('templates/../escape.txt'), false);
  assert.strictEqual(isSupportedBackupArtifactFileName('unexpected.txt'), false);
  const invalidArtifact = path.join(root, 'invalid-artifact-member');
  await cp(artifact, invalidArtifact, { recursive: true });
  const manifestPath = path.join(invalidArtifact, 'manifest.json');
  const invalidManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  invalidManifest.files['unexpected.txt'] = { sha256: '0'.repeat(64), size: 1 };
  await writeFile(manifestPath, JSON.stringify(invalidManifest), 'utf8');
  await assert.rejects(verifyBackupArtifact(invalidArtifact), /unsupported file name/);
}

async function assertRestoreRollback(root, artifact, databasePath, configPath, stateDir) {
  await assert.rejects(
    restoreBackupArtifact(artifact, databasePath, configPath, stateDir, {
      runtimeSettingsPath: databasePath,
      allowCurrentProcessLock: true,
    }),
    /Recovery state targets must not overlap/
  );
  await initDb(databasePath);
  await enqueueOutboxTask({ id: 'rollback-original', type: 'single', chatId: '-1001', messageId: 3, addedAt: 3 });
  await closeDb();
  await writeFile(configPath, JSON.stringify({ rollback: true }), 'utf8');
  const failedRecoveryRoot = path.join(root, 'failed-recovery-state');
  const invalidRuntimeTarget = path.join(failedRecoveryRoot, 'runtime-settings.json');
  await mkdir(invalidRuntimeTarget, { recursive: true });
  await assert.rejects(
    restoreBackupArtifact(artifact, databasePath, configPath, stateDir, {
      runtimeSettingsPath: invalidRuntimeTarget,
      templatesDirectory: path.join(failedRecoveryRoot, 'templates'),
      allowCurrentProcessLock: true,
    }),
    /Existing runtime settings must be a regular file/
  );
  await initDb(databasePath);
  assert.ok(await getOutboxTask('rollback-original'), 'Rollback must restore the database that existed before recovery.');
  await closeDb();
  assert.deepStrictEqual(JSON.parse(await readFile(configPath, 'utf8')), { rollback: true });
}

async function assertBackupWithoutOptionalRecoveryState(root, databasePath, backupRoot) {
  const previousRuntimeSettingsPath = process.env.RUNTIME_SETTINGS_PATH;
  const previousTemplatesDirectory = process.env.TEMPLATES_DIR;
  try {
    process.env.RUNTIME_SETTINGS_PATH = path.join(root, 'missing-runtime-settings.json');
    process.env.TEMPLATES_DIR = path.join(root, 'missing-templates');
    await initDb(databasePath);
    const artifact = await createBackupArtifact(backupRoot, null, 1_700_000_000_001);
    const manifest = await verifyBackupArtifact(artifact);
    assert.deepStrictEqual(manifest.recovery?.includedState, []);
    await closeDb();
  } finally {
    await closeDb();
    if (previousRuntimeSettingsPath === undefined) delete process.env.RUNTIME_SETTINGS_PATH;
    else process.env.RUNTIME_SETTINGS_PATH = previousRuntimeSettingsPath;
    if (previousTemplatesDirectory === undefined) delete process.env.TEMPLATES_DIR;
    else process.env.TEMPLATES_DIR = previousTemplatesDirectory;
  }
}

async function assertConfigDirectoryTemplateDiscovery(root, databasePath, backupRoot) {
  const previousConfigPath = process.env.CONFIG_PATH;
  const configPath = path.join(root, 'config', 'config.json');
  try {
    await mkdir(path.dirname(configPath), { recursive: true });
    process.env.CONFIG_PATH = configPath;
    await initDb(databasePath);
    const artifact = await createBackupArtifact(backupRoot, { apiId: 123 }, 1_700_000_000_002);
    const manifest = await verifyBackupArtifact(artifact);
    assert.ok(manifest.recovery?.includedState.includes('templates/default.xml'));
    await closeDb();
  } finally {
    await closeDb();
    if (previousConfigPath === undefined) delete process.env.CONFIG_PATH;
    else process.env.CONFIG_PATH = previousConfigPath;
  }
}

function verifiedReplication(objectName) {
  return {
    objectName,
    sha256: 'a'.repeat(64),
    size: 128,
    verifiedAt: Date.now(),
  };
}

async function assertBackupScheduler(root, databasePath) {
  assert.throws(() => new BackupScheduler(path.join(root, 'invalid-scheduler'), () => ({}), 59_999), /between 1 and 15 minutes/);
  assert.throws(() => new BackupScheduler(path.join(root, 'invalid-retention'), () => ({}), 60_000, 0), /between 1 and 10000/);
  assert.throws(
    () => new BackupScheduler(path.join(root, 'required-offsite'), () => ({}), 60_000, 2, () => {}, null, true),
    /Required off-site backup replication is not configured/
  );
  await initDb(databasePath);
  const schedulerRoot = path.join(root, 'scheduled');
  const messages = [];
  const scheduler = new BackupScheduler(schedulerRoot, () => ({ apiId: 123 }), 60_000, 2, message => messages.push(message));
  await scheduler.start();
  await scheduler.start();
  const concurrentBackup = scheduler.runNow();
  await assert.rejects(scheduler.runNow(), /already running/);
  await concurrentBackup;
  await scheduler.runNow();
  await scheduler.stop();
  const scheduledArtifacts = (await readdir(schedulerRoot)).filter(name => name.startsWith('backup-'));
  assert.strictEqual(scheduledArtifacts.length, 2, 'Retention must remove older verified artifacts');
  assert.strictEqual(scheduler.getStatus().healthy, true);
  assert.ok(messages.some(message => message.includes('Verified backup created')));
  await closeDb();

  await initDb(databasePath);
  const offsiteMessages = [];
  const offsiteScheduler = new BackupScheduler(
    path.join(root, 'offsite-scheduled'),
    () => ({ apiId: 123 }),
    60_000,
    2,
    message => offsiteMessages.push(message),
    { replicate: async () => verifiedReplication('backup-2026-offsite.tgfb'), recover: async () => { throw new Error('not used'); } },
    true
  );
  await offsiteScheduler.runNow();
  assert.strictEqual(offsiteScheduler.getStatus().offsiteHealthy, true);
  assert.ok(offsiteMessages.some(message => message.includes('Encrypted off-site backup verified')));

  const failedScheduler = new BackupScheduler(
    path.join(root, 'failed-offsite-scheduled'),
    () => ({ apiId: 123 }),
    60_000,
    2,
    () => {},
    { replicate: async () => { throw new Error('replication unavailable'); }, recover: async () => { throw new Error('not used'); } },
    true
  );
  await assert.rejects(failedScheduler.runNow(), /replication unavailable/);
  assert.match(failedScheduler.getStatus().lastError || '', /replication unavailable/);
  assert.strictEqual(failedScheduler.getStatus().offsiteHealthy, false);

  let releaseReplication;
  let markReplicationStarted;
  const replicationStarted = new Promise(resolve => { markReplicationStarted = resolve; });
  const drainingScheduler = new BackupScheduler(
    path.join(root, 'draining-offsite-scheduled'),
    () => ({ apiId: 123 }),
    60_000,
    2,
    () => {},
    {
      replicate: async () => {
        markReplicationStarted();
        return new Promise(resolve => { releaseReplication = resolve; });
      },
      recover: async () => { throw new Error('not used'); }
    }
  );
  const activeRun = drainingScheduler.runNow();
  await replicationStarted;
  const stopped = drainingScheduler.stop();
  releaseReplication(verifiedReplication('backup-2026-draining.tgfb'));
  await activeRun;
  await stopped;
  await closeDb();
}

async function runTests() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forwarder-backup-test-'));
  const previousConfigPath = process.env.CONFIG_PATH;
  const stateDir = path.join(root, 'state');
  const databasePath = path.join(stateDir, 'forwarder.db');
  const configPath = path.join(root, 'config.json');
  const backupRoot = path.join(root, 'backups');
  try {
    process.env.CONFIG_PATH = configPath;
    const { artifact, manifest } = await createVerifiedArtifact(root, databasePath, backupRoot);
    await assertRestoredState(root, artifact, databasePath, configPath, stateDir);
    await assertInvalidArtifacts(root, artifact, manifest, configPath, backupRoot);
    await assertArtifactNameValidation(root, artifact);
    await assertRestoreRollback(root, artifact, databasePath, configPath, stateDir);
    await assertBackupWithoutOptionalRecoveryState(root, databasePath, backupRoot);
    await assertConfigDirectoryTemplateDiscovery(root, databasePath, backupRoot);
    await assertBackupScheduler(root, databasePath);
    console.log('ALL BACKUP AND RESTORE TESTS PASSED!');
  } finally {
    await closeDb();
    await rm(root, { recursive: true, force: true });
    if (previousConfigPath === undefined) delete process.env.CONFIG_PATH;
    else process.env.CONFIG_PATH = previousConfigPath;
  }
}

await runTests().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
