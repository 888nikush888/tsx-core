import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { promises as fixtureFs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { BackupScheduler, createBackupArtifact, inspectBackupArtifact, restoreBackupArtifact, verifyBackupArtifact } from '../src/backup.js';
import { runIsolatedBackupRestoreDrill } from '../src/backup_restore_drill.js';
import { closeDb, getDatabase, initDb } from '../src/db.js';
import { acquireProcessLock } from '../src/process_lock.js';
import { beginMcpOfflineMaintenance } from '../src/mcp_maintenance.js';
import { enrollBackupFixture } from './fixtures/backup_generation_fixture.js';
import { seedTradingFixtures } from './trading_fixtures.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'tsx-backup-proofs-'));
const keys = ['CONFIG_PATH', 'RUNTIME_SETTINGS_PATH', 'TEMPLATES_DIR'];
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function refreshDatabaseHash(artifact) {
  const destination = path.join(artifact, 'manifest.json');
  const manifest = JSON.parse(await readFile(destination, 'utf8'));
  const bytes = await readFile(path.join(artifact, 'forwarder.db'));
  manifest.files['forwarder.db'] = { sha256: hash(bytes), size: bytes.length };
  await writeFile(destination, JSON.stringify(manifest));
}

async function leaseTarget(label, action) {
  const target = path.join(root, label);
  await mkdir(target);
  const databasePath = path.join(target, 'forwarder.db');
  const owner = await acquireProcessLock(path.join(target, '.process_active'));
  let lease;
  try {
    lease = await beginMcpOfflineMaintenance('isolated backup proof fixture', databasePath, owner);
    await lease.waitForQuiescence();
    await action(target, databasePath, lease);
  } finally { await lease?.release(); await owner.release(); }
}

async function stageChecks(artifact) {
  await writeFile(path.join(artifact, 'templates', 'unmanifested.txt'), 'must-never-be-restored');
  await leaseTarget('exact-stage', async (target, databasePath, lease) => {
    await restoreBackupArtifact(artifact, databasePath, path.join(target, 'config.json'), target,
      { maintenanceLease: lease, templatesDirectory: path.join(target, 'templates') });
    assert.deepEqual(await readdir(path.join(target, 'templates')), ['default.xml']);
  });
  await leaseTarget('changed-stage', async (target, databasePath, lease) => {
    const copy = fixtureFs.copyFile;
    let hit = false;
    try {
      fixtureFs.copyFile = async (...parameters) => {
        const result = await copy(...parameters);
        if (parameters[0] === path.join(artifact, 'config.json')) {
          hit = true;
          await writeFile(parameters[1], '{"apiId":999}\n');
        }
        return result;
      };
      await assert.rejects(restoreBackupArtifact(artifact, databasePath, path.join(target, 'config.json'), target,
        { maintenanceLease: lease, templatesDirectory: path.join(target, 'templates') }), /no longer matches/);
      assert.equal(hit, true);
      await assert.rejects(stat(databasePath), { code: 'ENOENT' });
      assert.equal((await readdir(target)).some(name => name.includes('.restore-')), false);
    } finally { fixtureFs.copyFile = copy; }
  });
}

async function unknownSourceChecks(artifact) {
  const changed = path.join(root, 'unknown-source');
  await cp(artifact, changed, { recursive: true });
  const database = await open({ filename: path.join(changed, 'forwarder.db'), driver: sqlite3.Database });
  try { await database.exec('ALTER TABLE trading_operations RENAME COLUMN phase TO unavailable_phase'); }
  finally { await database.close(); }
  await refreshDatabaseHash(changed);
  const evidence = await inspectBackupArtifact(changed);
  assert.ok(evidence.integrityVerified.verifiedAt);
  assert.equal(evidence.restoreEligibility.status, 'unknown');
  await assert.rejects(runIsolatedBackupRestoreDrill(changed), /incomplete evidence/);
}

async function manifestChecks(artifact) {
  const manifestPath = path.join(artifact, 'manifest.json');
  const manifest = await verifyBackupArtifact(artifact);
  assert.equal(manifest.configuration.version, 2);
  assert.equal(Object.hasOwn(manifest.configuration, 'files'), false);
  assert.equal(manifest.evidence.offsiteVerified, null);
  assert.equal(manifest.evidence.restoreDrill, null);
  const legacy = path.join(root, 'legacy-generation');
  await cp(artifact, legacy, { recursive: true });
  const legacyManifest = structuredClone(manifest);
  legacyManifest.configuration = { ...manifest.configuration, version: 1,
    files: Object.fromEntries(Object.entries(manifest.files).filter(([name]) => name !== 'forwarder.db')) };
  await writeFile(path.join(legacy, 'manifest.json'), JSON.stringify(legacyManifest));
  assert.ok((await inspectBackupArtifact(legacy)).configurationCoherent);
  delete legacyManifest.configuration;
  await writeFile(path.join(legacy, 'manifest.json'), JSON.stringify(legacyManifest));
  assert.equal((await inspectBackupArtifact(legacy)).configurationCoherent, null, 'Creation claim is not trusted without its generation evidence.');
  await writeFile(path.join(legacy, 'manifest.json'), ' '.repeat(64 * 1024 + 1));
  await assert.rejects(verifyBackupArtifact(legacy), /64 KiB/);
  const bytes = await readFile(manifestPath);
  const result = await runIsolatedBackupRestoreDrill(artifact);
  assert.equal(result.artifactSha256, hash(bytes));
  assert.ok(result.performedAt > 0);
  assert.equal(result.runtimeDisabled, true);
  assert.equal(result.osSandbox, false);
  assert.deepEqual(await readFile(manifestPath), bytes, 'Drill cannot change immutable manifest identity.');
  const after = await inspectBackupArtifact(artifact);
  assert.equal(after.restoreDrill, null, 'Fresh verification alone must not fabricate a performed drill receipt.');
  const tampered = path.join(root, 'tampered-drill');
  await cp(artifact, tampered, { recursive: true });
  await writeFile(path.join(tampered, 'config.json'), '{"tampered":true}');
  const mkdtemp = fixtureFs.mkdtemp;
  const created = [];
  try {
    fixtureFs.mkdtemp = async (...parameters) => { const result = await mkdtemp(...parameters); created.push(result); return result; };
    await assert.rejects(runIsolatedBackupRestoreDrill(tampered), /checksum mismatch/);
    assert.equal(created.length, 1);
    for (const directory of created) await assert.rejects(stat(directory), { code: 'ENOENT' });
  } finally { fixtureFs.mkdtemp = mkdtemp; }
  await assert.rejects(runIsolatedBackupRestoreDrill('\\\\untrusted-host\\backup'), /UNC\/network paths/);
}

async function schedulerProofs(databasePath) {
  const replicator = { replicate: async artifact => ({ objectName: 'backup-2026-fixture.tgfb', sha256: 'a'.repeat(64),
    artifactSha256: (await inspectBackupArtifact(artifact)).artifactSha256,
    artifactCreatedAt: (await inspectBackupArtifact(artifact)).artifactCreatedAt, verifiedAt: Date.now() }) };
  const scheduler = new BackupScheduler(path.join(root, 'scheduled'), () => ({ apiId: 17 }), 60_000, 3, () => {}, replicator, true);
  await initDb(databasePath);
  const artifact = await scheduler.runNow();
  const first = scheduler.getStatus();
  assert.ok(first.integrityVerified.verifiedAt);
  assert.ok(first.configurationCoherent.verifiedAt);
  assert.ok(first.offsiteVerified.verifiedAt);
  assert.equal(first.restoreEligibility.status, 'eligible');
  assert.equal(first.restoreDrill, null, 'An actual replica response is not a restore drill.');
  const drill = await scheduler.runRestoreDrill(artifact);
  assert.deepEqual(scheduler.getStatus().restoreDrill, drill);
  replicator.replicate = async () => { throw new Error('isolated offsite failure'); };
  await assert.rejects(scheduler.runNow(), /isolated offsite failure/);
  const failed = scheduler.getStatus();
  assert.notEqual(failed.integrityVerified.artifactSha256, first.integrityVerified.artifactSha256);
  assert.deepEqual(failed.offsiteVerified, first.offsiteVerified, 'Independent historical remote evidence is not relabelled as the newer local snapshot.');
  assert.deepEqual(failed.restoreDrill, drill);
  assert.equal(failed.healthy, false);
  assert.equal(failed.lastSuccessAt, failed.integrityVerified.verifiedAt);
  failed.restoreDrill.performedAt = 0;
  assert.ok(scheduler.getStatus().restoreDrill.performedAt > 0, 'Status snapshots cannot mutate stored evidence.');
  await closeDb();
}

async function maximumManifest(databasePath) {
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const many = path.join(root, 'maximum-manifest');
  try {
    process.env.CONFIG_PATH = path.join(many, 'config.json');
    process.env.RUNTIME_SETTINGS_PATH = path.join(many, 'runtime-settings.json');
    process.env.TEMPLATES_DIR = path.join(many, 'templates');
    await mkdir(process.env.TEMPLATES_DIR, { recursive: true });
    await writeFile(process.env.RUNTIME_SETTINGS_PATH, '{"shutdownGraceMs":30000}');
    for (let index = 0; index < 256; index++) await writeFile(path.join(process.env.TEMPLATES_DIR, `t${String(index).padStart(3, '0')}.xml`), '<template/>');
    await enrollBackupFixture({ apiId: 17 }, databasePath);
    await initDb(databasePath);
    const artifact = await createBackupArtifact(path.join(many, 'backups'), { apiId: 17 });
    const manifest = await verifyBackupArtifact(artifact);
    assert.equal(Object.keys(manifest.files).length, 259);
    assert.ok((await stat(path.join(artifact, 'manifest.json'))).size <= 64 * 1024, 'Maximum short-name file set fits without duplicating the generation file map or raising the 64-KiB limit.');
  } finally {
    await closeDb();
    for (const key of keys) process.env[key] = saved[key];
  }
}

async function actualUnresolvedSnapshot(databasePath) {
  await initDb(databasePath);
  await seedTradingFixtures();
  const database = getDatabase();
  const strategy = await database.get('SELECT id FROM trading_strategy_versions LIMIT 1');
  const now = Date.now();
  await database.run("INSERT INTO signals (id, chat_id, message_id, xml_content, normalized_content, created_at) VALUES ('drill-signal', '-1', 1, '<s/>', '<s/>', ?)", [now]);
  await database.run(`INSERT INTO trading_trade_intents (id, source_signal_id, root_source_signal_id, channel_id, strategy_version_id,
    account_id, exchange, mode, symbol, side, status, signal_json, created_at, updated_at)
    VALUES ('drill-intent', 'drill-signal', 'drill-signal', '-1', ?, 'paper-default', 'paper', 'paper', 'BTCUSDT', 'LONG', 'planned', '{}', ?, ?)`, [strategy.id, now, now]);
  await database.run(`INSERT INTO trading_positions (id, intent_id, account_id, strategy_version_id, channel_id, symbol, side, status, quantity, stop_price, updated_at)
    VALUES ('drill-position', 'drill-intent', 'paper-default', ?, '-1', 'BTCUSDT', 'LONG', 'opening', '0', '100', ?)`, [strategy.id, now]);
  await database.run(`INSERT INTO trading_orders (id, intent_id, account_id, client_order_id, role, side, order_type, status, quantity,
    filled_quantity, reduce_only, request_json, created_at, updated_at)
    VALUES ('drill-order', 'drill-intent', 'paper-default', 'drill-client', 'entry', 'buy', 'limit', 'created', '1', '0', 0, '{}', ?, ?)`, [now, now]);
  await database.run(`INSERT INTO trading_operations (id, account_id, intent_id, kind, logical_key, generation, request_hash, request_json,
    expected_orders_json, phase, created_at, updated_at) VALUES ('drill-operation', 'paper-default', 'drill-intent', 'submit', 'drill', 1, ?, '{}', '[]', 'prepared', ?, ?)`, ['a'.repeat(64), now, now]);
  await database.run(`INSERT INTO trading_remote_evidence (id, account_id, provider, kind, source, identity_key, content_hash, payload_json,
    reason, classification, first_seen_at, last_seen_at) VALUES ('drill-evidence', 'paper-default', 'paper', 'fill', 'fixture', 'drill-evidence', ?, '{}', 'unresolved fixture', 'unresolved', ?, ?)`, ['b'.repeat(64), now, now]);
  const artifact = await createBackupArtifact(path.join(root, 'blocked-snapshots'), { apiId: 17 });
  await closeDb();
  const manifest = await verifyBackupArtifact(artifact);
  assert.equal(manifest.evidence.restoreEligibility.status, 'blocked');
  const evidence = await inspectBackupArtifact(artifact);
  assert.ok(evidence.integrityVerified.verifiedAt);
  assert.ok(evidence.configurationCoherent.verifiedAt);
  assert.equal(evidence.restoreEligibility.reasons.length, 5);
  await assert.rejects(runIsolatedBackupRestoreDrill(artifact), /unresolved trading exposure/);
  await leaseTarget('blocked-real-stage', async (target, targetDb, lease) => {
    await assert.rejects(restoreBackupArtifact(artifact, targetDb, path.join(target, 'config.json'), target,
      { maintenanceLease: lease, templatesDirectory: path.join(target, 'templates') }), /unresolved trading exposure/);
    await assert.rejects(stat(targetDb), { code: 'ENOENT' });
  });
}

try {
  process.env.CONFIG_PATH = path.join(root, 'config.json');
  process.env.RUNTIME_SETTINGS_PATH = path.join(root, 'runtime-settings.json');
  process.env.TEMPLATES_DIR = path.join(root, 'templates');
  await mkdir(process.env.TEMPLATES_DIR);
  await writeFile(path.join(process.env.TEMPLATES_DIR, 'default.xml'), '<signal>only-fixture</signal>');
  const databasePath = path.join(root, 'state', 'forwarder.db');
  await initDb(databasePath);
  await getDatabase().run('UPDATE trading_runtime_state SET execution_enabled=1, live_trading_enabled=1, kill_switch_active=0 WHERE singleton_id=1');
  await enrollBackupFixture({ apiId: 17 }, databasePath);
  const artifact = await createBackupArtifact(path.join(root, 'backups'), { apiId: 17 });
  await closeDb();
  await manifestChecks(artifact);
  await stageChecks(artifact);
  await unknownSourceChecks(artifact);
  await schedulerProofs(databasePath);
  await maximumManifest(databasePath);
  await actualUnresolvedSnapshot(databasePath);
  const cli = spawnSync(process.execPath, ['--import', 'tsx', 'src/backup_cli.ts', 'drill', artifact], { encoding: 'utf8', windowsHide: true });
  assert.equal(cli.status, 0, cli.stderr);
  const report = JSON.parse(cli.stdout);
  assert.ok(report.integrityVerified.verifiedAt);
  assert.ok(report.restoreDrill.performedAt);
  assert.equal(report.offsiteVerified, null);
  console.log('Backup proofs: independent timestamps, true isolated restore drill, compact manifest, untrusted claims and exact staged members passed.');
} finally {
  await closeDb();
  await rm(root, { recursive: true, force: true });
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
}
