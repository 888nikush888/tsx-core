import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDatabase, saveSignal } from '../src/db.js';
import { StartupAuthority, STARTUP_GATES } from '../src/startup_authority.js';
import { TradingEngine } from '../src/trading_engine.js';
import { TradingRuntime } from '../src/trading_runtime.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { createTradingIntent, getTradingIntent, listTradingAccounts, listTradingStrategies,
  setTradingRoute, updateTradingRuntimeState } from '../src/trading_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';

const market = { symbol: 'BTCUSDT', markPrice: '100', priceTick: '0.01', quantityStep: '0.001',
  minimumQuantity: '0.001', minimumNotional: '1', maxLeverage: 50 };
const signal = { schema: 'standard', action: 'LONG', symbol: 'BTCUSDT',
  entry: { type: 'range', min: '100', max: '101' },
  targets: [{ min: '110', max: '110' }, { min: '120', max: '120' }], stopLoss: '95', suggestedLeverage: 2 };

async function createIntent(id) {
  await saveSignal(id, '-startup', 1, '<fixture/>', '<fixture/>');
  return createTradingIntent({ sourceSignalId: id, channelId: '-startup', signal });
}

async function fixture(file) {
  await initDb(file);
  await seedTradingFixtures();
  const [account] = await listTradingAccounts();
  const [strategy] = await listTradingStrategies();
  await setTradingRoute({ channelId: '-startup', strategyVersionId: strategy.id, accountId: account.id, enabled: true });
  await updateTradingRuntimeState({ executionEnabled: true });
  const paper = new PaperExchangeAdapter();
  await paper.setMarket(account.id, market);
  const authority = new StartupAuthority();
  const engine = new TradingEngine([paper], () => {}, undefined, { entryAuthority: () => authority.canEnter() });
  return { account, paper, authority, engine };
}

async function runtimeProtection(file) {
  const { account, paper, authority, engine } = await fixture(file);
  const runtime = new TradingRuntime(engine, 60_000, () => {}, undefined, authority);
  try {
    const intent = await createIntent('initial');
    await engine.processIntent(intent.id);
    assert.equal((await getTradingIntent(intent.id)).status, 'pending');
    authority.beginRecovery();
    await runtime.startProtectionOnly();
    for (const gate of STARTUP_GATES) authority.completeGate(gate);
    authority.release();
    await assert.rejects(runtime.enableEntries(), /Routing startup gate/);
    assert.equal((await getTradingIntent(intent.id)).status, 'pending');
    authority.completeGate('routing');
    await runtime.enableEntries();
    await engine.processIntent(intent.id);
    const submitted = await getTradingIntent(intent.id);
    assert.equal(submitted.status, 'monitoring', JSON.stringify({ reason: submitted.blockReason, error: submitted.error }));
    const pending = await createIntent('later');
    authority.block('late infrastructure failure');
    await engine.processIntent(pending.id);
    await assert.rejects(runtime.enableEntries(), /blocked/);
    const stops = (await paper.openState(account)).orders.filter(order => order.role === 'stop_loss');
    assert.equal(stops.length, 1);
    await paper.setMarket(account.id, { ...market, markPrice: '94' });
    await runtime.runOnce(true);
    assert.equal((await getTradingIntent(intent.id)).status, 'completed', 'Startup revocation must not stop protection reconciliation.');
    assert.equal((await getTradingIntent(pending.id)).status, 'pending');
    assert.equal((await getDatabase().get('SELECT COUNT(*) AS count FROM trading_orders WHERE intent_id = ?', [pending.id])).count, 0);
  } finally { await runtime.stop(); }
}

async function finalDispatchFence(file) {
  const { authority, engine, paper } = await fixture(file);
  authority.beginRecovery();
  for (const gate of [...STARTUP_GATES, 'routing']) authority.completeGate(gate);
  authority.release();
  const intent = await createIntent('dispatch-race');
  const database = getDatabase();
  const run = database.run.bind(database);
  let submissions = 0;
  let reachedFence = false;
  paper.submitProtectedEntry = async () => { submissions += 1; throw new Error('Revoked entry must never submit.'); };
  database.run = async (...args) => {
    const result = await run(...args);
    if (String(args[0]).includes('UPDATE trading_operations SET phase = ?') && args[1][0] === 'dispatching') {
      reachedFence = true;
      authority.block('shutdown at final journal await');
    }
    return result;
  };
  try { await engine.processIntent(intent.id); }
  finally { database.run = run; }
  assert.equal(reachedFence, true);
  assert.equal(submissions, 0);
  assert.equal((await getTradingIntent(intent.id)).blockReason, 'STARTUP_NOT_READY');
  assert.equal((await database.get('SELECT phase FROM trading_operations WHERE intent_id = ?', [intent.id])).phase, 'abandoned');
}

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-startup-trading-'));
try {
  await runtimeProtection(path.join(directory, 'runtime.db'));
  await closeDb();
  await finalDispatchFence(path.join(directory, 'dispatch.db'));
  console.log('Startup trading gates, untouched pending intents, continuing stop protection and final dispatch race passed.');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
