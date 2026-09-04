import assert from 'node:assert/strict';
import { correlateRemoteOrders, correlateRemoteFills } from '../src/exchange_order_correlation.js';

const local = {
  client_order_id: 'owned-stop', exchange_order_id: 'shared-remote-id', provider_symbol: 'BTC/USDT:USDT',
  symbol: 'BTCUSDT', role: 'stop_loss', side: 'sell', quantity: '1', reduce_only: 1, trigger_price: '90',
};
const remote = {
  clientOrderId: null, exchangeOrderId: 'shared-remote-id', providerSymbol: 'BTC/USDT:USDT',
  symbol: 'BTCUSDT', role: 'stop_loss', side: 'sell', quantity: '1', reduceOnly: true, triggerPrice: '90',
  status: 'open', filledQuantity: '0', price: null, averagePrice: null, error: null, raw: {},
};
const another = { ...local, client_order_id: 'eth-stop', provider_symbol: 'ETH/USDT:USDT', symbol: 'ETHUSDT' };
assert.equal(correlateRemoteOrders([local, another], [remote])[0].clientOrderId, 'owned-stop');
assert.equal(correlateRemoteOrders([local, another], [{ ...remote, symbol: 'ETHUSDT', providerSymbol: 'ETH/USDT:USDT' }])[0].clientOrderId, 'eth-stop');
assert.equal(correlateRemoteOrders([local], [{ ...remote, exchangeOrderId: 'similar-foreign-stop' }])[0].clientOrderId, null);
assert.equal(correlateRemoteOrders([{ ...local, exchange_order_id: null }], [remote])[0].clientOrderId, null);
for (const changed of [
  { clientOrderId: 'foreign-client' }, { clientOrderId: 'owned-stop', exchangeOrderId: 'wrong' },
  { clientOrderId: 'owned-stop', symbol: 'ETHUSDT' }, { quantity: '2' }, { side: 'buy' },
  { reduceOnly: false }, { triggerPrice: '95' },
]) {
  assert.throws(() => correlateRemoteOrders([local], [{ ...remote, ...changed }]), /conflict/i);
}
const fill = {
  clientOrderId: null, exchangeOrderId: local.exchange_order_id, symbol: 'BTCUSDT', providerSymbol: 'BTC/USDT:USDT',
  exchangeFillId: 'fill', price: '100', quantity: '0.1', fee: '0', feeAsset: 'USDT', filledAt: Date.now(), raw: {},
};
assert.equal(correlateRemoteFills([local, another], [fill])[0].clientOrderId, 'owned-stop');
const { symbol: _symbol, providerSymbol: _providerSymbol, ...unscoped } = fill;
assert.equal(correlateRemoteFills([local, another], [unscoped])[0].clientOrderId, null);
assert.throws(() => correlateRemoteFills([local, { ...local, client_order_id: 'duplicate-local' }], [fill]), /multiple/i);
console.log('Scoped order/fill identity and no-heuristic-ownership tests passed.');
