import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTradingPlan } from '../src/trading_risk.js';
import { DEFAULT_STRATEGY_CONFIGURATION } from '../src/trading_strategy.js';
import { requestFromOrder } from '../src/trading_order_request.js';
import { assertPlanTierDecision } from '../src/trading_leverage_admission.js';
import { deriveFxConversion } from '../src/trading_fx_quotes.js';
import { divideRational, rationalDecimalBounds, rationalFromDecimal } from '../src/trading_rational.js';
import { fxReceipt } from './fixtures/fx_receipts.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function python(mode, input) {
  const result = spawnSync(process.env.TSX_TEST_PYTHON || 'python', ['-B',
    path.join(root, 'exchange_executor/tests/fixtures/fx_sizing_interop.py'), mode], {
    cwd: root, encoding: 'utf8', input: JSON.stringify(input), timeout: 45000, maxBuffer: 512000, windowsHide: true,
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP,
      PYTHONNOUSERSITE: '1', PYTHONIOENCODING: 'utf-8' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

// The actual Python reader supplies the identity/profile/table; Node must not invent their hashes.
const context = python('context');
assert.equal(context.ccxtVersion, '4.5.75');
const now = Date.now(), at = now - 20;
const strategy = structuredClone(DEFAULT_STRATEGY_CONFIGURATION);
strategy.allowedSignalSchemas = ['standard'];
strategy.sizing = { ...strategy.sizing, positionSizingMode: 'equity_percent_margin', riskPerTradePercent: '10',
  maxAdaptiveRiskPercent: '10', maxPositionNotional: '1000000', maxLeverage: 2, defaultLeverage: 2 };
strategy.entry = { ...strategy.entry, orderType: 'limit', rangePrice: 'midpoint' };
strategy.exits = { ...strategy.exits, targetAllocationMode: 'manual', targetAllocationsPercent: ['100'] };
const profileHash = context.tiers.unit.profileHash;
const usd = fxReceipt('usd', at, { profileHash, value: '60001', envelope: { retCode: 0, retMsg: 'OK',
  result: { category: 'inverse', list: [{ symbol: 'BTCUSD', indexPrice: '60001' }] }, retExtInfo: {}, time: at } });
const conversion = deriveFxConversion([usd, fxReceipt('usdt', at, { profileHash })], 'USDT', 'USD', now,
  { mode: context.account.mode, profileHash });
assert.deepEqual(conversion.rate, { numerator: '60001', denominator: '60150' });

function nodeRequest({ native = false, contract = 'unit', cap = '1000000' } = {}) {
  const evidence = context.tiers[contract];
  const market = { symbol: 'BTCUSDT', markPrice: '100', priceTick: '0.1', quantityStep: '0.001',
    minimumQuantity: '0.001', minimumNotional: '1', maxLeverage: evidence.tiers[0].maxLeverage, leverageTiers: evidence,
    accounting: { version: 1, source: 'ccxt-market-v1', providerSymbol: evidence.providerSymbol,
      settlementAsset: 'USDT', quantityUnit: 'base', linear: true } };
  const plan = createTradingPlan({ intentId: `fx-python-${native}-${contract}-${cap}`, now,
    strategy: { ...strategy, sizing: { ...strategy.sizing, maxPositionNotional: cap } },
    signal: { schema: 'standard', action: 'LONG', symbol: 'BTCUSDT', entry: { type: 'range', min: '100', max: '100' },
      stopLoss: '90', targets: [{ min: '110', max: '110' }], suggestedLeverage: 2 },
    account: { equity: '1000', availableBalance: '1000', accounting: { reportingCurrency: native ? 'USDT' : 'USD' } },
    market, ...(native ? {} : { fxConversion: { id: 'd'.repeat(64), conversion } }) });
  assertPlanTierDecision({ id: context.account.id, exchange: 'bybit', externalAccountId: evidence.accountFingerprint,
    credentialGeneration: evidence.credentialGeneration, capabilities: { executionProfileHash: profileHash } }, plan, market);
  return requestFromOrder(context.account, plan, plan.orders.find(order => order.role === 'entry'));
}

const original = nodeRequest(), native = nodeRequest({ native: true }), capped = nodeRequest({ cap: '200' });
assert.equal(original.quantity, '2.004');
assert.equal(original.leverageTierDecision.version, 2);
assert.equal(original.leverageTierDecision.maximumNotional, null);
assert.deepEqual(original.leverageTierDecision.maximumNotionalValue.exact, { numerator: '12030000', denominator: '60001' });
assert.equal(capped.leverageTierDecision.version, 2);
assert.equal(capped.leverageTierDecision.maximumNotional, '200');
assert.equal(capped.leverageTierDecision.maximumNotionalValue.precision, 'exact_decimal');
assert.equal(native.leverageTierDecision.version, 1);
assert.equal(native.leverageTierDecision.maximumNotional, '200');
assert.equal(Object.hasOwn(native.leverageTierDecision, 'maximumNotionalValue'), false);
const threshold = rationalDecimalBounds(divideRational(original.leverageTierDecision.maximumNotionalValue.exact,
  rationalFromDecimal(original.quantity)));
assert.equal(threshold.exact, false, 'The adjacent 18-place prices straddle the genuine rational maximum.');

const cases = [];
function add(name, options = {}, change = () => {}) {
  const request = structuredClone(options.request ?? original);
  change(request, request.leverageTierDecision);
  cases.push({ name, path: 'sdk', contract: 'unit', mark: '100', ...options, request });
}
add('fractional-v2');
add('contract-quantity-v2', { contract: 'milli', request: nodeRequest({ contract: 'milli' }) });
add('decimal-alias-v2', { request: capped });
add('native-v1', { request: native });
add('spec-price-below-exact', { path: 'gate', specPrice: threshold.lower });
add('spec-price-above-exact', { path: 'gate', specPrice: threshold.upper, error: 'budget' });
add('mark-below-exact', { mark: threshold.lower });
add('mark-above-exact', { mark: threshold.upper, error: 'budget' });
add('actual-sdk-entry-above', { error: 'budget' }, request => { request.price = '100.1'; });
add('native-mark-above', { request: native, mark: '100.000000000000000001', error: 'budget' });
add('oversized-quantity', { error: 'budget' }, (request, decision) => { request.quantity = decision.quantity = '2.005'; });
add('sdk-rounding', { error: 'rounding' }, (request, decision) => { request.quantity = decision.quantity = '2.0045'; });
add('changed-table-hash', { error: 'table or contract' }, (_request, decision) => { decision.evidenceHash = '0'.repeat(64); });
add('changed-currency', { error: 'currency' }, (_request, decision) => { decision.maximumNotionalCurrency = 'USD'; });
add('invented-decimal-alias', { error: 'alias' }, (_request, decision) => { decision.maximumNotional = '201'; });
add('missing-null-alias', { error: 'alias' }, (_request, decision) => { delete decision.maximumNotional; });
add('changed-upper-bound', { error: 'disagree' }, (_request, decision) => { decision.maximumNotionalValue.upper = '201'; });
add('noncanonical-rational', { error: 'reduced' }, (_request, decision) => {
  decision.maximumNotionalValue.exact = { numerator: '24060000', denominator: '120002' };
});
add('missing-original-sizing', { error: 'sizing' }, request => { request.quantity = '2.005'; });

const originalBytes = JSON.stringify(cases);
const result = python('check', cases);
assert.equal(JSON.stringify(cases), originalBytes);
assert.deepEqual(result.map(row => row.name), cases.map(row => row.name));
for (const [index, row] of result.entries()) {
  const expected = cases[index];
  assert.equal(row.requestUnchanged, true, expected.name);
  if (expected.error) {
    assert.equal(row.code, 'LEVERAGE_TIERS_UNPROVEN', expected.name);
    assert.match(row.message, new RegExp(expected.error), expected.name);
    assert.equal(row.setterCalls, 0, `${expected.name}: no leverage mutation before rejection.`);
    assert.equal(row.batchCalls, 0, `${expected.name}: no SDK batch before rejection.`);
    continue;
  }
  assert.equal(row.code, null, expected.name);
  if (expected.path === 'gate') {
    assert.equal(row.setterCalls, 0);
    assert.equal(row.batchCalls, 0);
    continue;
  }
  assert.equal(row.setterCalls, 1, 'A valid request reaches the actual adapter setter branch in the local fake.');
  assert.equal(row.batchCalls, 1);
  assert.equal(row.signed, true);
  assert.equal(row.endpoint, '/v5/order/create-batch');
  assert.equal(row.category, 'linear');
  assert.equal(row.wire.qty, expected.contract === 'milli' ? '2004' : expected.request.quantity);
  assert.equal(row.spec.amount, row.wire.qty);
  assert.equal(row.wire.price, expected.request.price);
  assert.equal(row.wire.orderLinkId, expected.request.clientOrderId);
  assert.equal(row.wire.positionIdx, 0);
}
console.log(`Node plan/request -> Python exact tier gate -> pinned signed SDK body: ${cases.length} isolated cases passed.`);
