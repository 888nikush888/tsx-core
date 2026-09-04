// Isolated true worker probe: an explicit incomplete imported legacy page must not starve another healthy account.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { TradingEngine } from '../src/trading_engine.js';
import { TradingRuntime } from '../src/trading_runtime.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { createTradingAccount, createTradingIntent, getTradingAccount, getTradingIntent, listTradingStrategies,
  setTradingRoute, updateTradingRuntimeState } from '../src/trading_repository.js';
import { seedTradingFixtures } from '../tests/trading_fixtures.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-pending-fairness-probe-'));
const originalNow = Date.now;
let runtime;
try {
  await initDb(path.join(directory, 'test.db'));
  await seedTradingFixtures();
  await updateTradingRuntimeState({ executionEnabled: true });
  const legacy = await getTradingAccount('paper-default');
  const healthy = await createTradingAccount({ name: 'Healthy independent probe', exchange: 'paper', mode: 'paper', initialBalance: '10000' });
  const [strategy] = await listTradingStrategies();
  const paper = new PaperExchangeAdapter();
  const market = { symbol: 'ETHUSDT', markPrice: '3000', priceTick: '0.1', quantityStep: '0.001',
    minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 25 };
  await paper.setMarket(healthy.id, market);
  await setTradingRoute({ channelId: '-healthy-probe', strategyVersionId: strategy.id, accountId: healthy.id, enabled: true });
  await saveSignal('healthy-probe', '-healthy-probe', 1, '<signal/>', '<signal/>');
  const intent = await createTradingIntent({ sourceSignalId: 'healthy-probe', channelId: '-healthy-probe',
    signal: { schema: 'standard', action: 'LONG', symbol: 'ETHUSDT', entry: { type: 'market' },
      targets: [{ min: '3200', max: '3200' }, { min: '3300', max: '3300' }], stopLoss: '2900' } });
  for (let index = 0; index < 100; index += 1) {
    const id = `legacy-${index}`;
    await saveSignal(id, '-legacy-probe', index + 1, '<legacy/>', '<legacy/>');
    // Explicit incomplete imported legacy record; never a claimed accepted own trade.
    await getDatabase().run(`INSERT INTO trading_trade_intents (id,source_signal_id,root_source_signal_id,channel_id,
      strategy_version_id,account_id,exchange,mode,symbol,side,status,signal_json,plan_json,created_at,updated_at)
      VALUES (?,?,?,'-legacy-probe',?,?,'paper','paper','BTCUSDT','LONG','submitting','{}',NULL,?,?)`,
    [id, id, id, strategy.id, legacy.id, intent.createdAt - 1000 - index, intent.createdAt]);
  }
  const engine = new TradingEngine([paper]);
  const attempts = [];
  const processIntent = engine.processIntent.bind(engine);
  engine.processIntent = async id => { attempts.push(id); return processIntent(id); };
  runtime = new TradingRuntime(engine, 60_000);
  await runtime.startProtectionOnly();
  await runtime.enableEntries();
  const now = originalNow();
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    Date.now = () => now + cycle * 10_001;
    runtime.wake(); await runtime.active;
  }
  const observed = (await getTradingIntent(intent.id)).status;
  assert.equal((await getDatabase().get("SELECT COUNT(*) AS n FROM trading_trade_intents WHERE id LIKE 'legacy-%' AND status='submitting'")).n, 100);
  // Positive countercontrol: the exact same healthy intent satisfies genuine Engine/Paper entry safety.
  await processIntent(intent.id);
  assert.equal((await getTradingIntent(intent.id)).status, 'monitoring');
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  console.log(JSON.stringify({ workerCycles: 3, attempted: attempts.length, healthyAttempted: attempts.includes(intent.id),
    healthyStatusAfterWorker: observed, directEngineCountercontrol: 'monitoring' }));
  assert.equal(observed, 'monitoring', 'Repeated bounded worker cycles must eventually process the healthy account behind unprovable legacy intents.');
} finally {
  await runtime?.stop(); Date.now = originalNow; await closeDb();
  assert.equal(path.dirname(directory), os.tmpdir());
  assert.ok(path.basename(directory).startsWith('tsx-pending-fairness-probe-'));
  await rm(directory, { recursive: true, force: true });
}
