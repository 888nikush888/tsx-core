import assert from 'node:assert/strict';
import { TradingMutationCoordinator } from '../src/trading_mutation_coordinator.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const coordinator = new TradingMutationCoordinator();
const hold = deferred();
const entered = deferred();
const order = [];
let capturedContext;
const first = coordinator.run('a', async context => {
  capturedContext = context;
  order.push('a1');
  entered.resolve();
  await hold.promise;
  await coordinator.run('a', async () => { order.push('nested'); }, context);
  assert.throws(() => coordinator.assertEntryEpoch(context, epoch), /fence/i);
});
const epoch = coordinator.entryEpoch('a');
await entered.promise;
const second = coordinator.run('a', async () => { order.push('a2'); });
await coordinator.run('b', async () => { order.push('b'); });
coordinator.fenceEntries('a');
assert.deepEqual(order, ['a1', 'b']);
hold.resolve();
await Promise.all([first, second]);
assert.deepEqual(order, ['a1', 'b', 'nested', 'a2']);
await assert.rejects(coordinator.run('a', async () => undefined, capturedContext), /context/i);
await coordinator.run('a', async context => {
  await assert.rejects(coordinator.run('b', async () => undefined, context), /context/i);
  const before = coordinator.entryEpoch('a');
  coordinator.fenceEntries();
  assert.throws(() => coordinator.assertEntryEpoch(context, before), /fence/i);
});
await assert.rejects(coordinator.run('a', async () => { throw new Error('expected'); }), /expected/);
await coordinator.run('a', async () => { order.push('after-error'); });
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
