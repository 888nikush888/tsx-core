import assert from 'node:assert/strict';
import { assertPositionNamespace, proveOwnedQuantity } from '../src/trading_ownership.js';

const position = { symbol: 'BTCUSDT', providerSymbol: 'BTC/USDT:USDT', side: 'LONG', quantity: '1' };
assert.doesNotThrow(() => assertPositionNamespace(position, ['BTC/USDT:USDT', 'BTC/USDT:USDT']));
for (const symbols of [[], [null], ['BTC/USDC:USDC'], ['BTC/USDT:USDT', 'BTC/USDC:USDC']]) {
  assert.throws(() => assertPositionNamespace(position, symbols), error => error.code === 'POSITION_NAMESPACE_MISMATCH');
}
assert.throws(() => assertPositionNamespace({ ...position, providerSymbol: undefined }, ['BTC/USDT:USDT']), /POSITION_NAMESPACE_MISMATCH/);

const entry = { id: 'entry', role: 'entry', side: 'buy', reduce_only: 0, quantity: '1', filled_quantity: '0.6' };
const exit = { id: 'exit', role: 'stop_loss', side: 'sell', reduce_only: 1, quantity: '1', filled_quantity: '0.2' };
const fills = [{ order_id: 'entry', quantity: '0.4' }, { order_id: 'entry', quantity: '0.2' }, { order_id: 'exit', quantity: '0.2' }];
assert.deepEqual(proveOwnedQuantity([entry, exit], fills, 'LONG'), { entryQuantity: '0.6', exitQuantity: '0.2', netQuantity: '0.4' });
assert.deepEqual(proveOwnedQuantity([{ ...entry, side: 'sell' }, { ...exit, side: 'buy' }], fills, 'SHORT'), { entryQuantity: '0.6', exitQuantity: '0.2', netQuantity: '0.4' });
for (const [orders, evidence, code] of [
  [[entry, exit], [], 'CUMULATIVE_EXECUTION_MISMATCH'],
  [[entry, exit], [...fills, { order_id: 'foreign', quantity: '1' }], 'UNMAPPED_FILL'],
  [[entry, exit], [...fills, { order_id: 'entry', quantity: '0.5' }], 'ORDER_OVERFILLED'],
  [[{ ...entry, side: 'sell' }, exit], fills, 'ORDER_SEMANTICS'],
  [[entry, { ...exit, reduce_only: 0 }], fills, 'ORDER_SEMANTICS'],
  [[entry, { ...exit, filled_quantity: '0.8' }], [{ order_id: 'entry', quantity: '0.6' }, { order_id: 'exit', quantity: '0.8' }], 'EXITS_EXCEED_ENTRIES'],
]) {
  assert.throws(() => proveOwnedQuantity(orders, evidence, 'LONG'), error => error.code === code, code);
}
assert.deepEqual(proveOwnedQuantity([entry, { ...exit, filled_quantity: '0.6' }], [
  { order_id: 'entry', quantity: '0.6' }, { order_id: 'exit', quantity: '0.6' },
], 'LONG'), { entryQuantity: '0.6', exitQuantity: '0.6', netQuantity: '0' });
console.log('Owned quantity ledger, cumulative proof, overfill and direction tests passed.');
