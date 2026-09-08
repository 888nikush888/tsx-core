import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { createTradingIntent, getTradingIntent, listTradingAccounts, listTradingStrategies, setTradingRoute, updateTradingRuntimeState } from '../src/trading_repository.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { TradingEngine } from '../src/trading_engine.js';
import { seedTradingFixtures } from './trading_fixtures.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'engine-plan-guard-'));
try {
  await initDb(path.join(directory, 'test.db'));
  await seedTradingFixtures();
  const [account] = await listTradingAccounts();
  const [strategy] = await listTradingStrategies();
  await setTradingRoute({ channelId: '-100001', accountId: account.id, strategyVersionId: strategy.id, enabled: true });
  await updateTradingRuntimeState({ executionEnabled: true });
  await saveSignal('missing-entry', '-100001', 1, '<signal/>', '<signal/>');
  const intent = await createTradingIntent({ sourceSignalId: 'missing-entry', channelId: '-100001',
    signal: { schema: 'standard', action: 'LONG', symbol: 'BTCUSDT', entry: { type: 'market' },
      targets: [{ min: '110', max: '110' }], stopLoss: '90' } });
  assert.ok(intent, 'Fixture must create an executable intent.');
  await getDatabase().run('UPDATE trading_trade_intents SET plan_json = ? WHERE id = ?', [JSON.stringify({ orders: [] }), intent.id]);
  const paper = new PaperExchangeAdapter();
  let providerCalls = 0;
  paper.accountSnapshot = () => { providerCalls += 1; throw new Error('Provider must not be queried for an invalid stored plan.'); };
  const engine = new TradingEngine([paper]);
  await engine.processIntent(intent.id);
  const outcome = await getTradingIntent(intent.id);
  assert.equal(outcome.status, 'blocked');
  assert.equal(outcome.blockReason, 'TRADE_PLAN_INVALID');
  assert.equal(providerCalls, 0);
  for (const table of ['trading_orders', 'trading_operations']) {
    assert.equal((await getDatabase().get('SELECT COUNT(*) AS count FROM ' + table)).count, 0,
      'An invalid resumed plan must not create dispatch artifacts.');
  }
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
console.log('Malformed persisted trade plan is blocked before provider or dispatch effects.');
