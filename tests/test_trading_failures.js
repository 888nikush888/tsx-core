import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { TradingEngine } from '../src/trading_engine.js';
import { TradingRuntime } from '../src/trading_runtime.js';
import {
  createTradingStrategyDraft,
  createTradingIntent,
  ensureTradingDefaults,
  getTradingRuntimeState,
  getTradingIntent,
  listTradingAccounts,
  listTradingStrategies,
  publishTradingStrategyVersion,
  setTradingRoute,
  updateTradingRuntimeState,
} from '../src/trading_repository.js';
import { validateSignalXml } from '../src/signal_schema.js';
import { DEFAULT_STRATEGY_CONFIGURATION } from '../src/trading_strategy.js';

const SIGNAL = '<signal><action>LONG</action><pair>ETHUSDT</pair><entry_range><min>3000</min><max>3100</max></entry_range><targets><target id="1">3200</target><target id="2">3300</target></targets><stoploss>2900</stoploss></signal>';

async function setup(databasePath, trailingStopPercent = null) {
  await initDb(databasePath);
  await ensureTradingDefaults();
  const paper = new PaperExchangeAdapter();
  const [account] = await listTradingAccounts();
  let [strategy] = await listTradingStrategies();
  if (trailingStopPercent !== null) {
    const configuration = structuredClone(DEFAULT_STRATEGY_CONFIGURATION);
    configuration.exits.trailingStopPercent = trailingStopPercent;
    const draft = await createTradingStrategyDraft({ name: 'Trailing strategy', configuration });
    strategy = await publishTradingStrategyVersion(draft.id);
  }
  await setTradingRoute({ channelId: '-200001', strategyVersionId: strategy.id, accountId: account.id, enabled: true });
  await updateTradingRuntimeState({ executionEnabled: true });
  await paper.setMarket(account.id, {
    symbol: 'ETHUSDT', markPrice: '3000', priceTick: '0.1', quantityStep: '0.001',
    minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 25,
  });
  const signal = validateSignalXml(SIGNAL).execution;
  await saveSignal('failure-signal', '-200001', 1, SIGNAL, SIGNAL);
  const intent = await createTradingIntent({ sourceSignalId: 'failure-signal', channelId: '-200001', signal });
  return { paper, account, intent };
}

function wrappedAdapter(paper, submit) {
  return {
    exchange: 'paper',
    accountSnapshot: (...args) => paper.accountSnapshot(...args),
    marketSnapshot: (...args) => paper.marketSnapshot(...args),
    submitOrder: submit,
    cancelOrder: (...args) => paper.cancelOrder(...args),
    openState: (...args) => paper.openState(...args),
  };
}

async function testUnknownEntry(directory) {
  const { paper, account, intent } = await setup(path.join(directory, 'unknown-entry.db'));
  let submissions = 0;
  const adapter = wrappedAdapter(paper, async () => {
    submissions += 1;
    throw new Error('simulated submit timeout');
  });
  const engine = new TradingEngine([adapter]);
  await engine.processIntent(intent.id);
  assert.equal((await getTradingIntent(intent.id)).status, 'unknown');
  assert.equal((await getDatabase().get(
    `SELECT status FROM trading_orders WHERE intent_id = ? AND role = 'entry'`,
    [intent.id],
  )).status, 'unknown');
  await engine.processIntent(intent.id);
  assert.equal(submissions, 1, 'Unknown submit outcome must never be retried blindly.');
  assert.equal((await paper.openState(account)).positions.length, 0);
  await closeDb();
}

async function testProtectiveStopFailure(directory) {
  const { paper, account, intent } = await setup(path.join(directory, 'stop-failure.db'));
  const adapter = wrappedAdapter(paper, async (targetAccount, request) => {
    if (request.role === 'stop_loss') throw new Error('simulated protective stop timeout');
    return paper.submitOrder(targetAccount, request);
  });
  const engine = new TradingEngine([adapter]);
  await engine.processIntent(intent.id);
  assert.equal((await paper.openState(account)).positions.length, 0, 'Unprotected exposure must be flattened automatically.');
  const position = await getDatabase().get('SELECT * FROM trading_positions WHERE intent_id = ?', [intent.id]);
  assert.equal(position.status, 'closed');
  assert.equal(position.quantity, '0');
  assert.equal((await getTradingIntent(intent.id)).status, 'unknown');
  const event = await getDatabase().get(
    `SELECT code FROM trading_risk_events WHERE intent_id = ? AND code = 'EMERGENCY_FLATTENED'`,
    [intent.id],
  );
  assert.equal(event.code, 'EMERGENCY_FLATTENED');
  await closeDb();
}

async function testRuntimeStopWinsPendingIntentRace(directory) {
  const { paper, intent } = await setup(path.join(directory, 'runtime-stop-race.db'));
  let submissions = 0;
  const adapter = wrappedAdapter(paper, async (...args) => {
    submissions += 1;
    return paper.submitOrder(...args);
  });
  await updateTradingRuntimeState({ executionEnabled: false });
  const engine = new TradingEngine([adapter]);
  await engine.processIntent(intent.id);
  const stopped = await getTradingIntent(intent.id);
  assert.equal(submissions, 0, 'A dashboard stop must win the race against a persisted pending intent.');
  assert.equal(stopped.status, 'blocked');
  assert.equal(stopped.blockReason, 'EXECUTION_DISABLED');
  await closeDb();
}

async function testEntryTtlCancelsAndClosesEmptyPosition(directory) {
  const { paper, account, intent } = await setup(path.join(directory, 'entry-ttl.db'));
  await paper.setMarket(account.id, {
    symbol: 'ETHUSDT', markPrice: '4000', priceTick: '0.1', quantityStep: '0.001',
    minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 25,
  });
  const engine = new TradingEngine([paper]);
  await engine.processIntent(intent.id);
  assert.equal((await getDatabase().get(
    `SELECT status FROM trading_orders WHERE intent_id = ? AND role = 'entry'`, [intent.id],
  )).status, 'open');
  await engine.cancelExpiredEntries(Date.now() + 901_000);
  await engine.reconcileAccount(account.id);
  assert.equal((await getTradingIntent(intent.id)).status, 'failed');
  assert.equal((await getDatabase().get(
    'SELECT status FROM trading_positions WHERE intent_id = ?', [intent.id],
  )).status, 'closed');
  await closeDb();
}

async function testAdverseEntrySlippageFlattens(directory) {
  const { paper, intent } = await setup(path.join(directory, 'entry-slippage.db'));
  const roles = [];
  const adapter = wrappedAdapter(paper, async (_account, request) => {
    roles.push(request.role);
    return {
      clientOrderId: request.clientOrderId,
      exchangeOrderId: `fake-${request.role}`,
      status: 'filled',
      filledQuantity: request.quantity,
      averagePrice: request.role === 'entry' ? '3100' : '3090',
      error: null,
      raw: {},
    };
  });
  const engine = new TradingEngine([adapter]);
  await engine.processIntent(intent.id);
  const blocked = await getTradingIntent(intent.id);
  assert.deepEqual(roles, ['entry', 'flatten']);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blockReason, 'MAX_SLIPPAGE');
  assert.equal((await getDatabase().get(
    'SELECT status FROM trading_positions WHERE intent_id = ?', [intent.id],
  )).status, 'closed');
  await closeDb();
}

function orderResult(request, status, filledQuantity, averagePrice = null) {
  return {
    clientOrderId: request.clientOrderId,
    exchangeOrderId: `fake-${request.clientOrderId}`,
    status,
    filledQuantity,
    averagePrice,
    error: null,
    raw: {},
  };
}

function orderSnapshot(request, status, filledQuantity, averagePrice = null) {
  return {
    ...orderResult(request, status, filledQuantity, averagePrice),
    symbol: request.symbol,
    role: request.role,
    side: request.side,
    quantity: request.quantity,
    price: request.price,
    triggerPrice: request.triggerPrice,
    reduceOnly: request.reduceOnly,
  };
}

async function testPartialEntryProtectionAndTerminalResizing(directory) {
  const { paper, account, intent } = await setup(path.join(directory, 'partial-entry.db'));
  let entryRequest;
  let activeStop;
  let terminal = false;
  const submittedTakeProfits = [];
  const adapter = wrappedAdapter(paper, async (_targetAccount, request) => {
    if (request.role === 'entry') {
      entryRequest = request;
      return orderResult(request, 'partially_filled', '0.1', '3050');
    }
    if (request.role === 'stop_loss') {
      activeStop = request;
      return orderResult(request, 'open', '0');
    }
    if (request.role === 'take_profit') {
      submittedTakeProfits.push(request);
      return orderResult(request, 'open', '0');
    }
    throw new Error(`Unexpected ${request.role} submission.`);
  });
  adapter.cancelOrder = async (_targetAccount, clientOrderId) => {
    assert.equal(clientOrderId, activeStop.clientOrderId);
    return orderResult(activeStop, 'cancelled', '0');
  };
  adapter.openState = async () => ({
    orders: terminal
      ? [
        orderSnapshot(entryRequest, 'cancelled', '0.1', '3050'),
        orderSnapshot(activeStop, 'open', '0'),
      ]
      : [],
    positions: terminal
      ? [{ symbol: 'ETHUSDT', side: 'LONG', quantity: '0.1', averageEntryPrice: '3050', unrealizedPnl: '0' }]
      : [],
    fills: [],
    observedAt: Date.now(),
  });
  const engine = new TradingEngine([adapter]);
  await engine.processIntent(intent.id);
  assert.equal(activeStop.quantity, '0.327', 'An open partial entry must be protected up to its full possible quantity.');
  assert.equal(submittedTakeProfits.length, 0, 'Take profits must wait until the entry quantity is terminal.');
  assert.equal((await getDatabase().get(
    'SELECT quantity FROM trading_positions WHERE intent_id = ?', [intent.id],
  )).quantity, '0.1');

  terminal = true;
  await engine.reconcileAccount(account.id);
  assert.equal(activeStop.quantity, '0.1', 'The protective stop must shrink to the final partial position.');
  assert.deepEqual(
    submittedTakeProfits.map(order => order.quantity),
    ['0.05', '0.05'],
    'Take profits must be rescaled to exactly the terminal filled quantity.',
  );
  await closeDb();
}

async function testTrailingStopOnlyMovesTowardProfit(directory) {
  const { paper, account, intent } = await setup(path.join(directory, 'trailing-stop.db'), '2');
  const engine = new TradingEngine([paper]);
  await engine.processIntent(intent.id);
  await paper.setMarket(account.id, {
    symbol: 'ETHUSDT', markPrice: '3150', priceTick: '0.1', quantityStep: '0.001',
    minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 25,
  });
  await engine.reconcileAccount(account.id);
  let state = await paper.openState(account);
  assert.equal(
    state.orders.find(order => order.role === 'stop_loss' && order.status === 'open').triggerPrice,
    '3087',
    'A configured trailing stop must follow a favorable mark price.',
  );
  await paper.setMarket(account.id, {
    symbol: 'ETHUSDT', markPrice: '3100', priceTick: '0.1', quantityStep: '0.001',
    minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 25,
  });
  await engine.reconcileAccount(account.id);
  state = await paper.openState(account);
  assert.equal(
    state.orders.find(order => order.role === 'stop_loss' && order.status === 'open').triggerPrice,
    '3087',
    'A trailing stop must never move backward when the market retraces.',
  );
  await closeDb();
}

async function testPeriodicReconciliationFailureActivatesKillSwitch(directory) {
  await initDb(path.join(directory, 'periodic-reconciliation.db'));
  await ensureTradingDefaults();
  await updateTradingRuntimeState({ executionEnabled: true });
  const engine = {
    reconcileAccount: async () => { throw new Error('simulated periodic exchange outage'); },
    cancelExpiredEntries: async () => 0,
    processIntent: async () => undefined,
  };
  const runtime = new TradingRuntime(engine);
  await assert.rejects(runtime.runOnce(false), /simulated periodic exchange outage/);
  const state = await getTradingRuntimeState();
  assert.equal(state.executionEnabled, false);
  assert.equal(state.killSwitchActive, true);
  assert.match(state.killSwitchReason, /Periodic reconciliation failed/);
  await closeDb();
}

async function run() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'trading-failures-'));
  try {
    await testUnknownEntry(directory);
    await testProtectiveStopFailure(directory);
    await testRuntimeStopWinsPendingIntentRace(directory);
    await testEntryTtlCancelsAndClosesEmptyPosition(directory);
    await testAdverseEntrySlippageFlattens(directory);
    await testPartialEntryProtectionAndTerminalResizing(directory);
    await testTrailingStopOnlyMovesTowardProfit(directory);
    await testPeriodicReconciliationFailureActivatesKillSwitch(directory);
  } finally {
    await closeDb();
    await rm(directory, { recursive: true, force: true });
  }
  console.log('Trading failure-policy tests passed.');
}

await run();
