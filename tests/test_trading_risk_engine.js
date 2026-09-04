import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { TradingEngine } from '../src/trading_engine.js';
import { createTradingIntent, getTradingAccount, getTradingIntent, listTradingStrategies, setTradingRoute, updateTradingRuntimeState } from '../src/trading_repository.js';
import { validateSignalXml } from '../src/signal_schema.js';
import { seedTradingFixtures } from './trading_fixtures.js';
class CostPaper extends PaperExchangeAdapter {
  reads = 0; cancels = 0; fundingLoss = false; eventAt = null;
  constructor() { super({ maximumFillQuantity: '1' }); }
  async accountSnapshot(account) {
    this.reads += 1;
    const snapshot = await super.accountSnapshot(account);
    if (this.fundingLoss) {
      this.eventAt ??= snapshot.accounting.funding.until;
      snapshot.fundingPnlToday = '-1';
      snapshot.accounting.funding.events = [{ id: 'post-fill-funding', timestamp: this.eventAt, amount: '-1', asset: 'USDT' }];
    }
    return snapshot;
  }
  async cancelOrder(...args) { this.cancels += 1; return super.cancelOrder(...args); }
}
const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-risk-engine-'));
try {
  await initDb(path.join(directory, 'test.db')); await seedTradingFixtures();
  const [strategy] = await listTradingStrategies(); const account = await getTradingAccount('paper-default');
  await setTradingRoute({ channelId: '-risk-engine', strategyVersionId: strategy.id, accountId: account.id, enabled: true });
  await updateTradingRuntimeState({ executionEnabled: true });
  const paper = new CostPaper();
  const market = { symbol: 'BTCUSDT', markPrice: '100', priceTick: '0.1', quantityStep: '0.1', minimumQuantity: '0.1', minimumNotional: '1', maxLeverage: 10 };
  await paper.setMarket(account.id, market);
  const xml = '<signal><action>LONG</action><pair>BTCUSDT</pair><entry_range><min>100</min><max>100</max></entry_range><targets><target id="1">110</target><target id="2">120</target></targets><stoploss>90</stoploss><leverage>1</leverage></signal>';
  await saveSignal('risk-engine-signal', '-risk-engine', 1, xml, xml);
  const intent = await createTradingIntent({ sourceSignalId: 'risk-engine-signal', channelId: '-risk-engine', signal: validateSignalXml(xml, 'default').execution });
  const engine = new TradingEngine([paper]); await engine.processIntent(intent.id);
  assert.equal((await getTradingIntent(intent.id)).status, 'monitoring');
  paper.fundingLoss = true;
  const before = paper.reads;
  await assert.rejects(engine.reconcileAccount(account.id), /Entry drain remains unresolved/);
  assert.equal(paper.reads - before, 1, 'The whole reconciliation gets one post-protection balance read, not one per intermediate pass.');
  assert.equal(paper.cancels, 0, 'Risk overrun records the drain; it cannot start another five-attempt cancel series in the same pass.');
  const order = await getDatabase().get("SELECT entry_drain_requested_at, filled_quantity, quantity FROM trading_orders WHERE intent_id = ? AND role = 'entry'", [intent.id]);
  assert.equal(order.filled_quantity, '1'); assert.equal(order.quantity, '10'); assert.ok(order.entry_drain_requested_at);
  assert.equal((await getDatabase().get("SELECT COUNT(*) AS n FROM trading_orders WHERE intent_id = ? AND role = 'stop_loss' AND status = 'open'", [intent.id])).n, 1);
  const readsBeforeDrain = paper.reads;
  await assert.rejects(engine.reconcileAccount(account.id), error => error.code === 'RECONCILIATION_CONTINUATION_REQUIRED');
  assert.equal(paper.cancels, 2, 'One entry cancel plus one stale-stop cancel share the same bounded account pass.');
  assert.equal(paper.reads, readsBeforeDrain, 'Incomplete exit synchronization does not mint a complete risk observation.');
  assert.deepEqual(await getDatabase().all("SELECT quantity FROM trading_orders WHERE intent_id = ? AND role = 'stop_loss' AND status = 'open'", [intent.id]),
    [{ quantity: '1' }], 'The freshly confirmed replacement protects all remaining owned exposure during continuation.');
  await engine.reconcileAccount(account.id);
  assert.equal(paper.cancels, 2, 'The fourth authoritative read confirms the targets without another cancellation series.');
  assert.equal(paper.reads, readsBeforeDrain + 1);
  const exposure = (await paper.openState(account)).positions[0];
  assert.equal(exposure.quantity, '1', 'Budget overrun does not invent a second liquidation path.');
  assert.equal((await getDatabase().get("SELECT status FROM trading_orders WHERE intent_id = ? AND role = 'entry'", [intent.id])).status, 'cancelled');
  assert.equal((await getDatabase().get("SELECT COUNT(*) AS n FROM trading_money_events WHERE kind = 'funding'")).n, 1);
  assert.equal((await getDatabase().get('SELECT balance_reason FROM trading_risk_current WHERE account_id = ?', [account.id])).balance_reason, null);
  console.log('Post-fill current risk overrun preserves protection, durably drains residuals and shares the bounded lifecycle cancel budget.');
} finally { await closeDb(); await rm(directory, { recursive: true, force: true }); }
