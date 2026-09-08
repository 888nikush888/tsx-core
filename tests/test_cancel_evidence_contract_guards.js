import assert from 'node:assert/strict';
import { cancelAcquisitionFresh } from '../src/trading_cancel_evidence.js';
import { CANCEL_RETRY_MS } from '../src/trading_cancel_budget.js';

function snapshot() {
  return { orders: [], positions: [], fills: [], acquisition: { version: 1, startedAt: 100, completedAt: 102,
    checkedOrders: [], sources: ['orders', 'positions', 'fills', 'targeted_orders'].map(source => ({ source,
      startedAt: 100, completedAt: 102, completeness: 'complete', reason: null, since: null })) } };
}
assert.equal(cancelAcquisitionFresh(snapshot(), 100, 100 + CANCEL_RETRY_MS), true,
  'Exact retry-window boundary remains admissible.');
assert.equal(cancelAcquisitionFresh(snapshot(), 100, 101 + CANCEL_RETRY_MS), false);
assert.equal(cancelAcquisitionFresh(snapshot(), 101, 102), false, 'Pre-attempt acquisition never authorizes another cancellation.');
for (const mutate of [
  value => { value.acquisition.completedAt = 102.5; },
  value => { value.acquisition.completedAt = '102'; },
  value => { value.acquisition.sources[0].startedAt = 100.5; },
  value => { value.acquisition.sources[0].completedAt = 101.5; },
  value => { value.acquisition.sources[0].startedAt = '100'; },
  value => { value.acquisition.sources[0].completedAt = NaN; },
  value => { value.acquisition.sources.push({ ...value.acquisition.sources[0] }); },
  value => { value.acquisition.sources = value.acquisition.sources.slice(1); },
]) {
  const value = snapshot(); mutate(value);
  assert.equal(cancelAcquisitionFresh(value, 100, 103), false,
    'Malformed timing or ambiguous source evidence must not authorize cancellation.');
}
console.log('Cancellation evidence requires integer acquisition/source clocks and preserves retry-window edges.');
