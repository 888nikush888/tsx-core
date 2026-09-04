import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { TradingEngine } from '../src/trading_engine.js';
import { createTradingIntent, getTradingAccount, getTradingIntent, listTradingStrategies, setTradingRoute,
  updateTradingAccountConfiguration, updateTradingRuntimeState } from '../src/trading_repository.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { validateSignalXml } from '../src/signal_schema.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { emergencyFixture } from './fixtures/trading_emergency_fixture.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'trading-lifecycle-safety-'));
let sequence = 0;
async function closingFixture() {
  const fixture = await emergencyFixture(`closure-${++sequence}`, { partial: false, localQuantity: '1' });
  const stop = fixture.state.orders.get(`${fixture.id}-stop`);
  Object.assign(stop, { status: 'filled', filledQuantity: '1', averagePrice: '90' });
  fixture.state.fills.push({ clientOrderId: stop.clientOrderId, exchangeOrderId: stop.exchangeOrderId,
    exchangeFillId: `${fixture.id}-stop-fill`, symbol: 'BTCUSDT', providerSymbol: 'BTCUSDT', price: '90', quantity: '1',
    fee: '0', feeAsset: 'USDT', filledAt: Date.now(), raw: {} });
  fixture.state.owned = () => '0';
  return { ...fixture, engine: new TradingEngine([fixture.adapter]) };
}
function hasReason(error, code) {
  return error.code === code || Boolean(error.proof?.reasons.some(reason => reason.code === code))
    || Boolean(error.errors?.some(nested => hasReason(nested, code)));
}
async function assertUnclosed(fixture) {
  assert.notEqual((await getDatabase().get('SELECT status FROM trading_positions WHERE id = ?', [fixture.id])).status, 'closed');
  assert.equal((await getDatabase().get("SELECT COUNT(*) AS n FROM trading_risk_events WHERE intent_id = ? AND code = 'TRADE_CLOSURE_PROVED'", [fixture.id])).n, 0);
  assert.equal((await getTradingAccount(fixture.id)).killSwitchActive, true);
  assert.equal(fixture.state.flattenCalls.length, 0, 'Unproved closure never invents a new reducing order.');
}
async function rejectIncompleteClosure(patch, code) {
  const fixture = await closingFixture();
  const original = fixture.adapter.openState;
  fixture.adapter.openState = async () => {
    const state = await original();
    await patch(state, fixture);
    return state;
  };
  await assert.rejects(fixture.engine.reconcileAccount(fixture.id), error => hasReason(error, code), code);
  await assertUnclosed(fixture);
}
async function finalCommitRace(kind) {
  const fixture = await closingFixture();
  const database = getDatabase();
  const original = database.run.bind(database);
  const realNow = Date.now;
  let triggered = false;
  database.run = async (sql, parameters, ...rest) => {
    const result = await original(sql, parameters, ...rest);
    if (!triggered && /UPDATE trading_positions SET status = 'closed'/.test(sql) && parameters?.at(-1) === fixture.id) {
      triggered = true;
      if (kind === 'epoch') fixture.engine.mutations.fenceEntries(fixture.id);
      else if (kind === 'freshness') Date.now = () => realNow() + 31_000;
      else await original('UPDATE trading_accounts SET state_version = state_version + 1 WHERE id = ?', [fixture.id]);
    }
    return result;
  };
  try { await assert.rejects(fixture.engine.reconcileAccount(fixture.id), /operator fence|ACCOUNT_STATE_CHANGED|ACQUISITION_NOT_FRESH/); }
  finally { database.run = original; Date.now = realNow; }
  assert.equal(triggered, true);
  await assertUnclosed(fixture);
}
async function paperDrainFixture(name) {
  await closeDb();
  await initDb(path.join(directory, `${name}.db`));
  await seedTradingFixtures();
  const [strategy] = await listTradingStrategies();
  const account = await getTradingAccount('paper-default');
  const paper = new PaperExchangeAdapter({ maximumFillQuantity: '0.4', reduceOnlyRemainder: 'retain' });
  await setTradingRoute({ channelId: '-drain-proof', strategyVersionId: strategy.id, accountId: account.id, enabled: true });
  await updateTradingRuntimeState({ executionEnabled: true });
  const market = { symbol: 'BTCUSDT', markPrice: '100', priceTick: '0.1', quantityStep: '0.1', minimumQuantity: '0.1', minimumNotional: '1', maxLeverage: 10 };
  await paper.setMarket(account.id, market);
  const xml = '<signal><action>LONG</action><pair>BTCUSDT</pair><entry_range><min>100</min><max>101</max></entry_range><targets><target id="1">110</target><target id="2">120</target></targets><stoploss>90</stoploss><leverage>1</leverage></signal>';
  await saveSignal(name, '-drain-proof', 1, xml, xml);
  const intent = await createTradingIntent({ sourceSignalId: name, channelId: '-drain-proof', signal: validateSignalXml(xml).execution });
  const engine = new TradingEngine([paper]);
  await engine.processIntent(intent.id);
  assert.equal((await getTradingIntent(intent.id)).status, 'monitoring');
  const entry = (await paper.openState(account)).orders.find(order => order.role === 'entry');
  assert.equal(entry.status, 'partially_filled');
  return { account, paper, engine, intent, entry, market };
}
async function drainCases() {
  const missing = await paperDrainFixture('missing-drain-sources');
  const original = missing.paper.openState.bind(missing.paper);
  missing.paper.openState = async account => { const state = await original(account); delete state.acquisition; return state; };
  let entryCancels = 0;
  const cancelMissing = missing.paper.cancelOrder.bind(missing.paper);
  missing.paper.cancelOrder = async (account, id) => { if (id === missing.entry.clientOrderId) entryCancels += 1; return cancelMissing(account, id); };
  await assert.rejects(missing.engine.cancelOpenEntries(missing.account.id), error => hasReason(error, 'ACQUISITION_MISSING'));
  assert.equal((await original(missing.account)).orders.find(order => order.role === 'entry').status, 'cancelled', 'A terminal cancel acknowledgement alone is not drained proof.');
  assert.equal((await getTradingAccount(missing.account.id)).killSwitchActive, true);
  assert.notEqual((await getDatabase().get('SELECT status FROM trading_positions WHERE intent_id = ?', [missing.intent.id])).status, 'closed');
  missing.paper.openState = original;
  assert.equal(await missing.engine.cancelOpenEntries(missing.account.id), 0, 'Fresh evidence proves drain without repeating the accepted cancellation.');
  assert.equal(entryCancels, 1);

  const raced = await paperDrainFixture('drain-fill-race');
  const cancel = raced.paper.cancelOrder.bind(raced.paper);
  raced.paper.cancelOrder = async (account, id) => {
    if (id === raced.entry.clientOrderId) {
      for (let step = 0; step < 100; step += 1) {
        const entry = (await raced.paper.openState(account)).orders.find(order => order.role === 'entry');
        if (entry.status === 'filled') break;
        await raced.paper.setMarket(account.id, raced.market);
      }
    }
    return cancel(account, id);
  };
  assert.equal(await raced.engine.cancelOpenEntries(raced.account.id), 1);
  const position = await getDatabase().get('SELECT status, quantity FROM trading_positions WHERE intent_id = ?', [raced.intent.id]);
  assert.deepEqual(position, { status: 'open', quantity: raced.entry.quantity }, 'Filled during cancel means protected owned exposure, not an empty account.');
  assert.equal((await raced.paper.openState(raced.account)).orders.filter(order => order.role === 'flatten').length, 0, 'Entry drain is not implicit flatten.');
  const stored = await getDatabase().get("SELECT details_json FROM trading_risk_events WHERE account_id = ? AND code = 'ENTRY_DRAIN_PROVED'", [raced.account.id]);
  assert.equal(JSON.parse(stored.details_json).proof.purpose, 'entriesDrained');
}

try {
  await initDb(path.join(directory, 'test.db'));
  await seedTradingFixtures();
  const good = await closingFixture();
  await good.engine.reconcileAccount(good.id);
  assert.deepEqual(await getDatabase().get('SELECT status, quantity FROM trading_positions WHERE id = ?', [good.id]),
    { status: 'closed', quantity: '0' }, 'The last proved fill closes a previously nonzero local projection.');
  const evidence = await getDatabase().get("SELECT details_json FROM trading_risk_events WHERE intent_id = ? AND code = 'TRADE_CLOSURE_PROVED'", [good.id]);
  const proof = JSON.parse(evidence.details_json).proof;
  assert.equal(proof.purpose, 'tradeClosed');
  assert.equal(proof.safe, true);
  assert.equal(proof.binding.accountId, good.id);
  assert.match(proof.evidenceHash, /^[0-9a-f]{64}$/);
  const closure = JSON.parse((await getDatabase().get("SELECT details_json FROM trading_execution_events WHERE intent_id=? AND event_type='position_closed'", [good.id])).details_json);
  assert.ok(Object.hasOwn(closure, 'realizedPnlValue'));
  assert.ok(Object.hasOwn(closure, 'reportingCurrency'));
  assert.ok(['complete', 'unresolved'].includes(closure.accountingStatus));
  if (closure.accountingStatus === 'unresolved') {
    assert.equal(closure.realizedPnl, null); assert.equal(closure.realizedPnlValue, null);
  } else {
    assert.equal(closure.realizedPnl, closure.realizedPnlValue.decimal);
    assert.ok(closure.reportingCurrency);
  }
  await good.engine.reconcileAccount(good.id);
  assert.equal((await getDatabase().get("SELECT COUNT(*) AS n FROM trading_risk_events WHERE intent_id = ? AND code = 'TRADE_CLOSURE_PROVED'", [good.id])).n, 1);

  await rejectIncompleteClosure(state => { delete state.acquisition; }, 'ACQUISITION_MISSING');
  for (const source of ['orders', 'positions', 'fills']) {
    await rejectIncompleteClosure(state => { state.acquisition.sources.find(item => item.source === source).completeness = 'partial'; },
      `SOURCE_${source.toUpperCase()}_INCOMPLETE`);
  }
  await rejectIncompleteClosure(state => {
    state.acquisition.startedAt -= 31_000; state.acquisition.completedAt -= 31_000;
    for (const source of state.acquisition.sources) { source.startedAt -= 31_000; source.completedAt -= 31_000; }
  }, 'ACQUISITION_NOT_FRESH');
  await rejectIncompleteClosure(state => {
    const source = state.acquisition.sources.find(item => item.source === 'fills');
    source.since = source.completedAt;
  }, 'FILL_BASELINE_UNPROVED');
  await rejectIncompleteClosure((_state, fixture) => { fixture.engine.mutations.fenceEntries(fixture.id); }, 'RUNTIME_GENERATION_CHANGED');
  await rejectIncompleteClosure((_state, fixture) => updateTradingAccountConfiguration(fixture.id, { maxConcurrentPositions: 9 }), 'ACCOUNT_STATE_CHANGED');
  await finalCommitRace('epoch');
  await finalCommitRace('account');
  await finalCommitRace('freshness');
  await drainCases();
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  console.log('Lifecycle safety: fresh closure/drain, partial sources, account/epoch commit rollback and cancel-fill race passed.');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
