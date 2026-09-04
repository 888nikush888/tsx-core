import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb } from '../src/db.js';
import { getTradingAccount } from '../src/trading_repository.js';
import { accountLogDigest, accountLogAcquisitionFields } from '../src/trading_account_log_contract.js';
import { accountLogCheckpoint, persistAccountLogProgress } from '../src/trading_account_log_repository.js';
import { projectAccountLogMoney } from '../src/trading_account_log_money.js';
import { observedFundingEvidence, assertFundingObservationCurrent } from '../src/trading_funding_observation.js';
import { bindAccountReportingCurrency, moneyLedgerSnapshot, recordMoneyEvent } from '../src/trading_money_ledger.js';
import { validateFundingEvidence } from '../src/trading_accounting_contract.js';
import { logProgress } from './fixtures/account_log.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-funding-observation-'));
const filename = path.join(directory, 'test.db');
const now = Date.now(), today = new Date(now).setUTCHours(0, 0, 0, 0);
async function account(id = 'native', bind = true) {
  await getDatabase().run(`INSERT INTO trading_accounts (id,name,exchange,mode,status,enabled,credential_ref,external_account_id,
    credential_generation,created_at,updated_at) VALUES (?,?,'hyperliquid','testnet','ready',1,'fixture',?,?,?,?)`,
  [id, id, accountLogDigest(id), 'b'.repeat(64), today, now]);
  const result = await getTradingAccount(id);
  if (bind) await bindCurrency(result);
  return result;
}
async function bindCurrency(result) {
  await bindAccountReportingCurrency({ accountId: result.id, accountFingerprint: result.externalAccountId, profile: 'hyperliquid',
    reportingCurrency: 'USDC', settlementAssets: ['USDC'], source: 'hyperliquid-clearinghouse-state-v1', verifiedAt: now });
}
const raw = (coin, amount, timestamp = now - 1) => ({ type: 'funding', hash: `0x${'0'.repeat(64)}`, coin, usdc: amount, time: String(timestamp) });
async function append(target, records) {
  const checkpoint = await accountLogCheckpoint(target);
  await persistAccountLogProgress(target, logProgress(checkpoint, records, now));
  return checkpoint;
}
async function nativeReplayAndForgery() {
  const target = await account();
  const first = raw('BTC', '-0.1');
  await recordMoneyEvent({ accountId: target.id, accountFingerprint: target.externalAccountId,
    providerEventId: accountLogDigest([first.hash, first.coin, Number(first.time)]), kind: 'funding',
    source: 'hyperliquid:funding-v1', basis: 'provider', occurredAt: Number(first.time), amount: first.usdc, asset: 'USDC' });
  await append(target, [first, raw('ETH', '0.2'), raw('BTC', '-0.3', now)]);
  await closeDb(); await initDb(filename); // Raw receipt committed, financial consumer not yet run.
  const proof = await observedFundingEvidence(target, now);
  assert.equal(proof.observation.status, 'observed'); assert.equal(proof.observation.amount, '-0.2');
  assert.equal((await getDatabase().get("SELECT COUNT(*) AS n FROM trading_money_events WHERE account_id='native'")).n, 3);
  assert.deepEqual(validateFundingEvidence(proof), proof);
  for (const patch of [{ amount: '1' }, { through: now - 2 }, { reportingCurrency: 'USD' }, { namespace: 'bybit_uta_transaction_log_scope_v1' }]) {
    await assert.rejects(assertFundingObservationCurrent(target, { ...proof.observation, ...patch }), /stale|unresolved/);
  }
  assert.throws(() => validateFundingEvidence({ ...proof, source: 'other' }), /envelope/);
  await append(target, [raw('BTC', '-5', now - 2)]);
  await assert.rejects(assertFundingObservationCurrent(target, proof.observation), /stale|unresolved/,
    'New unconsumed negative source evidence invalidates the old proof before aggregate refresh.');
  assert.equal((await observedFundingEvidence(target, now)).observation.amount, '-5.2');
  assert.equal((await moneyLedgerSnapshot(target.id, today, now + 1)).funding, '-5.2');
}
async function missingValuation() {
  const target = await account('hip3');
  await append(target, [raw('xyz:XYZ100', '-2')]);
  const proof = await observedFundingEvidence(target, now);
  assert.equal(proof.observation.status, 'incomplete'); assert.equal(proof.observation.amount, null);
  const event = await getDatabase().get("SELECT asset,amount FROM trading_money_events WHERE account_id='hip3'");
  assert.deepEqual(event, { asset: null, amount: '-2' }, 'An usdc-named field is not collateral proof for an unknown DEX.');
}
async function receiptBeforeFirstBalance() {
  const target = await account('first-balance', false);
  await append(target, [raw('BTC', '-0.2')]); await projectAccountLogMoney(target);
  assert.equal((await observedFundingEvidence(target, now)).observation.amount, null);
  await bindCurrency(target);
  assert.equal((await observedFundingEvidence(target, now)).observation.amount, '-0.2',
    'Native originals ingested before the first balance bind must be valued without reposting or a manual retry.');
}
async function rollbackAndRotation() {
  const target = await account('atomic');
  const initial = await accountLogCheckpoint(target);
  await getDatabase().exec(`CREATE TRIGGER fail_log_checkpoint BEFORE UPDATE ON trading_account_log_checkpoints
    WHEN NEW.account_id='atomic' BEGIN SELECT RAISE(ABORT,'simulated cursor commit crash'); END;`);
  await assert.rejects(persistAccountLogProgress(target, logProgress(initial, [raw('BTC', '-1')], now)), /simulated/);
  assert.equal((await getDatabase().get("SELECT COUNT(*) AS n FROM trading_account_log_receipts WHERE account_id='atomic'")).n, 0);
  assert.equal((await accountLogCheckpoint(target)).revision, 0, 'Raw records, consumer work and cursor roll back atomically.');
  await getDatabase().exec('DROP TRIGGER fail_log_checkpoint');
  await append(target, []); await projectAccountLogMoney(target);
  const old = (await observedFundingEvidence(target, now)).observation;
  await getDatabase().run("UPDATE trading_accounts SET credential_generation=? WHERE id='atomic'", ['c'.repeat(64)]);
  const rotated = await getTradingAccount('atomic');
  const reset = await accountLogCheckpoint(rotated);
  assert.equal(reset.scannedThrough, null); assert.ok(reset.revision > initial.revision);
  await assert.rejects(assertFundingObservationCurrent(rotated, old), /stale|unresolved/);
  assert.equal((await getDatabase().get("SELECT COUNT(*) AS n FROM trading_account_log_receipts WHERE account_id='atomic'")).n, 1,
    'Credential rotation never deletes prior source evidence.');
}
try {
  await initDb(filename);
  await nativeReplayAndForgery(); await missingValuation(); await rollbackAndRotation(); await receiptBeforeFirstBalance();
  assert.throws(() => accountLogAcquisitionFields({ accountMode: { calls: 2 }, history: [{ pages: 2 }], targetedCalls: 2 }), /five/);
  assert.equal(accountLogAcquisitionFields({ accountMode: { calls: 2 }, history: [{ pages: 1 }], targetedCalls: 2 }).targetedCalls, 2);
  assert.equal((await getDatabase().all('PRAGMA foreign_key_check')).length, 0);
  console.log('Funding observations: native valued replay, delayed loss, immutable proof, atomic cursor and unknown collateral passed.');
} finally { await closeDb(); await rm(directory, { recursive: true, force: true }); }
