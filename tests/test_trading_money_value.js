import assert from 'node:assert/strict';
import {
  moneyValueFromDecimal, moneyValueFromRational, addMoneyValues,
  negateMoneyValue, validateMoneyValue,
} from '../src/trading_money_value.ts';
import { addRational, rationalFromDecimal } from '../src/trading_rational.ts';

const quantum = '0.000000000000000001';
const fraction = (numerator, denominator) => ({ numerator, denominator });
const rationalValue = (numerator, denominator) => moneyValueFromRational(fraction(numerator, denominator));
const zero = (terms = 1) => ({
  lower: '0', upper: '0', exact: fraction('0', '1'), decimal: '0', precision: 'exact_decimal', terms,
});

function testDecimalAndRationalEvents() {
  assert.deepEqual(moneyValueFromDecimal('-0.000'), zero());
  assert.deepEqual(moneyValueFromDecimal('1.2300'), {
    lower: '1.23', upper: '1.23', exact: fraction('123', '100'),
    decimal: '1.23', precision: 'exact_decimal', terms: 1,
  });
  assert.deepEqual(rationalValue('-6', '12'), {
    lower: '-0.5', upper: '-0.5', exact: fraction('-1', '2'),
    decimal: '-0.5', precision: 'exact_decimal', terms: 1,
  });
  assert.deepEqual(rationalValue('1', '3'), {
    lower: '0.333333333333333333', upper: '0.333333333333333334', exact: fraction('1', '3'),
    decimal: null, precision: 'exact_rational', terms: 1,
  });
  const third = rationalValue('1', '3');
  assert.deepEqual(addMoneyValues(addMoneyValues(third, third), third), {
    ...moneyValueFromDecimal('1'), terms: 3,
  });
  assert.deepEqual(addMoneyValues(moneyValueFromDecimal('-1.23'), moneyValueFromDecimal('0.23')), {
    ...moneyValueFromDecimal('-1'), terms: 2,
  });
}

function testTinyRebatesAndExactCancellation() {
  const denominator = '9'.repeat(256);
  const rebate = rationalValue('1', denominator);
  const cost = rationalValue('-1', denominator);
  assert.deepEqual(rebate, {
    lower: '0', upper: quantum, exact: fraction('1', denominator),
    decimal: null, precision: 'exact_rational', terms: 1,
  });
  assert.deepEqual(cost, {
    lower: '-' + quantum, upper: '0', exact: fraction('-1', denominator),
    decimal: null, precision: 'exact_rational', terms: 1,
  });
  assert.deepEqual(negateMoneyValue(rebate), cost);
  assert.deepEqual(negateMoneyValue(cost), rebate);
  assert.deepEqual(addMoneyValues(rebate, cost), zero(2));
  // A 36-decimal terminating fraction is retained, never rounded into an exact zero.
  const tinyFinite = rationalValue('1', '1' + '0'.repeat(36));
  assert.equal(tinyFinite.decimal, null);
  assert.equal(tinyFinite.precision, 'exact_rational');
  assert.deepEqual(addMoneyValues(tinyFinite, negateMoneyValue(tinyFinite)), zero(2));
  assert.deepEqual(negateMoneyValue(zero(0)), zero(0));
  assert.deepEqual(addMoneyValues(zero(0), rebate), rebate);
}

function overflowDenominatorPair() {
  // Coprime 10^200 - 1 and 10^200 produce a reduced 400-digit denominator.
  const left = rationalValue('1', '9'.repeat(200));
  const right = rationalValue('1', '1' + '0'.repeat(200));
  assert.throws(() => addRational(left.exact, right.exact), /bounded rational/);
  return [left, right];
}

function testProvenRationalLimitFallsBackOutwards() {
  const [left, right] = overflowDenominatorPair();
  const bounded = addMoneyValues(left, right);
  assert.deepEqual(bounded, {
    lower: '0', upper: '0.000000000000000002', exact: null,
    decimal: null, precision: 'bounded', terms: 2,
  });
  assert.deepEqual(addMoneyValues(negateMoneyValue(left), negateMoneyValue(right)), {
    ...bounded, lower: '-0.000000000000000002', upper: '0',
  });
  assert.deepEqual(negateMoneyValue(bounded), {
    ...bounded, lower: '-0.000000000000000002', upper: '0',
  });
  assert.deepEqual(addMoneyValues(bounded, moneyValueFromDecimal('-1')), {
    ...bounded, lower: '-1', upper: '-0.999999999999999998', terms: 3,
  });
  assert.deepEqual(addMoneyValues(moneyValueFromDecimal('1'), bounded), {
    ...bounded, lower: '1', upper: '1.000000000000000002', terms: 3,
  });
  // Lost correlation is not reconstructed from coincidentally mirrored bounds.
  assert.deepEqual(addMoneyValues(bounded, negateMoneyValue(bounded)), {
    ...bounded, lower: '-0.000000000000000002', upper: '0.000000000000000002', terms: 4,
  });
  assert.deepEqual(validateMoneyValue(JSON.parse(JSON.stringify(bounded))), bounded);
}

function testLongSequencesKeepExactnessUntilNecessary() {
  const tiny = rationalValue('1', '9'.repeat(256));
  const negative = negateMoneyValue(tiny);
  let total = zero(0);
  for (let index = 0; index < 300; index += 1) {
    total = addMoneyValues(addMoneyValues(total, tiny), negative);
    assert.deepEqual(total, zero((index + 1) * 2));
  }
  const [left, right] = overflowDenominatorPair();
  let bounded = addMoneyValues(left, right);
  for (let index = 0; index < 100; index += 1) {
    bounded = addMoneyValues(addMoneyValues(bounded, tiny), negative);
  }
  assert.deepEqual(bounded, {
    lower: '-0.0000000000000001', upper: '0.000000000000000102', exact: null,
    decimal: null, precision: 'bounded', terms: 202,
  });
  assert.deepEqual(addMoneyValues(moneyValueFromDecimal('0.1'), moneyValueFromDecimal('0.2')), {
    ...moneyValueFromDecimal('0.3'), terms: 2,
  });
}

function testReductionPrecedesTheResultBudget() {
  const b = 10n ** 100n, d = b + 1n, k = 10n ** 50n + 1n;
  const common = k * b + d;
  const left = rationalValue('1', String(common * b));
  const right = rationalValue(String(k), String(common * d));
  // The common-denominator intermediate has 351 digits; its reduced result has only 201.
  assert.equal(String(common * b * d).length, 351);
  assert.equal(String(b * d).length, 201);
  assert.deepEqual(addMoneyValues(left, right), {
    ...rationalValue('1', String(b * d)), terms: 2,
  });
  assert.deepEqual(addMoneyValues(negateMoneyValue(left), negateMoneyValue(right)), {
    ...rationalValue('-1', String(b * d)), terms: 2,
  });
  assert.deepEqual(addMoneyValues(addMoneyValues(left, right), rationalValue('-1', String(b * d))), zero(3));
}

function testNormalizedNumeratorLimitAlsoUsesBounds() {
  const denominator = '9'.repeat(256);
  const numerator = String(BigInt(denominator) - 1n);
  const almostOne = rationalValue(numerator, denominator);
  assert.equal(String(2n * BigInt(numerator)).length, 257);
  assert.throws(() => addRational(almostOne.exact, almostOne.exact), /bounded rational/);
  assert.deepEqual(addMoneyValues(almostOne, almostOne), {
    lower: '1.999999999999999998', upper: '2', exact: null,
    decimal: null, precision: 'bounded', terms: 2,
  });
  const opposite = negateMoneyValue(almostOne);
  assert.deepEqual(addMoneyValues(opposite, opposite), {
    lower: '-2', upper: '-1.999999999999999998', exact: null,
    decimal: null, precision: 'bounded', terms: 2,
  });
  assert.deepEqual(addMoneyValues(almostOne, opposite), zero(2));
}

function testValidationRejectsInconsistentClaims() {
  const exact = moneyValueFromDecimal('1');
  const third = rationalValue('1', '3');
  const bounded = addMoneyValues(...overflowDenominatorPair());
  const malformed = [null, [], {}, { ...exact, extra: true },
    { ...exact, lower: '1.0' }, { ...exact, upper: ' 1' }, { ...exact, decimal: '1.0' },
    { ...exact, upper: '0.0000000000000000001' },
    { ...exact, lower: '0' }, { ...exact, upper: '2' }, { ...exact, decimal: null },
    { ...exact, precision: 'exact_rational' }, { ...exact, exact: fraction('2', '2') },
    { ...exact, exact: fraction('2', '1') }, { ...exact, exact: null },
    { ...exact, exact: { ...exact.exact, extra: true } },
    { ...third, decimal: third.lower }, { ...third, precision: 'exact_decimal' },
    { ...third, lower: '0.333333333333333332' }, { ...third, upper: third.lower },
    { ...bounded, precision: 'exact_rational' }, { ...bounded, decimal: '0' },
    { ...bounded, exact: fraction('1', '3') }, { ...bounded, lower: bounded.upper },
    { ...bounded, lower: '1' }, { ...bounded, upper: '0.000000000000000003' },
    { ...bounded, terms: 0 }, { ...bounded, upper: quantum, terms: 1 },
    { ...exact, terms: 0 }, { ...exact, terms: -1 }, { ...zero(), terms: -0 },
    { ...exact, terms: 0.5 }, { ...exact, terms: '1' }, { ...exact, terms: Infinity },
    { ...exact, terms: Number.MAX_SAFE_INTEGER + 1 }, { ...zero(), lower: '-0' },
    Object.assign(Object.create({ unrelated: true }), exact),
  ];
  for (const value of malformed) {
    assert.throws(() => validateMoneyValue(value));
    assert.throws(() => addMoneyValues(value, zero()));
    assert.throws(() => negateMoneyValue(value));
  }
  assert.deepEqual(validateMoneyValue(zero(0)), zero(0));
  assert.deepEqual(validateMoneyValue(third), third);
  assert.deepEqual(validateMoneyValue({ ...zero(), terms: Number.MAX_SAFE_INTEGER }), {
    ...zero(), terms: Number.MAX_SAFE_INTEGER,
  });
}

function testInvalidStructureDoesNotRunAccessors() {
  const value = moneyValueFromDecimal('1');
  let reads = 0;
  const accessor = { ...value };
  Object.defineProperty(accessor, 'lower', { get() { reads += 1; return '1'; }, enumerable: true });
  assert.throws(() => validateMoneyValue(accessor));
  assert.equal(reads, 0);
  const hidden = { ...value };
  Object.defineProperty(hidden, 'hidden', { value: true });
  assert.throws(() => validateMoneyValue(hidden));
  assert.throws(() => validateMoneyValue({ ...value, [Symbol('extra')]: true }));
  const copy = validateMoneyValue(value);
  copy.exact.numerator = '2';
  assert.equal(value.exact.numerator, '1');
  const frozen = Object.freeze({ ...value, exact: Object.freeze({ ...value.exact }) });
  assert.deepEqual(addMoneyValues(frozen, frozen), { ...moneyValueFromDecimal('2'), terms: 2 });
}

function testDecimalAndTermOverflowNeverDowngrade() {
  const maximum = '9'.repeat(36) + '.' + '9'.repeat(18);
  const largest = moneyValueFromDecimal(maximum);
  assert.equal(largest.decimal, maximum);
  assert.throws(() => addMoneyValues(largest, moneyValueFromDecimal(quantum)), /decimal/i);
  assert.throws(() => addMoneyValues(negateMoneyValue(largest), moneyValueFromDecimal('-' + quantum)), /decimal/i);
  assert.throws(() => moneyValueFromRational(fraction('1' + '0'.repeat(36), '1')), /decimal/i);
  const bounded = addMoneyValues(...overflowDenominatorPair());
  assert.throws(() => addMoneyValues(largest, bounded), /decimal/i);
  assert.throws(() => addMoneyValues(negateMoneyValue(largest), negateMoneyValue(bounded)), /decimal/i);
  const exhausted = { ...zero(), terms: Number.MAX_SAFE_INTEGER };
  assert.throws(() => addMoneyValues(exhausted, zero()), /term/i);
  for (const value of ['1e-3', ' 1', '1 ', '- 1', '+1', '01', '-0.0000000000000000001',
    '1' + '0'.repeat(36), '', null, NaN, 1]) assert.throws(() => moneyValueFromDecimal(value));
  for (const value of [null, [], {}, fraction('1', '0'), fraction('1', '-1'), fraction('01', '2'),
    fraction('1', '1' + '0'.repeat(256)), fraction('1'.repeat(257), '1'), fraction(1, '2')]) {
    assert.throws(() => moneyValueFromRational(value));
  }
  assert.deepEqual(moneyValueFromRational(rationalFromDecimal(maximum)), largest);
}

testDecimalAndRationalEvents();
testTinyRebatesAndExactCancellation();
testProvenRationalLimitFallsBackOutwards();
testLongSequencesKeepExactnessUntilNecessary();
testReductionPrecedesTheResultBudget();
testNormalizedNumeratorLimitAlsoUsesBounds();
testValidationRejectsInconsistentClaims();
testInvalidStructureDoesNotRunAccessors();
testDecimalAndTermOverflowNeverDowngrade();
console.log('Exact money events, proven rational-limit fallback and conservative aggregate validation passed.');
