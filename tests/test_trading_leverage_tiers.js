import assert from 'node:assert/strict';
import { assertTierNotionalBudget, solveTierQuantity, validateTierTable } from '../src/trading_leverage_tiers.js';
import { compareDecimal, divideDecimal, multiplyDecimal } from '../src/trading_decimal.js';
import { createTradingPlan } from '../src/trading_risk.js';
import { DEFAULT_STRATEGY_CONFIGURATION } from '../src/trading_strategy.js';

const tiers = [{ lowerBound: '0', upperBound: '1000', maxLeverage: 50 },
  { lowerBound: '1000', upperBound: null, maxLeverage: 10 }];
const evidence = { tiers, markPrice: '100', contractSize: '0.001' };
const seen = [];
const solution = solveTierQuantity(evidence, 50, leverage => {
  seen.push(leverage);
  return String(leverage / 2);
});
assert.deepEqual(seen, [50, 10]);
assert.deepEqual(solution, { leverage: 10, quantity: '5', tierIndex: 0 });
assert.equal(solveTierQuantity(evidence, 50, () => '10').leverage, 10, 'Boundary chooses the conservative next tier.');
assert.equal(solveTierQuantity(evidence, 100, () => '1').leverage, 50);
assert.deepEqual(solveTierQuantity({ ...evidence, tiers: [tiers[0], { ...tiers[1], upperBound: '5000' }] },
  50, leverage => String(leverage * 2)), { leverage: 10, quantity: '20', tierIndex: 1 });
assert.equal(solveTierQuantity({ ...evidence, markPrice: '100.000000000000000001' }, 50, () => '10').leverage, 10);
assert.equal(solveTierQuantity({ ...evidence, markPrice: '99.999999999999999999' }, 50, () => '10').leverage, 50);
assert.throws(() => solveTierQuantity({ ...evidence, tiers: [] }, 50, () => '1'), /tier/i);
assert.throws(() => validateTierTable([{ ...tiers[0], lowerBound: '1' }]), /tier/i);
assert.throws(() => validateTierTable([tiers[0], { ...tiers[1], lowerBound: '999' }]), /tier/i);
assert.throws(() => validateTierTable([tiers[0], { ...tiers[1], maxLeverage: 51 }]), /tier/i);
assert.throws(() => solveTierQuantity({ ...evidence, tiers: [tiers[0]] }, 50, () => '10'), /tier/i);
assert.throws(() => solveTierQuantity({ ...evidence, contractSize: '0' }, 50, () => '1'), /decimal|contract/i);

const strategy = structuredClone(DEFAULT_STRATEGY_CONFIGURATION);
strategy.sizing.positionSizingMode = 'equity_percent_margin';
strategy.sizing.riskPerTradePercent = '10';
strategy.sizing.maxAdaptiveRiskPercent = '10';
strategy.sizing.maxPositionNotional = '100000';
strategy.sizing.maxLeverage = 50;
strategy.sizing.defaultLeverage = 50;
const input = { intentId: 'tier-sized', strategy, account: { equity: '1000', availableBalance: '1000' },
  signal: { schema: 'standard', action: 'LONG', symbol: 'BTCUSDT', entry: { type: 'range', min: '100', max: '100' },
    stopLoss: '90', targets: [{ min: '110', max: '110' }, { min: '120', max: '120' }] },
  market: { symbol: 'BTCUSDT', markPrice: '100', priceTick: '0.1', quantityStep: '0.001', minimumQuantity: '0.001',
    minimumNotional: '1', maxLeverage: 50, observedAt: Date.now(), leverageTiers: evidence } };
const plan = createTradingPlan(input);
assert.equal(plan.leverage, 10);
assert.equal(plan.quantity, '10');
assert.equal(plan.notional, '1000');
assert.equal(strategy.sizing.riskPerTradePercent, '10', 'Margin percentage must not be rewritten to retain old notional.');
assert.equal(plan.leverageTierDecision.tierIndex, 1);
assert.equal(createTradingPlan({ ...input, account: { equity: '1000', availableBalance: '1' } }).leverage, 50);
const notionalStrategy = structuredClone(strategy);
notionalStrategy.sizing.positionSizingMode = 'equity_percent_notional';
assert.equal(createTradingPlan({ ...input, strategy: notionalStrategy }).notional, '100', 'Notional sizing does not become margin sizing.');

function assertOriginalNotionalBudgets() {
  for (const [mode, leverage, quantity, maximumNotional] of [
    ['risk_percent', 10, '10', '10000'],
    ['equity_percent_notional', 50, '1', '100'],
    ['equity_percent_margin', 10, '10', '1000'],
  ]) {
    const candidate = structuredClone(input);
    candidate.strategy.sizing.positionSizingMode = mode;
    const result = createTradingPlan(candidate);
    assert.equal(result.leverage, leverage);
    assert.equal(result.quantity, quantity);
    assert.equal(result.leverageDecision.effective, leverage);
    assert.equal(result.leverageDecision.cappedBy, leverage < 50 ? 'market' : null);
    assert.equal(result.leverageTierDecision.maximumNotional, maximumNotional,
      `${mode}: retain the original budget purpose at the solved leverage.`);
    assert.equal(result.leverageTierDecision.quantity, result.quantity);
    assert.equal(result.leverageTierDecision.leverage, leverage);
    const cashLimited = createTradingPlan({ ...candidate, account: { equity: '1000', availableBalance: '1' } });
    assert.equal(cashLimited.quantity, '0.5');
    assert.equal(cashLimited.leverage, 50);
    assert.equal(cashLimited.leverageTierDecision.maximumNotional, '50');
    candidate.strategy.sizing.maxPositionNotional = '95';
    const capped = createTradingPlan(candidate);
    assert.equal(capped.quantity, '0.95');
    assert.equal(capped.leverage, 50);
    assert.equal(capped.leverageTierDecision.maximumNotional, '95');
  }
}

function assertConservativeMarginValuation() {
  for (const [markPrice, expectedQuantity] of [['80', '10'], ['100', '10'], ['120', '8.333']]) {
    const candidate = structuredClone(input);
    candidate.strategy.sizing.defaultLeverage = 10;
    candidate.strategy.sizing.maxLeverage = 10;
    candidate.market.markPrice = markPrice;
    candidate.market.leverageTiers = { ...evidence, markPrice,
      tiers: [{ lowerBound: '0', upperBound: null, maxLeverage: 50 }] };
    const result = createTradingPlan(candidate);
    assert.equal(result.quantity, expectedQuantity, 'Use max(current mark, bound entry), never the cheaper value.');
    assert.equal(result.entryPrice, '100', 'The original signal price does not follow a later valuation.');
    assert.equal(result.leverageTierDecision.maximumNotional, '1000');
    const price = compareDecimal(markPrice, '100') > 0 ? markPrice : '100';
    const usedMargin = divideDecimal(multiplyDecimal(result.quantity, price), '10');
    assert.ok(compareDecimal(usedMargin, '100') <= 0, 'Ten percent of equity remains a ceiling after quantization.');
    assertTierNotionalBudget(result.quantity, markPrice, '100', result.leverageTierDecision.maximumNotional);
    assert.throws(() => assertTierNotionalBudget(result.quantity, '121', '100', '1000'), /original margin\/notional budget/);
  }
}

function assertBoundedMarketMarginBudget() {
  const candidate = structuredClone(input);
  candidate.strategy.entry.orderType = 'market';
  candidate.strategy.safety.maxSlippagePercent = '1';
  candidate.strategy.sizing.defaultLeverage = 10;
  candidate.strategy.sizing.maxLeverage = 10;
  candidate.market.leverageTiers = { ...evidence, tiers: [{ lowerBound: '0', upperBound: null, maxLeverage: 50 }] };
  const original = createTradingPlan(candidate);
  assert.equal(original.orders[0].price, '101');
  assert.equal(original.quantity, '9.9', 'IOC margin is bounded using the permitted fill price, not the cheaper reference.');
  assert.equal(original.leverageTierDecision.maximumNotional, '1000');
  const updated = createTradingPlan({ ...candidate, entryPriceBoundary: original.entryPriceBoundary,
    market: { ...candidate.market, markPrice: '120', leverageTiers: { ...candidate.market.leverageTiers, markPrice: '120' } } });
  assert.equal(updated.quantity, '8.333', 'A within-tier mark increase must still respect the initial margin budget.');
  assert.deepEqual(updated.entryPriceBoundary, original.entryPriceBoundary);
  assert.equal(updated.orders[0].price, '101');
  assert.equal(updated.leverageTierDecision.maximumNotional, '1000');
  assertTierNotionalBudget(updated.quantity, '120', updated.orders[0].price, '1000');
}

assertOriginalNotionalBudgets();
assertConservativeMarginValuation();
assertBoundedMarketMarginBudget();
console.log('Exact tier boundaries, bounded monotone reduction and table validation passed.');
