import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb } from '../src/db.js';
import { listTradingAccounts } from '../src/trading_repository.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { createEntryPriceBoundary } from '../src/trading_risk.js';
import { seedTradingFixtures } from './trading_fixtures.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'paper-bounded-ioc-'));
try {
  await initDb(path.join(directory, 'fixture.db'));
  await seedTradingFixtures();
  const [account] = await listTradingAccounts();
  const paper = new PaperExchangeAdapter({ maximumFillQuantity: '0.5' });
  const market = { symbol: 'BTCUSDT', markPrice: '101', priceTick: '0.1', quantityStep: '0.1', minimumQuantity: '0.1', minimumNotional: '1', maxLeverage: 10 };
  await paper.setMarket(account.id, market);
  const entryPriceBoundary = createEntryPriceBoundary({ side: 'LONG', referencePrice: '100', priceTick: '0.1', maxSlippagePercent: '0.5' });
  const entry = { accountId: account.id, symbol: market.symbol, clientOrderId: 'ioc-no-fill', role: 'entry', side: 'buy',
    orderType: 'limit', timeInForce: 'IOC', price: '100.5', quantity: '2', triggerPrice: null, reduceOnly: false,
    postOnly: false, targetIndex: null, leverage: 10, timeoutSeconds: 10, entryPriceBoundary };
  const empty = await paper.submitOrder(account, entry);
  assert.equal(empty.status, 'cancelled');
  assert.equal(empty.filledQuantity, '0');
  await paper.setMarket(account.id, { ...market, markPrice: '100.2' });
  const partial = await paper.submitOrder(account, { ...entry, clientOrderId: 'ioc-partial' });
  assert.equal(partial.status, 'cancelled');
  assert.equal(partial.filledQuantity, '0.5');
  assert.equal(partial.averagePrice, '100.2');
  await paper.setMarket(account.id, { ...market, markPrice: '100' });
  const repeated = await paper.submitOrder(account, { ...entry, clientOrderId: 'ioc-partial' });
  assert.equal(repeated.filledQuantity, '0.5', 'IOC remainder must not chase or fill later.');
  await assert.rejects(paper.submitOrder(account, { ...entry, clientOrderId: 'bad-boundary', price: '100.6' }), /bound|price/i);
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
console.log('Paper bounded IOC no-fill, partial-fill, no-later-fill and price-fence tests passed.');
