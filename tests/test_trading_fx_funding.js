import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb } from '../src/db.js';
import { CcxtExchangeAdapter } from '../src/ccxt_exchange.js';
import { validateAccountSnapshot } from '../src/exchange_contract_validation.js';
import { validateFundingEvidence } from '../src/trading_accounting_contract.js';
import { assertEntryAccountingReady } from '../src/trading_accounting.js';
import { accountLogCheckpoint, persistAccountLogProgress } from '../src/trading_account_log_repository.js';
import { observedFundingEvidence, assertFundingObservationCurrent } from '../src/trading_funding_observation.js';
import { bindAccountReportingCurrency, moneyLedgerSnapshot } from '../src/trading_money_ledger.js';
import { moneyValueFromDecimal, moneyValueFromRational } from '../src/trading_money_value.js';
import { captureFxReceipts } from '../src/trading_fx_repository.js';
import { valueFxMoneyEvent } from '../src/trading_fx_valuation.js';
import { getTradingAccount } from '../src/trading_repository.js';
import { collectAccountReleaseEvidence } from '../src/trading_safety_repository.js';
import { fxReceipt, sealFxReceipt, FX_CONTEXT } from './fixtures/fx_receipts.js';
import { logProgress, seedPostUta2Origin } from './fixtures/account_log.js';

const now = Date.UTC(2026, 8, 3, 12), today = Date.UTC(2026, 8, 3), at = now - 1000;
const fractional = moneyValueFromRational({ numerator: '-4000', denominator: '401' });
const clone = value => structuredClone(value);
function fundingContract(value = fractional) {
  return { status: 'complete', since: today, until: now, cursor: null, source: 'bybit_uta_transaction_log_scope_v1',
    reason: null, nextReadAt: 0, events: [], observation: { version: 1, status: 'observed',
      namespace: 'bybit_uta_transaction_log_scope_v1', accountFingerprint: 'a'.repeat(64), credentialGeneration: 'c'.repeat(64),
      since: today, through: now, revisionHash: 'b'.repeat(64), reportingCurrency: 'USD', amount: value.decimal, value,
      sourceScope: 'source_account', finality: 'provider_as_observed', delivery: 'may_be_delayed', reason: null } };
}
function balance(account, funding) {
  return { equity: '10000', availableBalance: '9000', unrealizedPnl: '-2', marginUsed: '1000',
    fundingPnlToday: funding.observation?.amount ?? null, fundingPnlTodayValue: funding.observation?.value ?? null,
    accounting: { accountFingerprint: account.externalAccountId, reportingCurrency: 'USD', settlementAssets: ['USDT', 'USDC'],
      source: 'bybit-wallet-balance-v1', observedAt: now, unrealizedPnlSemantics: 'price_only', funding } };
}
function boundaryCases() {
  const proof = fundingContract();
  assert.deepEqual(validateFundingEvidence(clone(proof)), proof,
    'An observed exact rational value is complete even though its exact decimal alias is null.');
  const account = { externalAccountId: proof.observation.accountFingerprint };
  const snapshot = balance(account, proof);
  assert.deepEqual(validateAccountSnapshot(clone(snapshot)), snapshot);
  const observationOnly = clone(snapshot); delete observationOnly.fundingPnlTodayValue;
  assert.deepEqual(validateAccountSnapshot(observationOnly), observationOnly, 'The additive snapshot field remains optional.');
  for (const patch of [{ fundingPnlToday: '-9.975' }, { fundingPnlTodayValue: moneyValueFromDecimal('0') },
    { fundingPnlTodayValue: null }, { accounting: undefined }]) {
    assert.throws(() => validateAccountSnapshot({ ...snapshot, ...patch }), /funding|accounting|money/i);
  }
  for (const patch of [{ amount: '0' }, { value: null }, { value: undefined },
    { value: { ...fractional, lower: '0' } }, { reportingCurrency: null }]) {
    assert.throws(() => validateFundingEvidence({ ...proof, observation: { ...proof.observation, ...patch } }), /funding|money/i);
  }
  const native = fundingContract(moneyValueFromDecimal('-2'));
  assert.throws(() => validateFundingEvidence({ ...native, observation: { ...native.observation, amount: '-2.0' } }), /alias/i);
  delete native.observation.value;
  assert.deepEqual(validateFundingEvidence(clone(native)), native, 'The original native decimal DTO remains supported.');
  const nativeBalance = balance(account, native);
  delete nativeBalance.fundingPnlTodayValue;
  assert.deepEqual(validateAccountSnapshot(nativeBalance), nativeBalance);
  const incomplete = { ...proof, status: 'incomplete', reason: 'valuation_missing', observation: {
    ...proof.observation, status: 'incomplete', amount: null, value: null, reason: 'valuation_missing' } };
  assert.deepEqual(validateAccountSnapshot(balance(account, incomplete)).accounting.funding, incomplete);
}

async function accountFixture(id) {
  await getDatabase().run(`INSERT INTO trading_accounts (id,name,exchange,mode,status,enabled,credential_ref,
    external_account_id,credential_generation,capabilities_json,last_verified_at,created_at,updated_at)
    VALUES (?,?,'bybit','testnet','ready',1,'fixture',?,?,?,?,?,?)`, [id, id, createHash('sha256').update(id).digest('hex'),
  'c'.repeat(64), JSON.stringify({ executionProfileHash: FX_CONTEXT.profileHash, profileVersion: 1,
    executionCapabilities: { provider_api_version: 'bybit-v5' } }), today - 2000, today - 3000, now]);
  const account = await getTradingAccount(id);
  await bindAccountReportingCurrency({ accountId: id, accountFingerprint: account.externalAccountId, profile: 'bybit',
    reportingCurrency: 'USD', settlementAssets: ['USDT', 'USDC'], source: 'bybit-wallet-balance-v1', verifiedAt: now });
  await seedPostUta2Origin(account, today - 1000);
  return account;
}
async function appendFunding(account, id, amount = '-10', currency = 'USDT') {
  const checkpoint = await accountLogCheckpoint(account);
  const row = { id, type: 'SETTLEMENT', category: 'linear', transactionTime: String(at), currency,
    funding: amount, cashFlow: '0', fee: '0' };
  await persistAccountLogProgress(account, logProgress(checkpoint, [row], now));
  await observedFundingEvidence(account, now);
  return getDatabase().get('SELECT id FROM trading_money_events WHERE account_id=? AND provider_event_id=?', [account.id, id]);
}
async function releaseBalance(account, snapshot) {
  const row = await getDatabase().get('SELECT state_version FROM trading_accounts WHERE id=?', [account.id]);
  const remote = { orders: [], fills: [], positions: [], observedAt: now, accountFingerprint: account.externalAccountId };
  return collectAccountReleaseEvidence({ current: account, verificationAccount: account, epoch: 'fixture-epoch',
    requestedAt: now - 100, balanceStartedAt: now - 10, balanceCompletedAt: now, balance: snapshot,
    reconciled: { account, accountVersion: row.state_version, remote }, runtimeCurrent: true });
}
async function noSelfAuthorization(account, actual) {
  const fabricated = balance(account, fundingContract());
  fabricated.accounting.funding.observation.accountFingerprint = account.externalAccountId;
  assert.equal(validateAccountSnapshot(fabricated).fundingPnlToday, null, 'Shape validation is not source authorization.');
  await assert.rejects(assertEntryAccountingReady(account, fabricated), /accounting.*incomplete/i);
  assert.equal((await releaseBalance(account, fabricated)).balanceVerified, false);
  for (const patch of [{ reportingCurrency: 'USDC' }, { credentialGeneration: 'e'.repeat(64) },
    { revisionHash: 'f'.repeat(64) }, { through: now - 1 }, { value: moneyValueFromRational({ numerator: '-8000', denominator: '401' }) }]) {
    const altered = clone(actual);
    Object.assign(altered.accounting.funding.observation, patch);
    await assert.rejects(assertEntryAccountingReady(account, altered), /accounting.*incomplete/i);
    assert.equal((await releaseBalance(account, altered)).balanceVerified, false);
  }
  const stale = clone(actual); stale.accounting.observedAt -= 120000;
  await assert.rejects(assertEntryAccountingReady(account, stale), /accounting.*incomplete/i);
  assert.equal((await releaseBalance(account, stale)).balanceVerified, false);
}
async function nativeCompatibility() {
  const account = await accountFixture('native-funding');
  await appendFunding(account, 'native', '-2', 'USD');
  const proof = await observedFundingEvidence(account, now);
  const snapshot = balance(account, proof);
  delete snapshot.fundingPnlTodayValue;
  delete snapshot.accounting.funding.observation.value;
  await assertFundingObservationCurrent(account, clone(snapshot.accounting.funding.observation));
  await assertEntryAccountingReady(account, snapshot);
  assert.equal((await releaseBalance(account, snapshot)).balanceVerified, true);
}
async function fractionalPipeline(filename) {
  const account = await accountFixture('fx-funding');
  const event = await appendFunding(account, 'fraction');
  const incomplete = balance(account, await observedFundingEvidence(account, now));
  await assert.rejects(assertEntryAccountingReady(account, incomplete), /accounting.*incomplete/i);
  const receipts = [fxReceipt('usd', at - 20), fxReceipt('usdt', at), fxReceipt('usdc', at - 10)];
  await captureFxReceipts(account, receipts, { startedAt: at - 100, completedAt: at + 100 });
  await valueFxMoneyEvent(account, event.id); // Idempotent replay of the automatic valuation from retained originals.
  const proof = await observedFundingEvidence(account, now);
  assert.equal(proof.status, 'complete'); assert.equal(proof.observation.amount, null);
  assert.deepEqual(proof.observation.value, fractional);
  const snapshot = balance(account, proof);
  await assertEntryAccountingReady(account, clone(snapshot));
  assert.equal((await releaseBalance(account, snapshot)).balanceVerified, true);
  const observationOnly = clone(snapshot); delete observationOnly.fundingPnlTodayValue;
  await assertEntryAccountingReady(account, observationOnly);
  assert.equal((await releaseBalance(account, observationOnly)).balanceVerified, true,
    'The held original observation is authoritative even when the optional snapshot convenience field is absent.');
  const original = await getDatabase().get('SELECT content_json FROM trading_money_events WHERE id=?', [event.id]);
  await closeDb(); await initDb(filename);
  await assertFundingObservationCurrent(account, clone(proof.observation));
  await assertEntryAccountingReady(account, clone(snapshot));
  assert.deepEqual(await getDatabase().get('SELECT content_json FROM trading_money_events WHERE id=?', [event.id]), original);
  const adapter = new CcxtExchangeAdapter('bybit', {});
  adapter.post = async endpoint => {
    assert.equal(endpoint, '/v1/account-snapshot');
    return clone(incomplete);
  };
  const adapted = await adapter.accountSnapshot(account);
  assert.equal(adapted.fundingPnlToday, null); assert.deepEqual(adapted.fundingPnlTodayValue, fractional);
  await assertEntryAccountingReady(account, adapted);
  await noSelfAuthorization(account, snapshot);
  await appendFunding(account, 'late-negative', '-1');
  await assert.rejects(assertFundingObservationCurrent(account, proof.observation), /stale|unresolved/);
  assert.equal((await releaseBalance(account, snapshot)).balanceVerified, false);
  assert.equal((await moneyLedgerSnapshot(account.id, today, now + 1)).valuationStatus, 'valued',
    'Bounded automatic replay values this newly delivered event from retained matching originals; the old funding proof still fails.');
  const late = await getDatabase().get('SELECT id FROM trading_money_events WHERE provider_event_id=?', ['late-negative']);
  await valueFxMoneyEvent(account, late.id);
  const updated = balance(account, await observedFundingEvidence(account, now));
  await assertEntryAccountingReady(account, updated);
  assert.notDeepEqual(updated.fundingPnlTodayValue, fractional);
  const contradictory = clone(receipts[0]);
  contradictory.value = '61000'; contradictory.envelope.result.list[0].indexPrice = '61000';
  await captureFxReceipts(account, [sealFxReceipt(contradictory)], { startedAt: at - 100, completedAt: at + 100 });
  await assert.rejects(assertEntryAccountingReady(account, updated), /accounting.*incomplete/i);
  assert.equal((await releaseBalance(account, updated)).balanceVerified, false);
}

boundaryCases();
const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-fx-funding-'));
const filename = path.join(directory, 'funding.db'), realNow = Date.now;
try {
  Date.now = () => now;
  await initDb(filename);
  await fractionalPipeline(filename);
  await nativeCompatibility();
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  console.log('Rational funding DTO, persisted authority, entry/release, native compatibility, restart and late contradiction passed.');
} finally {
  Date.now = realNow; await closeDb();
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  await rm(directory, { recursive: true, force: true });
}
