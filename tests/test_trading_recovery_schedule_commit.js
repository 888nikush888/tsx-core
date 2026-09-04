import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb } from '../src/db.js';
import { getTradingAccount } from '../src/trading_repository.js';
import { recordAcquisitionEvidence } from '../src/trading_evidence_repository.js';
import { reserveScheduledRecovery, completeScheduledRecovery } from '../src/trading_recovery_schedule_repository.ts';
import { persistFxConversion } from '../src/trading_fx_repository.ts';
import { fxReceipt } from './fixtures/fx_receipts.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-schedule-commit-'));
const filename = path.join(directory, 'test.db');
const profileHash = 'c'.repeat(64);
async function setup(id) {
  const at = Date.now() - 1000;
  await getDatabase().run(`INSERT INTO trading_accounts(id,name,exchange,mode,status,enabled,credential_ref,
    external_account_id,credential_generation,capabilities_json,last_verified_at,created_at,updated_at)
    VALUES (?,?,'bybit','testnet','ready',1,'fixture',?,?,?,?,?,?)`, [id, id, createHash('sha256').update(id).digest('hex'),
  'b'.repeat(64), JSON.stringify({ executionProfileHash: profileHash, profileVersion: 1,
    executionCapabilities: { provider_api_version: 'bybit-v5' } }), at - 1000, at - 2000, at]);
  const account = await getTradingAccount(id);
  const query = await reserveScheduledRecovery(account, { since: at - 1000, orders: [], history: [] }, at);
  const receipts = ['usd', 'usdt', 'usdc'].map(kind => fxReceipt(kind, at + 100, { profileHash }));
  const evidence = { version: 1, startedAt: at + 90, completedAt: at + 120, checkedOrders: [], targetedCalls: 0, history: [],
    sources: ['orders', 'positions', 'fills', 'targeted_orders'].map(source => ({ source, startedAt: at + 90,
      completedAt: at + 120, completeness: 'complete', reason: null, since: source === 'fills' ? at - 1000 : null })),
    fxEvidence: { version: 1, calls: 3, receipts, reason: null, nextReadAt: 0 },
    recoverySchedule: { version: 1, profile: query.recoverySchedule.profile, attemptId: query.recoverySchedule.attemptId,
      baseRevision: query.recoverySchedule.revision, phase: query.recoverySchedule.phase, binding: query.recoverySchedule.binding,
      calls: 3, cooldownUntil: 0, lanes: query.recoverySchedule.grants.map(grant => ({ lane: grant.lane,
        calls: grant.lane === 'fx' ? 3 : 0, reason: grant.lane === 'fx' ? null : grant.deferredReason })) } };
  return { account, query, evidence, at };
}
async function count(table, accountId) {
  return (await getDatabase().get(`SELECT COUNT(*) n FROM ${table} WHERE account_id=?`, [accountId])).n;
}
try {
  await initDb(filename);
  const first = await setup('successful');
  await assert.rejects(completeScheduledRecovery(first.account, 'missing'), /NOT_PERSISTED/);
  await recordAcquisitionEvidence(first.account, first.evidence);
  const attempt = await getDatabase().get('SELECT status,calls FROM trading_recovery_schedule_attempts WHERE id=?', [first.query.recoverySchedule.attemptId]);
  assert.deepEqual(attempt, { status: 'succeeded', calls: 3 });
  assert.equal(await count('trading_fx_receipts', first.account.id), 3);
  assert.equal(await count('trading_acquisition_evidence', first.account.id), 1);
  assert.deepEqual((await persistFxConversion(first.account, 'USDT', 'USD', first.at + 100)).conversion.rate,
    { numerator: '400', denominator: '401' });
  const held = await getDatabase().get('SELECT phase,revision FROM trading_recovery_schedules WHERE account_id=?', [first.account.id]);
  assert.deepEqual(held, { phase: 1, revision: 1 });
  await assert.rejects(recordAcquisitionEvidence(first.account, first.evidence), /ATTEMPT_NOT_OPEN/);
  assert.equal(await count('trading_acquisition_evidence', first.account.id), 1);
  const next = await setup('rollback');
  await getDatabase().exec(`CREATE TRIGGER reject_schedule_commit BEFORE UPDATE ON trading_recovery_schedule_attempts
    WHEN NEW.account_id='rollback' AND NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'simulated final commit failure'); END;`);
  await assert.rejects(recordAcquisitionEvidence(next.account, next.evidence), /simulated final commit failure/);
  assert.equal(await count('trading_fx_receipts', next.account.id), 0);
  assert.equal(await count('trading_acquisition_evidence', next.account.id), 0);
  assert.deepEqual(await getDatabase().get('SELECT phase,revision FROM trading_recovery_schedules WHERE account_id=?', [next.account.id]), { phase: 0, revision: 0 });
  assert.equal((await getDatabase().get('SELECT status FROM trading_recovery_schedule_attempts WHERE id=?', [next.query.recoverySchedule.attemptId])).status, 'reserved');
  await getDatabase().exec('DROP TRIGGER reject_schedule_commit');
  const changed = structuredClone(next.evidence); changed.recoverySchedule.binding.credentialGeneration = 'e'.repeat(64);
  await assert.rejects(recordAcquisitionEvidence(next.account, changed), /SCHEDULE/);
  assert.equal(await count('trading_fx_receipts', next.account.id), 0);
  await recordAcquisitionEvidence(next.account, next.evidence);
  assert.equal(await count('trading_fx_receipts', next.account.id), 3);
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  await closeDb(); await initDb(filename);
  assert.equal(await count('trading_fx_receipts', first.account.id), 3);
  assert.equal((await getDatabase().get('SELECT status FROM trading_recovery_schedule_attempts WHERE id=?', [next.query.recoverySchedule.attemptId])).status, 'succeeded');
  console.log('Acquisition commit: validated request, retained FX originals, source-first atomic schedule progress, rollback and restart passed.');
} finally {
  await closeDb(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  await rm(directory, { recursive: true, force: true });
}
