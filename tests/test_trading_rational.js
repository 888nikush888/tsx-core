import assert from 'node:assert/strict';
import {
  rational, rationalFromDecimal, addRational, multiplyRational, divideRational,
  compareRational, rationalDecimalBounds, quantizeRational,
} from '../src/trading_rational.ts';

const ratio = (numerator, denominator) => rational({ numerator, denominator });
assert.deepEqual(ratio('60000', '60150'), { numerator: '400', denominator: '401' });
assert.deepEqual(ratio('-60000', '60150'), { numerator: '-400', denominator: '401' });
assert.deepEqual(ratio('0', '19'), { numerator: '0', denominator: '1' });
assert.deepEqual(rationalFromDecimal('-0.000'), ratio('0', '1'));
assert.deepEqual(rationalFromDecimal('1.002'), ratio('501', '500'));
assert.deepEqual(multiplyRational(rationalFromDecimal('-10'), rationalFromDecimal('0.98')), ratio('-49', '5'));
assert.deepEqual(multiplyRational(rationalFromDecimal('0.025'), rationalFromDecimal('1.002')), ratio('501', '20000'));
assert.deepEqual(divideRational(rationalFromDecimal('60000'), rationalFromDecimal('60150')), ratio('400', '401'));
assert.deepEqual(divideRational(ratio('1', '3'), ratio('-2', '9')), ratio('-3', '2'));
assert.deepEqual(addRational(ratio('1', '3'), ratio('1', '6')), ratio('1', '2'));
assert.deepEqual(addRational(ratio('-1', '3'), ratio('1', '3')), ratio('0', '1'));
assert.equal(compareRational(ratio('2', '6'), ratio('1', '3')), 0);
assert.equal(compareRational(ratio('-1', '3'), ratio('-1', '4')), -1);
assert.equal(compareRational(ratio('1', '3'), ratio('1', '4')), 1);

assert.deepEqual(rationalDecimalBounds(ratio('400', '401')), {
  lower: '0.997506234413965087', upper: '0.997506234413965088', exact: false,
});
assert.deepEqual(rationalDecimalBounds(ratio('-400', '401')), {
  lower: '-0.997506234413965088', upper: '-0.997506234413965087', exact: false,
});
assert.deepEqual(rationalDecimalBounds(ratio('-49', '5')), { lower: '-9.8', upper: '-9.8', exact: true });
assert.deepEqual(rationalDecimalBounds(ratio('501', '20000')), { lower: '0.02505', upper: '0.02505', exact: true });
assert.deepEqual(rationalDecimalBounds(ratio('1', '1000000000000000000000000000000000000')), {
  lower: '0', upper: '0.000000000000000001', exact: false,
});
assert.deepEqual(rationalDecimalBounds(ratio('-1', '1000000000000000000000000000000000000')), {
  lower: '-0.000000000000000001', upper: '0', exact: false,
});
assert.deepEqual(rationalDecimalBounds(ratio('1', '3'), 0), { lower: '0', upper: '1', exact: false });
assert.deepEqual(rationalDecimalBounds(ratio('-1', '3'), 0), { lower: '-1', upper: '0', exact: false });
assert.deepEqual(rationalDecimalBounds(ratio('0', '1')), { lower: '0', upper: '0', exact: true });

// Original exchange tick, not an intermediate rounded FX rate, bounds the size.
const size = divideRational(rationalFromDecimal('20'), multiplyRational(rationalFromDecimal('10'), rationalFromDecimal('1.25')));
assert.equal(quantizeRational(size, '0.1', 'floor'), '1.6');
assert.equal(quantizeRational(ratio('1', '3'), '0.1', 'floor'), '0.3');
assert.equal(quantizeRational(ratio('1', '3'), '0.1', 'ceil'), '0.4');
assert.equal(quantizeRational(ratio('-1', '3'), '0.1', 'floor'), '-0.4');
assert.equal(quantizeRational(ratio('-1', '3'), '0.1', 'ceil'), '-0.3');
assert.equal(quantizeRational(ratio('7', '10'), '0.25', 'floor'), '0.5');
assert.equal(quantizeRational(ratio('7', '10'), '0.25', 'ceil'), '0.75');
assert.equal(quantizeRational(ratio('0', '1'), '0.25', 'floor'), '0');

for (const value of [null, [], {}, { numerator: 1, denominator: '1' }, { numerator: '1', denominator: '0' },
  { numerator: '1', denominator: '-1' }, { numerator: '+1', denominator: '1' }, { numerator: '01', denominator: '1' },
  { numerator: '1.0', denominator: '1' }, { numerator: '1e3', denominator: '1' }, { numerator: ' 1', denominator: '1' },
  { numerator: '1', denominator: '1', extra: true }, { numerator: '1'.repeat(257), denominator: '1' }]) {
  assert.throws(() => rational(value), /rational/i);
}
for (const value of ['1e-3', '+1', ' 1', '1 ', '- 1', '-\t1', '.1', '01', 'NaN', Infinity, null, '0.0000000000000000001']) {
  assert.throws(() => rationalFromDecimal(value));
}
assert.throws(() => divideRational(ratio('1', '2'), ratio('0', '1')), /zero/i);
for (const scale of [-1, 19, 0.5, Infinity, '18']) assert.throws(() => rationalDecimalBounds(ratio('1', '3'), scale));
for (const step of ['0', '-1', '1e-3', ' 1']) assert.throws(() => quantizeRational(ratio('1', '3'), step, 'floor'));
assert.throws(() => quantizeRational(ratio('1', '3'), '0.1', 'nearest'));
assert.throws(() => rationalDecimalBounds(ratio('1' + '0'.repeat(36), '1')), /decimal/i);
const huge = ratio('9'.repeat(200), '1');
assert.throws(() => multiplyRational(huge, huge), /rational/i);
// Cross-reduce before enforcing the result bound: a large reciprocal is exact one.
assert.deepEqual(multiplyRational(huge, ratio('1', '9'.repeat(200))), ratio('1', '1'));

function testFinalQuantizationDoesNotBoundIntermediateRatio() {
  const numerator = '1' + '0'.repeat(255);
  const denominator = '9'.repeat(255);
  const nearOne = ratio(numerator, denominator);
  const negativeNearOne = ratio('-' + numerator, denominator);
  const tinyTick = '0.000000000000000001';
  assert.equal(quantizeRational(nearOne, tinyTick, 'floor'), '1');
  assert.equal(quantizeRational(nearOne, tinyTick, 'ceil'), '1.000000000000000001');
  assert.equal(quantizeRational(negativeNearOne, tinyTick, 'floor'), '-1.000000000000000001');
  assert.equal(quantizeRational(negativeNearOne, tinyTick, 'ceil'), '-1');
  // A wide tick temporarily expands the denominator, but the final amount still fits.
  const wideTick = '1' + '0'.repeat(35);
  assert.equal(quantizeRational(nearOne, wideTick, 'floor'), '0');
  assert.equal(quantizeRational(nearOne, wideTick, 'ceil'), wideTick);
  assert.equal(quantizeRational(negativeNearOne, wideTick, 'floor'), '-' + wideTick);
  assert.equal(quantizeRational(negativeNearOne, wideTick, 'ceil'), '0');
}

function testPublicIntegerBudgetRemainsBounded() {
  const largestInteger = '9'.repeat(256);
  assert.deepEqual(ratio(largestInteger, '1'), { numerator: largestInteger, denominator: '1' });
  assert.deepEqual(addRational(ratio(largestInteger, '1'), ratio('-' + largestInteger, '1')), ratio('0', '1'));
  assert.throws(() => addRational(ratio(largestInteger, '1'), ratio('1', '1')), /rational/i);
  assert.throws(() => rational({ numerator: '1', denominator: '1' + '0'.repeat(256) }), /rational/i);
  assert.throws(() => rational({ numerator: '-' + '1'.repeat(257), denominator: '1' }), /rational/i);
  assert.throws(() => quantizeRational(ratio('1' + '0'.repeat(36), '1'), '1', 'floor'), /decimal/i);
  const tiny = ratio('1', largestInteger);
  const negativeTiny = ratio('-1', largestInteger);
  assert.deepEqual(rationalDecimalBounds(tiny), { lower: '0', upper: '0.000000000000000001', exact: false });
  assert.deepEqual(rationalDecimalBounds(negativeTiny), { lower: '-0.000000000000000001', upper: '0', exact: false });
  assert.equal(quantizeRational(tiny, '0.000000000000000001', 'ceil'), '0.000000000000000001');
  assert.equal(quantizeRational(negativeTiny, '0.000000000000000001', 'floor'), '-0.000000000000000001');
}

testFinalQuantizationDoesNotBoundIntermediateRatio();
testPublicIntegerBudgetRemainsBounded();
console.log('Exact bounded rational arithmetic, signed reporting intervals and conservative tick quantization passed.');
