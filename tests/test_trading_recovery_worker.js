import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { TradingEngine } from '../src/trading_engine.js';
import { TradingRuntime } from '../src/trading_runtime.js';
import { createTradingAccount, createTradingIntent, getTradingAccount, getTradingIntent, listTradingStrategies,
  setTradingRoute, updateTradingRuntimeState } from '../src/trading_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'recovery-worker-'));
const originalNow = Date.now;
const signal = { schema: 'standard', action: 'LONG', symbol: 'ETHUSDT', entry: { type: 'market' },
  targets: [{ min: '3200', max: '3200' }, { min: '3300', max: '3300' }], stopLoss: '2900' };
const market = { symbol: 'ETHUSDT', markPrice: '3000', priceTick: '0.1', quantityStep: '0.001',
  minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 25 };

async function seedIntent(account, paper, name, requestedSignal = signal) {
  const [strategy] = await listTradingStrategies();
  await setTradingRoute({ channelId: name, strategyVersionId: strategy.id, accountId: account.id, enabled: true });
  await paper.setMarket(account.id, market);
  await saveSignal(name, name, 1, '<signal/>', '<signal/>');
  return createTradingIntent({ sourceSignalId: name, channelId: name, signal: requestedSignal });
}

async function disabledExposureStillNeedsWorker() {
  await initDb(path.join(directory, 'disabled.db'));
  await seedTradingFixtures();
  await updateTradingRuntimeState({ executionEnabled: true });
  const disabled = await getTradingAccount('paper-default');
  const healthy = await createTradingAccount({ name: 'Independent healthy account', exchange: 'paper', mode: 'paper', initialBalance: '10000' });
  const unused = await createTradingAccount({ name: 'Unused disabled account', exchange: 'paper', mode: 'paper', initialBalance: '10000' });
  const retired = await createTradingAccount({ name: 'Clean retired account', exchange: 'paper', mode: 'paper', initialBalance: '10000' });
  await getDatabase().run('UPDATE trading_accounts SET enabled = 0 WHERE id IN (?, ?)', [unused.id, retired.id]);
  await getDatabase().run('UPDATE trading_accounts SET retired_at = ? WHERE id = ?', [Date.now(), retired.id]);
  const paper = new PaperExchangeAdapter();
  const engine = new TradingEngine([paper]);
  const intents = [];
  for (const account of [disabled, healthy]) {
    const intent = await seedIntent(account, paper, `worker-${account.id}`);
    intents.push(intent);
    await engine.processIntent(intent.id);
    assert.equal((await getTradingIntent(intent.id)).status, 'monitoring');
    const stop = (await paper.openState(account)).orders.find(order => order.role === 'stop_loss' && order.status === 'open');
    await paper.cancelOrder(account, stop.clientOrderId);
  }
  await getDatabase().run('UPDATE trading_accounts SET enabled = 0 WHERE id = ?', [disabled.id]);
  const entriesBefore = await getDatabase().get("SELECT COUNT(*) AS count FROM trading_paper_orders WHERE role = 'entry'");
  const read = paper.openState.bind(paper);
  const workerReads = [];
  paper.openState = async account => { workerReads.push(account.id); return read(account); };
  const runtime = new TradingRuntime(engine, 60_000);
  try {
    await runtime.startProtectionOnly();
    assert.equal(runtime.isProtectionScanComplete(), true);
    const healthyStops = (await paper.openState(healthy)).orders.filter(order => order.role === 'stop_loss' && order.status === 'open');
    assert.equal(healthyStops.length, 1, 'The independent healthy account is genuinely repaired by the startup worker.');
    const disabledStops = (await paper.openState(disabled)).orders.filter(order => order.role === 'stop_loss' && order.status === 'open');
    assert.equal(disabledStops.length, 1,
      'Disabling new entries cannot remove an account with proved owned exposure from startup/periodic protection recovery.');
    assert.equal((await getTradingAccount(disabled.id)).enabled, false);
    assert.equal((await getDatabase().get("SELECT COUNT(*) AS count FROM trading_paper_orders WHERE role = 'entry'")).count, entriesBefore.count);
    for (const account of [disabled, healthy]) {
      const stop = (await read(account)).orders.find(order => order.role === 'stop_loss' && order.status === 'open');
      await paper.cancelOrder(account, stop.clientOrderId);
    }
    const now = originalNow();
    Date.now = () => now + 10_001;
    runtime.wake();
    await runtime.active;
    for (const account of [disabled, healthy]) {
      assert.equal((await read(account)).orders.filter(order => order.role === 'stop_loss' && order.status === 'open').length, 1,
        'The actual periodic wake reuses the same obligation-aware account target policy.');
    }
    assert.equal(workerReads.includes(unused.id), false, 'Unused disabled accounts do not trigger provider reads.');
    assert.equal(workerReads.includes(retired.id), false, 'Clean retired history does not trigger provider reads.');
    assert.equal((await getDatabase().get("SELECT COUNT(*) AS count FROM trading_paper_orders WHERE role = 'entry'")).count, entriesBefore.count);
  } finally { await runtime.stop(); }
  await closeDb();
}

async function acceptedEntryIsNotImplicitlyDrained() {
  await initDb(path.join(directory, 'accepted-execution-off.db'));
  await seedTradingFixtures();
  await updateTradingRuntimeState({ executionEnabled: true });
  const account = await getTradingAccount('paper-default'), paper = new PaperExchangeAdapter();
  const intent = await seedIntent(account, paper, 'accepted-execution-off',
    { ...signal, entry: { type: 'limit', min: '2950', max: '2950' } });
  await new TradingEngine([paper]).processIntent(intent.id);
  const prepared = await getTradingIntent(intent.id);
  assert.equal(prepared.status, 'monitoring', prepared.error);
  const before = await paper.openState(account);
  const entry = before.orders.find(order => order.role === 'entry'), stop = before.orders.find(order => order.role === 'stop_loss');
  assert.equal(entry.status, 'open'); assert.equal(entry.filledQuantity, '0'); assert.equal(stop.status, 'open');
  let cancels = 0, submits = 0;
  const cancel = paper.cancelOrder.bind(paper), submit = paper.submitProtectedEntry.bind(paper);
  paper.cancelOrder = async (...args) => { cancels += 1; return cancel(...args); };
  paper.submitProtectedEntry = async (...args) => { submits += 1; return submit(...args); };
  await updateTradingRuntimeState({ executionEnabled: false });
  const runtime = new TradingRuntime(new TradingEngine([paper]), 60_000);
  const now = originalNow();
  assert.ok(now + 10_001 < prepared.plan.entryExpiresAt);
  try {
    await runtime.startProtectionOnly();
    Date.now = () => now + 10_001;
    runtime.wake(); await runtime.active;
    const after = await paper.openState(account);
    assert.equal(after.orders.find(order => order.clientOrderId === entry.clientOrderId).status, 'open',
      'Execution-off is not an implicit cancel instruction for an already accepted original entry.');
    assert.equal(after.orders.find(order => order.clientOrderId === stop.clientOrderId).status, 'open');
    assert.equal(cancels, 0); assert.equal(submits, 0);
    assert.deepEqual((await getTradingIntent(intent.id)).plan, prepared.plan);
    assert.deepEqual(await getDatabase().get('SELECT execution_enabled, kill_switch_active FROM trading_runtime_state'),
      { execution_enabled: 0, kill_switch_active: 0 });
  } finally { await runtime.stop(); Date.now = originalNow; }
  await closeDb();
}

try {
  await disabledExposureStillNeedsWorker();
  Date.now = originalNow;
  await acceptedEntryIsNotImplicitlyDrained();
  console.log('Actual startup/periodic recovery protects disabled exposed accounts without enabling new entries.');
} finally {
  Date.now = originalNow;
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
