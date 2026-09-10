import assert from 'node:assert/strict';
import { TradingMutationCoordinator } from '../src/trading_mutation_coordinator.js';

function deferred() {
  const { promise, resolve } = Promise.withResolvers();
  return { promise, resolve };
}

const coordinator = new TradingMutationCoordinator();
const hold = deferred();
const entered = deferred();
const order = [];
let capturedContext;
const epoch = coordinator.entryEpoch('a');
const first = coordinator.run('a', async context => {
  capturedContext = context;
  order.push('a1');
  entered.resolve();
  await hold.promise;
  await coordinator.run('a', () => { order.push('nested'); return Promise.resolve(); }, context);
  assert.throws(() => coordinator.assertEntryEpoch(context, epoch), /fence/i);
});
await entered.promise;
const second = coordinator.run('a', () => { order.push('a2'); return Promise.resolve(); });
await coordinator.run('b', () => { order.push('b'); return Promise.resolve(); });
coordinator.fenceEntries('a');
assert.deepEqual(order, ['a1', 'b']);
hold.resolve();
await Promise.all([first, second]);
assert.deepEqual(order, ['a1', 'b', 'nested', 'a2']);
await assert.rejects(coordinator.run('a', () => Promise.resolve(), capturedContext), /context/i);
await coordinator.run('a', async context => {
  await assert.rejects(coordinator.run('b', () => Promise.resolve(), context), /context/i);
  const before = coordinator.entryEpoch('a');
  coordinator.fenceEntries();
  assert.throws(() => coordinator.assertEntryEpoch(context, before), /fence/i);
});
await assert.rejects(coordinator.run('a', () => { throw new Error('expected'); }), /expected/);
await coordinator.run('a', () => { order.push('after-error'); return Promise.resolve(); });
const firstHold = coordinator.holdEntries('a');
const secondHold = coordinator.holdEntries('a');
firstHold();
await coordinator.run('a', async context => {
  assert.throws(() => coordinator.assertEntryEpoch(context, coordinator.entryEpoch('a')), /fence/);
});
await coordinator.run('b', async context => {
  coordinator.assertEntryEpoch(context, coordinator.entryEpoch('b'));
});
secondHold();
await coordinator.run('a', async context => {
  coordinator.assertEntryEpoch(context, coordinator.entryEpoch('a'));
});
assert.equal(order.at(-1), 'after-error');
console.log('Account mutation serialization and fence tests passed.');
