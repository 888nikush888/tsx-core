import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb } from '../src/db.js';
import { getTradingAccount } from '../src/trading_repository.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { seedTradingFixtures } from './trading_fixtures.js';
const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-paper-current-money-'));
const market = { symbol: 'BTCUSDT', markPrice: '100', priceTick: '0.1', quantityStep: '1', minimumQuantity: '1', minimumNotional: '1', maxLeverage: 10 };
try {
  for (const [side, losing, winning] of [['buy', '95', '110'], ['sell', '105', '90']]) {
    const filename = path.join(directory, `${side}.db`);
    await initDb(filename); await seedTradingFixtures();
    const account = await getTradingAccount('paper-default'); const paper = new PaperExchangeAdapter();
    await paper.setMarket(account.id, market);
    await paper.submitOrder(account, { clientOrderId: `entry-${side}`, symbol: market.symbol, role: 'entry', side, orderType: 'market',
      quantity: '2', price: null, triggerPrice: null, reduceOnly: false, postOnly: false, targetIndex: null, leverage: 1 });
    for (const [markPrice, upl, equity, free] of [[losing, '-10', '9990', '9790'], [winning, '20', '10020', '9820']]) {
      await paper.setMarket(account.id, { ...market, markPrice });
      const snapshot = await paper.accountSnapshot(account);
      assert.equal(snapshot.unrealizedPnl, upl); assert.equal(snapshot.equity, equity);
      assert.equal(snapshot.availableBalance, free); assert.equal(snapshot.marginUsed, '200');
      assert.equal((await paper.openState(account)).positions[0].unrealizedPnl, upl);
    }
    await closeDb(); await initDb(filename);
    assert.equal((await paper.accountSnapshot(account)).unrealizedPnl, '20');
    await getDatabase().run('DELETE FROM trading_paper_markets WHERE account_id = ? AND symbol = ?', [account.id, market.symbol]);
    assert.equal((await paper.openState(account)).positions[0].unrealizedPnl, null);
    await assert.rejects(paper.accountSnapshot(account), /mark is missing/);
    if (side === 'sell') {
      await paper.setMarket(account.id, { ...market, markPrice: '10000' });
      await assert.rejects(paper.accountSnapshot(account), /nonpositive/);
      assert.equal((await paper.openState(account)).positions[0].unrealizedPnl, '-19800', 'Nonpositive equity is never fabricated into a safe value.');
    }
    await closeDb();
  }
  console.log('Paper current mark PnL/equity/free balance, unchanged actual margin, both sides, unknown mark and restart passed.');
} finally { await closeDb(); await rm(directory, { recursive: true, force: true }); }
