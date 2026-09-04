import assert from 'node:assert/strict';
import { TradingMutationCoordinator } from '../src/trading_mutation_coordinator.js';
import { claimCancelAttempt, consumeCancelAttempt } from '../src/trading_cancel_budget.js';

const coordinator = new TradingMutationCoordinator();
function attempt(account, order) {
  const permit = claimCancelAttempt(account, order);
  consumeCancelAttempt(permit, account, order);
  assert.throws(() => consumeCancelAttempt(permit, account, order), /permit/i);
}
assert.throws(() => claimCancelAttempt('a', 'outside'), /context/i);
await coordinator.run('@runtime', async () => {
  await coordinator.run('a', async a => {
    await coordinator.run('b', async b => {
      for (let index = 0; index < 3; index += 1) {
        await coordinator.run('a', async () => attempt('a', `entry-${index}`), a);
        await coordinator.run('b', async () => attempt('b', `stop-${index}`), b);
      }
      await coordinator.run('a', async () => {
        attempt('a', 'tp'); attempt('a', 'closure');
        assert.throws(() => claimCancelAttempt('a', 'sixth'), /budget/i);
        assert.throws(() => claimCancelAttempt('b', 'wrong-account'), /context/i);
      }, a);
      await coordinator.run('b', async () => {
        attempt('b', 'tp'); attempt('b', 'closure');
        assert.throws(() => claimCancelAttempt('b', 'sixth'), /budget/i);
      }, b);
    });
    await coordinator.run('a', async () => assert.throws(() => claimCancelAttempt('a', 'new-pass'), /budget/i), a);
  });
});
let expired;
await coordinator.run('a', async () => { expired = claimCancelAttempt('a', 'unused'); });
await coordinator.run('a', async () => {
  assert.throws(() => consumeCancelAttempt(expired, 'a', 'unused'), /permit/i);
  for (let index = 0; index < 5; index += 1) attempt('a', `fresh-${index}`);
});
console.log('Shared per-owner cancel budget, nested accounts and one-use permits passed.');
