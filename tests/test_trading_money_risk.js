import assert from 'node:assert/strict';
import { compareMoneyValue, calculateMonetaryDailyRisk } from '../src/trading_money_risk.ts';
import { moneyValueFromDecimal, moneyValueFromRational, addMoneyValues, validateMoneyValue } from '../src/trading_money_value.ts';
import { calculateDailyRisk } from '../src/trading_risk_reservations.ts';

const money = moneyValueFromDecimal;
const ratio = (numerator, denominator) => moneyValueFromRational({ numerator, denominator });
const quantum = '0.000000000000000001';
const interval = (lower, upper, terms = 2) => validateMoneyValue({
  lower, upper, exact: null, decimal: null, precision: 'bounded', terms,
});
const daily = (overrides = {}) => calculateMonetaryDailyRisk({
  budget: '1', ledgerPnl: money('0'), unrealizedPnl: '0', existingCommitment: money('0'),
  candidateCommitment: money('0'), ...overrides,
});
const flags = result => ({ allowed: result.allowed, breached: result.breached,
  lossLimitReached: result.lossLimitReached, precisionUncertain: result.precisionUncertain });

function testExactComparisonDoesNotRoundFractions() {
  const third = ratio('1', '3');
  assert.equal(compareMoneyValue(third, '0.333333333333333333'), 1);
  assert.equal(compareMoneyValue(third, '0.333333333333333334'), -1);
  assert.equal(compareMoneyValue(ratio('-1', '3'), '-0.333333333333333333'), -1);
  assert.equal(compareMoneyValue(ratio('-1', '3'), '-0.333333333333333334'), 1);
  assert.equal(compareMoneyValue(ratio('1', '2'), '0.50'), 0);
  assert.equal(compareMoneyValue(ratio('1', '9'.repeat(256)), '0'), 1);
  assert.equal(compareMoneyValue(ratio('-1', '9'.repeat(256)), '0'), -1);
  assert.equal(compareMoneyValue(money('-0.00'), '0'), 0);
  const wide = money('9007199254740993.000000000000000001');
  assert.equal(compareMoneyValue(wide, '9007199254740993'), 1);
  assert.equal(compareMoneyValue(wide, '9007199254740993.000000000000000002'), -1);
}

function testIntervalsDistinguishTouchingFromExactEquality() {
  const below = interval('0.999999999999999998', '0.999999999999999999');
  const above = interval('1.000000000000000001', '1.000000000000000002');
  const touchingBelow = interval('0.999999999999999999', '1');
  const touchingAbove = interval('1', '1.000000000000000001');
  const crossing = interval('0.999999999999999999', '1.000000000000000001');
  assert.equal(compareMoneyValue(below, '1'), -1);
  assert.equal(compareMoneyValue(above, '1'), 1);
  assert.equal(compareMoneyValue(touchingBelow, '1'), 'uncertain');
  assert.equal(compareMoneyValue(touchingAbove, '1'), 'uncertain');
  assert.equal(compareMoneyValue(crossing, '1'), 'uncertain');
  assert.equal(compareMoneyValue(interval('-0.000000000000000001', '0'), '0'), 'uncertain');
  assert.deepEqual(flags(daily({ existingCommitment: touchingBelow })), {
    allowed: true, breached: false, lossLimitReached: false, precisionUncertain: true,
  });
  assert.deepEqual(flags(daily({ existingCommitment: touchingAbove })), {
    allowed: false, breached: false, lossLimitReached: false, precisionUncertain: true,
  });
  assert.deepEqual(flags(daily({ existingCommitment: crossing })), {
    allowed: false, breached: false, lossLimitReached: false, precisionUncertain: true,
  });
  assert.deepEqual(flags(daily({ existingCommitment: above })), {
    allowed: false, breached: true, lossLimitReached: false, precisionUncertain: true,
  });
  assert.deepEqual(flags(daily({ existingCommitment: below })), {
    allowed: true, breached: false, lossLimitReached: false, precisionUncertain: true,
  });
}

function testExistingDecimalFixturesRemainEquivalent() {
  const cases = [
    ['30', '-1', '-10', '10', '9'],
    ['30', '-1', '-10', '10', '9.000000000000000001'],
    ['100', '19.25', '-10', '20', '80'],
    ['100', '-50', '0', '0', '49.05'],
    ['100', '-51', '0', '0', '49.05'],
    ['0', '0', '0', '0', '0'],
    ['1', '-1', '0', '0', '0'],
    ['1', '-1.000000000000000001', '0', '0', '0'],
  ];
  for (const [budget, ledgerPnl, unrealizedPnl, existingCommitment, candidateCommitment] of cases) {
    const original = { budget, ledgerPnl, unrealizedPnl, existingCommitment, candidateCommitment };
    const expected = calculateDailyRisk(original);
    const actual = calculateMonetaryDailyRisk({ ...original, ledgerPnl: money(ledgerPnl),
      existingCommitment: money(existingCommitment), candidateCommitment: money(candidateCommitment) });
    for (const key of ['dayPnl', 'consumedLoss', 'totalCommitment']) assert.equal(actual[key].decimal, expected[key], key);
    assert.equal(actual.allowed, expected.allowed);
    assert.equal(actual.breached, !expected.allowed);
    assert.equal(actual.lossLimitReached, compareMoneyValue(money(expected.consumedLoss), budget) >= 0);
    assert.equal(actual.precisionUncertain, false);
    assert.equal(actual.budget, budget);
    assert.deepEqual(actual.existingCommitment, money(existingCommitment));
    assert.deepEqual(actual.candidateCommitment, money(candidateCommitment));
  }
}

function testTinyLossAndRebateNeverBecomeFalseZero() {
  const denominator = '1' + '0'.repeat(36);
  const tinyLoss = ratio('-1', denominator);
  const loss = daily({ budget: '0', ledgerPnl: tinyLoss });
  assert.deepEqual(loss.consumedLoss.exact, { numerator: '1', denominator });
  assert.equal(loss.consumedLoss.decimal, null);
  assert.deepEqual(flags(loss), { allowed: false, breached: true, lossLimitReached: true, precisionUncertain: false });
  const rebate = ratio('1', denominator);
  const compensated = daily({ budget: '0', ledgerPnl: addMoneyValues(tinyLoss, rebate) });
  assert.equal(compensated.dayPnl.decimal, '0');
  assert.equal(compensated.consumedLoss.decimal, '0');
  assert.equal(compensated.allowed, true);
  const netLoss = daily({ budget: quantum, ledgerPnl: addMoneyValues(money('-' + quantum), rebate) });
  assert.equal(netLoss.consumedLoss.decimal, null);
  assert.equal(compareMoneyValue(netLoss.consumedLoss, quantum), -1);
  assert.deepEqual(flags(netLoss), { allowed: true, breached: false, lossLimitReached: false, precisionUncertain: false });
  const rebateOnly = daily({ ledgerPnl: rebate });
  assert.equal(rebateOnly.dayPnl.decimal, null);
  assert.equal(rebateOnly.consumedLoss.decimal, '0');
  assert.equal(rebateOnly.consumedLoss.terms, rebateOnly.dayPnl.terms);
}

function testLossClampingPreservesIntervalKnowledge() {
  const crossing = daily({ budget: '0', ledgerPnl: interval('-0.000000000000000001', quantum) });
  assert.deepEqual(crossing.consumedLoss, interval('0', quantum, 3));
  assert.deepEqual(flags(crossing), { allowed: false, breached: false, lossLimitReached: true, precisionUncertain: true });
  for (const ledgerPnl of [interval('0', quantum), interval('1', '1.000000000000000001')]) {
    const result = daily({ ledgerPnl });
    assert.equal(result.consumedLoss.decimal, '0');
    assert.deepEqual(result.consumedLoss.exact, { numerator: '0', denominator: '1' });
    assert.equal(result.consumedLoss.terms, result.dayPnl.terms);
    assert.deepEqual(flags(result), { allowed: true, breached: false, lossLimitReached: false, precisionUncertain: true });
  }
  const touching = daily({ ledgerPnl: interval('-1', '-0.999999999999999999') });
  assert.deepEqual(touching.consumedLoss, interval('0.999999999999999999', '1', 3));
  assert.deepEqual(flags(touching), { allowed: true, breached: false, lossLimitReached: false, precisionUncertain: true });
  const reached = daily({ ledgerPnl: interval('-1.000000000000000001', '-1') });
  assert.deepEqual(flags(reached), { allowed: false, breached: false, lossLimitReached: true, precisionUncertain: true });
  const exceeded = daily({ ledgerPnl: interval('-1.000000000000000002', '-1.000000000000000001') });
  assert.deepEqual(flags(exceeded), { allowed: false, breached: true, lossLimitReached: true, precisionUncertain: true });
}

function testRationalBudgetAndFundingFlows() {
  const ledgerPnl = ratio('-1', '3');
  const below = daily({ budget: '0.333333333333333333', ledgerPnl });
  const above = daily({ budget: '0.333333333333333334', ledgerPnl });
  assert.deepEqual(below.consumedLoss.exact, { numerator: '1', denominator: '3' });
  assert.deepEqual(flags(below), { allowed: false, breached: true, lossLimitReached: true, precisionUncertain: false });
  assert.deepEqual(flags(above), { allowed: true, breached: false, lossLimitReached: false, precisionUncertain: false });
  const exactlyOne = daily({ ledgerPnl, existingCommitment: ratio('1', '3'), candidateCommitment: ratio('1', '3') });
  assert.equal(exactlyOne.totalCommitment.decimal, '1');
  assert.equal(exactlyOne.allowed, true);
  assert.equal(exactlyOne.breached, false);
  // Already evidenced native/reporting amounts, not an implicit stablecoin conversion.
  const fundingAndRebate = addMoneyValues(money('-9.8'), money('0.02505'));
  const flow = daily({ budget: '10', ledgerPnl: fundingAndRebate, unrealizedPnl: '1',
    existingCommitment: money('1'), candidateCommitment: money('0.22505') });
  assert.equal(flow.dayPnl.decimal, '-8.77495');
  assert.equal(flow.consumedLoss.decimal, '8.77495');
  assert.equal(flow.totalCommitment.decimal, '10');
  assert.equal(flow.allowed, true);
  assert.equal(flow.precisionUncertain, false);
}

function testAggregationOverflowRetainsUncertainty() {
  const a = ratio('1', '9'.repeat(200));
  const b = ratio('1', '1' + '0'.repeat(200));
  const result = daily({ budget: quantum, existingCommitment: a, candidateCommitment: b });
  assert.deepEqual(result.totalCommitment, interval('0', '0.000000000000000002', 4));
  assert.deepEqual(flags(result), { allowed: false, breached: false, lossLimitReached: false, precisionUncertain: true });
  const wide = '9007199254740993';
  const exact = daily({ budget: wide, existingCommitment: money(wide), candidateCommitment: money(quantum) });
  assert.equal(exact.allowed, false);
  assert.equal(exact.breached, true);
  const maximum = '9'.repeat(36) + '.' + '9'.repeat(18);
  const maximumAllowed = daily({ budget: maximum, existingCommitment: money(maximum) });
  assert.equal(maximumAllowed.totalCommitment.decimal, maximum);
  assert.deepEqual(flags(maximumAllowed), { allowed: true, breached: false, lossLimitReached: false, precisionUncertain: false });
  assert.throws(() => daily({ budget: maximum, existingCommitment: money(maximum), candidateCommitment: money(quantum) }), /decimal/i);
}

function testInvalidOrPossiblyNegativeCommitmentsFail() {
  for (const field of ['existingCommitment', 'candidateCommitment']) {
    for (const value of [money('-1'), ratio('-1', '9'.repeat(256)),
      interval('-0.000000000000000001', quantum), interval('-0.000000000000000001', '0')]) {
      assert.throws(() => daily({ [field]: value }), /nonnegative|negative|commitment/i);
    }
    for (const value of [null, {}, { ...money('0'), decimal: null }, { ...money('1'), lower: '0' }]) {
      assert.throws(() => daily({ [field]: value }));
    }
  }
  for (const budget of ['-1', '-0', ' 1', '1 ', '1e3', '+1', '', NaN, null, 1]) assert.throws(() => daily({ budget }));
  for (const unrealizedPnl of ['- 1', ' 0', '1e3', null, NaN, 1]) assert.throws(() => daily({ unrealizedPnl }));
  for (const threshold of [' 0', '1 ', '1e3', null, NaN, 1]) assert.throws(() => compareMoneyValue(money('1'), threshold));
  assert.throws(() => compareMoneyValue({ ...money('1'), upper: '2' }, '1'));
  assert.throws(() => daily({ ledgerPnl: { ...money('0'), terms: Number.MAX_SAFE_INTEGER } }), /term/i);
  assert.doesNotThrow(() => daily({ existingCommitment: interval('0', quantum) }));
  assert.doesNotThrow(() => daily({ candidateCommitment: ratio('1', '9'.repeat(256)) }));
}

testExactComparisonDoesNotRoundFractions();
testIntervalsDistinguishTouchingFromExactEquality();
testExistingDecimalFixturesRemainEquivalent();
testTinyLossAndRebateNeverBecomeFalseZero();
testLossClampingPreservesIntervalKnowledge();
testRationalBudgetAndFundingFlows();
testAggregationOverflowRetainsUncertainty();
testInvalidOrPossiblyNegativeCommitmentsFail();
console.log('Exact and bounded monetary daily risk, conservative admission and proven breach boundaries passed.');
