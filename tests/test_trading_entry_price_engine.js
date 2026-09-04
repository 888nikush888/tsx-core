import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDatabase, saveSignal } from '../src/db.js';
import { createTradingIntent, getTradingIntent, listTradingAccounts, listTradingStrategies,
  setTradingRoute, updateTradingRuntimeState } from '../src/trading_repository.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { TradingEngine } from '../src/trading_engine.js';
import { seedTradingFixtures } from './trading_fixtures.js';

const market = { symbol: 'BTCUSDT', markPrice: '100', priceTick: '0.1', quantityStep: '0.01',
  minimumQuantity: '0.01', minimumNotional: '1', maxLeverage: 10 };

async function fixture(file) {
  await initDb(file);
  await seedTradingFixtures();
  const [account] = await listTradingAccounts();
  const [strategy] = await listTradingStrategies();
  await setTradingRoute({ channelId: '-price-bound', accountId: account.id, strategyVersionId: strategy.id, enabled: true });
  await updateTradingRuntimeState({ executionEnabled: true });
  await saveSignal('price-bound', '-price-bound', 1, '<signal/>', '<signal/>');
  const intent = await createTradingIntent({ sourceSignalId: 'price-bound', channelId: '-price-bound', signal: {
    schema: 'standard', action: 'LONG', symbol: 'BTCUSDT', entry: { type: 'market', min: '100', max: '100' },
    targets: [{ min: '110', max: '110' }, { min: '120', max: '120' }], stopLoss: '90',
  } });
  const paper = new PaperExchangeAdapter({ maximumFillQuantity: '0.5' });
  await paper.setMarket(account.id, market);
  return { account, intent, paper, engine: new TradingEngine([paper]) };
}

async function assertTerminalPartial(file) {
  const { account, intent, paper, engine } = await fixture(file);
  await engine.processIntent(intent.id);
  const stored = await getTradingIntent(intent.id);
  assert.equal(stored.status, 'monitoring', stored.error);
  const remote = await paper.openState(account);
  const entry = remote.orders.find(order => order.role === 'entry');
  assert.equal(entry.status, 'cancelled');
  assert.equal(entry.filledQuantity, '0.5');
  assert.equal(remote.positions[0].quantity, '0.5');
  assert.ok(remote.orders.some(order => order.role === 'stop_loss' && order.status === 'open'));
  await paper.setMarket(account.id, { ...market, markPrice: '99' });
  await closeDb();
  await initDb(file);
  await new TradingEngine([paper]).processIntent(intent.id);
  const later = await paper.openState(account);
  assert.equal(later.orders.filter(order => order.role === 'entry').length, 1);
  assert.equal(later.positions[0].quantity, '0.5', 'A cancelled IOC remainder must never chase after restart.');
}

async function assertRevalidationKeepsOriginalCap(file) {
  const { account, intent, paper, engine } = await fixture(file);
  const initial = await engine.preparePendingIntent(intent);
  await paper.setMarket(account.id, { ...market, markPrice: '140' });
  await engine.processIntent(intent.id);
  const stored = await getTradingIntent(intent.id);
  assert.deepEqual(stored.plan.entryPriceBoundary, initial.plan.entryPriceBoundary);
  const remote = await paper.openState(account);
  const entry = remote.orders.find(order => order.role === 'entry');
  assert.equal(entry, undefined, 'Changed sizing/mark budget must block before dispatch, never move the original price cap.');
  assert.equal(remote.positions.length, 0);
  assert.equal(stored.status, 'blocked', stored.error);
}

async function assertFinalBoundaryFence(file) {
  const { intent, paper, engine } = await fixture(file);
  const prepare = engine.preparePendingIntent.bind(engine);
  let prepared;
  engine.preparePendingIntent = async (...args) => { prepared = await prepare(...args); return prepared; };
  const database = getDatabase();
  const run = database.run.bind(database);
  let crossed = false;
  database.run = async (...args) => {
    const result = await run(...args);
    if (String(args[0]).includes('UPDATE trading_operations SET phase = ?') && args[1][0] === 'dispatching') {
      crossed = true;
      prepared.plan.entryPriceBoundary.limitPrice = '101';
    }
    return result;
  };
  let submits = 0;
  paper.submitProtectedEntry = async () => { submits += 1; throw new Error('Boundary fence failed'); };
  try { await engine.processIntent(intent.id); } finally { database.run = run; }
  assert.equal(crossed, true);
  assert.equal(submits, 0);
  assert.equal((await getTradingIntent(intent.id)).blockReason, 'ENTRY_PRICE_BOUND_UNPROVEN');
}

const directory = await mkdtemp(path.join(os.tmpdir(), 'entry-price-engine-'));
try {
  for (const [name, run] of [['partial', assertTerminalPartial], ['jump', assertRevalidationKeepsOriginalCap], ['fence', assertFinalBoundaryFence]]) {
    await run(path.join(directory, `${name}.db`));
    await closeDb();
  }
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
console.log('Engine immutable entry cap, terminal partial IOC, restart and final dispatch fence tests passed.');
