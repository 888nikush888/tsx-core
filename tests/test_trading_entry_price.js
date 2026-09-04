import assert from 'node:assert/strict';
import { assertEntryPriceBoundary, createEntryPriceBoundary, createTradingPlan } from '../src/trading_risk.js';
import { DEFAULT_STRATEGY_CONFIGURATION } from '../src/trading_strategy.js';
import { assertBoundedEntryProfile } from '../src/trading_execution_constraints.js';

const boundary = (side, referencePrice = '100.05', priceTick = '0.1') => createEntryPriceBoundary({
  side, referencePrice, priceTick, maxSlippagePercent: '0.5',
});
assert.equal(boundary('LONG').limitPrice, '100.5');
assert.equal(boundary('SHORT').limitPrice, '99.6');
assert.equal(boundary('LONG', '0.000000000000000003', '0.000000000000000001').limitPrice, '0.000000000000000003');
assert.equal(boundary('SHORT', '0.000000000000000003', '0.000000000000000001').limitPrice, '0.000000000000000003');

function planInput(side = 'LONG', entryType = 'market') {
  return { intentId: 'bounded-entry', strategy: structuredClone(DEFAULT_STRATEGY_CONFIGURATION),
    signal: { schema: 'standard', action: side, symbol: 'BTCUSDT', entry: { type: entryType, min: '100', max: '100' },
      stopLoss: side === 'LONG' ? '90' : '110', targets: side === 'LONG'
        ? [{ min: '110', max: '110' }, { min: '120', max: '120' }] : [{ min: '90', max: '90' }, { min: '80', max: '80' }] },
    account: { equity: '10000', availableBalance: '10000' },
    market: { symbol: 'BTCUSDT', markPrice: '100.05', priceTick: '0.1', quantityStep: '0.01',
      minimumQuantity: '0.01', minimumNotional: '1', maxLeverage: 10, observedAt: Date.now() } };
}
for (const side of ['LONG', 'SHORT']) {
  const input = planInput(side);
  const plan = createTradingPlan(input);
  const entry = plan.orders.find(order => order.role === 'entry');
  assert.equal(entry.orderType, 'limit');
  assert.equal(entry.timeInForce, 'IOC');
  assert.equal(entry.price, boundary(side).limitPrice);
  assert.equal(entry.postOnly, false);
  assertEntryPriceBoundary(plan, entry);
  for (const change of [{ price: side === 'LONG' ? '100.6' : '99.5' }, { orderType: 'market' }, { timeInForce: undefined }, { postOnly: true }]) {
    assert.throws(() => assertEntryPriceBoundary(plan, { ...entry, ...change }), /price|bound|IOC/i);
  }
  assert.throws(() => assertEntryPriceBoundary({ ...plan, entryPriceBoundary: null }, entry), /bound/i);
  const revalidated = createTradingPlan({ ...input, market: { ...input.market, markPrice: '150' },
    entryPriceBoundary: plan.entryPriceBoundary, now: plan.createdAt });
  assert.deepEqual(revalidated.entryPriceBoundary, plan.entryPriceBoundary, 'Revalidation must never move the original boundary.');
  assert.deepEqual(revalidated.orders, plan.orders);
  const stop = plan.orders.find(order => order.role === 'stop_loss');
  assert.equal(stop.orderType, 'stop_market');
  assert.equal(stop.timeInForce, undefined);
  assert.equal(stop.price, null);
}
const regular = planInput('LONG', 'range');
regular.strategy.entry.postOnly = true;
const regularPlan = createTradingPlan(regular);
assert.equal(regularPlan.entryPriceBoundary, undefined);
assert.equal(regularPlan.orders[0].price, '100');
assert.equal(regularPlan.orders[0].postOnly, true);
assert.equal(regularPlan.orders[0].timeInForce, undefined);
assertEntryPriceBoundary(regularPlan, regularPlan.orders[0]);
const boundedPlan = createTradingPlan(planInput());
for (const exchange of ['bybit', 'hyperliquid']) {
  assert.throws(() => assertBoundedEntryProfile({ exchange, capabilities: {} }, boundedPlan), /not proven/);
  assertBoundedEntryProfile({ exchange, capabilities: { executionCapabilities: { protected_bounded_entry: 'limit_ioc_batch_v1' } } }, boundedPlan);
}
assert.throws(() => assertBoundedEntryProfile({ exchange: 'krakenfutures', capabilities: {
  executionCapabilities: { protected_bounded_entry: 'limit_ioc_batch_v1' },
} }, boundedPlan), /not proven/, 'A declared flag must not override the unresolved Kraken protected form.');
assertBoundedEntryProfile({ exchange: 'krakenfutures' }, regularPlan);
console.log('Original entry-price boundary, adverse tick and immutable revalidation tests passed.');
