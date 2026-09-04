import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb } from '../src/db.js';
import { TradingEngine } from '../src/trading_engine.js';
import { prepareTradingOperation, transitionTradingOperation } from '../src/trading_recovery.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { emergencyFixture } from './fixtures/trading_emergency_fixture.js';
import { assertExitCancellationSafe } from '../src/trading_exit_cancel.js';
import { loadCancelOrder } from '../src/trading_cancel_recovery.js';
import { persistCorrelatedFill } from '../src/trading_evidence_repository.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'exit-cancel-recovery-'));
const file = path.join(directory, 'test.db');
async function closing(name, phase = 'unresolved') {
  const fixture = await emergencyFixture(name, { partial: false, localQuantity: '1' });
  const stop = fixture.state.orders.get(`${name}-stop`);
  Object.assign(stop, { status: 'filled', filledQuantity: '1', averagePrice: '90' });
  fixture.state.fills.push({ clientOrderId: stop.clientOrderId, exchangeOrderId: stop.exchangeOrderId,
    exchangeFillId: `${name}-stop-fill`, symbol: 'BTCUSDT', providerSymbol: 'BTCUSDT', price: '90', quantity: '1',
    fee: '0', feeAsset: 'USDT', filledAt: Date.now(), raw: {} });
  fixture.state.owned = () => '0';
  const target = { ...stop, clientOrderId: `${name}-tp`, exchangeOrderId: `${name}-remote-tp`, role: 'take_profit', orderType: 'limit',
    status: 'open', filledQuantity: '0', averagePrice: null, price: '120', triggerPrice: null };
  fixture.state.orders.set(target.clientOrderId, target);
  await getDatabase().run(`INSERT INTO trading_orders (id, intent_id, account_id, client_order_id, exchange_order_id, provider_symbol,
    role, side, order_type, status, quantity, filled_quantity, price, reduce_only, request_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'BTCUSDT', 'take_profit', 'sell', 'limit', 'open', '1', '0', '120', 1, '{}', 1, 1)`,
  [target.clientOrderId, name, name, target.clientOrderId, target.exchangeOrderId]);
  const operation = await prepareTradingOperation({ account: fixture.account, intentId: name, kind: 'cancel',
    clientOrderIds: [target.clientOrderId], request: { clientOrderId: target.clientOrderId } });
  if (phase !== 'prepared') {
    await transitionTradingOperation(operation, 'prepared', 'dispatching');
    if (phase === 'unresolved') await transitionTradingOperation(operation, 'dispatching', 'unresolved');
  }
  await getDatabase().run("UPDATE trading_orders SET status = 'cancel_pending' WHERE id = ?", [target.clientOrderId]);
  await getDatabase().run('UPDATE trading_operations SET created_at = 1, updated_at = 1 WHERE id = ?', [operation]);
  return { ...fixture, target, operation };
}
async function resumedClosure(phase) {
  const fixture = await closing(`resume-${phase}`, phase);
  await closeDb(); await initDb(file);
  await new TradingEngine([fixture.adapter]).reconcileAccount(fixture.id);
  assert.deepEqual(fixture.state.cancelCalls, [fixture.target.clientOrderId]);
  assert.equal((await getDatabase().get('SELECT status FROM trading_positions WHERE id = ?', [fixture.id])).status, 'closed');
  const attempts = await getDatabase().all('SELECT phase, evidence_json FROM trading_operations WHERE account_id = ? ORDER BY generation', [fixture.id]);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].phase, phase === 'prepared' ? 'abandoned' : 'resolved');
  assert.equal(JSON.parse(attempts[0].evidence_json).source, 'fresh_exact_cancel_still_active');
  assert.equal(attempts[1].phase, 'resolved');
}
async function blockedClosure(name, patch) {
  const fixture = await closing(name);
  const read = fixture.adapter.openState;
  fixture.adapter.openState = async () => { const state = await read(); await patch(state, fixture); return state; };
  await assert.rejects(new TradingEngine([fixture.adapter]).reconcileAccount(fixture.id));
  assert.equal(fixture.state.cancelCalls.length, 0, name);
  assert.notEqual((await getDatabase().get('SELECT status FROM trading_positions WHERE id = ?', [fixture.id])).status, 'closed');
}
async function sharedPassBudget() {
  const fixture = await closing('six-exits');
  for (let index = 1; index < 6; index += 1) {
    const order = { ...fixture.target, clientOrderId: `six-tp-${index}`, exchangeOrderId: `six-remote-${index}` };
    fixture.state.orders.set(order.clientOrderId, order);
    await getDatabase().run(`INSERT INTO trading_orders (id, intent_id, account_id, client_order_id, exchange_order_id, provider_symbol,
      role, side, order_type, status, quantity, filled_quantity, price, reduce_only, request_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'BTCUSDT', 'take_profit', 'sell', 'limit', 'open', '1', '0', '120', 1, '{}', 1, 1)`,
    [order.clientOrderId, fixture.id, fixture.id, order.clientOrderId, order.exchangeOrderId]);
  }
  const engine = new TradingEngine([fixture.adapter]);
  await assert.rejects(engine.reconcileAccount(fixture.id), /requires another fresh reconciliation/);
  assert.equal(fixture.state.cancelCalls.length, 5, 'One account pass never starts another five-cancel series.');
  await engine.reconcileAccount(fixture.id);
  assert.equal(fixture.state.cancelCalls.length, 6);
  assert.equal((await getDatabase().get('SELECT status FROM trading_positions WHERE id = ?', [fixture.id])).status, 'closed');
}
async function independentStopProof() {
  const fixture = await emergencyFixture('replacement-proof', { partial: true, localQuantity: '1' });
  await persistCorrelatedFill(fixture.account, fixture.state.fills[0]);
  const target = await loadCancelOrder(fixture.id, `${fixture.id}-stop`);
  await assert.rejects(assertExitCancellationSafe(fixture.account, target, await fixture.adapter.openState()), /independent replacement/);
  const replacement = { ...fixture.state.orders.get(target.client_order_id), clientOrderId: 'independent-stop', exchangeOrderId: 'independent-remote' };
  fixture.state.orders.set(replacement.clientOrderId, replacement);
  await getDatabase().run(`INSERT INTO trading_orders (id, intent_id, account_id, client_order_id, exchange_order_id, provider_symbol,
    role, side, order_type, status, quantity, filled_quantity, trigger_price, reduce_only, request_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'BTCUSDT', 'stop_loss', 'sell', 'stop_market', 'open', '2', '0', '90', 1, '{}', 1, 1)`,
  [replacement.clientOrderId, fixture.id, fixture.id, replacement.clientOrderId, replacement.exchangeOrderId]);
  await assertExitCancellationSafe(fixture.account, target, await fixture.adapter.openState());
  await getDatabase().run("UPDATE trading_orders SET status = 'cancel_pending' WHERE id = ?", [replacement.clientOrderId]);
  await assert.rejects(assertExitCancellationSafe(fixture.account, target, await fixture.adapter.openState()), /independent replacement/,
    'A still-active replacement with a pending cancel is not lasting protection.');
  await getDatabase().run("UPDATE trading_orders SET status = 'open', quantity = '1' WHERE id = ?", [replacement.clientOrderId]);
  replacement.quantity = '1';
  await assert.rejects(assertExitCancellationSafe(fixture.account, target, await fixture.adapter.openState()), /independent replacement/,
    'Replacement must cover current exposure plus the remaining entry, not exposure alone.');
}
try {
  await initDb(file); await seedTradingFixtures();
  for (const phase of ['prepared', 'dispatching', 'unresolved']) await resumedClosure(phase);
  await blockedClosure('absent', (state, fixture) => { state.orders = state.orders.filter(order => order.clientOrderId !== fixture.target.clientOrderId); });
  await blockedClosure('old', state => { state.acquisition.startedAt -= 10_001; });
  await blockedClosure('unknown-fill', (state, fixture) => { state.orders.find(order => order.clientOrderId === fixture.target.clientOrderId).filledQuantity = null; });
  await blockedClosure('too-soon', async (_state, fixture) => {
    await getDatabase().run('UPDATE trading_operations SET updated_at = ? WHERE id = ?', [Date.now(), fixture.operation]);
  });
  await blockedClosure('changed-request', async (_state, fixture) => {
    await getDatabase().run('UPDATE trading_operations SET request_json = ? WHERE id = ?', ['{"clientOrderId":"foreign"}', fixture.operation]);
  });
  await sharedPassBudget();
  await independentStopProof();
  console.log('Exit cancel recovery: prepared/dispatching/unknown restart, absence, freshness and retry interval passed.');
} finally { await closeDb(); await rm(directory, { recursive: true, force: true }); }
