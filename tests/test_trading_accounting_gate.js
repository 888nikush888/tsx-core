import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { TradingEngine } from '../src/trading_engine.js';
import { createTradingIntent, getTradingAccount, getTradingIntent, listTradingStrategies, setTradingRoute, updateTradingRuntimeState } from '../src/trading_repository.js';
import { validateAccountSnapshot } from '../src/exchange_contract_validation.js';
import { validateSignalXml } from '../src/signal_schema.js';
import { seedTradingFixtures } from './trading_fixtures.js';

class FundingPaper extends PaperExchangeAdapter {
  incomplete = true;
  async accountSnapshot(account) {
    const result = await super.accountSnapshot(account);
    if (this.incomplete) {
      result.fundingPnlToday = null;
      result.accounting.funding.status = 'incomplete';
      result.accounting.funding.reason = 'provider_rejected_read';
    }
    return result;
  }
  async openState(account, recovery) {
    const result = await super.openState(account, recovery);
    return { ...result, fills: result.fills.map(fill => ({ ...fill, fee: '0.01', feeAsset: null })) };
  }
}
const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-accounting-gate-'));
try {
  await initDb(path.join(directory, 'test.db'));
  await seedTradingFixtures();
  const [strategy] = await listTradingStrategies();
  await setTradingRoute({ channelId: '-money', strategyVersionId: strategy.id, accountId: 'paper-default', enabled: true });
  await updateTradingRuntimeState({ executionEnabled: true });
  const paper = new FundingPaper();
  const market = { symbol: 'BTCUSDT', markPrice: '60000', priceTick: '0.1', quantityStep: '0.001', minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 50 };
  await paper.setMarket('paper-default', market);
  const xml = '<signal><action>LONG</action><pair>BTCUSDT</pair><entry_range><min>60000</min><max>61000</max></entry_range><targets><target id="1">62000</target><target id="2">63000</target></targets><stoploss>59000</stoploss><leverage>3</leverage></signal>';
  const create = async number => {
    await saveSignal(`money-${number}`, '-money', number, xml, xml);
    return createTradingIntent({ sourceSignalId: `money-${number}`, channelId: '-money', signal: validateSignalXml(xml, 'default').execution });
  };
  const engine = new TradingEngine([paper]);
  const blocked = await create(1);
  await engine.processIntent(blocked.id);
  assert.equal((await getTradingIntent(blocked.id)).blockReason, 'ACCOUNTING_INCOMPLETE', 'Unknown funding must block a new entry before any order dispatch.');
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS n FROM trading_orders')).n, 0);
  paper.incomplete = false;
  const allowed = await create(2);
  await engine.processIntent(allowed.id);
  assert.equal((await getTradingIntent(allowed.id)).status, 'monitoring');
  assert.equal((await getDatabase().get("SELECT COUNT(*) AS n FROM trading_money_events WHERE kind = 'fee' AND asset IS NULL")).n, 1,
    'An actual owned fill with unknown fee asset must be durably posted before final closure.');
  paper.incomplete = true;
  await paper.setMarket('paper-default', { ...market, markPrice: '58000' });
  await engine.reconcileAccount('paper-default');
  assert.equal((await getTradingIntent(allowed.id)).status, 'completed', 'Incomplete accounting must not prevent an existing stop from closing exposure.');
  assert.equal((await getDatabase().get('SELECT ledger_realized_pnl FROM trading_positions WHERE intent_id = ?', [allowed.id])).ledger_realized_pnl, null);
  paper.incomplete = false;
  const unresolved = await create(3);
  await engine.processIntent(unresolved.id);
  assert.equal((await getTradingIntent(unresolved.id)).blockReason, 'ACCOUNTING_INCOMPLETE');
  const snapshot = await paper.accountSnapshot(await getTradingAccount('paper-default'));
  assert.throws(() => validateAccountSnapshot({ ...snapshot, fundingPnlToday: '-1' }), /contradicts/);
  assert.equal(validateAccountSnapshot({ ...snapshot, fundingPnlToday: null, accounting: { ...snapshot.accounting,
    funding: { ...snapshot.accounting.funding, status: 'unsupported', reason: 'unverified_profile' } } }).fundingPnlToday, null);
  const { assertEntryAccountingReady } = await import('../src/trading_accounting.js');
  const account = await getTradingAccount('paper-default');
  await assert.rejects(assertEntryAccountingReady(account, { ...snapshot, accounting: undefined }), /accounting/i);
  await assert.rejects(assertEntryAccountingReady(account, { ...snapshot, accounting: { ...snapshot.accounting, observedAt: Date.now() - 120_000 } }), /accounting/i);
  assert.equal((await getDatabase().all('PRAGMA foreign_key_check')).length, 0);
  console.log('Incomplete accounting blocks new entries while existing stop, close and evidence replay remain available.');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
