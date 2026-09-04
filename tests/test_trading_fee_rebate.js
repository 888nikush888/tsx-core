import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { TradingEngine } from '../src/trading_engine.js';
import { createTradingIntent, getTradingIntent, listTradingStrategies, setTradingRoute, updateTradingRuntimeState } from '../src/trading_repository.js';
import { validateSignalXml } from '../src/signal_schema.js';
import { seedTradingFixtures } from './trading_fixtures.js';

class RebatePaper extends PaperExchangeAdapter {
  async openState(account, recovery) {
    const state = await super.openState(account, recovery);
    const entries = new Set(state.orders.filter(order => order.role === 'entry').map(order => order.exchangeOrderId));
    state.fills = state.fills.map(fill => entries.has(fill.exchangeOrderId) ? { ...fill, fee: '-0.125', feeAsset: 'USDT' } : fill);
    return state;
  }
}

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-fee-rebate-'));
try {
  await initDb(path.join(directory, 'test.db'));
  await seedTradingFixtures();
  const [strategy] = await listTradingStrategies();
  await setTradingRoute({ channelId: '-rebate', strategyVersionId: strategy.id, accountId: 'paper-default', enabled: true });
  await updateTradingRuntimeState({ executionEnabled: true });
  const paper = new RebatePaper();
  const market = { symbol: 'BTCUSDT', markPrice: '60000', priceTick: '0.1', quantityStep: '0.001', minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 50 };
  await paper.setMarket('paper-default', market);
  const xml = '<signal><action>LONG</action><pair>BTCUSDT</pair><entry_range><min>60000</min><max>61000</max></entry_range><targets><target id="1">62000</target><target id="2">63000</target></targets><stoploss>59000</stoploss><leverage>3</leverage></signal>';
  await saveSignal('rebate', '-rebate', 1, xml, xml);
  const intent = await createTradingIntent({ sourceSignalId: 'rebate', channelId: '-rebate', signal: validateSignalXml(xml, 'default').execution });
  const engine = new TradingEngine([paper]);
  await engine.processIntent(intent.id);
  assert.equal((await getTradingIntent(intent.id)).status, 'monitoring', JSON.stringify({ intent: await getTradingIntent(intent.id),
    accounting: await getDatabase().all('SELECT * FROM trading_accounting_projections') }));
  assert.equal((await getDatabase().get("SELECT COUNT(*) AS n FROM trading_money_events WHERE kind = 'fee' AND intent_id = ?", [intent.id])).n, 1,
    'A fee/rebate must be posted while the trade is still open, not only at final close.');
  await paper.setMarket('paper-default', { ...market, markPrice: '58000' });
  await engine.reconcileAccount('paper-default');
  assert.equal((await getTradingIntent(intent.id)).status, 'completed', 'A negative fee rebate must not break terminal reconciliation.');
  assert.equal((await getDatabase().get('SELECT realized_pnl FROM trading_positions WHERE intent_id = ?', [intent.id])).realized_pnl, '-39.875');
  await engine.reconcileAccount('paper-default');
  assert.equal((await getDatabase().get('SELECT realized_pnl FROM trading_positions WHERE intent_id = ?', [intent.id])).realized_pnl, '-39.875');
  console.log('Engine fee rebate remains signed exactly once through close and replay.');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
