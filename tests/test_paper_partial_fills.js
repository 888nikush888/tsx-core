import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb } from '../src/db.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { getTradingAccount } from '../src/trading_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'paper-partial-'));
const market = { symbol: 'BTCUSDT', markPrice: '100', priceTick: '0.1', quantityStep: '0.1',
  minimumQuantity: '0.1', minimumNotional: '1', maxLeverage: 10 };
const request = { clientOrderId: 'entry', symbol: 'BTCUSDT', role: 'entry', side: 'buy', orderType: 'market',
  quantity: '1', price: null, triggerPrice: null, reduceOnly: false, postOnly: false, targetIndex: null, leverage: 1 };

try {
  await initDb(path.join(directory, 'clipped.db'));
  await seedTradingFixtures();
  let account = await getTradingAccount('paper-default');
  let paper = new PaperExchangeAdapter();
  await paper.setMarket(account.id, market);
  await paper.submitOrder(account, request);
  const clipped = await paper.submitOrder(account, { ...request, clientOrderId: 'clipped', role: 'flatten',
    side: 'sell', reduceOnly: true, quantity: '2' });
  assert.equal(clipped.filledQuantity, '1');
  assert.equal(clipped.status, 'cancelled', 'The default flat-position policy cancels the unfilled remainder; it must not invent a full fill.');
  assert.equal((await paper.openState(account)).positions.length, 0);
  await closeDb();

  await initDb(path.join(directory, 'partial.db'));
  await seedTradingFixtures();
  account = await getTradingAccount('paper-default');
  paper = new PaperExchangeAdapter({ maximumFillQuantity: '0.4', reduceOnlyRemainder: 'retain' });
  await paper.setMarket(account.id, market);
  let entry = await paper.submitOrder(account, request);
  assert.equal(entry.status, 'partially_filled');
  assert.equal(entry.filledQuantity, '0.4');
  await paper.setMarket(account.id, { ...market, markPrice: '110' });
  entry = (await paper.openState(account)).orders.find(order => order.clientOrderId === 'entry');
  assert.equal(entry.filledQuantity, '0.8');
  assert.equal(entry.averagePrice, '105', 'Partial-fill VWAP is cumulative, not the last fill price.');
  await paper.setMarket(account.id, { ...market, markPrice: '120' });
  entry = (await paper.openState(account)).orders.find(order => order.clientOrderId === 'entry');
  assert.equal(entry.status, 'filled');
  assert.equal(entry.filledQuantity, '1');
  assert.equal(entry.averagePrice, '108');
  assert.equal((await paper.accountSnapshot(account)).unrealizedPnl, '12');
  assert.equal((await paper.accountSnapshot(account)).equity, '10012');
  assert.equal((await paper.accountSnapshot(account)).marginUsed, '108');
  assert.equal((await paper.accountSnapshot(account)).availableBalance, '9904');
  assert.equal((await paper.openState(account)).positions[0].unrealizedPnl, '12');
  assert.deepEqual((await paper.openState(account)).fills.map(fill => fill.quantity), ['0.4', '0.4', '0.2']);

  const stopRequest = { ...request, clientOrderId: 'stop', role: 'stop_loss', side: 'sell',
    orderType: 'stop_market', triggerPrice: '90', reduceOnly: true, quantity: '2' };
  await paper.submitOrder(account, stopRequest);
  await paper.setMarket(account.id, { ...market, markPrice: '90' });
  let stop = (await paper.openState(account)).orders.find(order => order.clientOrderId === 'stop');
  assert.equal(stop.status, 'partially_filled');
  assert.equal(stop.filledQuantity, '0.4');
  assert.equal((await paper.openState(account)).positions[0].quantity, '0.6');
  await closeDb();
  await initDb(path.join(directory, 'partial.db'));
  paper = new PaperExchangeAdapter({ maximumFillQuantity: '0.4', reduceOnlyRemainder: 'retain' });
  await paper.setMarket(account.id, { ...market, markPrice: '95' });
  stop = (await paper.openState(account)).orders.find(order => order.clientOrderId === 'stop');
  assert.equal(stop.filledQuantity, '0.8', 'An already triggered partially filled stop stays executable after a price rebound and restart.');
  await paper.setMarket(account.id, { ...market, markPrice: '96' });
  stop = (await paper.openState(account)).orders.find(order => order.clientOrderId === 'stop');
  assert.equal(stop.status, 'partially_filled', 'Explicit retain policy models a still-active reduce-only remainder after the position reaches zero.');
  assert.equal(stop.filledQuantity, '1');
  await paper.setMarket(account.id, market);
  assert.equal((await paper.openState(account)).fills.length, 6, 'Zero remaining exposure must never create fake fills.');
  assert.equal((await paper.submitOrder(account, stopRequest)).filledQuantity, '1', 'An idempotent submit cannot fill the same quantity twice.');
  const cancelled = await paper.cancelOrder(account, 'stop');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.filledQuantity, '1');
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  console.log('Paper cumulative partial fills, triggered stops, restart, clipping and remainder policies passed.');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
