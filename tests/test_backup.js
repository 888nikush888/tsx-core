import assert from 'assert';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { promises as fixtureFileSystem } from 'node:fs';
import {
  BackupScheduler,
  createBackupArtifact,
  isSupportedBackupArtifactFileName,
  inspectBackupArtifact,
  pruneBackupArtifacts,
  restoreBackupArtifact,
  verifyBackupArtifact
} from '../src/backup.js';
import { DEFAULT_RUNTIME_SETTINGS } from '../src/runtime_settings.js';
import { acquireProcessLock } from '../src/process_lock.js';
import { beginMcpSharedMaintenance } from '../src/mcp_maintenance.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { enrollBackupFixture } from './fixtures/backup_generation_fixture.js';
import { withPinnedConfigurationGeneration } from '../src/backup_generation.js';
import {
  closeDb,
  enqueueOutboxTask,
  getDatabase,
  getOutboxTask,
  initDb,
  REQUIRED_DATABASE_TABLES,
  saveSignal
} from '../src/db.js';

async function leasedRestore(artifact, databasePath, configPath, stateDirectory, options = {}) {
  const owner = await acquireProcessLock(path.join(stateDirectory, '.process_active'));
  let maintenanceLease;
  try {
    maintenanceLease = await beginMcpSharedMaintenance('isolated restore fixture', databasePath, owner);
    await maintenanceLease.waitForQuiescence();
    return await restoreBackupArtifact(artifact, databasePath, configPath, stateDirectory, { ...options, maintenanceLease });
  } finally { await maintenanceLease?.release(); await owner.release(); }
}

async function assertAuthorityBeforeArtifactInspection() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'backup-authority-fixture-'));
  try {
    await assert.rejects(
      restoreBackupArtifact(path.join(root, 'unread-artifact'), path.join(root, 'target.db'), path.join(root, 'config.json'), root,
        { allowCurrentProcessLock: true }),
      /genuine.*lease/i,
      'Missing ownership must be rejected before inspecting backup artifacts or creating staging files.'
    );
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function createVerifiedArtifact(root, databasePath, backupRoot) {
  assert.ok(
    REQUIRED_DATABASE_TABLES.includes('trading_fallback_runs') &&
      REQUIRED_DATABASE_TABLES.includes('trading_fallback_candidates'),
    'Verified backups must require the complete ordered-fallback state.',
  );
  await initDb(databasePath);
  await seedTradingFixtures();
  await enqueueOutboxTask({ id: 'before-backup', type: 'single', chatId: '-1001', messageId: 1, addedAt: 1 });
  await saveSignal('signal-before', '-1001', 1, '<signal/>', '<signal/>');
  await getDatabase().run(
    `UPDATE trading_runtime_state
     SET execution_enabled = 1, live_trading_enabled = 1, kill_switch_active = 0, kill_switch_reason = NULL
     WHERE singleton_id = 1`
  );
  await mkdir(path.join(root, 'templates', 'nested'), { recursive: true });
  await writeFile(path.join(root, 'runtime-settings.json'), JSON.stringify({ ...DEFAULT_RUNTIME_SETTINGS, shutdownGraceMs: 120_000 }), 'utf8');
  await writeFile(path.join(root, 'templates', 'default - alt.txt'), '<alternate-template/>', 'utf8');
  await writeFile(path.join(root, 'templates', 'default.xml'), '<template/>', 'utf8');
  await writeFile(path.join(root, 'templates', 'nested', 'source.xml'), '<source/>', 'utf8');
  const config = {
    apiId: 123,
    apiHash: 'must-not-be-backed-up',
    nested: { DASHBOARD_ADMIN_TOKEN: 'must-not-be-backed-up' },
    list: [{ password: 'must-not-be-backed-up' }, { value: 'retained' }],
    xmlParsing: { aiLimits: { dailyTokenLimit: 5000 } }
  };
  await enrollBackupFixture(config, databasePath);
  const artifact = await createBackupArtifact(backupRoot, config, 1_700_000_000_000);
  const manifest = await verifyBackupArtifact(artifact);
  assert.strictEqual(manifest.version, 2);
  assert.strictEqual(manifest.compatibility.application.id, 'tsx-core');
  assert.match(manifest.compatibility.application.releaseVersion, /^\d+\.\d+\.\d+/);
  assert.strictEqual(manifest.compatibility.application.dataModel, 'integrated-trading');
  assert.ok(manifest.compatibility.database.schemaVersion >= 6);
  assert.strictEqual(
    manifest.compatibility.database.migrations.length,
    manifest.compatibility.database.schemaVersion,
    'The manifest must bind every applied migration.',
  );
  assert.ok(manifest.compatibility.features.includes('integrated-trading-control-plane'));
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
  await assert.rejects(
    restoreBackupArtifact(artifact, databasePath, configPath, stateDir, { allowCurrentProcessLock: true }),
    /genuine.*lease/i,
    'A historical boolean bypass cannot authorize replacing an operational database.'
  );
  await assert.rejects(
    restoreBackupArtifact(artifact, databasePath, configPath, stateDir, { maintenanceLease: { assertQuiescent: async () => {} } }),
    /genuine.*lease/i
  );
  const recoveryRoot = path.join(root, 'recovery-state');
  await mkdir(path.join(recoveryRoot, 'templates'), { recursive: true });
  await writeFile(path.join(recoveryRoot, 'runtime-settings.json'), JSON.stringify({ old: true }), 'utf8');
  await writeFile(path.join(recoveryRoot, 'templates', 'old.xml'), '<old/>', 'utf8');
  const restored = await leasedRestore(artifact, databasePath, configPath, stateDir, {
    runtimeSettingsPath: path.join(recoveryRoot, 'runtime-settings.json'),
    templatesDirectory: path.join(recoveryRoot, 'templates'),
  });
  assert.ok(restored.previousDatabase);
  assert.ok(restored.previousConfig);
  await initDb(databasePath);
  assert.ok(await getOutboxTask('before-backup'));
  assert.strictEqual(await getOutboxTask('after-backup'), null, 'Restore must replace post-backup state');
  const restoredRuntime = await getDatabase().get(
    `SELECT execution_enabled, live_trading_enabled, kill_switch_active, kill_switch_reason
     FROM trading_runtime_state WHERE singleton_id = 1`
  );
  assert.equal(restoredRuntime.execution_enabled, 0);
  assert.equal(restoredRuntime.live_trading_enabled, 0);
  assert.equal(restoredRuntime.kill_switch_active, 1);
  assert.match(restoredRuntime.kill_switch_reason, /operator reconciliation required/);
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
    ['wrong-data-model', manifest => { manifest.compatibility.application.dataModel = 'forwarding-only'; }, /unsupported application/],
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

  const incompleteTradingArtifact = path.join(root, 'incomplete-trading-backup');
  await cp(artifact, incompleteTradingArtifact, { recursive: true });
  const incompleteDatabasePath = path.join(incompleteTradingArtifact, 'forwarder.db');
  const incompleteDatabase = await open({ filename: incompleteDatabasePath, driver: sqlite3.Database });
  await incompleteDatabase.exec('DROP TABLE trading_paper_positions;');
  await incompleteDatabase.close();
  const incompleteManifestPath = path.join(incompleteTradingArtifact, 'manifest.json');
  const incompleteManifest = JSON.parse(await readFile(incompleteManifestPath, 'utf8'));
  const databaseBytes = await readFile(incompleteDatabasePath);
  incompleteManifest.files['forwarder.db'] = {
    sha256: createHash('sha256').update(databaseBytes).digest('hex'),
    size: databaseBytes.length,
  };
  await writeFile(incompleteManifestPath, JSON.stringify(incompleteManifest), 'utf8');
  await assert.rejects(
    verifyBackupArtifact(incompleteTradingArtifact),
    /missing required tables: trading_paper_positions/,
    'A checksum-consistent backup without complete trading state must be rejected.',
  );

  const unresolvedTradingArtifact = path.join(root, 'unresolved-trading-backup');
  await cp(artifact, unresolvedTradingArtifact, { recursive: true });
  const unresolvedDatabasePath = path.join(unresolvedTradingArtifact, 'forwarder.db');
  const unresolvedDatabase = await open({ filename: unresolvedDatabasePath, driver: sqlite3.Database });
  const strategy = await unresolvedDatabase.get('SELECT id FROM trading_strategy_versions LIMIT 1');
  await unresolvedDatabase.run(
    `INSERT INTO signals (id, chat_id, message_id, xml_content, normalized_content, created_at)
     VALUES ('restore-active-signal', '-1001', 999, '<signal/>', '<signal/>', ?)`,
    [Date.now()],
  );
  await unresolvedDatabase.run(
    `INSERT INTO trading_trade_intents (
       id, source_signal_id, root_source_signal_id, channel_id, strategy_version_id, account_id, exchange, mode,
       symbol, side, status, signal_json, created_at, updated_at
     ) VALUES ('restore-active-intent', 'restore-active-signal', 'restore-active-signal', '-1001', ?, 'paper-default',
               'paper', 'paper', 'BTCUSDT', 'LONG', 'monitoring', '{}', ?, ?)`,
    [strategy.id, Date.now(), Date.now()],
  );
  await unresolvedDatabase.run(
    `INSERT INTO trading_orders (
       id, intent_id, account_id, client_order_id, role, side, order_type, status,
       quantity, filled_quantity, reduce_only, request_json, created_at, updated_at
     ) VALUES ('restore-active-order', 'restore-active-intent', 'paper-default', 'restore-active-client',
               'entry', 'buy', 'limit', 'open', '1', '0', 0, '{}', ?, ?)`,
    [Date.now(), Date.now()],
  );
  await unresolvedDatabase.close();
  const unresolvedManifestPath = path.join(unresolvedTradingArtifact, 'manifest.json');
  const unresolvedManifest = JSON.parse(await readFile(unresolvedManifestPath, 'utf8'));
  const unresolvedBytes = await readFile(unresolvedDatabasePath);
  unresolvedManifest.files['forwarder.db'] = {
    sha256: createHash('sha256').update(unresolvedBytes).digest('hex'),
    size: unresolvedBytes.length,
  };
  await writeFile(unresolvedManifestPath, JSON.stringify(unresolvedManifest), 'utf8');
  await verifyBackupArtifact(unresolvedTradingArtifact);
  const unresolvedEvidence = await inspectBackupArtifact(unresolvedTradingArtifact);
  assert.ok(unresolvedEvidence.integrityVerified.verifiedAt, 'Intact exposure backup still has a local integrity proof.');
  assert.ok(unresolvedEvidence.configurationCoherent.verifiedAt);
  assert.equal(unresolvedEvidence.restoreEligibility.status, 'blocked');
  assert.equal(unresolvedEvidence.restoreDrill, null);
  await assert.rejects(
    leasedRestore(
      unresolvedTradingArtifact,
      path.join(root, 'state', 'forwarder.db'),
      configPath,
      path.join(root, 'state'),
    ),
    /backup captures unresolved trading exposure/,
  );
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

  const linkedArtifact = path.join(root, 'linked-artifact-manifest');
  const manifestTarget = path.join(root, 'external-manifest.json');
  await mkdir(linkedArtifact);
  await cp(path.join(artifact, 'manifest.json'), manifestTarget);
  let manifestLinkCreated = true;
  try {
    await symlink(manifestTarget, path.join(linkedArtifact, 'manifest.json'), 'file');
  } catch (error) {
    if (!['EPERM', 'ENOTSUP'].includes(error?.code)) throw error;
    manifestLinkCreated = false;
  }
  if (manifestLinkCreated) {
    await assert.rejects(verifyBackupArtifact(linkedArtifact), /not a symbolic link/);
  }
}

async function assertLegacyBrandCompatibility(root, artifact) {
  const legacyArtifact = path.join(root, 'legacy-brand-backup');
  await cp(artifact, legacyArtifact, { recursive: true });
  const manifestPath = path.join(legacyArtifact, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.compatibility.application.id = 'telegram-tdlib-forwarder';
  await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
  await verifyBackupArtifact(legacyArtifact);
}

async function assertRestoreRollback(root, artifact, databasePath, configPath, stateDir) {
  await assert.rejects(
    leasedRestore(artifact, databasePath, configPath, stateDir, {
      runtimeSettingsPath: databasePath,
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
    leasedRestore(artifact, databasePath, configPath, stateDir, {
      runtimeSettingsPath: invalidRuntimeTarget,
      templatesDirectory: path.join(failedRecoveryRoot, 'templates'),
    }),
    /Existing runtime settings must be a regular file/
  );
  await initDb(databasePath);
  assert.ok(await getOutboxTask('rollback-original'), 'Rollback must restore the database that existed before recovery.');
  await closeDb();
  assert.deepStrictEqual(JSON.parse(await readFile(configPath, 'utf8')), { rollback: true });
}

async function assertRestoreLeaseFence(root, artifact, databasePath, configPath, stateDirectory) {
  const owner = await acquireProcessLock(path.join(stateDirectory, '.process_active'));
  const lease = await beginMcpSharedMaintenance('pre-replacement fence fixture', databasePath, owner);
  const originalCopy = fixtureFileSystem.copyFile;
  try {
    await assert.rejects(restoreBackupArtifact(artifact, databasePath, configPath, stateDirectory, { maintenanceLease: lease }), /not acknowledged/);
    await lease.waitForQuiescence();
    await assert.rejects(restoreBackupArtifact(artifact, databasePath, configPath, root, { maintenanceLease: lease }), /state directory differs/);
    const originalDatabase = await readFile(databasePath);
    const originalConfig = await readFile(configPath);
    const priorStagingNames = (await readdir(stateDirectory)).filter(file => file.includes('.restore-'));
    let revoked = false;
    fixtureFileSystem.copyFile = async (...parameters) => {
      const result = await originalCopy(...parameters);
      if (!revoked && String(parameters[1]).includes('.restore-')) { revoked = true; await lease.release(); }
      return result;
    };
    await assert.rejects(restoreBackupArtifact(artifact, databasePath, configPath, stateDirectory, { maintenanceLease: lease }), /released/);
    assert.equal(revoked, true, 'Fixture must revoke only after staging begins.');
    assert.deepEqual(await readFile(databasePath), originalDatabase, 'No operational DB rename is allowed after the lease was revoked during staging.');
    assert.deepEqual(await readFile(configPath), originalConfig);
    assert.deepEqual((await readdir(stateDirectory)).filter(file => file.includes('.restore-')), priorStagingNames);
  } finally { fixtureFileSystem.copyFile = originalCopy; await lease.release(); await owner.release(); }
}

async function assertOfflineBackupCli(root, artifact) {
  const state = path.join(root, 'offline-cli-state');
  await mkdir(state);
  const target = path.join(state, 'forwarder.db');
  const environment = { ...process.env, FORWARDER_DB_PATH: target, CONFIG_PATH: path.join(state, 'config.json'),
    RUNTIME_SETTINGS_PATH: path.join(state, 'runtime-settings.json'), TEMPLATES_DIR: path.join(state, 'templates') };
  const run = () => spawnSync(process.execPath, ['--import', 'tsx', 'src/backup_cli.ts', 'restore', artifact], {
    cwd: process.cwd(), env: environment, encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  const restored = run();
  assert.equal(restored.status, 0, restored.stderr);
  assert.ok((await readFile(target)).length > 0);
  assert.equal(JSON.parse(await readFile(environment.CONFIG_PATH, 'utf8')).apiId, 123);
  await withPinnedConfigurationGeneration(environment.CONFIG_PATH, target, async generation => {
    assert.equal(JSON.parse(generation.files.get('config.json')).apiId, 123,
      'The real restore CLI must leave the installed files in a committed local generation.');
  });
  const original = await readFile(target);
  const owner = await acquireProcessLock(path.join(state, '.process_active'));
  try {
    const rejected = run();
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /already active/i);
    assert.deepEqual(await readFile(target), original);
  } finally { await owner.release(); }
}

async function assertBackupWithoutOptionalRecoveryState(root, databasePath, backupRoot) {
  const previousConfigPath = process.env.CONFIG_PATH;
  const previousRuntimeSettingsPath = process.env.RUNTIME_SETTINGS_PATH;
  const previousTemplatesDirectory = process.env.TEMPLATES_DIR;
  try {
    process.env.CONFIG_PATH = path.join(root, 'without-optional-state.json');
    process.env.RUNTIME_SETTINGS_PATH = path.join(root, 'missing-runtime-settings.json');
    process.env.TEMPLATES_DIR = path.join(root, 'missing-templates');
    await initDb(databasePath);
    await enrollBackupFixture({}, databasePath);
    const artifact = await createBackupArtifact(backupRoot, null, 1_700_000_000_001);
    const manifest = await verifyBackupArtifact(artifact);
    assert.deepStrictEqual(manifest.recovery?.includedState, []);
    await closeDb();
  } finally {
    await closeDb();
    process.env.CONFIG_PATH = previousConfigPath;
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
    await enrollBackupFixture({ apiId: 123 }, databasePath);
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

async function verifiedReplication(objectName, artifact) {
  const evidence = await inspectBackupArtifact(artifact);
  return {
    objectName,
    sha256: 'a'.repeat(64),
    size: 128,
    verifiedAt: Date.now(),
    artifactSha256: evidence.artifactSha256,
    artifactCreatedAt: evidence.artifactCreatedAt,
    restoreDrill: null,
  };
}

async function assertBackupScheduler(root, databasePath) {
  process.env.CONFIG_PATH = path.join(root, 'scheduler-config.json');
  await enrollBackupFixture({ apiId: 123 }, databasePath);
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
    { replicate: async artifact => verifiedReplication('backup-2026-offsite.tgfb', artifact), recover: async () => { throw new Error('not used'); } },
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
      replicate: async artifact => {
        markReplicationStarted();
        return new Promise(resolve => { releaseReplication = () => resolve(verifiedReplication('backup-2026-draining.tgfb', artifact)); });
      },
      recover: async () => { throw new Error('not used'); }
    }
  );
  const activeRun = drainingScheduler.runNow();
  await replicationStarted;
  const stopped = drainingScheduler.stop();
  releaseReplication();
  await activeRun;
  await stopped;
  await closeDb();
}

async function runTests() {
  await assertAuthorityBeforeArtifactInspection();
  const root = await mkdtemp(path.join(os.tmpdir(), 'forwarder-backup-test-'));
  const previousConfigPath = process.env.CONFIG_PATH;
  const previousRuntimeSettingsPath = process.env.RUNTIME_SETTINGS_PATH;
  const previousTemplatesDirectory = process.env.TEMPLATES_DIR;
  const stateDir = path.join(root, 'state');
  const databasePath = path.join(stateDir, 'forwarder.db');
  const configPath = path.join(root, 'config.json');
  const backupRoot = path.join(root, 'backups');
  try {
    process.env.CONFIG_PATH = configPath;
    process.env.RUNTIME_SETTINGS_PATH = path.join(root, 'runtime-settings.json');
    process.env.TEMPLATES_DIR = path.join(root, 'templates');
    const { artifact, manifest } = await createVerifiedArtifact(root, databasePath, backupRoot);
    await assertRestoredState(root, artifact, databasePath, configPath, stateDir);
    await assertInvalidArtifacts(root, artifact, manifest, configPath, backupRoot);
    await assertLegacyBrandCompatibility(root, artifact);
    await assertArtifactNameValidation(root, artifact);
    await assertRestoreRollback(root, artifact, databasePath, configPath, stateDir);
    await assertRestoreLeaseFence(root, artifact, databasePath, configPath, stateDir);
    await assertOfflineBackupCli(root, artifact);
    await assertBackupWithoutOptionalRecoveryState(root, databasePath, backupRoot);
    await assertConfigDirectoryTemplateDiscovery(root, databasePath, backupRoot);
    await assertBackupScheduler(root, databasePath);
    console.log('ALL BACKUP AND RESTORE TESTS PASSED!');
  } finally {
    await closeDb();
    await rm(root, { recursive: true, force: true });
    if (previousConfigPath === undefined) delete process.env.CONFIG_PATH;
    else process.env.CONFIG_PATH = previousConfigPath;
    if (previousRuntimeSettingsPath === undefined) delete process.env.RUNTIME_SETTINGS_PATH;
    else process.env.RUNTIME_SETTINGS_PATH = previousRuntimeSettingsPath;
    if (previousTemplatesDirectory === undefined) delete process.env.TEMPLATES_DIR;
    else process.env.TEMPLATES_DIR = previousTemplatesDirectory;
  }
}

await runTests().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
