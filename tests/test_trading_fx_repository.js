import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, withDatabaseTransaction } from '../src/db.js';
import { getTradingAccount } from '../src/trading_repository.js';
import { captureFxReceipts, persistFxConversion, readFxConversion } from '../src/trading_fx_repository.ts';
import { fxReceipt, sealFxReceipt, FX_CONTEXT } from './fixtures/fx_receipts.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-fx-repository-'));
const filename = path.join(directory, 'fx.db');
const at = Date.now() - 1000;
const receipts = [fxReceipt('usd', at - 20), fxReceipt('usdt', at), fxReceipt('usdc', at - 10)];
const read = { startedAt: at - 100, completedAt: at + 100 };
async function fixture(id) {
  await getDatabase().run(`INSERT INTO trading_accounts (id,name,exchange,mode,status,enabled,credential_ref,
    external_account_id,credential_generation,capabilities_json,last_verified_at,created_at,updated_at)
    VALUES (?,?,'bybit','testnet','ready',1,'fixture',?,?,?,?,?,?)`, [id, id, createHash('sha256').update(id).digest('hex'), 'c'.repeat(64),
  JSON.stringify({ executionProfileHash: FX_CONTEXT.profileHash, profileVersion: 1,
    executionCapabilities: { provider_api_version: 'bybit-v5' } }), at - 2000, at - 3000, at]);
  return getTradingAccount(id);
}
async function count(table) { return (await getDatabase().get(`SELECT COUNT(*) n FROM ${table}`)).n; }
try {
  await initDb(filename);
  const account = await fixture('fx-a'), other = await fixture('fx-b');
  let identityReads = 0;
  const changingIdentity = Object.defineProperty({ ...account }, 'id', {
    enumerable: true, get: () => ++identityReads === 1 ? account.id : other.id,
  });
  await assert.rejects(captureFxReceipts(changingIdentity, [receipts[0]], read), /FX/,
    'A changing account getter must not validate account A and persist its fingerprint under account B.');
  assert.equal(await count('trading_fx_receipts'), 0);
  const mutable = { ...account };
  const pending = captureFxReceipts(mutable, [receipts[0]], read);
  mutable.id = other.id;
  await pending;
  assert.equal((await getDatabase().get('SELECT account_id FROM trading_fx_receipts')).account_id, account.id,
    'A normal caller mutation after invocation cannot change the original account binding either.');
  await captureFxReceipts(account, receipts, read);
  assert.equal(await count('trading_fx_receipts'), 3);
  const invalidPayload = '{}\u0000' + 'x'.repeat(131072);
  await assert.rejects(getDatabase().run(`INSERT INTO trading_fx_receipts
    (id,account_id,account_fingerprint,credential_generation,mode,profile_hash,receipt_hash,leg_id,provider_response_at,
    acquisition_started_at,acquisition_completed_at,payload_json,recorded_at)
    SELECT ?,account_id,account_fingerprint,credential_generation,mode,profile_hash,?,leg_id,provider_response_at,
    acquisition_started_at,acquisition_completed_at,?,recorded_at FROM trading_fx_receipts LIMIT 1`,
  ['d'.repeat(64), 'e'.repeat(64), invalidPayload]), /CHECK/,
  'SQLite TEXT length/json_valid stop at embedded NUL; the persisted payload must enforce bytes and reject NUL.');
  await captureFxReceipts(account, receipts, read);
  assert.equal(await count('trading_fx_receipts'), 3, 'Read replay does not rewrite or duplicate original observations.');
  const proof = await persistFxConversion(account, 'USDT', 'USD', at);
  assert.deepEqual(proof.conversion.rate, { numerator: '400', denominator: '401' });
  assert.deepEqual(await readFxConversion(account, proof.id), proof);
  assert.deepEqual(await persistFxConversion(account, 'USDT', 'USD', at), proof);
  assert.equal(await count('trading_fx_conversions'), 1);
  assert.equal(await count('trading_fx_conversion_receipts'), 2);
  await assert.rejects(readFxConversion(other, proof.id), /FX/);
  await assert.rejects(persistFxConversion(other, 'USDT', 'USD', at), /FX.*UNAVAILABLE/);
  await captureFxReceipts(other, receipts, read);
  assert.notEqual((await persistFxConversion(other, 'USDT', 'USD', at)).id, proof.id,
    'Public quote originals may be observed by two accounts, but never share account authority.');
  // Even a complete, correctly hashed recipe must reference the actual retained originals.
  const { fxEvidenceDigest } = await import('../src/trading_fx_contract.ts');
  const { evidenceHash: omitted, ...body } = proof.conversion;
  void omitted;
  const fakeBody = { ...body, rate: { numerator: '1', denominator: '1' } };
  const fake = { ...fakeBody, evidenceHash: fxEvidenceDigest('tsx-fx-conversion-v1', fakeBody) };
  const fakeId = fxEvidenceDigest('tsx-fx-account-conversion-v1', { accountId: account.id,
    accountFingerprint: account.externalAccountId, credentialGeneration: account.credentialGeneration, evidenceHash: fake.evidenceHash });
  await getDatabase().run(`INSERT INTO trading_fx_conversions (id,account_id,account_fingerprint,credential_generation,
    evidence_hash,payload_json,recorded_at) VALUES (?,?,?,?,?,?,?)`,
  [fakeId, account.id, account.externalAccountId, account.credentialGeneration, fake.evidenceHash, JSON.stringify(fake), at]);
  await assert.rejects(readFxConversion(account, fakeId), /FX.*ORIGINALS/);
  await getDatabase().run(`INSERT INTO trading_fx_conversion_receipts(account_id,conversion_id,receipt_id,ordinal)
    SELECT account_id,?,receipt_id,ordinal FROM trading_fx_conversion_receipts WHERE conversion_id=?`, [fakeId, proof.id]);
  await assert.rejects(readFxConversion(account, fakeId), /FX.*CHANGED/);
  await closeDb(); await initDb(filename);
  assert.deepEqual(await readFxConversion(account, proof.id), proof, 'Restart revalidates the pinned originals.');
  for (const table of ['trading_fx_receipts', 'trading_fx_conversions', 'trading_fx_conversion_receipts']) {
    await assert.rejects(getDatabase().run(`UPDATE ${table} SET account_id=account_id`), /immutable/);
    await assert.rejects(getDatabase().run(`DELETE FROM ${table}`), /retained/);
  }
  await assert.rejects(captureFxReceipts(account, receipts, { startedAt: at, completedAt: at + 100 }), /FX/);
  await assert.rejects(captureFxReceipts(account, [receipts[0], { ...receipts[1], profileHash: 'd'.repeat(64) }], read), /FX/);
  await assert.rejects(persistFxConversion(account, 'USDT', 'USD', at + 10001), /FX/);
  await assert.rejects(persistFxConversion(account, 'USDT', 'USD', at - 1), /FX/);
  await assert.rejects(persistFxConversion(account, 'BNB', 'USD', at), /FX/);
  for (const patch of [{ mode: 'live' }, { exchange: 'hyperliquid' }, { credentialGeneration: 'f'.repeat(64) },
    { externalAccountId: 'd'.repeat(64) }, { capabilities: { ...account.capabilities, executionProfileHash: 'e'.repeat(64) } }]) {
    await assert.rejects(captureFxReceipts({ ...account, ...patch }, receipts, read), /FX/);
    await assert.rejects(readFxConversion({ ...account, ...patch }, proof.id), /FX/);
  }
  const before = await count('trading_fx_receipts');
  await assert.rejects(withDatabaseTransaction(async () => {
    await captureFxReceipts(account, [fxReceipt('usd', at + 1)], read);
    throw new Error('simulated caller rollback');
  }), /simulated caller rollback/);
  assert.equal(await count('trading_fx_receipts'), before);
  await getDatabase().run('UPDATE trading_accounts SET last_verified_at=NULL WHERE id=?', [account.id]);
  await assert.rejects(captureFxReceipts(account, receipts, read), /FX.*UNVERIFIED/);
  await getDatabase().run('UPDATE trading_accounts SET last_verified_at=? WHERE id=?', [at - 2000, account.id]);
  await captureFxReceipts(account, [fxReceipt('usd', at + 5)], read);
  assert.deepEqual(await readFxConversion(account, proof.id), proof, 'A later quote never reprices a pinned historical recipe.');
  const conflicting = structuredClone(receipts[0]);
  conflicting.value = '61000'; conflicting.envelope.result.list[0].indexPrice = conflicting.value;
  await captureFxReceipts(account, [sealFxReceipt(conflicting)], read);
  await assert.rejects(persistFxConversion(account, 'USDT', 'USD', at), /FX.*CONFLICT/);
  await assert.rejects(readFxConversion(account, proof.id), /FX.*CONFLICT/,
    'A later-discovered contradiction of the SAME original observation must invalidate its usable proof, without repricing it.');
  await getDatabase().run("UPDATE trading_accounts SET credential_generation=? WHERE id=?", ['f'.repeat(64), account.id]);
  await assert.rejects(readFxConversion(account, proof.id), /FX/);
  const changed = await getTradingAccount(account.id);
  await assert.rejects(persistFxConversion(changed, 'USDT', 'USD', at), /FX.*UNAVAILABLE/);
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  console.log('Immutable FX account/profile bindings, original receipt proofs, replay, restart, expiry and rollback passed.');
} finally {
  await closeDb(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  await rm(directory, { recursive: true, force: true });
}
