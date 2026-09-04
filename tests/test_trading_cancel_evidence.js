import assert from 'node:assert/strict';
import { exactActiveCancelEvidence } from '../src/trading_cancel_evidence.js';
import { completeSafetyState } from './fixtures/safety_acquisition.js';

const account = { id: 'a', exchange: 'bybit', externalAccountId: 'a'.repeat(64), credentialGeneration: 'b'.repeat(64) };
const local = { account_id: 'a', intent_id: 'i', client_order_id: 'c', exchange_order_id: 'real-1', provider_symbol: 'BTC/USDT:USDT',
  symbol: 'BTCUSDT', role: 'stop_loss', side: 'sell', status: 'cancel_pending', quantity: '2', filled_quantity: '0.5', reduce_only: 1,
  price: null, trigger_price: '90' };
const observed = { clientOrderId: 'c', exchangeOrderId: 'real-1', providerSymbol: 'BTC/USDT:USDT', symbol: 'BTCUSDT',
  role: 'stop_loss', side: 'sell', status: 'partially_filled', quantity: '2', filledQuantity: '0.75', reduceOnly: true, price: null, triggerPrice: '90' };
const fresh = () => completeSafetyState({ accountFingerprint: account.externalAccountId, orders: [{ ...observed }] });
const matches = state => exactActiveCancelEvidence(local, state, account, 1);
assert.equal(matches(fresh()).remainingQuantity, '1.25');
for (const patch of [{ exchangeOrderId: 'invented' }, { providerSymbol: 'BTC/USDC:USDC' }, { clientOrderId: 'foreign' },
  { symbol: 'ETHUSDT' }, { role: 'take_profit' }, { side: 'buy' }, { reduceOnly: false }, { quantity: '3' },
  { filledQuantity: null }, { filledQuantity: '0.25' }, { filledQuantity: '2' }, { status: 'unknown' }, { triggerPrice: '80' }]) {
  const state = fresh(); Object.assign(state.orders[0], patch);
  assert.equal(matches(state), null, JSON.stringify(patch));
}
for (const mutate of [state => { state.orders = []; }, state => state.orders.push({ ...state.orders[0] }),
  state => { state.accountFingerprint = 'c'.repeat(64); }, state => { delete state.acquisition; },
  state => { state.acquisition.startedAt -= 10_001; }, state => { state.acquisition.completedAt += 10_000; },
  state => { state.acquisition.sources[0].completeness = 'partial'; }]) {
  const state = fresh(); mutate(state); assert.equal(matches(state), null);
}
const state = fresh();
assert.equal(exactActiveCancelEvidence(local, state, account, state.acquisition.startedAt + 1), null);
console.log('Exact active cancel evidence rejects absence, stale state, conflicts and unknown remaining quantities.');
