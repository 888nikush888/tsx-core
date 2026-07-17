import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  closeDb,
  getDatabase,
  initDb,
  saveSignal,
} from '../src/db.js';
import {
  addDecimal,
  compareDecimal,
  decimal,
  divideDecimal,
  midpointDecimal,
  multiplyDecimal,
  subtractDecimal,
} from '../src/trading_decimal.js';
import {
  DEFAULT_STRATEGY_CONFIGURATION,
  validateStrategyConfiguration,
} from '../src/trading_strategy.js';
import { allocateTargetQuantities, createTradingPlan } from '../src/trading_risk.js';
import {
  createTradingIntent,
  createTradingAccount,
  createTradingStrategyDraft,
  archiveTradingStrategyVersion,
  deleteTradingAccount,
  deleteTradingRoute,
  ensureTradingDefaults,
  getTradingOverview,
  getTradingOperationalSnapshot,
  listTradingAccounts,
  listTradingActivity,
  listTradingIntents,
  listTradingRoutes,
  listTradingStrategies,
  publishTradingStrategyVersion,
  setTradingRoute,
  updateTradingRuntimeState,
  updateTradingAccountState,
  updateTradingStrategyDraft,
} from '../src/trading_repository.js';
import { validateSignalXml } from '../src/signal_schema.js';

const STANDARD_SIGNAL = `<signal>
<action>LONG</action>
<pair>BTCUSDT</pair>
<entry_range><min>60000</min><max>61000</max></entry_range>
<targets><target id="1">62000</target><target id="2">63000</target></targets>
<stoploss>59000</stoploss>
<leverage>3</leverage>
</signal>`;

function configuration(risk = '1') {
  return structuredClone({
    ...DEFAULT_STRATEGY_CONFIGURATION,
    sizing: { ...DEFAULT_STRATEGY_CONFIGURATION.sizing, riskPerTradePercent: risk },
  });
}

function invalidConfiguration(change, expected) {
  const candidate = configuration();
  change(candidate);
  assert.throws(() => validateStrategyConfiguration(candidate), expected);
}

function testDecimalAndStrategyContracts() {
  assert.throws(() => decimal('001'), /Invalid unsigned decimal/);
  assert.equal(decimal('1.2300'), '1.23');
  assert.equal(compareDecimal('1.10', '1.1'), 0);
  assert.equal(addDecimal('0.1', '0.2'), '0.3');
  assert.equal(subtractDecimal('5', '1.25'), '3.75');
  assert.equal(multiplyDecimal('1.25', '4'), '5');
  assert.equal(divideDecimal('1', '8'), '0.125');
  assert.equal(midpointDecimal({ min: '60000', max: '61000' }), '60500');
  assert.throws(() => subtractDecimal('1', '2'), /negative/);

  const invalidAllocation = configuration();
  invalidAllocation.exits.targetAllocationsPercent = ['50', '49'];
  assert.throws(() => validateStrategyConfiguration(invalidAllocation), /exactly 100/);
  const invalidStopPolicy = configuration();
  invalidStopPolicy.safety.requireProtectiveStop = false;
  assert.throws(() => validateStrategyConfiguration(invalidStopPolicy), /mandatory/);
  const invalidRemainderPolicy = configuration();
  invalidRemainderPolicy.exits.closeRemainderAtLastTarget = false;
  assert.throws(() => validateStrategyConfiguration(invalidRemainderPolicy), /full remainder.*mandatory/);
  invalidConfiguration(value => { value.schemaVersion = 2; }, /Unsupported strategy schema/);
  invalidConfiguration(value => { value.unsupported = true; }, /unsupported fields/);
  invalidConfiguration(value => { value.allowedSignalSchemas = []; }, /supported executable signal schema/);
  invalidConfiguration(value => { value.allowedSignalSchemas = ['standard', 'STANDARD']; }, /duplicates/);
  invalidConfiguration(value => { value.allowedSymbols = ['BTC-USDT']; }, /invalid normalized symbol/);
  invalidConfiguration(value => { value.allowedSides = []; }, /LONG and\/or SHORT/);
  invalidConfiguration(value => { value.entry.orderType = 'stop'; }, /market or limit/);
  invalidConfiguration(value => { value.entry.rangePrice = 'outside'; }, /rangePrice/);
  invalidConfiguration(value => { value.entry.postOnly = 'yes'; }, /postOnly must be boolean/);
  invalidConfiguration(value => { value.entry.orderType = 'market'; value.entry.postOnly = true; }, /cannot be post-only/);
  invalidConfiguration(value => { value.entry.timeoutSeconds = 31; }, /between 2 and 30/);
  invalidConfiguration(value => { value.sizing.maxLeverage = 0; }, /between 1 and 50/);
  invalidConfiguration(value => { value.exits.targetAllocationsPercent = '100'; }, /one and twenty/);
  invalidConfiguration(value => { value.exits.trailingStopPercent = '21'; }, /must not exceed/);
  invalidConfiguration(value => { value.safety.maxSlippagePercent = '6'; }, /must not exceed/);
  invalidConfiguration(value => { value.safety.entryOrderTtlSeconds = 9; }, /between 10 and 86400/);

}

function planInput(executable) {
  return {
    intentId: 'risk-contract',
    signal: executable,
    strategy: configuration(),
    account: { equity: '10000', availableBalance: '10000' },
    market: {
      symbol: 'BTCUSDT', markPrice: '60000', priceTick: '0.1', quantityStep: '0.001',
      minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 20, observedAt: Date.now(),
    },
  };
}

function testTradingPlanContracts() {
  const executable = validateSignalXml(STANDARD_SIGNAL, 'default').execution;
  const input = planInput(executable);
  const baselinePlan = createTradingPlan(input);
  assert.equal(baselinePlan.symbol, 'BTCUSDT');
  assert.equal(baselinePlan.entryPrice, '60500');
  assert.equal(baselinePlan.orders[0].side, 'buy');
  assert.equal(baselinePlan.orders[0].orderType, 'limit');
  assert.equal(baselinePlan.orders[0].postOnly, false);

  const postOnlyStrategy = configuration();
  postOnlyStrategy.entry.postOnly = true;
  assert.equal(createTradingPlan({ ...input, strategy: postOnlyStrategy }).orders[0].postOnly, true);

  const nearStrategy = configuration();
  nearStrategy.entry.rangePrice = 'near';
  assert.equal(createTradingPlan({ ...input, strategy: nearStrategy }).entryPrice, '61000');
  const farStrategy = configuration();
  farStrategy.entry.rangePrice = 'far';
  assert.equal(createTradingPlan({ ...input, strategy: farStrategy }).entryPrice, '60000');

  const marketStrategy = configuration();
  marketStrategy.entry.orderType = 'market';
  marketStrategy.entry.postOnly = false;
  const marketPlan = createTradingPlan({ ...input, strategy: marketStrategy });
  assert.equal(marketPlan.entryPrice, input.market.markPrice);
  assert.equal(marketPlan.orders[0].orderType, 'market');
  assert.equal(marketPlan.orders[0].price, null);
  assert.equal(marketPlan.orders[0].postOnly, false);

  const shortSignal = {
    ...executable,
    action: 'SHORT',
    stopLoss: '62000',
    suggestedLeverage: undefined,
    suggestedRiskPercent: '0.5',
  };
  const shortPlan = createTradingPlan({ ...input, signal: shortSignal });
  assert.equal(shortPlan.side, 'SHORT');
  assert.equal(shortPlan.orders[0].side, 'sell');
  assert.equal(shortPlan.orders[1].side, 'buy');
  assert.equal(shortPlan.riskAmount, '50');
  assert.equal(shortPlan.leverage, configuration().sizing.maxLeverage);
  assert.throws(
    () => allocateTargetQuantities('0.001', ['1', '99'], '0.001'),
    /allocation rounds to zero/,
  );
  const schemaBlocked = configuration();
  schemaBlocked.allowedSignalSchemas = ['loma'];
  assert.throws(() => createTradingPlan({ ...input, strategy: schemaBlocked }), /does not allow standard/);
  const sideBlocked = configuration();
  sideBlocked.allowedSides = ['SHORT'];
  assert.throws(() => createTradingPlan({ ...input, strategy: sideBlocked }), /does not allow LONG/);
  const symbolBlocked = configuration();
  symbolBlocked.allowedSymbols = ['ETHUSDT'];
  assert.throws(() => createTradingPlan({ ...input, strategy: symbolBlocked }), /does not allow BTCUSDT/);
  const targetMismatch = configuration();
  targetMismatch.exits.targetAllocationsPercent = ['100'];
  assert.throws(() => createTradingPlan({ ...input, strategy: targetMismatch }), /defines 1 exits/);
  assert.throws(() => createTradingPlan({
    ...input, signal: { ...executable, stopLoss: '61000' },
  }), /LONG stop must be below entry/);
  assert.throws(() => createTradingPlan({
    ...input, market: { ...input.market, minimumQuantity: '1' },
  }), /below the exchange minimum/);
  assert.throws(() => createTradingPlan({
    ...input, market: { ...input.market, minimumNotional: '10000' },
  }), /notional is below the exchange minimum/i);
}

async function testRepositoryValidation(defaults, accounts) {
  await assert.rejects(createTradingAccount({ name: '', exchange: 'paper', mode: 'paper' }), /name must contain/);
  await assert.rejects(createTradingAccount({ name: 'Bad exchange', exchange: 'unknown', mode: 'testnet', credentialRef: 'x' }), /Unsupported exchange/);
  await assert.rejects(createTradingAccount({ name: 'Bad mode', exchange: 'bybit', mode: 'paper', credentialRef: 'x' }), /Paper mode may only/);
  await assert.rejects(createTradingAccount({ name: 'Missing credential', exchange: 'bybit', mode: 'testnet' }), /credential reference/);
  await assert.rejects(
    updateTradingAccountState(accounts[0].id, { status: 'error', enabled: true }),
    /Only a verified ready account/,
  );
  await assert.rejects(updateTradingRuntimeState({ killSwitchActive: true, killSwitchReason: ' ' }), /requires a reason/);
  await assert.rejects(listTradingIntents(0), /between 1 and 1000/);
  await assert.rejects(listTradingActivity(0), /between 1 and 1000/);
  await assert.rejects(setTradingRoute({
    channelId: '', strategyVersionId: defaults[0].id, accountId: accounts[0].id, enabled: true,
  }), /valid channel identifier/);
  await assert.rejects(setTradingRoute({
    channelId: '-missing-strategy', strategyVersionId: 'missing', accountId: accounts[0].id, enabled: true,
  }), /published immutable strategy/);
  await assert.rejects(setTradingRoute({
    channelId: '-missing-account', strategyVersionId: defaults[0].id, accountId: 'missing', enabled: true,
  }), /account does not exist/);
}

async function testRepositoryRouting(defaults, accounts) {
  const draft = await createTradingStrategyDraft({
    name: 'Second channel strategy',
    configuration: configuration('0.5'),
  });
  const edited = await updateTradingStrategyDraft(draft.id, {
    name: draft.name,
    description: 'Different immutable strategy for a parallel channel.',
    configuration: configuration('0.75'),
  });
  assert.equal(edited.configuration.sizing.riskPerTradePercent, '0.75');
  const published = await publishTradingStrategyVersion(draft.id, 1_700_000_000_100);
  await assert.rejects(
    updateTradingStrategyDraft(published.id, {
      name: published.name,
      configuration: configuration('2'),
    }),
    /Only an existing draft/,
  );
  await assert.rejects(
    getDatabase().run(`UPDATE trading_strategy_versions SET name = 'tampered' WHERE id = ?`, [published.id]),
    /immutable/,
  );

  await setTradingRoute({
    channelId: '-100001', strategyVersionId: defaults[0].id, accountId: accounts[0].id, enabled: true,
  });
  await setTradingRoute({
    channelId: '-100002', strategyVersionId: published.id, accountId: accounts[0].id, enabled: true,
  });
  const routes = await listTradingRoutes();
  assert.equal(routes.length, 2, 'Two channels must route in parallel.');
  assert.notEqual(routes[0].strategyVersionId, routes[1].strategyVersionId);

  const validated = validateSignalXml(STANDARD_SIGNAL, 'default');
  assert.ok(validated.execution);
  await saveSignal('signal-1', '-100001', 1, STANDARD_SIGNAL, STANDARD_SIGNAL);
  const disabledIntent = await createTradingIntent({
    sourceSignalId: 'signal-1', channelId: '-100001', signal: validated.execution,
  });
  assert.equal(disabledIntent.status, 'blocked');
  assert.equal(disabledIntent.blockReason, 'EXECUTION_DISABLED');

  await updateTradingRuntimeState({ executionEnabled: true });
  await saveSignal('signal-2', '-100002', 2, STANDARD_SIGNAL, STANDARD_SIGNAL);
  const enabledIntent = await createTradingIntent({
    sourceSignalId: 'signal-2', channelId: '-100002', signal: validated.execution,
  });
  assert.equal(enabledIntent.status, 'pending');
  assert.equal(enabledIntent.strategyVersionId, published.id);

  const overview = await getTradingOverview();
  assert.equal(overview.enabledRouteCount, 2);
  assert.equal(overview.pendingIntentCount, 1);
  assert.equal(overview.runtime.executionEnabled, true);
  const operational = await getTradingOperationalSnapshot();
  assert.equal(operational.enabledRoutes, 2);
  assert.equal(operational.pendingIntents, 1);
  assert.equal(operational.latestReconciliationAt, null);
  await assert.rejects(archiveTradingStrategyVersion(published.id), /active routed strategy/);
  await assert.rejects(deleteTradingRoute('-100002'), /active or unresolved trades/);
  await assert.rejects(deleteTradingAccount('paper-default'), /default paper account/);

  const removableAccount = await createTradingAccount({
    name: 'Referenced account', exchange: 'bybit', mode: 'testnet', credentialRef: 'managed-secret',
  });
  await updateTradingAccountState(removableAccount.id, {
    status: 'ready', enabled: true, verifiedAt: Date.now(),
  });
  await setTradingRoute({
    channelId: '-temporary', strategyVersionId: defaults[0].id,
    accountId: removableAccount.id, enabled: true,
  });
  await assert.rejects(deleteTradingAccount(removableAccount.id), /all routes to be removed/);
  assert.equal(await deleteTradingRoute('-temporary'), true);
  assert.equal(await deleteTradingAccount(removableAccount.id), true);
}

async function runRepositoryTests() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'trading-core-'));
  try {
    await initDb(path.join(directory, 'forwarder.db'));
    await ensureTradingDefaults(1_700_000_000_000);
    const defaults = await listTradingStrategies();
    const accounts = await listTradingAccounts();
    assert.equal(defaults.length, 1);
    assert.equal(defaults[0].status, 'published');
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].mode, 'paper');
    await testRepositoryValidation(defaults, accounts);
    await testRepositoryRouting(defaults, accounts);
  } finally {
    await closeDb();
    await rm(directory, { recursive: true, force: true });
  }
}

testDecimalAndStrategyContracts();
testTradingPlanContracts();
await runRepositoryTests();
console.log('Trading core tests passed.');
