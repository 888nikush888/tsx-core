import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { TradingEngine } from '../src/trading_engine.js';
import { createTradingIntent, getTradingAccount, getTradingIntent, listTradingStrategies,
  setTradingRoute, updateTradingRuntimeState } from '../src/trading_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { validateSignalXml } from '../src/signal_schema.js';
import { addDecimal, subtractDecimal } from '../src/trading_decimal.js';
import { completedTargetEvidence, resizeTargetTotals } from '../src/trading_take_profit.js';
import { recoverPreparedExits } from '../src/trading_recovery.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'trading-tp-'));
const market = { symbol: 'ETHUSDT', markPrice: '3000', priceTick: '0.1', quantityStep: '0.001',
  minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 25 };
const xml = '<signal><action>LONG</action><pair>ETHUSDT</pair><entry_range><min>3000</min><max>3100</max></entry_range><targets><target id="1">3200</target><target id="2">3300</target></targets><stoploss>2900</stoploss></signal>';
async function setup(name, options = {}) {
  const file = path.join(directory, `${name}.db`);
  await initDb(file);
  await seedTradingFixtures();
  const account = await getTradingAccount('paper-default');
  const [strategy] = await listTradingStrategies();
  await setTradingRoute({ channelId: '-tp', strategyVersionId: strategy.id, accountId: account.id, enabled: true });
  await updateTradingRuntimeState({ executionEnabled: true });
  const paper = new PaperExchangeAdapter(options);
  await paper.setMarket(account.id, market);
  await saveSignal(name, '-tp', 1, xml, xml);
  const intent = await createTradingIntent({ sourceSignalId: name, channelId: '-tp', signal: validateSignalXml(xml).execution });
  const engine = new TradingEngine([paper]);
  await engine.processIntent(intent.id);
  assert.equal((await getTradingIntent(intent.id)).status, 'monitoring');
  return { file, account, intent, paper, engine };
}
function activeTargets(state) {
  return state.orders.filter(order => order.role === 'take_profit' && ['open', 'partially_filled'].includes(order.status));
}
function quantity(orders) {
  return orders.reduce((total, order) => addDecimal(total, subtractDecimal(order.quantity, order.filledQuantity)), '0');
}

async function undersizeTarget(context) {
  const target = activeTargets(await context.paper.openState(context.account))[0];
  for (const table of ['trading_orders', 'trading_paper_orders']) {
    await getDatabase().run(`UPDATE ${table} SET quantity = '0.08' WHERE client_order_id = ?`, [target.clientOrderId]);
  }
  return target.clientOrderId;
}

function tracedAdapter(paper, hooks = {}) {
  const events = [];
  const adapter = { exchange: 'paper' };
  for (const method of ['openState', 'submitOrder', 'cancelOrder', 'marketSnapshot', 'accountSnapshot']) {
    adapter[method] = async (...args) => {
      events.push({ method, order: args[1] });
      return hooks[method] ? hooks[method](...args) : paper[method](...args);
    };
  }
  return { adapter, events };
}

async function settle(engine, accountId) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { await engine.reconcileAccount(accountId); return; } catch (error) {
      if (!/requires another fresh reconciliation/.test(error.message)) throw error;
    }
  }
  throw new Error('Bounded reconciliation did not settle in five cycles.');
}

async function proveCancelFillRace() {
  const context = await setup('cancel-fill');
  const staleId = await undersizeTarget(context);
  let raced = false;
  const { adapter, events } = tracedAdapter(context.paper, {
    cancelOrder: async (account, clientId) => {
      if (!raced && clientId === staleId) {
        raced = true;
        await context.paper.setMarket(account.id, { ...market, markPrice: '3200' });
        await context.paper.setMarket(account.id, market);
      }
      return context.paper.cancelOrder(account, clientId);
    },
  });
  await settle(new TradingEngine([adapter]), context.account.id);
  assert.equal(raced, true);
  const cancelIndex = events.findIndex(event => event.method === 'cancelOrder' && event.order === staleId);
  const nextSubmit = events.findIndex((event, index) => index > cancelIndex && event.method === 'submitOrder');
  assert.ok(events.slice(cancelIndex + 1, nextSubmit).some(event => event.method === 'openState'),
    'No replacement, including another target, may precede post-cancel account evidence.');
  const state = await context.paper.openState(context.account);
  assert.equal(state.positions[0].quantity, '0.247');
  assert.equal(quantity(activeTargets(state)), '0.247');
  assert.equal((await getTradingAccount(context.account.id)).killSwitchActive, false,
    'Needing a further bounded evidence pass is not a hard safety incident after a successful, proved cancellation.');
  assert.equal(state.orders.find(order => order.clientOrderId === staleId).filledQuantity, '0.08');
  assert.deepEqual(await getDatabase().all('SELECT quantity FROM trading_fills WHERE order_id IN (SELECT id FROM trading_orders WHERE client_order_id = ?)', [staleId]), [{ quantity: '0.08' }]);
  await closeDb();
}

async function proveUnknownCancel() {
  const context = await setup('unknown-cancel');
  const staleId = await undersizeTarget(context);
  const { adapter, events } = tracedAdapter(context.paper, {
    cancelOrder: async (account, clientId) => ({ ...await context.paper.cancelOrder(account, clientId), filledQuantity: null }),
  });
  await assert.rejects(new TradingEngine([adapter]).reconcileAccount(context.account.id), /decimal|cancel|quantity/i);
  assert.equal(events.filter(event => event.method === 'submitOrder').length, 0,
    'An incomplete cancel acknowledgement cannot authorize a replacement.');
  assert.equal((await getDatabase().get("SELECT phase FROM trading_operations WHERE kind = 'cancel' ORDER BY created_at DESC LIMIT 1")).phase, 'unresolved');
  await closeDb();
  await initDb(context.file);
  await settle(new TradingEngine([new PaperExchangeAdapter()]), context.account.id);
  const orders = activeTargets(await context.paper.openState(context.account));
  assert.equal(orders.length, 2);
  assert.ok(orders.every(order => order.clientOrderId !== staleId));
  assert.equal(quantity(orders), '0.327');
  await closeDb();
}

async function proveStopIndependentOfTargetFailure() {
  const context = await setup('tp-failure-stop');
  const stop = (await context.paper.openState(context.account)).orders.find(order => order.role === 'stop_loss' && order.status === 'open');
  await context.paper.cancelOrder(context.account, stop.clientOrderId);
  await getDatabase().run('UPDATE trading_take_profit_allocations SET plan_hash = ? WHERE intent_id = ?', ['0'.repeat(64), context.intent.id]);
  await assert.rejects(context.engine.reconcileAccount(context.account.id), /immutable trade plan/);
  const state = await context.paper.openState(context.account);
  assert.equal(state.orders.filter(order => order.role === 'stop_loss' && order.status === 'open').length, 1,
    'Broken TP metadata must not prevent independent restoration of a proved owned protective stop.');
  assert.equal((await getTradingAccount(context.account.id)).killSwitchActive, true);
  await closeDb();
}

async function proveAmbiguousLegacyReview() {
  const context = await setup('legacy-review');
  const state = await context.paper.openState(context.account);
  const target = activeTargets(state)[0];
  const stop = state.orders.find(order => order.role === 'stop_loss' && order.status === 'open');
  await context.paper.cancelOrder(context.account, target.clientOrderId);
  await context.paper.cancelOrder(context.account, stop.clientOrderId);
  await getDatabase().run('DELETE FROM trading_take_profit_allocations WHERE intent_id = ?', [context.intent.id]);
  const { adapter, events } = tracedAdapter(context.paper);
  const engine = new TradingEngine([adapter]);
  await assert.rejects(engine.reconcileAccount(context.account.id), /TP_ALLOCATION_REVIEW_REQUIRED/);
  assert.equal(events.filter(event => event.method === 'submitOrder' && event.order.role === 'take_profit').length, 0,
    'An ambiguous cancelled legacy target must not be recreated using guessed original quotas.');
  const protectedState = await context.paper.openState(context.account);
  assert.equal(protectedState.orders.filter(order => order.role === 'stop_loss' && order.status === 'open').length, 1,
    'Legacy review never blocks independent restoration of the proved own stop.');
  assert.equal((await getTradingAccount(context.account.id)).killSwitchActive, true);
  assert.equal(await getDatabase().get('SELECT intent_id FROM trading_take_profit_allocations WHERE intent_id = ?', [context.intent.id]), undefined);
  assert.equal((await getDatabase().get("SELECT COUNT(*) AS n FROM trading_risk_events WHERE code = 'TP_ALLOCATION_RECOVERED' AND intent_id = ?", [context.intent.id])).n, 0);
  await closeDb();
  await initDb(context.file);
  await assert.rejects(new TradingEngine([new PaperExchangeAdapter()]).reconcileAccount(context.account.id), /TP_ALLOCATION_REVIEW_REQUIRED/);
  assert.equal((await context.paper.openState(context.account)).fills.length, protectedState.fills.length,
    'A restart does not turn review into a new economic execution.');
  await closeDb();
}

async function proveActiveLegacyRecovery() {
  const context = await setup('legacy-active');
  const before = activeTargets(await context.paper.openState(context.account));
  await getDatabase().run('DELETE FROM trading_take_profit_allocations WHERE intent_id = ?', [context.intent.id]);
  await settle(new TradingEngine([context.paper]), context.account.id);
  const after = activeTargets(await context.paper.openState(context.account));
  assert.deepEqual(after.map(row => [row.clientOrderId, row.quantity]), before.map(row => [row.clientOrderId, row.quantity]));
  const evidence = await getDatabase().get("SELECT details_json FROM trading_risk_events WHERE code = 'TP_ALLOCATION_RECOVERED' AND intent_id = ?", [context.intent.id]);
  assert.equal(JSON.parse(evidence.details_json).source, 'exact_target_generations');
  await settle(new TradingEngine([context.paper]), context.account.id);
  assert.equal((await getDatabase().get("SELECT COUNT(*) AS n FROM trading_risk_events WHERE code = 'TP_ALLOCATION_RECOVERED' AND intent_id = ?", [context.intent.id])).n, 1);
  await closeDb();
}

function allocationTables() {
  assert.deepEqual(resizeTargetTotals(['0.5', '0.5'], ['0', '0'], '0.8', '0.1').totals, ['0.4', '0.4']);
  assert.deepEqual(resizeTargetTotals(['0.4', '0.4'], ['0.4', '0'], '0.3', '0.1').remaining, ['0', '0.3'], 'Completed resized target never replenishes.');
  assert.deepEqual(resizeTargetTotals(['0.5', '0.5', '0.5'], ['0', '0', '0'], '1.4', '0.1').remaining, ['0.4', '0.5', '0.5'], 'Rounding may not increase the last target on shrink.');
  assert.deepEqual(resizeTargetTotals(['0.4', '0.4'], ['0.5', '0'], '0.3', '0.1').remaining, ['0', '0.3'], 'A raced fill beyond its new budget reduces other outstanding targets.');
  assert.equal(resizeTargetTotals(['0.5', '0.5'], ['0', '0'], '0.0001', '0.001').unallocatedQuantity, '0.0001');
  assert.throws(() => resizeTargetTotals(['0.5'], ['0.5'], '0.1', '0.1'), /EXHAUSTED/);
  assert.deepEqual(completedTargetEvidence(['0.4'], ['0.1'], [false], ['0.4']), [true]);
  assert.deepEqual(completedTargetEvidence(['0.1'], ['0.1'], [false], ['0.1']), [false], 'Removing a target remainder by stop/dust resizing is not proof that price target completed.');
  assert.deepEqual(completedTargetEvidence(['0.1'], ['0.1'], [true], ['0.1']), [true], 'Real completion survives replay.');
}

async function hardCrash(file, timing) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/take_profit_crash.js', file, 'paper-default', timing], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
  });
  await new Promise((resolve, reject) => {
    let output = '';
    let killed = false;
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('TP crash fixture timed out.')); }, 10_000);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (!killed && output.includes('TP_CRASH_MARKER')) { killed = true; child.kill('SIGKILL'); }
    });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', () => { clearTimeout(timeout); if (killed) resolve(); else reject(new Error(output)); });
  });
}

async function proveHardCrash(timing) {
  const context = await setup(`crash-${timing}`);
  await undersizeTarget(context);
  await closeDb();
  await hardCrash(context.file, timing);
  await initDb(context.file);
  const replacement = await getDatabase().get(`SELECT orders.* FROM trading_orders AS orders JOIN trading_order_generations AS generation
    ON orders.client_order_id = generation.client_order_id WHERE generation.intent_id = ? AND generation.slot LIKE 'take_profit:%'`, [context.intent.id]);
  assert.ok(replacement);
  assert.equal(replacement.status, timing === 'created' ? 'created' : 'submitting');
  const operation = await getDatabase().get(`SELECT * FROM trading_operations WHERE intent_id = ? AND kind = 'submit'
    AND json_extract(request_json, '$.clientOrderId') = ?`, [context.intent.id, replacement.client_order_id]);
  assert.equal(operation.phase, timing === 'accepted' ? 'dispatching' : 'prepared');
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS count FROM trading_paper_orders WHERE client_order_id = ?', [replacement.client_order_id])).count,
    timing === 'accepted' ? 1 : 0);
  if (timing === 'prepared') {
    const stored = () => getDatabase().get('SELECT status FROM trading_orders WHERE client_order_id = ?', [replacement.client_order_id]);
    await recoverPreparedExits({ ...context.account, externalAccountId: 'a'.repeat(64) }, context.intent.id, 'take_profit');
    assert.equal((await stored()).status, 'submitting', 'Different account identity cannot authorize a no-send reset.');
    for (const [column, invalid] of [['phase', 'dispatching'], ['request_hash', '0'.repeat(64)], ['expected_orders_json', '[]']]) {
      await getDatabase().run(`UPDATE trading_operations SET ${column} = ? WHERE id = ?`, [invalid, operation.id]);
      await recoverPreparedExits(context.account, context.intent.id, 'take_profit');
      assert.equal((await stored()).status, 'submitting', `Unproved ${column} cannot authorize a reset.`);
      await getDatabase().run(`UPDATE trading_operations SET ${column} = ? WHERE id = ?`, [operation[column], operation.id]);
    }
    await getDatabase().run('UPDATE trading_orders SET quantity = ? WHERE id = ?', ['0.17', replacement.id]);
    await recoverPreparedExits(context.account, context.intent.id, 'take_profit');
    assert.equal((await stored()).status, 'submitting', 'Changed order fields cannot pass the prepared request proof.');
    await getDatabase().run('UPDATE trading_orders SET quantity = ? WHERE id = ?', [replacement.quantity, replacement.id]);
  }
  await settle(new TradingEngine([new PaperExchangeAdapter()]), context.account.id);
  const targets = activeTargets(await context.paper.openState(context.account));
  assert.equal(targets.length, 2);
  assert.ok(targets.some(order => order.clientOrderId === replacement.client_order_id), 'Unchanged prepared/accepted TP keeps its durable identity after a real process death.');
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS count FROM trading_paper_orders WHERE client_order_id = ?', [replacement.client_order_id])).count, 1);
  assert.equal((await getDatabase().get("SELECT generation FROM trading_order_generations WHERE intent_id = ? AND slot LIKE 'take_profit:%'", [context.intent.id])).generation, 1);
  await closeDb();
}

try {
  allocationTables();
  const context = await setup('stop-partial', { maximumFillQuantity: '0.1', reduceOnlyRemainder: 'retain' });
  for (let tick = 0; tick < 3; tick += 1) await context.paper.setMarket(context.account.id, { ...market, markPrice: '2890' });
  await context.engine.reconcileAccount(context.account.id);
  let state = await context.paper.openState(context.account);
  assert.equal(state.positions[0].quantity, '0.027');
  assert.equal(quantity(activeTargets(state)), '0.027', 'Stop executions must reduce TP allocation; never allocate the full entry again.');
  assert.deepEqual(activeTargets(state).map(order => order.price), ['3200', '3300']);
  const targetIds = activeTargets(state).map(order => order.clientOrderId);
  await closeDb();
  await initDb(context.file);
  await new TradingEngine([new PaperExchangeAdapter()]).reconcileAccount(context.account.id);
  state = await context.paper.openState(context.account);
  assert.deepEqual(activeTargets(state).map(order => order.clientOrderId), targetIds, 'Restart keeps the same restored TP allocation and orders.');
  const partialStop = state.orders.find(order => order.role === 'stop_loss' && order.status === 'partially_filled');
  await context.paper.cancelOrder(context.account, partialStop.clientOrderId);
  await context.paper.setMarket(context.account.id, market);
  await settle(new TradingEngine([context.paper]), context.account.id);
  await context.paper.setMarket(context.account.id, { ...market, markPrice: '3200' });
  await settle(new TradingEngine([context.paper]), context.account.id);
  state = await context.paper.openState(context.account);
  assert.equal(state.orders.find(order => order.clientOrderId === targetIds[0]).status, 'filled');
  assert.equal(activeTargets(state).length, 1, 'A filled resized TP does not get topped up to the original gross allocation.');
  assert.equal(activeTargets(state)[0].price, '3300');
  assert.equal(quantity(activeTargets(state)), state.positions[0].quantity);
  await getDatabase().run('DELETE FROM trading_take_profit_allocations WHERE intent_id = ?', [context.intent.id]);
  await closeDb();
  await initDb(context.file);
  await settle(new TradingEngine([new PaperExchangeAdapter()]), context.account.id);
  const recovered = await context.paper.openState(context.account);
  assert.equal(activeTargets(recovered).length, 1, 'Legacy metadata recovery must not reopen a completed smaller target.');
  assert.equal(activeTargets(recovered)[0].clientOrderId, activeTargets(state)[0].clientOrderId);
  assert.equal(quantity(activeTargets(recovered)), recovered.positions[0].quantity);
  assert.equal(recovered.fills.length, state.fills.length, 'Legacy recovery must not introduce an accidental repeat target fill.');
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  await closeDb();
  await proveCancelFillRace();
  await proveUnknownCancel();
  await proveStopIndependentOfTargetFailure();
  await proveActiveLegacyRecovery();
  await proveAmbiguousLegacyReview();
  for (const timing of ['created', 'prepared', 'accepted']) await proveHardCrash(timing);
  console.log('Durable TP remaining allocation and cancel/fill reconciliation tests passed.');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
