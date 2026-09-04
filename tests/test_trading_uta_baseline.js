import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { closeDb, getDatabase, initDb } from '../src/db.js';
import { createTradingAccount, updateTradingAccountState } from '../src/trading_repository.js';
import { observeAccountBaseline } from '../src/trading_account_baseline.js';
import { recordAcquisitionEvidence } from '../src/trading_evidence_repository.js';
import { accountModeDigest } from '../src/trading_account_mode_contract.js';
import { accountModeReadRequired, accountOriginScope } from '../src/trading_account_mode.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-uta-baseline-'));
const fingerprint = 'a'.repeat(64), generation = 'b'.repeat(64), start = Date.now() - 2000;
function snapshot(offset, withMode = false, patch = {}) {
  const startedAt = start + offset, completedAt = startedAt + 20;
  const observation = { version: 1, profile: 'bybit_uta_v1', accountFingerprint: fingerprint, credentialGeneration: generation,
    providerAccountUid: '9007199254740993', parentAccountUid: '42', isMaster: false, unifiedMarginStatus: 5,
    accountUpdatedAt: 0, startedAt: startedAt + 1, completedAt: completedAt - 1, ...patch };
  return { orders: [], fills: [], positions: [], observedAt: completedAt, accountFingerprint: fingerprint,
    acquisition: { version: 1, startedAt, completedAt, targetedCalls: 0, checkedOrders: [], history: [],
      ...(withMode ? { accountMode: { calls: 2, observation: { ...observation, evidenceHash: accountModeDigest(observation) }, reason: null } } : {}),
      sources: ['positions', 'orders', 'fills', 'targeted_orders'].map(source => ({ source, startedAt, completedAt,
        completeness: ['orders', 'positions'].includes(source) ? 'complete' : 'unknown', since: null, reason: null,
        ...(['orders', 'positions'].includes(source) ? { scopes: [{ scope: 'linear:all', pages: 1, complete: true }] } : {}) })) } };
}
async function ingest(account, state) {
  await recordAcquisitionEvidence(account, state.acquisition);
  await observeAccountBaseline(account, state);
}
async function fixture(name) {
  await initDb(path.join(directory, `${name}.db`));
  const account = await createTradingAccount({ name, exchange: 'bybit', mode: 'testnet', credentialRef: 'fixture' });
  return updateTradingAccountState(account.id, { status: 'ready', enabled: true, verifiedAt: Date.now(),
    externalAccountId: fingerprint, credentialGeneration: generation });
}
try {
  const account = await fixture('positive');
  const exhausted = snapshot(-100);
  exhausted.acquisition.accountMode = { calls: 0, observation: null, reason: 'budget_exhausted' };
  await ingest(account, exhausted);
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS n FROM trading_account_baselines')).n, 0);
  await ingest(account, snapshot(0, true));
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS n FROM trading_account_baselines')).n, 0,
    'A mode read inside the first snapshot cannot prove a mode before that snapshot starts.');
  assert.equal(await accountModeReadRequired(account), false, 'Allow the next flat observation to establish a candidate without starving history.');
  await closeDb(); await initDb(path.join(directory, 'positive.db'));
  assert.equal(await accountModeReadRequired(account), false, 'Restart retains the actual prior mode instead of spending the same two reads again.');
  await ingest(account, snapshot(100));
  assert.equal((await getDatabase().get('SELECT status FROM trading_account_baselines')).status, 'candidate');
  await closeDb(); await initDb(path.join(directory, 'positive.db'));
  assert.equal(await accountModeReadRequired(account), true, 'Restart requests the second authenticated mode read.');
  const beforeVerify = snapshot(200);
  beforeVerify.acquisition.accountMode = { calls: 1, observation: null, reason: 'budget_exhausted' };
  await ingest(account, beforeVerify);
  assert.equal((await getDatabase().get('SELECT status FROM trading_account_baselines')).status, 'candidate');
  assert.equal(await accountModeReadRequired(account), true);
  await ingest(account, snapshot(300, true));
  const baseline = await getDatabase().get('SELECT * FROM trading_account_baselines');
  assert.equal(baseline.status, 'established');
  assert.equal(baseline.boundary_at, start + 100, 'Do not move the actual first flat boundary to a key-created/upgrade date.');
  assert.equal((await accountOriginScope(account, baseline.boundary_at)).status, 'post_uta2_baseline');
  assert.match((await accountOriginScope(account, baseline.boundary_at - 1)).reason, /pre_baseline/);
  assert.equal(await accountModeReadRequired(account), false);
  const binding = await getDatabase().get('SELECT * FROM trading_account_baseline_bindings');
  assert.equal(JSON.parse(binding.proof_json).finality, 'not_proven');
  await assert.rejects(getDatabase().run('UPDATE trading_account_baseline_bindings SET boundary_at=0'), /immutable/);
  assert.equal((await accountOriginScope({ ...account, credentialGeneration: 'c'.repeat(64) }, baseline.boundary_at)).status, 'not_proven');
  await closeDb(); await initDb(path.join(directory, 'positive.db'));
  assert.equal((await accountOriginScope(account, baseline.boundary_at)).status, 'post_uta2_baseline');
  await ingest(account, snapshot(400, true, { providerAccountUid: '99' }));
  assert.equal((await accountOriginScope(account, baseline.boundary_at)).reason, 'observed_account_mode_or_uid_conflict');
  await closeDb();

  const legacy = await fixture('legacy');
  await ingest(legacy, snapshot(0)); await ingest(legacy, snapshot(100));
  const legacyBoundary = (await getDatabase().get('SELECT boundary_at FROM trading_account_baselines')).boundary_at;
  await ingest(legacy, snapshot(200, true));
  assert.equal((await getDatabase().get('SELECT boundary_at FROM trading_account_baselines')).boundary_at, legacyBoundary);
  assert.equal((await accountOriginScope(legacy, legacyBoundary)).status, 'not_proven', 'Today mode cannot retroactively certify a legacy boundary.');
  await closeDb();

  for (const [name, patch] of [['uid-conflict', { providerAccountUid: '99' }], ['mode-conflict', { unifiedMarginStatus: 3 }]]) {
    const changed = await fixture(name);
    await ingest(changed, snapshot(0, true)); await ingest(changed, snapshot(100));
    await ingest(changed, snapshot(200, true, patch));
    assert.equal((await getDatabase().get('SELECT COUNT(*) AS n FROM trading_account_baseline_bindings')).n, 0);
    assert.equal((await getDatabase().get('SELECT status FROM trading_account_baselines')).status, 'candidate');
    await ingest(changed, snapshot(300, true));
    assert.equal((await getDatabase().get('SELECT COUNT(*) AS n FROM trading_account_baseline_bindings')).n, 0,
      'Returning to the initial mode/UID cannot hide an observed contradictory interval.');
    await closeDb();
  }
} finally {
  await closeDb(); await rm(directory, { recursive: true, force: true });
}
console.log('UTA baseline: real pre-boundary mode, restart, immutable scope, legacy and conflicting mode passed.');
