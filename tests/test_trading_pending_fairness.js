import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal, withDatabaseTransaction } from '../src/db.js';
import { TradingEngine } from '../src/trading_engine.js';
import { TradingRuntime } from '../src/trading_runtime.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { createTradingAccount, createTradingIntent, getTradingAccount, getTradingIntent, listTradingStrategies,
  setTradingRoute, updateTradingRuntimeState } from '../src/trading_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'trading-pending-fairness-'));
let sequence = 0;

async function fixture() {
  const file = path.join(directory, `${sequence++}.db`);
  await initDb(file);
  await seedTradingFixtures();
  await updateTradingRuntimeState({ executionEnabled: true });
  return { file, account: await getTradingAccount('paper-default'), strategy: (await listTradingStrategies())[0] };
}

async function legacyRows(context, count, prefix = 'legacy', createdAt = 1) {
  const rows = [];
  await withDatabaseTransaction(async () => {
    for (let index = 0; index < count; index += 1) {
      const id = `${prefix}-${String(index).padStart(4, '0')}`;
      await saveSignal(id, prefix, index + 1, '<legacy/>', '<legacy/>');
      await getDatabase().run(`INSERT INTO trading_trade_intents (id,source_signal_id,root_source_signal_id,channel_id,
        strategy_version_id,account_id,exchange,mode,symbol,side,status,signal_json,plan_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'paper','paper','BTCUSDT','LONG','submitting','{}',NULL,?,?)`,
      [id, id, id, prefix, context.strategy.id, context.account.id, createdAt, createdAt]);
      rows.push(id);
    }
  });
  return rows;
}

async function startRuntime(engine) {
  const runtime = new TradingRuntime(engine, 60_000);
  await runtime.startProtectionOnly();
  await runtime.enableEntries();
  return runtime;
}

async function wake(runtime) {
  runtime.wake();
  await runtime.active;
}

function schedulerEngine(attempt) {
  // Only scheduler tests use these explicit local lifecycle fakes. The first case uses the actual Engine and Paper.
  const engine = new TradingEngine([]);
  engine.retireUnauthorizedPreparations = async () => 0;
  engine.reconcileAccount = async () => undefined;
  engine.cancelExpiredEntries = async () => undefined;
  engine.processIntent = attempt;
  return engine;
}

async function healthyAccountBeyondLegacyPage() {
  const context = await fixture();
  const old = await legacyRows(context, 100);
  const originalRows = await getDatabase().all('SELECT * FROM trading_trade_intents ORDER BY id');
  const healthy = await createTradingAccount({ name: 'Independent healthy account', exchange: 'paper', mode: 'paper', initialBalance: '10000' });
  const paper = new PaperExchangeAdapter();
  await paper.setMarket(healthy.id, { symbol: 'ETHUSDT', markPrice: '3000', priceTick: '0.1', quantityStep: '0.001',
    minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 25 });
  await setTradingRoute({ channelId: 'healthy', strategyVersionId: context.strategy.id, accountId: healthy.id, enabled: true });
  await saveSignal('healthy', 'healthy', 1, '<signal/>', '<signal/>');
  const intent = await createTradingIntent({ sourceSignalId: 'healthy', channelId: 'healthy', signal: {
    schema: 'standard', action: 'LONG', symbol: 'ETHUSDT', entry: { type: 'market' },
    targets: [{ min: '3200', max: '3200' }, { min: '3300', max: '3300' }], stopLoss: '2900' } });
  const engine = new TradingEngine([paper]), attempts = [];
  const process = engine.processIntent.bind(engine);
  engine.processIntent = async id => { attempts.push(id); return process(id); };
  const runtime = await startRuntime(engine);
  try {
    await wake(runtime);
    assert.equal(attempts.length, 100);
    assert.equal((await getTradingIntent(intent.id)).status, 'pending');
    await wake(runtime);
    assert.equal((await getTradingIntent(intent.id)).status, 'monitoring',
      'Unprovable legacy preparations cannot starve a genuinely admissible independent account.');
    assert.deepEqual(await getDatabase().all('SELECT * FROM trading_trade_intents WHERE account_id=? ORDER BY id',
      [context.account.id]), originalRows, 'Fairness cannot alter the original legacy data or invent terminal outcomes.');
    assert.equal(new Set(attempts.filter(id => old.includes(id))).size, 100);
    assert.equal((await getDatabase().get("SELECT COUNT(*) AS n FROM trading_paper_orders WHERE role='entry'")).n, 1);
    assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  } finally { await runtime.stop(); await closeDb(); }
}

async function stablePagesAndRestart() {
  const context = await fixture(), ids = await legacyRows(context, 205, 'same-time');
  let attempts = [];
  let runtime = await startRuntime(schedulerEngine(async id => { attempts.push(id); }));
  try {
    for (const expected of [100, 200, 205, 305]) {
      await wake(runtime);
      assert.equal(attempts.length, expected, 'One wake attempts at most 100 rows and wraps only after the page end.');
    }
    assert.deepEqual(attempts.slice(0, 205), ids, 'The immutable id tie-breaker prevents equal-time skips.');
    assert.deepEqual(attempts.slice(205), ids.slice(0, 100));
    await runtime.stop(); await closeDb(); await initDb(context.file);
    attempts = [];
    runtime = await startRuntime(schedulerEngine(async id => { attempts.push(id); }));
    for (let index = 0; index < 3; index += 1) await wake(runtime);
    assert.deepEqual(attempts, ids, 'A new runtime/DB handle safely revisits the durable queue and reaches every page.');
  } finally { await runtime.stop(); await closeDb(); }
}

async function disappearingIdsAndEarlierInsertion() {
  const context = await fixture(), ids = await legacyRows(context, 101, 'cursor');
  const attempts = [];
  const runtime = await startRuntime(schedulerEngine(async id => { attempts.push(id); }));
  try {
    await wake(runtime);
    await getDatabase().run('DELETE FROM trading_trade_intents WHERE id=?', [ids[99]]);
    const inserted = await legacyRows(context, 1, 'new-earlier', 0);
    await wake(runtime);
    assert.equal(attempts.at(-1), ids[100], 'The vanished cursor id does not invalidate its immutable keyset boundary.');
    await wake(runtime);
    assert.equal(attempts[101], inserted[0], 'Rows inserted before the cursor are reached on the next wrap.');
    assert.equal(attempts.length, 201);
    assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  } finally { await runtime.stop(); await closeDb(); }
}

async function interruptionDoesNotSkipUnattemptedRows() {
  const context = await fixture(), ids = await legacyRows(context, 105, 'interrupted');
  const attempts = [];
  let runtime;
  const engine = schedulerEngine(async id => {
    attempts.push(id);
    if (attempts.length === 1) runtime.disableEntries();
  });
  runtime = await startRuntime(engine);
  try {
    await wake(runtime);
    assert.deepEqual(attempts, [ids[0]]);
    await runtime.enableEntries();
    await wake(runtime);
    assert.deepEqual(attempts, ids.slice(0, 101), 'Pausing cannot advance over selected but unattempted entries.');
    await wake(runtime);
    assert.deepEqual(attempts, ids);
  } finally { await runtime.stop(); await closeDb(); }
}

async function missingSelectionAndEmptyQueue() {
  const context = await fixture(), ids = await legacyRows(context, 3, 'vanished');
  const attempts = [];
  const engine = schedulerEngine(async id => {
    attempts.push(id);
    if (id === ids[0]) await getDatabase().run('DELETE FROM trading_trade_intents WHERE id=?', [ids[1]]);
    // Match the actual Engine's missing-id no-op; do not manufacture a terminal state.
    if (!await getTradingIntent(id)) return;
    await getDatabase().run('DELETE FROM trading_trade_intents WHERE id=?', [id]);
  });
  const runtime = await startRuntime(engine);
  try {
    await wake(runtime);
    assert.deepEqual(attempts, ids);
    await wake(runtime);
    assert.deepEqual(attempts, ids, 'Empty wrap is bounded and performs no engine call.');
    const fresh = await legacyRows(context, 1, 'fresh', 0);
    await wake(runtime);
    assert.deepEqual(attempts, [...ids, ...fresh]);
  } finally { await runtime.stop(); await closeDb(); }
}

async function unexpectedFailureDoesNotPinCursor() {
  const context = await fixture(), ids = await legacyRows(context, 2, 'failed');
  const attempts = [];
  const runtime = await startRuntime(schedulerEngine(async id => {
    attempts.push(id);
    if (id === ids[0]) throw new Error('Local scheduler fake: failed account attempt');
  }));
  try {
    await wake(runtime);
    await wake(runtime);
    assert.ok(attempts.includes(ids[1]), 'An unexpected attempt failure cannot pin every later cycle to the same row.');
  } finally { await runtime.stop(); await closeDb(); }
}

try {
  await healthyAccountBeyondLegacyPage();
  await stablePagesAndRestart();
  await disappearingIdsAndEarlierInsertion();
  await interruptionDoesNotSkipUnattemptedRows();
  await missingSelectionAndEmptyQueue();
  await unexpectedFailureDoesNotPinCursor();
  console.log('Pending worker: bounded stable rotation, genuine independent entry, restart, deletion, wrap and interruption passed.');
} finally {
  await closeDb();
  assert.equal(path.dirname(directory), os.tmpdir());
  assert.ok(path.basename(directory).startsWith('trading-pending-fairness-'));
  await rm(directory, { recursive: true, force: true });
}
