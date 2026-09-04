import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { assessRestoreEligibility, hasCurrentRestorableBackup, requireRestoreEligibility } from '../src/backup_evidence.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'tsx-backup-eligibility-'));
const database = await open({ filename: path.join(root, 'isolated.db'), driver: sqlite3.Database });
try {
  const absent = await assessRestoreEligibility(database);
  assert.equal(absent.status, 'unknown', 'Missing sources must not be silently counted as zero.');
  assert.equal(absent.reasons.length, 5);
  assert.throws(() => requireRestoreEligibility(absent), /incomplete evidence/);
  await database.exec(`
    CREATE TABLE trading_trade_intents (status TEXT NOT NULL);
    CREATE TABLE trading_positions (status TEXT NOT NULL, quantity TEXT NOT NULL);
    CREATE TABLE trading_orders (status TEXT NOT NULL);
    CREATE TABLE trading_operations (phase TEXT NOT NULL);
    CREATE TABLE trading_remote_evidence (classification TEXT NOT NULL);
  `);
  assert.equal((await assessRestoreEligibility(database)).status, 'eligible');
  const cases = [
    ['trading_trade_intents', 'status', ['pending', 'planned', 'submitting', 'monitoring', 'unknown']],
    ['trading_orders', 'status', ['created', 'submitting', 'open', 'partially_filled', 'cancel_pending', 'unknown']],
    ['trading_operations', 'phase', ['prepared', 'dispatching', 'acknowledged', 'unresolved']],
    ['trading_remote_evidence', 'classification', ['unresolved', 'conflict']],
  ];
  for (const [table, column, states] of cases) {
    for (const state of states) {
      await database.run(`INSERT INTO ${table} (${column}) VALUES (?)`, [state]);
      const evidence = await assessRestoreEligibility(database);
      assert.equal(evidence.status, 'blocked', `${table}/${state} must block the actual restore gate.`);
      assert.throws(() => requireRestoreEligibility(evidence), /unresolved trading exposure/);
      await database.exec(`DELETE FROM ${table}`);
    }
  }
  for (const state of ['opening', 'open', 'closing', 'emergency']) {
    await database.run('INSERT INTO trading_positions VALUES (?, ?)', [state, '0']);
    assert.equal((await assessRestoreEligibility(database)).status, 'blocked', `${state}/quantity=0 is not proof of terminal exposure.`);
    await database.exec('DELETE FROM trading_positions');
  }
  for (const count of [undefined, null, '0', -1, 0.5, Number.NaN]) {
    const fake = { get: async () => ({ count }) };
    assert.equal((await assessRestoreEligibility(fake)).status, 'unknown');
  }
  const now = Date.now();
  const proof = { artifactSha256: 'a'.repeat(64), artifactCreatedAt: new Date(now).toISOString(), verifiedAt: now };
  const eligible = { healthy: true, integrityVerified: proof, configurationCoherent: proof,
    restoreEligibility: { status: 'eligible', scope: 'artifact-local-integrated-restore', checkedAt: now, artifactSha256: proof.artifactSha256, reasons: [] } };
  assert.equal(hasCurrentRestorableBackup(eligible, now), true);
  for (const change of [
    value => { value.restoreEligibility.status = 'blocked'; },
    value => { value.restoreEligibility.status = 'unknown'; },
    value => { value.configurationCoherent = null; },
    value => { value.restoreEligibility.artifactSha256 = 'b'.repeat(64); },
    value => { value.integrityVerified.verifiedAt = now - 30 * 60_000 - 1; },
    value => { value.integrityVerified.artifactCreatedAt = new Date(now - 31 * 60_000).toISOString(); },
    value => { value.restoreEligibility.checkedAt = now + 1; },
    value => { value.restoreEligibility.scope = 'current-exchange-flatness'; },
  ]) {
    const invalid = structuredClone(eligible);
    change(invalid);
    assert.equal(hasCurrentRestorableBackup(invalid, now), false);
  }
  console.log('Backup eligibility: prepared/created/opening-zero, unresolved operations/evidence and missing sources stay fail-closed.');
} finally {
  await database.close();
  await rm(root, { recursive: true, force: true });
}
