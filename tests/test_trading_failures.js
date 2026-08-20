import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { TradingEngine } from '../src/trading_engine.js';
import { TradingRuntime } from '../src/trading_runtime.js';
import {
  createTradingAccount,
  createTradingStrategyDraft,
  createTradingIntent,
  getTradingRuntimeState,
  getTradingIntent,
  listTradingAccounts,
  listTradingStrategies,
  publishTradingStrategyVersion,
  setTradingRoute,
  updateTradingRuntimeState,
  updateTradingAccountState,
} from '../src/trading_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { validateSignalXml } from '../src/signal_schema.js';
import { DEFAULT_STRATEGY_CONFIGURATION } from '../src/trading_strategy.js';

const SIGNAL = '<signal><action>LONG</action><pair>ETHUSDT</pair><entry_range><min>3000</min><max>3100</max></entry_range><targets><target id="1">3200</target><target id="2">3300</target></targets><stoploss>2900</stoploss></signal>';

async function setup(databasePath, trailingStopPercent = null) {
  await initDb(databasePath);
  await seedTradingFixtures();
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

function wrappedAdapter(paper, submit, submitProtectedEntry = null) {
  return {
    exchange: 'paper',
    accountSnapshot: (...args) => paper.accountSnapshot(...args),
    marketSnapshot: (...args) => paper.marketSnapshot(...args),
    submitOrder: submit,
    submitProtectedEntry: submitProtectedEntry || (async (account, entry, protectiveStop) => {
      const entryResult = await submit(account, entry);
      const stopResult = await submit(account, protectiveStop);
      return { entry: entryResult, protectiveStop: stopResult };
    }),
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
  const submit = (...args) => paper.submitOrder(...args);
  const adapter = wrappedAdapter(paper, submit, async (targetAccount, entry, protectiveStop) => ({
    entry: await paper.submitOrder(targetAccount, entry),
    protectiveStop: {
      clientOrderId: protectiveStop.clientOrderId,
      exchangeOrderId: '',
      status: 'rejected',
      filledQuantity: '0',
      averagePrice: null,
      error: 'simulated provider-native protective stop rejection',
    },
  }));
  const engine = new TradingEngine([adapter]);
  await engine.processIntent(intent.id);
  assert.equal((await paper.openState(account)).positions.length, 0, 'Unprotected exposure must be flattened automatically.');
  const position = await getDatabase().get('SELECT * FROM trading_positions WHERE intent_id = ?', [intent.id]);
  assert.equal(position.status, 'emergency', 'A submitted flatten remains unsafe until exchange reconciliation proves closure.');
  assert.notEqual(position.quantity, '0');
  assert.equal((await getTradingIntent(intent.id)).status, 'unknown');
  const event = await getDatabase().get(
    `SELECT code FROM trading_risk_events WHERE intent_id = ? AND code = 'EMERGENCY_FLATTEN_PENDING_RECONCILIATION'`,
    [intent.id],
  );
  assert.equal(event.code, 'EMERGENCY_FLATTEN_PENDING_RECONCILIATION');
  await engine.reconcileAccount(account.id);
  const reconciled = await getDatabase().get(
    'SELECT status, quantity, realized_pnl FROM trading_positions WHERE intent_id = ?', [intent.id],
  );
  assert.equal(reconciled.status, 'closed');
  assert.equal(reconciled.quantity, '0');
  assert.notEqual(reconciled.realized_pnl, null, 'Closure PnL must be derived only after terminal fills reconcile.');
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

async function testStalePendingIntentNeverSubmits(directory) {
  const { paper, intent } = await setup(path.join(directory, 'stale-pending-intent.db'));
  await getDatabase().run(
    'UPDATE trading_trade_intents SET created_at = ?, updated_at = ? WHERE id = ?',
    [Date.now() - 901_000, Date.now() - 901_000, intent.id],
  );
  let submissions = 0;
  const adapter = wrappedAdapter(paper, async (...args) => {
    submissions += 1;
    return paper.submitOrder(...args);
  });
  await new TradingEngine([adapter]).processIntent(intent.id);
  const expired = await getTradingIntent(intent.id);
  assert.equal(submissions, 0, 'A stale pending intent must never reach order submission.');
  assert.equal(expired.status, 'blocked');
  assert.equal(expired.blockReason, 'ENTRY_INTENT_EXPIRED');
  assert.deepEqual(
    await getDatabase().get('SELECT severity, code FROM trading_risk_events WHERE intent_id = ?', [intent.id]),
    { severity: 'warning', code: 'ENTRY_INTENT_EXPIRED' },
  );
  await closeDb();
}

async function testUnavailableMarketFailureIsolation(directory) {
  const strict = await setup(path.join(directory, 'unavailable-market-strict.db'));
  const strictAdapter = {
    ...wrappedAdapter(strict.paper, (...args) => strict.paper.submitOrder(...args)),
    marketSnapshot: async () => {
      throw new Error('Exchange executor request failed (400): Hyperliquid symbol ETH is unavailable.');
    },
  };
  await new TradingEngine([strictAdapter]).processIntent(strict.intent.id);
  assert.equal((await getTradingIntent(strict.intent.id)).status, 'unknown');
  assert.deepEqual(
    await getDatabase().get('SELECT severity, code FROM trading_risk_events WHERE intent_id = ?', [strict.intent.id]),
    { severity: 'critical', code: 'ORDER_OUTCOME_UNKNOWN' },
  );
  await closeDb();

  const isolated = await setup(path.join(directory, 'unavailable-market-isolated.db'));
  const isolatedAdapter = {
    ...wrappedAdapter(isolated.paper, (...args) => isolated.paper.submitOrder(...args)),
    marketSnapshot: async () => {
      throw new Error('Exchange executor request failed (400): Hyperliquid symbol ETH is unavailable.');
    },
  };
  await new TradingEngine(
    [isolatedAdapter],
    () => undefined,
    undefined,
    { isolateUnavailableMarketFailures: true },
  ).processIntent(isolated.intent.id);
  const intent = await getTradingIntent(isolated.intent.id);
  assert.equal(intent.status, 'blocked');
  assert.equal(intent.blockReason, 'SYMBOL_UNAVAILABLE');
  assert.equal(intent.plan, null, 'An unavailable market must be rejected before an order plan exists.');
  assert.equal(
    Number((await getDatabase().get('SELECT COUNT(*) AS count FROM trading_orders WHERE intent_id = ?', [isolated.intent.id])).count),
    0,
    'An unavailable market must never reach order submission.',
  );
  assert.deepEqual(
    await getDatabase().get('SELECT severity, code FROM trading_risk_events WHERE intent_id = ?', [isolated.intent.id]),
    { severity: 'warning', code: 'SYMBOL_UNAVAILABLE' },
  );
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
  assert.deepEqual(roles, ['entry', 'stop_loss', 'flatten']);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blockReason, 'MAX_SLIPPAGE');
  assert.equal((await getDatabase().get(
    'SELECT status FROM trading_positions WHERE intent_id = ?', [intent.id],
  )).status, 'emergency');
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
  const submittedStops = new Map();
  let terminal = false;
  const submittedTakeProfits = [];
  const adapter = wrappedAdapter(paper, async (_targetAccount, request) => {
    if (request.role === 'entry') {
      entryRequest = request;
      return orderResult(request, 'partially_filled', '0.1', '3050');
    }
    if (request.role === 'stop_loss') {
      activeStop = request;
      submittedStops.set(request.clientOrderId, request);
      return orderResult(request, 'open', '0');
    }
    if (request.role === 'take_profit') {
      submittedTakeProfits.push(request);
      return orderResult(request, 'open', '0');
    }
    throw new Error(`Unexpected ${request.role} submission.`);
  });
  adapter.cancelOrder = async (_targetAccount, clientOrderId) => {
    const cancelled = submittedStops.get(clientOrderId);
    assert.ok(cancelled, 'Only a previously confirmed stop may be cancelled.');
    assert.notEqual(clientOrderId, activeStop.clientOrderId, 'Replacement must be active before the stale stop is cancelled.');
    return orderResult(cancelled, 'cancelled', '0');
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
  assert.equal(entryRequest.maxSlippagePercent, '0.5', 'Entry requests must carry the provider-side slippage budget.');
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
  await seedTradingFixtures();
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

async function testEntryExpiryFailureActivatesKillSwitch(directory) {
  await initDb(path.join(directory, 'entry-expiry-failure.db'));
  await seedTradingFixtures();
  await updateTradingRuntimeState({ executionEnabled: true });
  const engine = {
    reconcileAccount: async () => undefined,
    cancelExpiredEntries: async () => { throw new Error('simulated expiry cancellation outage'); },
    processIntent: async () => undefined,
  };
  const runtime = new TradingRuntime(engine);
  await assert.rejects(runtime.runOnce(false), /entry-expiry.*simulated expiry cancellation outage/);
  assert.equal((await getTradingRuntimeState()).killSwitchActive, true);
  await closeDb();
}

async function testRuntimeIsolatesAccountFailures(directory) {
  await initDb(path.join(directory, 'runtime-account-isolation.db'));
  await seedTradingFixtures();
  const first = (await listTradingAccounts())[0];
  await getDatabase().run(
    `INSERT INTO trading_accounts (
       id, name, exchange, mode, status, enabled, created_at, updated_at
     ) VALUES ('paper-secondary', 'Secondary paper', 'paper', 'paper', 'ready', 1, ?, ?)`,
    [Date.now() + 1, Date.now() + 1],
  );
  await updateTradingRuntimeState({ executionEnabled: true });
  const calls = [];
  const engine = {
    reconcileAccount: async accountId => {
      calls.push(accountId);
      if (accountId === first.id) throw new Error('first account unavailable');
    },
    cancelExpiredEntries: async () => 0,
    processIntent: async () => undefined,
  };
  const runtime = new TradingRuntime(engine);
  await assert.rejects(runtime.runOnce(false), /first account unavailable/);
  assert.deepEqual(calls, [first.id, 'paper-secondary'], 'One account failure must not skip protection for later accounts.');
  assert.equal(runtime.isProtectionHealthy(), false);
  await closeDb();
}

async function testStopReplacementCancellationFailsClosed(directory) {
  const { paper, account, intent } = await setup(path.join(directory, 'stop-replacement-cancel.db'), '2');
  const adapter = wrappedAdapter(paper, (...args) => paper.submitOrder(...args));
  adapter.cancelOrder = async () => { throw new Error('simulated stale-stop cancellation timeout'); };
  const engine = new TradingEngine([adapter]);
  await engine.processIntent(intent.id);
  await paper.setMarket(account.id, {
    symbol: 'ETHUSDT', markPrice: '3150', priceTick: '0.1', quantityStep: '0.001',
    minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 25,
  });

  await assert.rejects(
    engine.reconcileAccount(account.id),
    /replacement stop is active but the stale stop outcome is unresolved/i,
  );
  const state = await getTradingRuntimeState();
  assert.equal(state.executionEnabled, false);
  assert.equal(state.killSwitchActive, true);
  assert.match(state.killSwitchReason, /Protective stop cancellation is unresolved/);
  assert.equal(
    (await getDatabase().get(
      `SELECT COUNT(*) AS count FROM trading_risk_events
       WHERE intent_id = ? AND code = 'STOP_REPLACEMENT_CANCEL_UNRESOLVED'`,
      [intent.id],
    )).count,
    1,
  );
  assert.equal(
    (await paper.openState(account)).orders.filter(order => order.role === 'stop_loss' && order.status === 'open').length,
    2,
    'Both confirmed stops must remain tracked when stale-stop cancellation is unresolved.',
  );
  await closeDb();
}

async function testRemoteAccountIdentityBinding(directory) {
  await initDb(path.join(directory, 'remote-account-identity.db'));
  await seedTradingFixtures();
  const boundIdentity = 'a'.repeat(64);
  const account = await createTradingAccount({
    name: 'Bound Bybit', exchange: 'bybit', mode: 'testnet', credentialRef: 'managed-secret',
  });
  await updateTradingAccountState(account.id, {
    status: 'ready', enabled: true, verifiedAt: Date.now(), externalAccountId: boundIdentity,
  });
  let observedIdentity = boundIdentity;
  const adapter = {
    exchange: 'bybit',
    openState: async () => ({
      orders: [], positions: [], fills: [], observedAt: Date.now(), accountFingerprint: observedIdentity,
    }),
  };
  const engine = new TradingEngine([adapter]);
  await engine.reconcileAccount(account.id);
  observedIdentity = 'b'.repeat(64);
  await assert.rejects(
    engine.reconcileAccount(account.id),
    /does not match the bound external account identity/,
  );
  const state = await getTradingRuntimeState();
  assert.equal(state.killSwitchActive, true);
  assert.equal(state.executionEnabled, false);
  await closeDb();
}

async function testProtectionOnlyStartupRequiresExplicitEntryEnable(directory) {
  const { paper, intent } = await setup(path.join(directory, 'protection-only-startup.db'));
  const runtime = new TradingRuntime(new TradingEngine([paper]), 60_000);
  await runtime.startProtectionOnly();
  assert.equal(runtime.isProtectionHealthy(), true);
  assert.equal((await getTradingIntent(intent.id)).status, 'pending', 'Protection-only startup must not consume pending intents.');
  await updateTradingRuntimeState({ executionEnabled: false });
  await assert.rejects(runtime.enableEntries(), /execution is disabled or the kill switch is active/);
  await updateTradingRuntimeState({ executionEnabled: true });
  await runtime.enableEntries();
  runtime.disableEntries();
  await runtime.runOnce(false);
  assert.equal((await getTradingIntent(intent.id)).status, 'pending', 'An explicitly closed entry latch must preserve pending intents.');
  await runtime.enableEntries();
  await updateTradingRuntimeState({ executionEnabled: false });
  await runtime.runOnce(false);
  assert.equal((await getTradingIntent(intent.id)).status, 'pending', 'A stopped control plane must disable entry processing.');
  await updateTradingRuntimeState({ executionEnabled: true });
  await runtime.enableEntries();
  await runtime.runOnce(false);
  assert.equal((await getTradingIntent(intent.id)).status, 'monitoring');
  await runtime.stop();
  await closeDb();
}

async function testClockDriftBlocksEveryEntryPath(directory) {
  const unsafeClock = {
    sample: () => ({
      healthy: false,
      driftMilliseconds: 1_500,
      maxDriftMilliseconds: 1_000,
      checkedAt: Date.now(),
      reason: 'simulated unsafe clock drift',
    }),
  };
  const direct = await setup(path.join(directory, 'clock-drift-direct.db'));
  const engine = new TradingEngine([direct.paper], () => undefined, unsafeClock);
  await engine.processIntent(direct.intent.id);
  const blocked = await getTradingIntent(direct.intent.id);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blockReason, 'CLOCK_DRIFT_UNSAFE');
  assert.equal((await getTradingRuntimeState()).killSwitchActive, true);
  await closeDb();

  await initDb(path.join(directory, 'clock-drift-runtime.db'));
  await seedTradingFixtures();
  await updateTradingRuntimeState({ executionEnabled: true });
  const runtime = new TradingRuntime({
    reconcileAccount: async () => undefined,
    cancelExpiredEntries: async () => 0,
    processIntent: async () => undefined,
  }, 60_000, () => undefined, unsafeClock);
  await runtime.startProtectionOnly();
  await assert.rejects(runtime.enableEntries(), /simulated unsafe clock drift/);
  const runtimeState = await getTradingRuntimeState();
  assert.equal(runtimeState.executionEnabled, false);
  assert.equal(runtimeState.killSwitchActive, true);
  assert.match(runtimeState.killSwitchReason, /clock drift exceeded/i);
  await runtime.stop();
  await closeDb();
}

async function testAccountDailyRiskIncludesExistingLoss(directory) {
  const { paper, account, intent } = await setup(path.join(directory, 'account-daily-risk.db'));
  const now = Date.now();
  await getDatabase().run(
    `UPDATE trading_trade_intents SET status = 'completed', updated_at = ? WHERE id = ?`,
    [now, intent.id],
  );
  await getDatabase().run(
    `INSERT INTO trading_positions (
       id, intent_id, account_id, strategy_version_id, channel_id, symbol, side,
       status, quantity, average_entry_price, stop_price, realized_pnl,
       opened_at, closed_at, updated_at
     ) VALUES ('historical-loss', ?, ?, ?, ?, 'OLDUSDT', 'LONG',
               'closed', '0', '100', '90', '-50', ?, ?, ?)`,
    [intent.id, account.id, intent.strategyVersionId, intent.channelId, now - 1_000, now, now],
  );
  await saveSignal('daily-risk-signal', '-200001', 2, SIGNAL, SIGNAL);
  const next = await createTradingIntent({
    sourceSignalId: 'daily-risk-signal', channelId: '-200001', signal: validateSignalXml(SIGNAL).execution,
  });
  await new TradingEngine([paper]).processIntent(next.id);
  const blocked = await getTradingIntent(next.id);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blockReason, 'MAX_DAILY_RISK');
  assert.equal(
    (await getDatabase().get('SELECT COUNT(*) AS count FROM trading_orders WHERE intent_id = ?', [next.id])).count,
    0,
    'Daily account loss and the new risk reservation must be checked before persisting or submitting orders.',
  );
  await closeDb();
}

async function testAccountDailyRiskIncludesFundingLoss(directory) {
  const { paper, intent } = await setup(path.join(directory, 'account-funding-risk.db'));
  const adapter = wrappedAdapter(paper, (...args) => paper.submitOrder(...args));
  adapter.accountSnapshot = async account => ({
    ...await paper.accountSnapshot(account),
    fundingPnlToday: '-90',
  });
  await new TradingEngine([adapter]).processIntent(intent.id);
  const blocked = await getTradingIntent(intent.id);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blockReason, 'MAX_DAILY_RISK');
  assert.equal(
    (await getDatabase().get('SELECT COUNT(*) AS count FROM trading_orders WHERE intent_id = ?', [intent.id])).count,
    0,
    'Funding losses must reduce the remaining daily risk budget before order persistence.',
  );
  await closeDb();
}

async function testRuntimeLifecycleAndDefaultFailureLogger(directory) {
  await initDb(path.join(directory, 'runtime-lifecycle.db'));
  await seedTradingFixtures();
  let reconciliations = 0;
  const engine = {
    reconcileAccount: async () => {
      reconciliations += 1;
      if (reconciliations === 2) throw new Error('scheduled failure handled by default logger');
    },
    cancelExpiredEntries: async () => 0,
    processIntent: async () => undefined,
  };
  assert.throws(() => new TradingRuntime(engine, 249), /interval must be between 250 and 60000/);
  await assert.rejects(new TradingRuntime(engine).enableEntries(), /runtime is not running/);
  const runtime = new TradingRuntime(engine, 60_000);
  await runtime.start();
  runtime.wake();
  await runtime.stop();
  assert.equal(reconciliations, 2);
  await closeDb();
}

async function waitForCondition(predicate, message) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function testExchangeStreamAcceleratesAuthoritativeReconciliation(directory) {
  await initDb(path.join(directory, 'runtime-exchange-stream.db'));
  await seedTradingFixtures();
  const account = await createTradingAccount({
    name: 'Stream Bybit', exchange: 'bybit', mode: 'testnet', credentialRef: 'managed-stream',
  });
  await updateTradingAccountState(account.id, {
    status: 'ready', enabled: true, verifiedAt: Date.now(), externalAccountId: 'stream-account',
  });
  const reconciliations = [];
  let emitted = false;
  const engine = {
    reconcileAccount: async (accountId, options) => { reconciliations.push([accountId, options?.force]); },
    cancelExpiredEntries: async () => 0,
    processIntent: async () => undefined,
    pollAccountStream: async () => {
      if (emitted) return null;
      emitted = true;
      const now = Date.now();
      return {
        account: { ...account, status: 'ready', enabled: true },
        batch: {
          events: [{
            cursor: 1,
            eventKey: 'c'.repeat(64),
            eventType: 'order',
            symbol: 'BTCUSDT',
            sequence: 1,
            occurredAt: now,
            receivedAt: now,
            payload: { orderId: 'stream-order' },
          }],
          nextCursor: 1,
          gap: false,
          health: { status: 'healthy', startedAt: now, lastEventAt: now, lastError: null },
        },
      };
    },
  };
  const runtime = new TradingRuntime(engine, 60_000);
  await runtime.startProtectionOnly();
  await waitForCondition(async () => {
    const event = await getDatabase().get(
      'SELECT id FROM trading_exchange_events WHERE account_id = ?', [account.id],
    );
    return Boolean(event) && reconciliations.some(([id, force]) => id === account.id && force === true);
  }, 'WebSocket state event did not trigger authoritative forced reconciliation.');
  assert.ok(
    reconciliations.some(([id, force]) => id === account.id && force === true),
    'State-bearing stream events must accelerate a forced REST reconciliation.',
  );
  await runtime.stop();
  const streamState = await getDatabase().get(
    'SELECT status FROM trading_exchange_stream_state WHERE account_id = ?', [account.id],
  );
  assert.equal(streamState.status, 'stopped');
  await closeDb();
}

async function testStartupReconciliationFailureKeepsControlPlaneAvailable(directory) {
  await initDb(path.join(directory, 'startup-reconciliation.db'));
  await seedTradingFixtures();
  await updateTradingRuntimeState({ executionEnabled: true });
  const logs = [];
  const engine = {
    reconcileAccount: async () => { throw new Error('simulated unmanaged startup exposure'); },
    cancelExpiredEntries: async () => 0,
    processIntent: async () => undefined,
  };
  const runtime = new TradingRuntime(engine, 60_000, message => logs.push(message));

  await runtime.start();

  const state = await getTradingRuntimeState();
  assert.equal(state.executionEnabled, false);
  assert.equal(state.killSwitchActive, true);
  assert.match(state.killSwitchReason, /Startup reconciliation failed/);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /trading remains fail-closed and will retry/);
  await assert.rejects(runtime.enableEntries(), /protection has not reached a healthy reconciliation latch/);
  await runtime.stop();
  await closeDb();
}

async function testUnmanagedExposureAndOperatorFlatten(directory) {
  const unmanaged = await setup(path.join(directory, 'unmanaged-exposure.db'));
  const unmanagedAdapter = wrappedAdapter(unmanaged.paper, (...args) => unmanaged.paper.submitOrder(...args));
  unmanagedAdapter.openState = async () => ({
    orders: [{
      clientOrderId: `0x${'9'.repeat(32)}`, exchangeOrderId: 'external-1', status: 'open',
      filledQuantity: '0', averagePrice: null, error: null, raw: {}, symbol: 'ETHUSDT',
      role: 'entry', side: 'buy', quantity: '1', price: '3000', triggerPrice: null, reduceOnly: false,
    }],
    positions: [], fills: [], observedAt: Date.now(),
  });
  await assert.rejects(
    new TradingEngine([unmanagedAdapter]).reconcileAccount(unmanaged.account.id),
    /Unmanaged remote order or position/,
  );
  assert.equal((await getTradingRuntimeState()).killSwitchActive, true);
  await closeDb();

  const absent = await setup(path.join(directory, 'unconfirmed-position-absence.db'));
  const absentAdapter = wrappedAdapter(absent.paper, (...args) => absent.paper.submitOrder(...args));
  const absenceEngine = new TradingEngine([absentAdapter]);
  await absenceEngine.processIntent(absent.intent.id);
  absentAdapter.openState = async () => ({ orders: [], positions: [], fills: [], observedAt: Date.now() });
  await assert.rejects(
    absenceEngine.reconcileAccount(absent.account.id),
    /absent without terminal fill proof/,
  );
  const retained = await getDatabase().get(
    'SELECT status, quantity FROM trading_positions WHERE intent_id = ?', [absent.intent.id],
  );
  assert.equal(retained.status, 'open');
  assert.notEqual(retained.quantity, '0', 'A missing snapshot must never close local ownership without terminal fills.');
  await closeDb();

  const managed = await setup(path.join(directory, 'operator-flatten.db'));
  const engine = new TradingEngine([managed.paper]);
  await engine.processIntent(managed.intent.id);
  assert.equal(await engine.emergencyFlattenManaged(managed.account.id), 1);
  assert.equal((await managed.paper.openState(managed.account)).positions.length, 0);
  await closeDb();
}

async function run() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'trading-failures-'));
  try {
    await testUnknownEntry(directory);
    await testProtectiveStopFailure(directory);
    await testRuntimeStopWinsPendingIntentRace(directory);
    await testStalePendingIntentNeverSubmits(directory);
    await testUnavailableMarketFailureIsolation(directory);
    await testEntryTtlCancelsAndClosesEmptyPosition(directory);
    await testAdverseEntrySlippageFlattens(directory);
    await testPartialEntryProtectionAndTerminalResizing(directory);
    await testTrailingStopOnlyMovesTowardProfit(directory);
    await testStopReplacementCancellationFailsClosed(directory);
    await testPeriodicReconciliationFailureActivatesKillSwitch(directory);
    await testEntryExpiryFailureActivatesKillSwitch(directory);
    await testRuntimeIsolatesAccountFailures(directory);
    await testRemoteAccountIdentityBinding(directory);
    await testProtectionOnlyStartupRequiresExplicitEntryEnable(directory);
    await testClockDriftBlocksEveryEntryPath(directory);
    await testAccountDailyRiskIncludesExistingLoss(directory);
    await testAccountDailyRiskIncludesFundingLoss(directory);
    await testRuntimeLifecycleAndDefaultFailureLogger(directory);
    await testExchangeStreamAcceleratesAuthoritativeReconciliation(directory);
    await testStartupReconciliationFailureKeepsControlPlaneAvailable(directory);
    await testUnmanagedExposureAndOperatorFlatten(directory);
  } finally {
    await closeDb();
    await rm(directory, { recursive: true, force: true });
  }
  console.log('Trading failure-policy tests passed.');
}

await run();
