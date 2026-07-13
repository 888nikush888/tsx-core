import assert from 'assert';
import { cp, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  BackupScheduler,
  createBackupArtifact,
  pruneBackupArtifacts,
  restoreBackupArtifact,
  verifyBackupArtifact
} from '../src/backup.js';
import {
  closeDb,
  enqueueOutboxTask,
  getOutboxTask,
  initDb,
  saveSignal
} from '../src/db.js';

async function runTests() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forwarder-backup-test-'));
  const stateDir = path.join(root, 'state');
  const databasePath = path.join(stateDir, 'forwarder.db');
  const configPath = path.join(root, 'config.json');
  const backupRoot = path.join(root, 'backups');
  try {
    await initDb(databasePath);
    await enqueueOutboxTask({ id: 'before-backup', type: 'single', chatId: '-1001', messageId: 1, addedAt: 1 });
    await saveSignal('signal-before', '-1001', 1, '<signal/>', '<signal/>');
    const artifact = await createBackupArtifact(backupRoot, {
      apiId: 123,
      apiHash: 'must-not-be-backed-up',
      nested: { DASHBOARD_ADMIN_TOKEN: 'must-not-be-backed-up' },
      list: [{ password: 'must-not-be-backed-up' }, { value: 'retained' }],
      xmlParsing: { aiLimits: { dailyTokenLimit: 5000 } }
    }, 1_700_000_000_000);
    const manifest = await verifyBackupArtifact(artifact);
    assert.strictEqual(manifest.version, 1);
    const backedUpConfig = JSON.parse(await readFile(path.join(artifact, 'config.json'), 'utf8'));
    assert.strictEqual(backedUpConfig.apiHash, undefined);
    assert.strictEqual(backedUpConfig.nested.DASHBOARD_ADMIN_TOKEN, undefined);
    assert.strictEqual(backedUpConfig.list[0].password, undefined);
    assert.strictEqual(backedUpConfig.list[1].value, 'retained');
    assert.strictEqual(backedUpConfig.xmlParsing.aiLimits.dailyTokenLimit, 5000, 'Non-secret token limits must be retained');

    await enqueueOutboxTask({ id: 'after-backup', type: 'single', chatId: '-1001', messageId: 2, addedAt: 2 });
    await closeDb();
    await writeFile(configPath, JSON.stringify({ old: true }), 'utf8');

    await writeFile(path.join(stateDir, '.process_active'), 'active', 'utf8');
    await assert.rejects(
      restoreBackupArtifact(artifact, databasePath, configPath, stateDir),
      /Restore refused.*process_active/
    );
    await unlink(path.join(stateDir, '.process_active'));

    const restored = await restoreBackupArtifact(artifact, databasePath, configPath, stateDir);
    assert.ok(restored.previousDatabase);
    assert.ok(restored.previousConfig);
    await initDb(databasePath);
    assert.ok(await getOutboxTask('before-backup'));
    assert.strictEqual(await getOutboxTask('after-backup'), null, 'Restore must replace post-backup state');
    await closeDb();
    const restoredConfig = JSON.parse(await readFile(configPath, 'utf8'));
    assert.strictEqual(restoredConfig.apiId, 123);
    assert.strictEqual(restoredConfig.apiHash, undefined);

    const corruptArtifact = path.join(root, 'corrupt-backup');
    await cp(artifact, corruptArtifact, { recursive: true });
    await writeFile(path.join(corruptArtifact, 'config.json'), '{"tampered":true}', 'utf8');
    await assert.rejects(verifyBackupArtifact(corruptArtifact), /checksum mismatch/);

    await assert.rejects(verifyBackupArtifact(configPath), /must be a directory/);
    await assert.rejects(createBackupArtifact(backupRoot, {}, 0), /timestamp is invalid/);
    await assert.rejects(pruneBackupArtifacts(backupRoot, 0), /between 1 and 10000/);

    for (const [name, mutate, expected] of [
      ['unsupported', manifest => { manifest.version = 2; }, /Unsupported or malformed/],
      ['bad-date', manifest => { manifest.createdAt = 'not-a-date'; }, /invalid creation timestamp/],
      ['bad-metadata', manifest => { delete manifest.files['config.json']; }, /metadata for 'config.json' is invalid/]
    ]) {
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

    assert.throws(() => new BackupScheduler(path.join(root, 'invalid-scheduler'), () => ({}), 59_999), /between 1 and 15 minutes/);
    assert.throws(() => new BackupScheduler(path.join(root, 'invalid-retention'), () => ({}), 60_000, 0), /between 1 and 10000/);

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

    console.log('ALL BACKUP AND RESTORE TESTS PASSED!');
  } finally {
    await closeDb();
    await rm(root, { recursive: true, force: true });
  }
}

await runTests().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
