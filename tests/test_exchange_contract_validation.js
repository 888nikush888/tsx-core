import assert from 'node:assert/strict';
import { confirmedOrderEvidence, validateAcquisitionEvidence, validateMarketSnapshot, validateOrderResult, validateOpenState } from '../src/exchange_contract_validation.js';

const request = { clientOrderId: 'expected', quantity: '1' };
const result = { clientOrderId: 'expected', exchangeOrderId: 'remote', status: 'filled', filledQuantity: '1', averagePrice: '100', error: null, raw: {} };
assert.equal(validateOrderResult(result, request).exchangeOrderId, 'remote');
assert.throws(() => validateOrderResult({ ...result, clientOrderId: 'other' }, request), /identifier/i);
assert.throws(() => validateOrderResult({ ...result, exchangeOrderId: '' }, request), /identifier/i);
assert.throws(() => validateOrderResult({ ...result, filledQuantity: '2' }, request), /quantity/i);
assert.throws(() => validateOrderResult({ ...result, averagePrice: '-1' }, request), /decimal/i);
assert.throws(() => validateOrderResult({ ...result, status: 'open', filledQuantity: 'NaN' }, request), /decimal/i);
const stopRequest = { clientOrderId: 'stop', quantity: '1' };
const stopResult = { ...result, clientOrderId: 'stop', exchangeOrderId: 'remote-stop' };
assert.deepEqual(confirmedOrderEvidence([stopResult, result], [request, stopRequest]), [result, stopResult]);
assert.deepEqual(confirmedOrderEvidence([result, { ...stopResult, exchangeOrderId: null }], [request, stopRequest]), [result]);
assert.deepEqual(confirmedOrderEvidence([result, { ...stopResult, exchangeOrderId: result.exchangeOrderId }], [request, stopRequest]), []);

const market = { symbol: 'BTCUSDT', markPrice: '100', priceTick: '0.1', quantityStep: '0.001', minimumQuantity: '0.001', minimumNotional: '1', maxLeverage: 50, observedAt: Date.now() };
assert.equal(validateMarketSnapshot(market, 'BTCUSDT').markPrice, '100');
for (const change of [{ symbol: 'ETHUSDT' }, { priceTick: '0' }, { markPrice: '1e5' }, { maxLeverage: 0 }, { observedAt: Date.now() + 120_000 }]) {
  assert.throws(() => validateMarketSnapshot({ ...market, ...change }, 'BTCUSDT'));
}
const state = { orders: [], positions: [], fills: [], observedAt: Date.now(), accountFingerprint: 'a'.repeat(64) };
assert.equal(validateOpenState(state, 'a'.repeat(64)).positions.length, 0);
const observed = Date.now();
const acquisition = { version: 1, startedAt: observed - 100, completedAt: observed,
  sources: ['positions', 'orders', 'targeted_orders', 'fills'].map(source => ({ source, startedAt: observed - 100, completedAt: observed,
    completeness: 'unknown', reason: 'bounded_history', since: 0, headers: 'MUST_NOT_PERSIST' })),
  checkedOrders: [{ clientOrderId: 'expected', status: 'not_found', secret: 'MUST_NOT_PERSIST' }], apiKey: 'MUST_NOT_PERSIST' };
assert.doesNotMatch(JSON.stringify(validateAcquisitionEvidence(acquisition)), /MUST_NOT_PERSIST|apiKey|headers/);
assert.equal(validateAcquisitionEvidence(acquisition).checkedOrders[0].status, 'not_found');
const scopedAcquisition = { ...acquisition, sources: acquisition.sources.map(source => ({ ...source,
  completeness: 'complete', reason: null, scopes: [{ scope: 'linear:USDT', pages: 2, complete: true, raw: 'MUST_NOT_PERSIST' }] })) };
assert.deepEqual(validateAcquisitionEvidence(scopedAcquisition).sources[0].scopes,
  [{ scope: 'linear:USDT', pages: 2, complete: true }]);
for (const scopes of [[], [{ scope: 'linear:USDT', pages: 0, complete: true }],
  [{ scope: 'linear:USDT', pages: 2, complete: false }], [{ scope: 'linear:USDT', pages: 65, complete: true }],
  [{ scope: 'linear:USDT', pages: 1, complete: true }, { scope: 'linear:USDT', pages: 1, complete: true }],
  [{ scope: 'bad\nscope', pages: 1, complete: true }]]) {
  assert.throws(() => validateAcquisitionEvidence({ ...scopedAcquisition,
    sources: scopedAcquisition.sources.map(source => ({ ...source, scopes })) }), /scope/i);
}
for (const change of [{ version: 2 }, { completedAt: observed - 101 }, { sources: acquisition.sources.slice(1) },
  { checkedOrders: [...acquisition.checkedOrders, ...acquisition.checkedOrders] },
  { sources: acquisition.sources.map(source => ({ ...source, completeness: 'probably_complete' })) },
  { sources: acquisition.sources.map(source => ({ ...source, startedAt: observed - 101 })) }]) {
  assert.throws(() => validateAcquisitionEvidence({ ...acquisition, ...change }));
}
assert.throws(() => validateOpenState(state, 'b'.repeat(64)), /identity/i);
const remoteOrder = { ...result, clientOrderId: null, symbol: 'BTCUSDT', role: 'stop_loss', side: 'sell', quantity: '1', price: null, triggerPrice: '90', reduceOnly: true };
assert.equal(validateOpenState({ ...state, orders: [remoteOrder] }).orders[0].clientOrderId, null);
assert.equal(validateOpenState({ ...state, orders: [{ ...remoteOrder, filledQuantity: null }] }).orders[0].filledQuantity, null);
assert.throws(() => validateOrderResult({ ...result, filledQuantity: null }, request), /decimal/i);
for (const change of [{ side: 'LONG' }, { reduceOnly: 'true' }, { quantity: '-1' }, { filledQuantity: '2' }, { exchangeOrderId: '' }]) {
  assert.throws(() => validateOpenState({ ...state, orders: [{ ...remoteOrder, ...change }] }));
}
const fill = { exchangeFillId: 'fill', clientOrderId: null, exchangeOrderId: 'remote', price: '100', quantity: '1', fee: '-0.1', feeAsset: 'USDT', filledAt: Date.now(), raw: {} };
assert.equal(validateOpenState({ ...state, fills: [fill] }).fills[0].fee, '-0.1');
const accounting = { version: 1, source: 'ccxt-market-v1', providerSymbol: 'BTC/USDT:USDT', settlementAsset: 'USDT', linear: true, quantityUnit: 'base' };
assert.deepEqual(validateOpenState({ ...state, fills: [{ ...fill, providerSymbol: accounting.providerSymbol,
  accounting: { ...accounting, credential: 'MUST_NOT_PERSIST' } }] }).fills[0].accounting, accounting);
for (const change of [{ linear: false }, { quantityUnit: 'contracts' }, { settlementAsset: null }, { providerSymbol: 'BTC/USD:BTC' }]) {
  assert.throws(() => validateOpenState({ ...state, fills: [{ ...fill, providerSymbol: accounting.providerSymbol, accounting: { ...accounting, ...change } }] }));
}
assert.throws(() => validateOpenState({ ...state, fills: [{ ...fill, quantity: '0' }] }));
console.log('Exchange contract validation tests passed.');
