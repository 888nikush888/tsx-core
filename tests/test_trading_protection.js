import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { TradingEngine } from '../src/trading_engine.js';
import { createTradingIntent, getTradingAccount, getTradingIntent, getTradingOperationalSnapshot,
  listTradingStrategies, setTradingRoute, updateTradingRuntimeState } from '../src/trading_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { validateSignalXml } from '../src/signal_schema.js';
import { subtractDecimal } from '../src/trading_decimal.js';
import { protectiveStopCoverage, requiredStopQuantity } from '../src/trading_protection.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'trading-protection-'));
const xml = '<signal><action>LONG</action><pair>ETHUSDT</pair><entry_range><min>3000</min><max>3100</max></entry_range><targets><target id="1">3200</target><target id="2">3300</target></targets><stoploss>2900</stoploss></signal>';
const market = { symbol: 'ETHUSDT', markPrice: '3000', priceTick: '0.1', quantityStep: '0.001',
  minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 25 };
async function setup(name) {
  await initDb(path.join(directory, `${name}.db`));
  await seedTradingFixtures();
  const account = await getTradingAccount('paper-default');
  const [strategy] = await listTradingStrategies();
  await setTradingRoute({ channelId: '-protection', strategyVersionId: strategy.id, accountId: account.id, enabled: true });
  await updateTradingRuntimeState({ executionEnabled: true });
  const paper = new PaperExchangeAdapter({ maximumFillQuantity: '0.1', reduceOnlyRemainder: 'retain' });
  await paper.setMarket(account.id, market);
  await saveSignal(name, '-protection', 1, xml, xml);
  const intent = await createTradingIntent({ sourceSignalId: name, channelId: '-protection', signal: validateSignalXml(xml).execution });
  const engine = new TradingEngine([paper]);
  await engine.processIntent(intent.id);
  assert.equal((await getTradingIntent(intent.id)).status, 'monitoring');
  return { account, paper, engine, intent };
}

function proofTables() {
  const need = { accountId: 'account', intentId: 'intent', symbol: 'BTCUSDT', side: 'LONG', quantity: '0.7', minimumTrigger: '90' };
  const order = { ...need, clientOrderId: 'client', exchangeOrderId: 'exchange', role: 'stop_loss', side: 'sell',
    status: 'partially_filled', quantity: '1', filledQuantity: '0.3', triggerPrice: '90', reduceOnly: true };
  assert.deepEqual(protectiveStopCoverage(order, need), { protected: true, remainingQuantity: '0.7', reason: null });
  for (const [patch, reason] of [
    [{ accountId: 'foreign' }, 'STOP_BINDING_MISMATCH'], [{ intentId: 'foreign' }, 'STOP_BINDING_MISMATCH'],
    [{ symbol: 'ETHUSDT' }, 'STOP_BINDING_MISMATCH'], [{ clientOrderId: null }, 'STOP_BINDING_MISMATCH'],
    [{ exchangeOrderId: null }, 'STOP_BINDING_MISMATCH'], [{ side: 'buy' }, 'STOP_SEMANTICS_INVALID'],
    [{ reduceOnly: false }, 'STOP_SEMANTICS_INVALID'], [{ role: 'take_profit' }, 'STOP_SEMANTICS_INVALID'],
    [{ filledQuantity: null }, 'STOP_QUANTITY_UNKNOWN'], [{ filledQuantity: '0.4' }, 'STOP_REMAINING_INSUFFICIENT'],
    [{ filledQuantity: '1' }, 'STOP_EXHAUSTED'], [{ filledQuantity: '1.1' }, 'STOP_EVIDENCE_INVALID'],
    [{ quantity: '0' }, 'STOP_EVIDENCE_INVALID'], [{ triggerPrice: null }, 'STOP_EVIDENCE_INVALID'],
    [{ triggerPrice: '0' }, 'STOP_EVIDENCE_INVALID'], [{ triggerPrice: '89' }, 'STOP_TRIGGER_TOO_LOOSE'],
    ...['created', 'submitting', 'unknown', 'cancel_pending', 'filled', 'cancelled', 'rejected'].map(status => [{ status }, 'STOP_NOT_ACTIVE']),
  ]) assert.equal(protectiveStopCoverage({ ...order, ...patch }, need).reason, reason, JSON.stringify(patch));
  assert.equal(protectiveStopCoverage({ ...order, triggerPrice: '91' }, need).protected, true);
  assert.equal(protectiveStopCoverage({ ...order, side: 'buy', triggerPrice: '89' }, { ...need, side: 'SHORT' }).protected, true);
  assert.equal(protectiveStopCoverage({ ...order, side: 'buy', triggerPrice: '91' }, { ...need, side: 'SHORT' }).reason, 'STOP_TRIGGER_TOO_LOOSE');
  for (const status of ['created', 'open', 'partially_filled', 'submitting', 'cancel_pending', 'unknown']) {
    assert.equal(requiredStopQuantity('0.1', [{ status, quantity: '0.327', filledQuantity: '0.2' }]), '0.227', status);
  }
  assert.equal(requiredStopQuantity('0.1', [{ status: 'cancelled', quantity: '0.327', filledQuantity: '0.2' }]), '0.1');
  assert.throws(() => requiredStopQuantity('0.1', [{ status: 'unknown', quantity: '1', filledQuantity: null }]), /not proved/);
}

try {
  proofTables();
  const { account, paper, engine, intent } = await setup('partial-stop');
  await paper.setMarket(account.id, { ...market, markPrice: '2890' });
  const before = await paper.openState(account);
  const stop = before.orders.find(order => order.role === 'stop_loss');
  assert.equal(stop.status, 'partially_filled');
  assert.equal(stop.filledQuantity, '0.1');
  await engine.reconcileAccount(account.id);
  const after = await paper.openState(account);
  assert.equal(after.orders.filter(order => order.role === 'stop_loss').length, 1,
    'A partially filled stop covers the current position plus possible late entry fills; no duplicate stop or cancellation.');
  assert.equal(after.orders.find(order => order.clientOrderId === stop.clientOrderId).status, 'partially_filled');
  assert.equal((await getTradingOperationalSnapshot()).unprotectedPositions, 0,
    'Monitoring and execution must agree about sufficient partially filled stop coverage.');
  const entry = before.orders.find(order => order.role === 'entry');
  assert.equal(subtractDecimal(stop.quantity, stop.filledQuantity), '0.227');
  assert.equal(subtractDecimal(entry.quantity, entry.filledQuantity), '0.127');
  assert.equal((await getDatabase().get('SELECT quantity FROM trading_positions WHERE intent_id = ?', [intent.id])).quantity, '0.1');
  assert.equal((await getTradingAccount(account.id)).killSwitchActive, false);
  for (const [column, invalid, original] of [['side', 'buy', 'sell'], ['reduce_only', 0, 1],
    ['trigger_price', '2800', '2900'], ['filled_quantity', '0.3', '0.1']]) {
    // Columns are fixed test constants, never runtime input.
    await getDatabase().run(`UPDATE trading_orders SET ${column} = ? WHERE client_order_id = ?`, [invalid, stop.clientOrderId]);
    assert.equal((await getTradingOperationalSnapshot()).unprotectedPositions, 1, `Monitoring must reject ${column}.`);
    await getDatabase().run(`UPDATE trading_orders SET ${column} = ? WHERE client_order_id = ?`, [original, stop.clientOrderId]);
  }
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  await closeDb();

  const replacement = await setup('partial-replacement');
  const original = (await replacement.paper.openState(replacement.account)).orders.find(order => order.role === 'stop_loss');
  await replacement.paper.cancelOrder(replacement.account, original.clientOrderId);
  await replacement.paper.setMarket(replacement.account.id, { ...market, markPrice: '2890' });
  await replacement.engine.reconcileAccount(replacement.account.id);
  const stops = (await replacement.paper.openState(replacement.account)).orders.filter(order => order.role === 'stop_loss');
  assert.equal(stops.length, 2);
  assert.equal(stops.find(order => order.clientOrderId !== original.clientOrderId).status, 'partially_filled');
  assert.equal((await getTradingAccount(replacement.account.id)).killSwitchActive, false,
    'A proved partially executed replacement triggers a fresh quantity read, not a false emergency.');
  assert.equal((await getTradingOperationalSnapshot()).unprotectedPositions, 0);
  await replacement.engine.reconcileAccount(replacement.account.id);
  assert.equal((await replacement.paper.openState(replacement.account)).orders.filter(order => order.role === 'stop_loss').length, 2);
  await closeDb();

  const safer = await setup('no-loosening');
  const oldStop = (await safer.paper.openState(safer.account)).orders.find(order => order.role === 'stop_loss');
  await safer.paper.cancelOrder(safer.account, oldStop.clientOrderId);
  await getDatabase().run('UPDATE trading_positions SET stop_price = ? WHERE intent_id = ?', ['2950', safer.intent.id]);
  await safer.engine.reconcileAccount(safer.account.id);
  assert.equal((await safer.paper.openState(safer.account)).orders.find(order => order.role === 'stop_loss' && order.status === 'open').triggerPrice,
    '2950', 'A missing/consumed stop must not reset a previously tightened trigger to the original signal stop.');
  console.log('Shared partial-stop remaining quantity and operational coverage tests passed.');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
