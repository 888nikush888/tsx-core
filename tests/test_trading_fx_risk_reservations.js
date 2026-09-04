import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { getTradingAccount, listTradingStrategies } from '../src/trading_repository.js';
import { bindAccountReportingCurrency, moneyLedgerSnapshot, recordMoneyEvent } from '../src/trading_money_ledger.js';
import { captureFxReceipts, persistFxConversion } from '../src/trading_fx_repository.js';
import { bindRiskContract, existingRiskCommitment, observeRiskReservations } from '../src/trading_risk_repository.js';
import { assertRiskAdmissionFresh, createRiskAdmission, verifyRiskAdmission } from '../src/trading_risk_admission.js';
import { refreshReconciledRisk } from '../src/trading_risk_reconciliation.js';
import { calculateFxRiskReservation } from '../src/trading_fx_risk.js';
import { calculateMonetaryDailyRisk } from '../src/trading_money_risk.js';
import { moneyValueFromDecimal } from '../src/trading_money_value.js';
import { captureFillAccounting } from '../src/trading_fill_accounting.js';
import { provenFillIdentity } from '../src/trading_fill_identity.js';
import { nativeFillFixture } from './fixtures/native_fill_identity.js';
import { valueFxMoneyEvent } from '../src/trading_fx_valuation.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { fxReceipt, sealFxReceipt, FX_CONTEXT } from './fixtures/fx_receipts.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-fx-risk-'));
const filename = path.join(directory, 'risk.db');
const originalNow = Date.now;
const at = Date.now() - 1000;
let now = at + 100;
Date.now = () => now;
let strategyId;
const metadata = { version: 1, source: 'ccxt-market-v1', providerSymbol: 'BTC/USDT:USDT',
  settlementAsset: 'USDT', linear: true, quantityUnit: 'base' };

async function accountFixture(id) {
  await getDatabase().run(`INSERT INTO trading_accounts(id,name,exchange,mode,status,enabled,credential_ref,
    external_account_id,credential_generation,capabilities_json,last_verified_at,created_at,updated_at)
    VALUES (?,?,'bybit','testnet','ready',1,'fixture-only',?,?,?,?,?,?)`, [id, id,
  createHash('sha256').update(id).digest('hex'), 'c'.repeat(64), JSON.stringify({ profileVersion: 1,
    executionProfileHash: FX_CONTEXT.profileHash, executionCapabilities: { provider_api_version: 'bybit-v5' } }), at - 1000, at - 1000, at]);
  const account = await getTradingAccount(id);
  await bindAccountReportingCurrency({ accountId: id, accountFingerprint: account.externalAccountId, profile: 'bybit',
    reportingCurrency: 'USD', settlementAssets: ['USDT', 'USDC'], source: 'bybit-wallet-balance-v1', verifiedAt: at });
  return account;
}

async function capture(account, usd = '60000', usdt = '60150', time = at) {
  const receipts = ['usd', 'usdt'].map(kind => {
    const receipt = fxReceipt(kind, time), value = kind === 'usd' ? usd : usdt;
    receipt.value = value; receipt.envelope.result.list[0].indexPrice = value;
    return sealFxReceipt(receipt);
  });
  await captureFxReceipts(account, receipts, { startedAt: time - 20, completedAt: time + 20 });
}

async function pendingFixture(account, id, quantity = '5', symbol = 'BTCUSDT', market = metadata) {
  await saveSignal(id, '-fx-risk', 1, '<signal/>', `<signal>${id}</signal>`);
  await getDatabase().run(`INSERT INTO trading_trade_intents(id,source_signal_id,root_source_signal_id,channel_id,
    strategy_version_id,account_id,exchange,mode,symbol,side,status,signal_json,created_at,updated_at)
    VALUES (?,?,?,'-fx-risk',?,?,'bybit','testnet',?,'LONG','monitoring','{}',?,?)`,
  [id, id, id, strategyId, account.id, symbol, at, at]);
  for (const role of ['entry', 'stop_loss']) {
    await getDatabase().run(`INSERT INTO trading_orders(id,intent_id,account_id,client_order_id,exchange_order_id,
      provider_symbol,role,side,order_type,status,price,trigger_price,quantity,filled_quantity,reduce_only,request_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,'open',?,?,?,'0',?,'{}',?,?)`, [`${id}-${role}`, id, account.id, `${id}-${role}`,
    `remote-${id}-${role}`, market.providerSymbol, role, role === 'entry' ? 'buy' : 'sell', role === 'entry' ? 'limit' : 'stop_market',
    role === 'entry' ? '100' : null, role === 'entry' ? null : '90', quantity, Number(role !== 'entry'), at, at]);
  }
  await bindRiskContract(account, id, { observedAt: at, accounting: market });
  return { observedAt: at, positions: [], orders: [{ clientOrderId: `${id}-stop_loss`, exchangeOrderId: `remote-${id}-stop_loss`,
    providerSymbol: market.providerSymbol, symbol, role: 'stop_loss', side: 'sell', status: 'open', quantity,
    filledQuantity: '0', reduceOnly: true, triggerPrice: '90' }] };
}

async function exactPendingReserve() {
  const account = await accountFixture('fx-risk-exact'), remote = await pendingFixture(account, 'pending-exact');
  await capture(account, '58800', '60000');
  await observeRiskReservations(account, remote, '0:0');
  const proof = await existingRiskCommitment(account, '', '0:0', 'USD');
  assert.equal(proof.commitment, '49', '50 USDT of pending Entry→Stop risk is exactly 49 USD, never 50 USD.');
  assert.deepEqual(proof.value.exact, { numerator: '49', denominator: '1' });
  assert.equal(proof.reservations[0].amounts.markToStopRisk, '0');
  assert.equal(proof.reservations[0].amounts.pendingEntryRisk, '49');
  assert.equal(proof.fxConversions.length, 1);
  assert.equal(proof.expiresAt, at + 10000, 'The 10-second FX lifetime shortens the 60-second exposure observation.');
  await closeDb(); await initDb(filename);
  assert.deepEqual(await existingRiskCommitment(account, '', '0:0', 'USD'), proof);
  return { account, remote, proof };
}

function snapshot(account) {
  return { equity: '1000', freeBalance: '1000', unrealizedPnl: '0', fundingPnlToday: '0', accounting: {
    accountFingerprint: account.externalAccountId, reportingCurrency: 'USD', settlementAssets: ['USDT', 'USDC'],
    source: 'bybit-wallet-balance-v1', observedAt: at, unrealizedPnlSemantics: 'price_only', funding: {
      status: 'complete', source: 'fixture-funding-originals', since: new Date(at).setUTCHours(0, 0, 0, 0),
      until: at, cursor: null, reason: null, nextReadAt: at, events: [] } } };
}

async function candidateFixture(account, id, quantity = '5', stopPrice = '90') {
  await pendingFixture(account, id, quantity);
  const orders = [{ role: 'entry', clientOrderId: `${id}-entry`, quantity, price: '100', triggerPrice: null,
    orderType: 'limit', side: 'buy', reduceOnly: false }, { role: 'stop_loss', clientOrderId: `${id}-stop_loss`, quantity,
    price: null, triggerPrice: stopPrice, orderType: 'stop_market', side: 'sell', reduceOnly: true }];
  const plan = { version: 1, side: 'LONG', symbol: 'BTCUSDT', stopPrice, riskAmount: '777', orders, createdAt: at };
  await getDatabase().run('UPDATE trading_trade_intents SET plan_json=? WHERE id=?', [JSON.stringify(plan), id]);
  await getDatabase().run("UPDATE trading_orders SET status='created',trigger_price=? WHERE intent_id=? AND role='stop_loss'", [stopPrice, id]);
  await getDatabase().run("UPDATE trading_orders SET status='created' WHERE intent_id=? AND role='entry'", [id]);
  return { account, intentId: id, plan, market: { observedAt: at, accounting: metadata }, snapshot: snapshot(account), budget: '50', epoch: '0:0' };
}

async function rationalAndTinyCandidates() {
  const account = await accountFixture('fx-risk-rational');
  await capture(account);
  const input = await candidateFixture(account, 'candidate-rational');
  const proof = await createRiskAdmission(input);
  assert.equal(proof.candidateCommitment, null, 'Nonterminating rates never become rounded exact scalar aliases.');
  assert.deepEqual(proof.candidateValue.exact, { numerator: '20000', denominator: '401' });
  await verifyRiskAdmission(proof, input.plan);
  await assert.rejects(createRiskAdmission({ ...input, budget: proof.candidateValue.lower }), error => error.code === 'MAX_DAILY_RISK');
  await createRiskAdmission({ ...input, budget: proof.candidateValue.upper });
  const tinyAccount = await accountFixture('fx-risk-tiny');
  await capture(tinyAccount);
  const tinyInput = await candidateFixture(tinyAccount, 'candidate-tiny', '0.000000000000000001', '99');
  const tiny = await createRiskAdmission({ ...tinyInput, budget: '0.000000000000000001' });
  assert.deepEqual(tiny.candidateValue.exact, { numerator: '1', denominator: '1002500000000000000' });
  assert.equal(tiny.candidateValue.lower, '0'); assert.equal(tiny.candidateCommitment, null);
  await assert.rejects(createRiskAdmission({ ...tinyInput, budget: '0' }), error => error.code === 'MAX_DAILY_LOSS');
  await verifyRiskAdmission(tiny, tinyInput.plan);
  return { input, proof };
}

async function markRiskNoDoubleCounting(account) {
  const input = { side: 'LONG', ownedQuantity: '2', averageEntryPrice: '100', markPrice: '95', stopPrice: '90',
    reportingCurrency: 'USD', market: metadata, protectionProven: true, entries: [{ id: 'partial', generation: 0,
      status: 'partially_filled', quantity: '5', filledQuantity: '2', price: '101', operationUnresolved: false }] };
  const reserve = await calculateFxRiskReservation(account, input, at);
  assert.equal(reserve.amounts.markToStopRisk, '9.8');
  assert.equal(reserve.amounts.pendingEntryRisk, '32.34');
  assert.equal(reserve.amounts.actualFillToStopRisk, '19.6');
  assert.equal(reserve.amounts.additionalRisk, '42.14', 'Do not add entry-to-stop risk again on already owned quantity.');
  const cancelled = await calculateFxRiskReservation(account, { ...input, entries: [{ ...input.entries[0], status: 'cancelled' }] }, at);
  assert.equal(cancelled.amounts.additionalRisk, '9.8');
  const short = await calculateFxRiskReservation(account, { ...input, side: 'SHORT', markPrice: '105', stopPrice: '110',
    entries: [{ ...input.entries[0], price: '99' }] }, at);
  assert.equal(short.amounts.additionalRisk, '42.14');
  const daily = calculateMonetaryDailyRisk({ budget: '60', ledgerPnl: moneyValueFromDecimal('-1'), unrealizedPnl: '-10',
    existingCommitment: reserve.amounts.additionalRiskValue, candidateCommitment: moneyValueFromDecimal('0') });
  assert.equal(daily.totalCommitment.decimal, '53.14', 'Observed loss is counted once, independently of future mark-to-stop commitment.');
}

async function observedOwnedAndPending() {
  const account = await accountFixture('fx-risk-owned'), id = 'owned-and-pending';
  const remote = await pendingFixture(account, id);
  await capture(account, '58800', '60000');
  await getDatabase().run("UPDATE trading_orders SET filled_quantity='2',status='partially_filled',price='101' WHERE id=?", [`${id}-entry`]);
  const raw = nativeFillFixture('bybit', { exchangeFillId: 'fx-owned-fill', exchangeOrderId: `remote-${id}-entry`,
    clientOrderId: `${id}-entry`, symbol: 'BTCUSDT', providerSymbol: metadata.providerSymbol,
    price: '100', quantity: '2', fee: '0', feeAsset: 'USDT', filledAt: at });
  raw.accounting = metadata;
  const identity = provenFillIdentity(account, raw);
  assert.ok(identity);
  await getDatabase().run(`INSERT INTO trading_fills(id,order_id,account_id,exchange_fill_id,price,quantity,fee,fee_asset,
    filled_at,raw_json,remote_fill_key,provider_symbol,identity_status,identity_json)
    VALUES ('fx-owned-fill',?,?,?,'100','2','0','USDT',?,?,?,?,'proven',?)`, [`${id}-entry`, account.id,
  raw.exchangeFillId, at, JSON.stringify(raw.raw), identity.key, metadata.providerSymbol, JSON.stringify(identity.identity)]);
  await captureFillAccounting(account, raw, 'fx-owned-fill');
  await getDatabase().run(`INSERT INTO trading_positions(id,intent_id,account_id,strategy_version_id,channel_id,symbol,
    side,status,quantity,average_entry_price,stop_price,opened_at,updated_at)
    VALUES ('fx-owned-position',?,?,?,'-fx-risk','BTCUSDT','LONG','open','2','100','90',?,?)`, [id, account.id, strategyId, at, at]);
  remote.positions.push({ symbol: 'BTCUSDT', providerSymbol: metadata.providerSymbol, side: 'LONG', quantity: '2',
    averageEntryPrice: '100', markPrice: '95', accounting: metadata });
  await observeRiskReservations(account, remote, '0:0');
  const proof = await existingRiskCommitment(account, '', '0:0', 'USD');
  assert.equal(proof.value.decimal, '42.14');
  assert.equal(proof.reservations[0].amounts.actualFillToStopRisk, '19.6');
  assert.equal(proof.reservations[0].amounts.pendingQuantity, '3');
  const second = await pendingFixture(account, 'owned-other-pending', '1', 'ETHUSDT', { ...metadata, providerSymbol: 'ETH/USDT:USDT' });
  remote.orders.push(...second.orders);
  await observeRiskReservations(account, remote, '0:0');
  const summed = await existingRiskCommitment(account, '', '0:0', 'USD');
  assert.equal(summed.commitment, '51.94');
  assert.equal(summed.reservations.length, 2);
  assert.equal(summed.fxConversions.length, 1, 'Same actual conversion is retained once, not minted for each risk component.');
}

async function finalOriginalFences({ input, proof }) {
  await capture(input.account, '61000', '60150', at + 50);
  await verifyRiskAdmission(proof, input.plan);
  assert.deepEqual(proof.candidateValue.exact, { numerator: '20000', denominator: '401' }, 'A later quote cannot silently reprice the original plan.');
  for (const [column, replacement] of [['credential_generation', 'd'.repeat(64)], ['external_account_id', 'e'.repeat(64)],
    ['capabilities_json', JSON.stringify({ ...input.account.capabilities, executionProfileHash: 'f'.repeat(64) })]]) {
    const previous = (await getDatabase().get(`SELECT ${column} value FROM trading_accounts WHERE id=?`, [input.account.id])).value;
    await getDatabase().run(`UPDATE trading_accounts SET ${column}=? WHERE id=?`, [replacement, input.account.id]);
    await assert.rejects(verifyRiskAdmission(proof, input.plan), /identity changed|FX/);
    await getDatabase().run(`UPDATE trading_accounts SET ${column}=? WHERE id=?`, [previous, input.account.id]);
  }
  await verifyRiskAdmission(proof, input.plan);
  now = at + 10001;
  assert.throws(() => assertRiskAdmissionFresh(proof), /stale/);
  await assert.rejects(verifyRiskAdmission(proof, input.plan), /stale/);
  now = at + 100;
  await capture(input.account, '61000', '60150');
  await assert.rejects(verifyRiskAdmission(proof, input.plan), /FX_QUOTE_CONFLICT/);
}

async function sizingBinding() {
  const account = await accountFixture('fx-sizing-binding');
  await capture(account);
  const input = await candidateFixture(account, 'candidate-sizing');
  const sizingFx = await persistFxConversion(account, 'USDT', 'USD', at);
  await assert.rejects(createRiskAdmission({ ...input, sizingFx }), /sizing/i, 'An unreferenced conversion cannot supply sizing authority.');
  input.plan.fxSizing = { version: 1, conversionId: sizingFx.id, conversion: sizingFx.conversion,
    reportingCurrency: 'USD', notionalCurrency: 'USDT', strategyMaximumNotionalCurrency: 'USDT', riskAmountCurrency: 'USD' };
  await getDatabase().run('UPDATE trading_trade_intents SET plan_json=? WHERE id=?', [JSON.stringify(input.plan), input.intentId]);
  await assert.rejects(createRiskAdmission(input), /sizing/i, 'The plan must not omit its original sizing recipe from the final fence.');
  const proof = await createRiskAdmission({ ...input, sizingFx });
  await verifyRiskAdmission(proof, input.plan);
  await assert.rejects(verifyRiskAdmission({ ...proof, fxConversions: [] }, input.plan), /sizing/i,
    'The final proof must still retain the original sizing dependency.');
  assert.ok(proof.fxConversions.some(fx => fx.id === sizingFx.id));
  for (const change of [{ conversionId: '0'.repeat(64) }, { reportingCurrency: 'USDC' }, { notionalCurrency: 'USD' },
    { strategyMaximumNotionalCurrency: 'USD' }, { riskAmountCurrency: 'BTC' },
    { conversion: { ...sizingFx.conversion, rate: { numerator: '1', denominator: '1' } } }]) {
    await assert.rejects(createRiskAdmission({ ...input, sizingFx, plan: { ...input.plan, fxSizing: { ...input.plan.fxSizing, ...change } } }), /sizing/i);
  }
  await assert.rejects(createRiskAdmission({ ...input, sizingFx: { ...sizingFx, id: '0'.repeat(64) } }), /sizing/i);
  const other = await accountFixture('fx-sizing-other-owner');
  await capture(other);
  const foreignFx = await persistFxConversion(other, 'USDT', 'USD', at);
  await assert.rejects(createRiskAdmission({ ...input, sizingFx: foreignFx, plan: { ...input.plan,
    fxSizing: { ...input.plan.fxSizing, conversionId: foreignFx.id, conversion: foreignFx.conversion } } }), /FX_CONVERSION_UNAVAILABLE/,
  'A correct original recipe retained by another account cannot authorize this account.');
}

async function missingUnsupportedAndExpired() {
  const account = await accountFixture('fx-risk-unavailable'), remote = await pendingFixture(account, 'pending-unavailable');
  const args = { account, remote, epoch: '0:0', readBalance: async () => snapshot(account), budgetForIntent: async () => '1' };
  assert.equal(await refreshReconciledRisk(args), false);
  await assert.rejects(existingRiskCommitment(account, '', '0:0', 'USD'), /QUOTE_UNAVAILABLE/);
  await capture(account, '58800', '60000');
  await observeRiskReservations(account, remote, '0:0');
  now = at + 10000;
  await assert.rejects(existingRiskCommitment(account, '', '0:0', 'USD'), /stale/);
  now = at + 10001;
  assert.equal(await refreshReconciledRisk(args), false, 'Expired FX does not prevent a completed protection loop.');
  await assert.rejects(existingRiskCommitment(account, '', '0:0', 'USD'), /EXPIRED/);
  now = at + 100;
  const input = { side: 'LONG', ownedQuantity: '1', averageEntryPrice: '100', markPrice: '100', stopPrice: '90',
    reportingCurrency: 'USD', market: { ...metadata, settlementAsset: 'BTC' }, protectionProven: true, entries: [] };
  const unknown = await calculateFxRiskReservation(account, input, at);
  assert.equal(unknown.amounts.status, 'unresolved'); assert.equal(unknown.amounts.additionalRiskValue, null);
  assert.match(unknown.amounts.reason, /ASSET_UNSUPPORTED/);
  const native = await calculateFxRiskReservation(account, { ...input, reportingCurrency: 'USDT', market: metadata }, at);
  assert.equal(native.fx, null); assert.equal(native.amounts.additionalRiskValue.decimal, '10');
  assert.equal((await getDatabase().get("SELECT status FROM trading_orders WHERE id='pending-unavailable-stop_loss'")).status, 'open');
}

async function boundedHistoricalLoss() {
  const account = await accountFixture('fx-bounded-loss'), remote = await pendingFixture(account, 'pending-bounded');
  // Distinct original rates yield a provably >256-digit aggregate denominator; no rounded event is injected.
  for (let index = 0; index < 10; index++) {
    const eventAt = at - 2000 + index * 100;
    await capture(account, '1', String(10n ** 35n + BigInt(2 * index + 1)), eventAt);
    const event = await recordMoneyEvent({ accountId: account.id, accountFingerprint: account.externalAccountId,
      providerEventId: `tiny-fee-${index}`, kind: 'fee', source: 'fixture-original-fee', basis: 'provider',
      occurredAt: eventAt, amount: '-1', asset: 'USDT' });
    await valueFxMoneyEvent(account, event.id);
  }
  await capture(account, '58800', '60000');
  const ledger = await moneyLedgerSnapshot(account.id, new Date(at).setUTCHours(0, 0, 0, 0), now);
  assert.equal(ledger.valuationStatus, 'valued');
  assert.equal(ledger.value.precision, 'bounded'); assert.equal(ledger.value.decimal, null);
  assert.equal(ledger.value.upper, '0'); assert.notEqual(ledger.value.lower, '0');
  const args = { account, remote, epoch: '0:0', readBalance: async () => snapshot(account), budgetForIntent: async () => '49' };
  assert.equal(await refreshReconciledRisk(args), false, 'An outward loss upper bound is not a proved breach.');
  assert.equal((await getDatabase().get('SELECT balance_reason FROM trading_risk_current WHERE account_id=?', [account.id])).balance_reason,
    'RISK_PRECISION_UNCERTAIN');
  const input = await candidateFixture(account, 'candidate-bounded');
  await assert.rejects(createRiskAdmission({ ...input, budget: '98' }), error => error.code === 'RISK_PRECISION_UNCERTAIN');
  assert.equal((await getDatabase().get("SELECT status FROM trading_orders WHERE id='pending-bounded-stop_loss'")).status, 'open');
}

async function stableUnitsAndReportingBinding() {
  const account = await accountFixture('fx-stable-units');
  await capture(account, '58800', '60000');
  await captureFxReceipts(account, [fxReceipt('usdc', at)], { startedAt: at - 20, completedAt: at + 20 });
  const base = { side: 'LONG', ownedQuantity: '5', averageEntryPrice: '100', markPrice: '100', stopPrice: '90',
    reportingCurrency: 'USD', market: { ...metadata, settlementAsset: 'USDC' }, protectionProven: true, entries: [] };
  const usdc = await calculateFxRiskReservation(account, base, at);
  assert.equal(usdc.amounts.additionalRisk, '50.1');
  const cross = await calculateFxRiskReservation(account, { ...base, reportingCurrency: 'USDC', market: metadata }, at);
  assert.deepEqual(cross.amounts.additionalRiskValue.exact, { numerator: '24500', denominator: '501' });
  const inverse = await calculateFxRiskReservation(account, { ...base, reportingCurrency: 'USDT', market: { ...metadata, settlementAsset: 'USD' } }, at);
  assert.deepEqual(inverse.amounts.additionalRiskValue.exact, { numerator: '2500', denominator: '49' });
  const input = await candidateFixture(account, 'candidate-units');
  await assert.rejects(createRiskAdmission({ ...input, budget: '1000', snapshot: { ...input.snapshot,
    accounting: { ...input.snapshot.accounting, reportingCurrency: 'USDC' } } }), /reporting currency/i,
  'A valid rate cannot relabel the actual USD-bound ledger/account budget as USDC.');
}

async function lateFeeAndRefresh(exact) {
  const { account, remote } = exact;
  let reads = 0;
  const args = { account, remote, epoch: '0:0', readBalance: async () => { reads++; return snapshot(account); }, budgetForIntent: async () => '49' };
  assert.equal(await refreshReconciledRisk(args), false, 'Exactly on budget is allowed, not a breach.');
  assert.equal(reads, 1);
  assert.equal(await refreshReconciledRisk({ ...args, budgetForIntent: async () => '48.999999999999999999' }), true);
  const other = await accountFixture('fx-late-fee');
  await capture(other, '58800', '60000');
  const input = await candidateFixture(other, 'candidate-fee');
  const proof = await createRiskAdmission(input);
  await recordMoneyEvent({ accountId: other.id, accountFingerprint: other.externalAccountId, providerEventId: 'late-fee',
    kind: 'fee', source: 'bybit-execution-v1', basis: 'provider', occurredAt: at, amount: '-1', asset: 'USD' });
  await assert.rejects(verifyRiskAdmission(proof, input.plan), /monetary evidence changed/);
  const refreshed = await createRiskAdmission({ ...input, budget: '50' });
  assert.equal(refreshed.candidateCommitment, '49');
  await assert.rejects(createRiskAdmission({ ...input, budget: '49.999999999999999999' }), error => error.code === 'MAX_DAILY_RISK');
  await capture(account, '58801', '60000');
  assert.equal(await refreshReconciledRisk({ ...args, budgetForIntent: async () => '0' }), false,
    'Unknown FX is not evidence of a loss breach and cannot trigger a drain.');
  assert.match((await getDatabase().get('SELECT balance_reason FROM trading_risk_current WHERE account_id=?', [account.id])).balance_reason, /FX_QUOTE_CONFLICT/);
  assert.equal((await getDatabase().get("SELECT status FROM trading_orders WHERE id='pending-exact-stop_loss'")).status, 'open');
}

try {
  await initDb(filename); await seedTradingFixtures();
  strategyId = (await listTradingStrategies())[0].id;
  const exact = await exactPendingReserve();
  await markRiskNoDoubleCounting(exact.account);
  await observedOwnedAndPending();
  const rational = await rationalAndTinyCandidates();
  await sizingBinding();
  await missingUnsupportedAndExpired();
  await boundedHistoricalLoss();
  await stableUnitsAndReportingBinding();
  await finalOriginalFences(rational);
  await lateFeeAndRefresh(exact);
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  console.log('FX reserves/admission: exact, rational, tiny, original source/expiry fences, fees, no double count, restart and conservative drain passed.');
} finally {
  Date.now = originalNow;
  await closeDb(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  await rm(directory, { recursive: true, force: true });
}
