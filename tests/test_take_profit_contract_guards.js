import assert from 'node:assert/strict';
import { completedTargetEvidence, resizeTargetTotals } from '../src/trading_take_profit.js';

const sparse = Array(2);
sparse[1] = '0';
for (const [previous, filled] of [[sparse, ['0', '0']], [['1', '1'], sparse], [['1', null], ['0', '0']]]) {
  assert.throws(() => resizeTargetTotals(previous, filled, '0', '1'), /missing or invalid target quantity/);
}
assert.throws(() => completedTargetEvidence(['1', '1'], ['0', '0'], [false, undefined], ['0', '0']), /completion evidence/);
assert.throws(() => completedTargetEvidence(sparse, ['0', '0'], [false, false], ['0', '0']), /target quantity/);
assert.throws(() => completedTargetEvidence(['2'], ['1'], [false], ['0']), /fill evidence regressed/);
assert.deepEqual(completedTargetEvidence(['2', '2'], ['1', '2'], [false, true], ['2', '2']), [true, true]);
assert.deepEqual(resizeTargetTotals(['1', '1'], ['0', '0'], '1', '1'),
  { totals: ['0', '1'], remaining: ['0', '1'], unallocatedQuantity: '0' }, 'Rounding residue stays on the last target.');
assert.deepEqual(resizeTargetTotals(['1', '1'], ['1', '0'], '1', '1'),
  { totals: ['1', '1'], remaining: ['0', '1'], unallocatedQuantity: '0' }, 'Filled targets never receive a fresh budget.');
assert.throws(() => resizeTargetTotals(['1'], ['1'], '1', '1'), /TP_TARGETS_EXHAUSTED_WITH_EXPOSURE/);
console.log('Take-profit quantity/completion holes fail closed; rounding and consumed budgets remain stable.');
