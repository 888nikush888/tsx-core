import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { closeDb, getDatabase, initDb } from '../src/db.js';
import { createTradingAccount, updateTradingAccountState } from '../src/trading_repository.js';
import { accountModeDigest, assertAccountModeResponse, validateAccountModeObservation, validateAccountModeProgress } from '../src/trading_account_mode_contract.js';
import { accountModeReadRequired, persistAccountModeObservation } from '../src/trading_account_mode.js';
import { validateAcquisitionEvidence } from '../src/exchange_contract_validation.js';

const fingerprint = 'a'.repeat(64), generation = 'b'.repeat(64);
function observation(patch = {}) {
  const value = { version: 1, profile: 'bybit_uta_v1', accountFingerprint: fingerprint, credentialGeneration: generation,
    providerAccountUid: '9007199254740993', parentAccountUid: '42', isMaster: false,
    unifiedMarginStatus: 5, accountUpdatedAt: 0, startedAt: Date.now() - 20, completedAt: Date.now() - 10, ...patch };
  return { ...value, evidenceHash: accountModeDigest(value) };
}
const valid = observation();
assert.equal(observation({ startedAt: 100, completedAt: 120 }).evidenceHash,
  'f73cc12296c652e979e9699bc4942738bba230e44a941e4ae224f7cf70c48865', 'Pinned Python sorted-JSON hash matches Node without locale dependence.');
assert.deepEqual(validateAccountModeObservation(valid), valid);
for (const patch of [{ providerAccountUid: '0' }, { parentAccountUid: '0' }, { unifiedMarginStatus: '5' },
  { accountUpdatedAt: null }, { evidenceHash: 'e'.repeat(64) }, { createdAt: 0 }, { startedAt: valid.completedAt + 1 }]) {
  assert.throws(() => validateAccountModeObservation({ ...valid, ...patch }));
}
const acquisition = { startedAt: valid.startedAt, completedAt: valid.completedAt };
assert.equal(validateAccountModeProgress({ calls: 2, observation: valid, reason: null }, acquisition).calls, 2);
assert.throws(() => validateAccountModeProgress({ calls: 0, observation: valid, reason: null }, acquisition));
assert.throws(() => validateAccountModeProgress({ calls: 2, observation: valid, reason: null }, { ...acquisition, startedAt: valid.startedAt + 1 }));
const expected = { accountFingerprint: fingerprint, credentialGeneration: generation };
assert.throws(() => assertAccountModeResponse(true, undefined, expected));
assert.throws(() => assertAccountModeResponse(false, { calls: 2, observation: valid, reason: null }, expected));
assert.throws(() => assertAccountModeResponse(true, { calls: 2, observation: valid, reason: null }, { ...expected, credentialGeneration: 'c'.repeat(64) }));
assertAccountModeResponse(true, { calls: 0, observation: null, reason: 'budget_exhausted' }, expected);
const acquisitionEnvelope = { version: 1, ...acquisition, targetedCalls: 3, checkedOrders: [], history: [],
  accountMode: { calls: 2, observation: valid, reason: null }, sources: ['positions', 'orders', 'fills', 'targeted_orders'].map(source => ({
    source, ...acquisition, completeness: 'unknown', reason: null, since: null })) };
assert.equal(validateAcquisitionEvidence(acquisitionEnvelope).targetedCalls, 3);
assert.throws(() => validateAcquisitionEvidence({ ...acquisitionEnvelope, targetedCalls: 4 }), /five/);
assert.throws(() => validateAcquisitionEvidence({ ...acquisitionEnvelope, targetedCalls: undefined }));
const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-mode-consumer-'));
try {
  const filename = path.join(directory, 'fixture.db');
  await initDb(filename);
  const created = await createTradingAccount({ name: 'Mode evidence fixture', exchange: 'bybit', mode: 'testnet', credentialRef: 'local-fixture' });
  const account = await updateTradingAccountState(created.id, { status: 'ready', enabled: true, verifiedAt: Date.now(),
    externalAccountId: fingerprint, credentialGeneration: generation });
  assert.equal(await accountModeReadRequired(account), true);
  await persistAccountModeObservation(account, { calls: 2, observation: valid, reason: null }, acquisition);
  await persistAccountModeObservation(account, { calls: 2, observation: valid, reason: null }, acquisition);
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS n FROM trading_account_mode_observations')).n, 1);
  assert.equal(await accountModeReadRequired(account), false);
  await assert.rejects(persistAccountModeObservation({ ...account, credentialGeneration: 'c'.repeat(64) },
    { calls: 2, observation: valid, reason: null }, acquisition), /binding/);
  await assert.rejects(getDatabase().run('UPDATE trading_account_mode_observations SET completed_at=0'), /immutable/);
  await closeDb();
  await initDb(filename);
  assert.equal(await accountModeReadRequired(account), false, 'Restart must reuse the actual bound observation.');
  assert.equal((await getDatabase().get('SELECT external_account_id FROM trading_accounts WHERE id=?', [account.id])).external_account_id,
    fingerprint, 'UID is additional evidence, never a silent account rebind.');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
console.log('Account mode: strict binding, immutable evidence and restart passed.');
