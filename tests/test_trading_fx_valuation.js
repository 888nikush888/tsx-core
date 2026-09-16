import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, withDatabaseTransaction } from '../src/db.js';
import { getTradingAccount } from '../src/trading_repository.js';
import { bindAccountReportingCurrency, getMoneyEvent, moneyLedgerSnapshot, recordMoneyEvent } from '../src/trading_money_ledger.js';
import { captureFxReceipts } from '../src/trading_fx_repository.ts';
import { readFxMoneyValuation, valueFxMoneyEvent, valueFxAccountMoney } from '../src/trading_fx_valuation.ts';
import { fxReceipt, sealFxReceipt, FX_CONTEXT } from './fixtures/fx_receipts.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-fx-money-'));
const filename = path.join(directory, 'money.db');
const at = Date.now() - 1000;
async function fixture(id) {
  await getDatabase().run(`INSERT INTO trading_accounts (id,name,exchange,mode,status,enabled,credential_ref,
    external_account_id,credential_generation,capabilities_json,last_verified_at,created_at,updated_at)
    VALUES (?,?,'bybit','testnet','ready',1,'fixture',?,?,?,?,?,?)`, [id, id, createHash('sha256').update(id).digest('hex'), 'c'.repeat(64),
  JSON.stringify({ executionProfileHash: FX_CONTEXT.profileHash, profileVersion: 1,
    executionCapabilities: { provider_api_version: 'bybit-v5' } }), at - 2000, at - 3000, at]);
  const account = await getTradingAccount(id);
  await bindAccountReportingCurrency({ accountId: id, accountFingerprint: account.externalAccountId, profile: 'bybit',
    reportingCurrency: 'USD', settlementAssets: ['USDT', 'USDC'], source: 'bybit-wallet-balance-v1', verifiedAt: at });
  return account;
}
const event = (account, providerEventId, amount, asset, occurredAt = at) => recordMoneyEvent({ accountId: account.id,
  accountFingerprint: account.externalAccountId, providerEventId, amount, asset, occurredAt,
  kind: 'funding', basis: 'provider', source: 'synthetic-local-fixture' });
const count = async table => (await getDatabase().get(`SELECT COUNT(*) n FROM ${table}`)).n;
try {
  await initDb(filename);
  const account = await fixture('money-a'), other = await fixture('money-b');
  const original = await event(account, 'fraction', '-10', 'USDT');
  assert.equal(original.valuationStatus, 'unresolved');
  await assert.rejects(valueFxMoneyEvent(account, original.id), /FX.*UNAVAILABLE/);
  assert.equal(await count('trading_fx_money_valuations'), 0);
  const receipts = [fxReceipt('usd', at - 20), fxReceipt('usdt', at), fxReceipt('usdc', at - 10)];
  await captureFxReceipts(account, receipts, { startedAt: at - 100, completedAt: at + 100 });
  const proof = await valueFxMoneyEvent(account, original.id);
  assert.deepEqual(proof.value.exact, { numerator: '-4000', denominator: '401' });
  assert.equal(proof.value.decimal, null, 'An exact nonterminating amount must not be passed off as a rounded decimal.');
  assert.equal(proof.reportingCurrency, 'USD');
  assert.equal((await getMoneyEvent(original.id)).valuationStatus, 'valued');
  assert.deepEqual((await getMoneyEvent(original.id)).reportingValue, proof.value);
  const ledger = await moneyLedgerSnapshot(account.id, at - 1, at + 1);
  assert.equal(ledger.valuationStatus, 'valued');
  assert.equal(ledger.amount, null);
  assert.deepEqual(ledger.value.exact, proof.value.exact);
  assert.deepEqual(ledger.fundingValue, proof.value);
  assert.deepEqual(ledger.unresolvedEventIds, []);
  assert.deepEqual(await valueFxMoneyEvent(account, original.id), proof);
  assert.equal(await count('trading_fx_money_valuations'), 1);
  assert.equal(await count('trading_money_valuations'), 0, 'Do not insert a rounded surrogate into the old decimal ledger.');
  await assert.rejects(valueFxMoneyEvent(other, original.id), /FX/);
  const future = await event(account, 'no-prior-usdt-quote', '-1', 'USDT', at - 1);
  const old = await event(account, 'stale', '-1', 'USDT', at + 10001);
  const bnb = await event(account, 'unsupported', '-1', 'BNB');
  for (const item of [future, old, bnb]) await assert.rejects(valueFxMoneyEvent(account, item.id), /FX/);
  const rebate = await event(other, 'rebate', '0.025', 'USDC');
  await captureFxReceipts(other, receipts, { startedAt: at - 100, completedAt: at + 100 });
  assert.equal((await valueFxMoneyEvent(other, rebate.id)).value.decimal, '0.02505');
  const native = await event(other, 'native', '-2', 'USD');
  const nativeBytes = await getDatabase().get('SELECT content_json FROM trading_money_valuations WHERE event_id=?', [native.id]);
  await assert.rejects(valueFxMoneyEvent(other, native.id), /FX/);
  assert.deepEqual(await getDatabase().get('SELECT content_json FROM trading_money_valuations WHERE event_id=?', [native.id]), nativeBytes);
  const pending = await event(other, 'pending', '-0.000000000000000001', 'USDT');
  await assert.rejects(withDatabaseTransaction(async () => {
    await valueFxMoneyEvent(other, pending.id);
    throw new Error('forced outer rollback');
  }), /forced outer rollback/);
  assert.equal(await readFxMoneyValuation(pending.id), null);
  await valueFxAccountMoney(other, 1);
  const tiny = await readFxMoneyValuation(pending.id);
  assert.equal(tiny.value.lower, '-0.000000000000000001');
  assert.equal(tiny.value.upper, '0');
  assert.notEqual(tiny.value.exact.numerator, '0');
  await closeDb(); await initDb(filename);
  assert.deepEqual(await readFxMoneyValuation(original.id), proof);
  await captureFxReceipts(account, [fxReceipt('usd', at + 5)], { startedAt: at - 100, completedAt: at + 100 });
  assert.deepEqual(await valueFxMoneyEvent(account, original.id), proof, 'A newer quote cannot reprice the event.');
  const contradictory = structuredClone(receipts[0]);
  contradictory.value = '61000'; contradictory.envelope.result.list[0].indexPrice = contradictory.value;
  await captureFxReceipts(account, [sealFxReceipt(contradictory)], { startedAt: at - 100, completedAt: at + 100 });
  await assert.rejects(readFxMoneyValuation(original.id), /FX.*CONFLICT/);
  assert.equal((await getMoneyEvent(original.id)).valuationStatus, 'unresolved');
  await assert.rejects(getDatabase().run('UPDATE trading_fx_money_valuations SET recorded_at=recorded_at'), /immutable/);
  await assert.rejects(getDatabase().run('DELETE FROM trading_fx_money_valuations'), /retained/);
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  console.log('Exact event-time FX values, native preservation, tiny costs, replay, rollback and contradictory-original rejection passed.');
} finally {
  await closeDb(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  await rm(directory, { recursive: true, force: true });
}
