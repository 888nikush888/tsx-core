import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canTransitionIntent, mergeOrderEvidence } from '../src/trading_state_transitions.js';

const local = { status: 'partially_filled', filledQuantity: '0.4', quantity: '1', averagePrice: '100' };
const fixtures = JSON.parse(await readFile(new URL('./fixtures/order_evidence.json', import.meta.url), 'utf8'));
for (const fixture of fixtures) {
  if (fixture.error) assert.throws(() => mergeOrderEvidence(fixture.current, fixture.incoming), undefined, fixture.name);
  else assert.deepEqual(mergeOrderEvidence(fixture.current, fixture.incoming), fixture.expected, fixture.name);
}
assert.equal(canTransitionIntent('pending', 'planned'), true);
assert.equal(canTransitionIntent('completed', 'monitoring'), false);
assert.equal(canTransitionIntent('failed', 'submitting'), false);
assert.equal(canTransitionIntent('blocked', 'pending'), false);
assert.equal(canTransitionIntent('unknown', 'monitoring'), true);
assert.equal(canTransitionIntent('unexpected', 'monitoring'), false);

assert.deepEqual(
  mergeOrderEvidence(local, { status: 'open', filledQuantity: '0', averagePrice: null }),
  { status: 'partially_filled', filledQuantity: '0.4', averagePrice: '100' },
);
assert.equal(mergeOrderEvidence({ ...local, status: 'cancelled' }, { status: 'open', filledQuantity: '0' }).status, 'cancelled');
assert.deepEqual(
  mergeOrderEvidence({ ...local, status: 'cancelled' }, { status: 'partially_filled', filledQuantity: '0.6', averagePrice: '101' }),
  { status: 'cancelled', filledQuantity: '0.6', averagePrice: '101' },
);
assert.equal(
  mergeOrderEvidence({ ...local, status: 'cancelled' }, { status: 'filled', filledQuantity: '1', averagePrice: '102' }).status,
  'filled',
);
assert.equal(mergeOrderEvidence({ ...local, status: 'filled' }, { status: 'unknown', filledQuantity: '0' }).status, 'filled');
assert.equal(mergeOrderEvidence({ ...local, status: 'cancel_pending' }, { status: 'open', filledQuantity: '0.4' }).status, 'cancel_pending');
assert.equal(mergeOrderEvidence(local, { status: 'cancelled', filledQuantity: null }).filledQuantity, '0.4');
assert.throws(() => mergeOrderEvidence(local, { status: 'filled', filledQuantity: '1.1' }), /quantity/i);
assert.throws(() => mergeOrderEvidence(local, { status: 'open', filledQuantity: '-1' }), /decimal/i);
assert.throws(() => mergeOrderEvidence(local, { status: 'made_up', filledQuantity: '0' }), /status/i);
assert.throws(() => mergeOrderEvidence({ ...local, status: 'rejected', filledQuantity: '0' }, { status: 'filled', filledQuantity: '1' }), /rejected/i);
console.log('Monotone trading state tests passed.');
