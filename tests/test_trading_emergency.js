import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { TradingEngine } from '../src/trading_engine.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { createTradingIntent, getTradingIntent, listTradingStrategies, setTradingRoute, updateTradingRuntimeState } from '../src/trading_repository.js';
import { validateSignalXml } from '../src/signal_schema.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { emergencyFixture } from './fixtures/trading_emergency_fixture.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'trading-emergency-'));
const databasePath = path.join(directory, 'test.db');
async function hardCrash(file, timing) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/emergency_crash.js', file, 'paper-default', timing], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
  });
  await new Promise((resolve, reject) => {
    let output = '';
    let killed = false;
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Emergency crash fixture timed out.')); }, 10_000);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (!killed && output.includes('EMERGENCY_CRASH_MARKER')) { killed = true; child.kill('SIGKILL'); }
    });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', () => { clearTimeout(timeout); if (killed) resolve(); else reject(new Error(output)); });
  });
}

async function proveHardCrashRecovery(timing) {
  const file = path.join(directory, `crash-${timing}.db`);
  await initDb(file);
  await seedTradingFixtures();
  const [strategy] = await listTradingStrategies();
  const paper = new PaperExchangeAdapter();
  await setTradingRoute({ channelId: '-crash', strategyVersionId: strategy.id, accountId: 'paper-default', enabled: true });
  await updateTradingRuntimeState({ executionEnabled: true });
  await paper.setMarket('paper-default', { symbol: 'BTCUSDT', markPrice: '100', priceTick: '0.1', quantityStep: '0.1',
    minimumQuantity: '0.1', minimumNotional: '1', maxLeverage: 10 });
  const xml = '<signal><action>LONG</action><pair>BTCUSDT</pair><entry_range><min>100</min><max>101</max></entry_range><targets><target id="1">110</target><target id="2">120</target></targets><stoploss>90</stoploss><leverage>1</leverage></signal>';
  await saveSignal('crash-signal', '-crash', 1, xml, xml);
  const intent = await createTradingIntent({ sourceSignalId: 'crash-signal', channelId: '-crash', signal: validateSignalXml(xml).execution });
  await new TradingEngine([paper]).processIntent(intent.id);
  assert.equal((await getTradingIntent(intent.id)).status, 'monitoring');
  await closeDb();
  await hardCrash(file, timing);
  await initDb(file);
  const order = await getDatabase().get("SELECT client_order_id, status FROM trading_orders WHERE role = 'flatten'");
  const operation = await getDatabase().get("SELECT phase FROM trading_operations WHERE kind = 'submit' AND request_json LIKE '%flatten%'");
  assert.equal(operation.phase, timing === 'before' ? 'prepared' : 'dispatching');
  assert.equal(order.status, 'submitting');
  assert.equal((await getDatabase().get("SELECT COUNT(*) AS count FROM trading_paper_orders WHERE role = 'flatten'")).count, timing === 'before' ? 0 : 1);
  await new TradingEngine([new PaperExchangeAdapter()]).reconcileAccount('paper-default');
  assert.equal((await getDatabase().get('SELECT status FROM trading_positions WHERE intent_id = ?', [intent.id])).status, 'closed');
  assert.deepEqual(await getDatabase().all("SELECT client_order_id FROM trading_orders WHERE role = 'flatten'"), [{ client_order_id: order.client_order_id }]);
  assert.equal((await getDatabase().get("SELECT COUNT(*) AS count FROM trading_paper_orders WHERE role = 'flatten'")).count, 1,
    'A real process crash before or after provider acceptance must lead to exactly one proved paper execution.');
  await closeDb();
}

async function proveGlobalEmergencyIndependence() {
  await initDb(path.join(directory, 'global.db'));
  await seedTradingFixtures();
  const unsafe = await emergencyFixture('global-unsafe', { partial: false, localQuantity: '1' });
  unsafe.state.foreign = '0.3';
  const healthy = await emergencyFixture('global-healthy', { partial: false, localQuantity: '1' });
  const fixtures = new Map([unsafe, healthy].map(fixture => [fixture.id, fixture]));
  const assertRequestsPersisted = async () => {
    const markers = await getDatabase().all('SELECT emergency_requested_at FROM trading_positions');
    assert.equal(markers.length, 2);
    assert.ok(markers.every(row => typeof row.emergency_requested_at === 'number'),
      'Every selected account must have a durable emergency request before the first provider action.');
  };
  const adapter = { exchange: 'paper' };
  for (const method of ['openState', 'submitOrder', 'cancelOrder']) {
    adapter[method] = async (account, ...args) => {
      await assertRequestsPersisted();
      return fixtures.get(account.id).adapter[method](account, ...args);
    };
  }
  await assert.rejects(new TradingEngine([adapter]).emergencyFlattenManaged(), /pending|unresolved/i);
  assert.equal(unsafe.state.flattenCalls.length, 0);
  assert.equal(healthy.state.flattenCalls.length, 1, 'A conflicting account cannot prevent a separately proved account from being reduced.');
  assert.equal((await getDatabase().get('SELECT status FROM trading_positions WHERE id = ?', [healthy.id])).status, 'closed');
  assert.equal((await getDatabase().get('SELECT status FROM trading_positions WHERE id = ?', [unsafe.id])).status, 'emergency');
  await closeDb();
}
try {
  await initDb(databasePath);
  await seedTradingFixtures();
  const partial = await emergencyFixture('partial');
  let engine = new TradingEngine([partial.adapter]);
  await assert.rejects(engine.emergencyFlattenManaged(partial.id), /pending|unresolved|entry|drain/i);
  assert.deepEqual(partial.state.flattenCalls.map(order => order.quantity), ['1'],
    'A pending entry cancellation must not prevent reduction of freshly proved owned exposure, even with local quantity zero.');
  assert.equal((await getDatabase().get('SELECT status FROM trading_positions WHERE id = ?', [partial.id])).status, 'emergency');
  await closeDb();
  await initDb(databasePath);
  engine = new TradingEngine([partial.adapter]);
  await assert.rejects(engine.reconcileAccount(partial.id), /pending|unresolved|entry|drain/i);
  assert.equal(partial.state.flattenCalls.length, 1, 'No new flatten without new proved owned quantity.');
  partial.state.addEntryFill('0.5');
  await assert.rejects(engine.reconcileAccount(partial.id), /pending|unresolved|entry|drain/i);
  assert.deepEqual(partial.state.flattenCalls.map(order => order.quantity), ['1', '0.5']);
  assert.notEqual(partial.state.flattenCalls[0].clientOrderId, partial.state.flattenCalls[1].clientOrderId,
    'A later own fill gets its own durable generation only after the first flatten is proved.');
  partial.state.orders.get('partial-entry').status = 'cancelled';
  await engine.reconcileAccount(partial.id);
  assert.equal((await getDatabase().get('SELECT status FROM trading_positions WHERE id = ?', [partial.id])).status, 'closed');

  const missing = await emergencyFixture('lost-ack', { partial: false, localQuantity: '1' });
  missing.state.loseNextFlattenAck = true;
  engine = new TradingEngine([missing.adapter]);
  await assert.rejects(engine.emergencyFlattenManaged(missing.id));
  assert.equal(missing.state.flattenCalls.length, 1);
  await closeDb();
  await initDb(databasePath);
  missing.state.hideFlattens = true;
  engine = new TradingEngine([missing.adapter]);
  await assert.rejects(engine.reconcileAccount(missing.id));
  assert.equal(missing.state.flattenCalls.length, 1, 'Missing remote evidence cannot authorize a duplicate flatten.');
  missing.state.hideFlattens = false;
  await engine.reconcileAccount(missing.id);
  assert.equal(missing.state.flattenCalls.length, 1);
  assert.equal((await getDatabase().get('SELECT status FROM trading_positions WHERE id = ?', [missing.id])).status, 'closed');

  const foreign = await emergencyFixture('foreign', { partial: false, localQuantity: '1' });
  foreign.state.foreign = '0.3';
  await assert.rejects(new TradingEngine([foreign.adapter]).emergencyFlattenManaged(foreign.id));
  assert.equal(foreign.state.flattenCalls.length, 0, 'An unproved foreign same-side difference is never flattened.');
  assert.equal(foreign.state.cancelCalls.length, 0, 'Existing protection remains untouched on foreign ownership conflict.');

  for (const exchange of ['hyperliquid', 'bybit', 'krakenfutures']) {
    const profile = await emergencyFixture(`profile-${exchange}`, { exchange, partial: false, localQuantity: '1' });
    const reduction = new TradingEngine([profile.adapter]).emergencyFlattenManaged(profile.id);
    if (exchange === 'bybit') {
      await assert.rejects(reduction, error => error.errors.some(item => item.proof?.reasons.some(reason => reason.code === 'FILL_OPTION_SCOPE_UNPROVED')));
    } else assert.equal(await reduction, 1);
    assert.deepEqual(profile.state.flattenCalls.map(order => order.quantity), ['1']);
    assert.equal((await getDatabase().get('SELECT status FROM trading_positions WHERE id = ?', [profile.id])).status,
      exchange === 'bybit' ? 'emergency' : 'closed', 'Unproved provider-wide history blocks completion, never the already-proved own reduction.');
  }
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  await closeDb();
  await proveHardCrashRecovery('before');
  await proveHardCrashRecovery('after');
  await proveGlobalEmergencyIndependence();
  console.log('Durable emergency drain, late fills, lost acknowledgements, restart and cross-profile ownership tests passed.');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
