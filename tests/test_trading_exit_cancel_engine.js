import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { TradingEngine } from '../src/trading_engine.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { createTradingIntent, getTradingAccount, getTradingIntent, listTradingStrategies, setTradingRoute, updateTradingRuntimeState } from '../src/trading_repository.js';
import { createGeneratedTradingOrder, persistTradingOrderResult } from '../src/trading_order_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { validateSignalXml } from '../src/signal_schema.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'exit-cancel-engine-'));
const market = { symbol: 'ETHUSDT', markPrice: '3000', priceTick: '0.1', quantityStep: '0.001', minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 25 };
async function setup(name) {
  const file = path.join(directory, `${name}.db`);
  await initDb(file); await seedTradingFixtures();
  const account = await getTradingAccount('paper-default');
  const [strategy] = await listTradingStrategies();
  await setTradingRoute({ channelId: '-exit-retry', strategyVersionId: strategy.id, accountId: account.id, enabled: true });
  await updateTradingRuntimeState({ executionEnabled: true });
  const paper = new PaperExchangeAdapter();
  await paper.setMarket(account.id, market);
  const xml = '<signal><action>LONG</action><pair>ETHUSDT</pair><entry_range><min>3000</min><max>3100</max></entry_range><targets><target id="1">3200</target><target id="2">3300</target></targets><stoploss>2900</stoploss></signal>';
  await saveSignal(name, '-exit-retry', 1, xml, xml);
  const intent = await createTradingIntent({ sourceSignalId: name, channelId: '-exit-retry', signal: validateSignalXml(xml).execution });
  await new TradingEngine([paper]).processIntent(intent.id);
  assert.equal((await getTradingIntent(intent.id)).status, 'monitoring');
  return { file, account, paper, intent: await getTradingIntent(intent.id) };
}
async function staleTarget(context) {
  const target = (await context.paper.openState(context.account)).orders.find(order => order.role === 'take_profit' && order.status === 'open');
  for (const table of ['trading_orders', 'trading_paper_orders']) {
    await getDatabase().run(`UPDATE ${table} SET quantity = '0.08' WHERE client_order_id = ?`, [target.clientOrderId]);
  }
  return target.clientOrderId;
}
async function staleStop(context) {
  const template = context.intent.plan.orders.find(order => order.role === 'stop_loss');
  const order = await createGeneratedTradingOrder(context.intent, { ...template, triggerPrice: '2800' });
  const result = await context.paper.submitOrder(context.account, { ...order, accountId: context.account.id, symbol: market.symbol, leverage: context.intent.plan.leverage });
  await persistTradingOrderResult(context.intent.id, order.clientOrderId, result);
  return order.clientOrderId;
}
async function settle(engine, accountId) {
  for (let index = 0; index < 4; index += 1) {
    try { await engine.reconcileAccount(accountId); return; } catch (error) {
      if (!/requires another fresh reconciliation/.test(error.message)) throw error;
    }
  }
  assert.fail('Exit reconciliation did not settle.');
}
async function retries(role) {
  const context = await setup(`retry-${role}`);
  const id = await (role === 'stop' ? staleStop(context) : staleTarget(context));
  const send = context.paper.cancelOrder.bind(context.paper);
  let calls = 0;
  context.paper.cancelOrder = async (account, target) => {
    if (target === id && ++calls === 1) throw new Error('simulated cancel timeout; order still active');
    return send(account, target);
  };
  await assert.rejects(new TradingEngine([context.paper]).reconcileAccount(context.account.id), /cancel|unresolved/i);
  assert.equal(calls, 1);
  await closeDb(); await initDb(context.file);
  const engine = new TradingEngine([context.paper]);
  await assert.rejects(engine.reconcileAccount(context.account.id), role === 'stop' ? /stale stop outcome is unresolved/ : /ten-second/);
  assert.equal(calls, 1, 'Immediate restart is not a cancellation retry authorization.');
  const now = Date.now;
  Date.now = () => now() + 10_001;
  try { await settle(engine, context.account.id); } finally { Date.now = now; }
  assert.equal(calls, 2, 'A later fresh active observation permits one bounded retry of the exact order.');
  const state = await context.paper.openState(context.account);
  assert.equal(state.orders.find(order => order.clientOrderId === id).status, 'cancelled');
  assert.ok(state.orders.some(order => order.role === 'stop_loss' && order.status === 'open' && order.triggerPrice === '2900'));
  await closeDb();
}
async function lateDispatchChange(kind) {
  const context = await setup(`late-${kind}`);
  const target = await staleTarget(context);
  const database = getDatabase();
  const read = database.get.bind(database);
  let changed = false;
  let calls = 0;
  context.paper.cancelOrder = async () => { calls += 1; throw new Error('must not dispatch'); };
  database.get = async (sql, ...args) => {
    const row = await read(sql, ...args);
    if (!changed && sql.includes('SELECT side, stop_price FROM trading_positions')) {
      changed = true;
      if (kind === 'binding') await database.run("UPDATE trading_accounts SET credential_generation = 'rotated' WHERE id = ?", [context.account.id]);
      else await database.run("UPDATE trading_orders SET quantity = '0.07' WHERE client_order_id = ?", [target]);
    }
    return row;
  };
  try { await assert.rejects(new TradingEngine([context.paper]).reconcileAccount(context.account.id)); }
  finally { database.get = read; }
  assert.equal(changed, true);
  assert.equal(calls, 0, `${kind} drift during final protection reads must be fenced before send.`);
  await closeDb();
}
try {
  await retries('tp'); await retries('stop'); await lateDispatchChange('binding'); await lateDispatchChange('quantity');
  console.log('TP and stale-stop retries share fresh identity/protection fences across restarts.');
} finally { await closeDb(); await rm(directory, { recursive: true, force: true }); }
