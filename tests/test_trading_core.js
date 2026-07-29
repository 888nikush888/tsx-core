import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  clearDb,
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
  sumDecimals,
} from '../src/trading_decimal.js';
import {
  DEFAULT_STRATEGY_CONFIGURATION,
  signalSchemaIdentifier,
  strategyConfigurationSha256,
  validateStrategyConfiguration,
} from '../src/trading_strategy.js';
import {
  adaptiveStopLossDecision,
  adaptiveTargetAllocations,
  allocateTargetQuantities,
  createTradingPlan,
} from '../src/trading_risk.js';
import {
  createTradingIntent,
  createTradingAccount,
  createSignalContract,
  createSignalContractDraftVersion,
  createTradingSignalSchema,
  createTradingStrategyDraft,
  archiveTradingStrategyVersion,
  deleteTradingAccount,
  deleteTradingRoute,
  deleteTradingSignalSchema,
  deleteTradingStrategyVersion,
  deleteSignalContractDraft,
  deleteSignalContractVersion,
  getTradingOverview,
  getTradingOperationalSnapshot,
  getTradingSignalSchemaForTemplate,
  getTradingStrategyVersion,
  listTradingAccounts,
  listTradingActivity,
  listTradingIntents,
  listTradingRoutes,
  listTradingSignalSchemas,
  listSignalContracts,
  listTradingStrategies,
  publishTradingStrategyVersion,
  publishSignalContractVersion,
  setTradingRoute,
  updateTradingRuntimeState,
  updateTradingAccountState,
  updateTradingSignalSchema,
  updateSignalContractDraft,
  updateTradingStrategyDraft,
} from '../src/trading_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { validateSignalXml } from '../src/signal_schema.js';
import { BUILTIN_SIGNAL_CONTRACTS } from '../src/signal_contract.js';
import {
  deleteChannelRiskPolicy,
  listChannelRiskEvaluations,
  resolveEffectiveChannelRisk,
  upsertChannelRiskPolicy,
} from '../src/trading_channel_risk.js';

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
    sizing: {
      ...DEFAULT_STRATEGY_CONFIGURATION.sizing,
      riskPerTradePercent: risk,
      maxAdaptiveRiskPercent: risk,
    },
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
  const legacyConfiguration = configuration();
  delete legacyConfiguration.exits.targetAllocationMode;
  delete legacyConfiguration.exits.stopLossMode;
  const normalizedLegacy = validateStrategyConfiguration(legacyConfiguration);
  assert.equal(normalizedLegacy.exits.targetAllocationMode, 'manual');
  assert.equal(normalizedLegacy.exits.stopLossMode, 'configured');
  invalidConfiguration(value => { value.exits.targetAllocationMode = 'unsupported'; }, /targetAllocationMode/);
  invalidConfiguration(value => { value.exits.stopLossMode = 'unsupported'; }, /stopLossMode/);
  invalidConfiguration(value => { value.schemaVersion = 4; }, /Unsupported strategy schema/);
  invalidConfiguration(value => { value.sizing.maxAdaptiveRiskPercent = '0.5'; }, /must not be below/);
  invalidConfiguration(value => { value.unsupported = true; }, /unsupported fields/);
  invalidConfiguration(value => { value.allowedSignalSchemas = []; }, /executable signal schema/);
  invalidConfiguration(value => { value.allowedSignalSchemas = 'standard'; }, /array of strings/);
  invalidConfiguration(value => { value.allowedSignalSchemas = ['standard', 7]; }, /array of strings/);
  invalidConfiguration(value => { value.allowedSignalSchemas = ['standard', 'STANDARD']; }, /duplicates/);
  invalidConfiguration(value => { value.allowedSignalSchemas = ['bad schema']; }, /identifier/);
  assert.throws(() => signalSchemaIdentifier(undefined), /identifier is invalid/);
  invalidConfiguration(value => { value.allowedSymbols = ['BTC-USDT']; }, /invalid normalized symbol/);
  invalidConfiguration(value => { delete value.symbolPolicy; }, /symbolPolicy/);
  invalidConfiguration(value => { value.symbolPolicy = 'unsupported'; }, /symbolPolicy/);
  invalidConfiguration(value => { value.symbolPolicy = 'allowlist'; value.allowedSymbols = []; }, /requires at least one/);
  invalidConfiguration(value => { value.symbolPolicy = 'all'; value.allowedSymbols = ['BTCUSDT']; }, /must be empty/);
  const legacySymbolPolicy = configuration();
  legacySymbolPolicy.schemaVersion = 2;
  delete legacySymbolPolicy.symbolPolicy;
  legacySymbolPolicy.allowedSymbols = ['ETHBTC'];
  const normalizedLegacySymbolPolicy = validateStrategyConfiguration(legacySymbolPolicy);
  assert.equal(normalizedLegacySymbolPolicy.symbolPolicy, 'allowlist');
  assert.equal(validateStrategyConfiguration(normalizedLegacySymbolPolicy).symbolPolicy, 'allowlist');
  invalidConfiguration(value => { value.schemaVersion = 2; value.symbolPolicy = 'none'; }, /Legacy strategy schemas/);
  invalidConfiguration(value => { value.allowedSides = []; }, /LONG and\/or SHORT/);
  invalidConfiguration(value => { value.entry.orderType = 'stop'; }, /market or limit/);
  invalidConfiguration(value => { value.entry.rangePrice = 'outside'; }, /rangePrice/);
  invalidConfiguration(value => { value.entry.postOnly = 'yes'; }, /postOnly must be boolean/);
  invalidConfiguration(value => { value.entry.orderType = 'market'; value.entry.postOnly = true; }, /cannot be post-only/);
  invalidConfiguration(value => { value.entry.timeoutSeconds = 31; }, /between 2 and 30/);
  invalidConfiguration(value => { value.sizing.maxLeverage = 0; }, /between 1 and 50/);
  invalidConfiguration(value => { value.exits.targetAllocationsPercent = '100'; }, /At least one target allocation/);
  invalidConfiguration(value => { value.exits.trailingStopPercent = '21'; }, /must not exceed/);
  invalidConfiguration(value => { value.safety.maxSlippagePercent = '6'; }, /must not exceed/);
  invalidConfiguration(value => { value.safety.entryOrderTtlSeconds = 9; }, /between 10 and 86400/);

  assert.deepEqual(adaptiveTargetAllocations(1), ['100']);
  assert.deepEqual(adaptiveTargetAllocations(3), ['50', '25', '25']);
  assert.deepEqual(adaptiveTargetAllocations(4), ['50', '25', '12.5', '12.5']);
  assert.deepEqual(adaptiveTargetAllocations(5), ['50', '25', '12.5', '6.25', '6.25']);
  const manyTargetAllocations = adaptiveTargetAllocations(25);
  assert.equal(manyTargetAllocations.length, 25);
  assert.ok(manyTargetAllocations.every(allocation => compareDecimal(allocation, '0') > 0));
  assert.equal(sumDecimals(manyTargetAllocations), '100');
  assert.throws(() => adaptiveTargetAllocations(0), /at least one/);

  const manualManyTargets = configuration();
  manualManyTargets.exits.targetAllocationsPercent = [...Array(20).fill('1'), '80'];
  assert.equal(validateStrategyConfiguration(manualManyTargets).exits.targetAllocationsPercent.length, 21);

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

function testAdaptivePlanContracts() {
  const executable = validateSignalXml(STANDARD_SIGNAL, 'default').execution;
  const input = planInput(executable);
  const legacyStrategy = configuration();
  delete legacyStrategy.exits.targetAllocationMode;
  delete legacyStrategy.exits.stopLossMode;
  const legacyPlan = createTradingPlan({ ...input, strategy: legacyStrategy });
  assert.equal(legacyPlan.targetAllocationMode, 'manual');
  assert.equal(legacyPlan.stopLossMode, 'configured');
  const invalidRuntimeMode = configuration();
  invalidRuntimeMode.exits.targetAllocationMode = 'unsupported';
  assert.throws(
    () => createTradingPlan({ ...input, strategy: invalidRuntimeMode }),
    /Unsupported target allocation mode/,
  );
  const adaptiveStrategy = configuration();
  adaptiveStrategy.exits.targetAllocationMode = 'adaptive_halving';
  adaptiveStrategy.exits.stopLossMode = 'adaptive_targets';
  const adaptiveSignal = {
    ...executable,
    targets: ['62000', '63000', '64000', '65000', '66000'].map(price => ({ min: price, max: price })),
  };
  const adaptivePlan = createTradingPlan({ ...input, signal: adaptiveSignal, strategy: adaptiveStrategy });
  assert.equal(adaptivePlan.targetAllocationMode, 'adaptive_halving');
  assert.equal(adaptivePlan.stopLossMode, 'adaptive_targets');
  assert.deepEqual(adaptivePlan.targetAllocationsPercent, ['50', '25', '12.5', '6.25', '6.25']);
  assert.deepEqual(
    adaptivePlan.orders.filter(order => order.role === 'take_profit').map(order => order.quantity),
    ['0.008', '0.004', '0.002', '0.001', '0.001'],
  );
  assert.deepEqual(adaptiveStopLossDecision(adaptivePlan, 0), {
    trigger: '59000', reason: 'initial', referenceTargetIndex: null,
  });
  assert.deepEqual(adaptiveStopLossDecision(adaptivePlan, 1), {
    trigger: '60500', reason: 'break_even_after_target', referenceTargetIndex: null,
  });
  assert.equal(adaptiveStopLossDecision(adaptivePlan, 2).trigger, '60500');
  assert.deepEqual(adaptiveStopLossDecision(adaptivePlan, 3), {
    trigger: '62000', reason: 'target_ladder_after_target', referenceTargetIndex: 1,
  });
  assert.deepEqual(adaptiveStopLossDecision(adaptivePlan, 4), {
    trigger: '63000', reason: 'target_ladder_after_target', referenceTargetIndex: 2,
  });
  assert.deepEqual(adaptiveStopLossDecision(adaptivePlan, 5), {
    trigger: '63000', reason: 'final_target_complete', referenceTargetIndex: null,
  });
  const singleTargetPlan = createTradingPlan({
    ...input,
    strategy: adaptiveStrategy,
    signal: { ...executable, targets: [{ min: '62000', max: '62000' }] },
  });
  assert.deepEqual(adaptiveStopLossDecision(singleTargetPlan, 1), {
    trigger: '59000', reason: 'final_target_complete', referenceTargetIndex: null,
  });
  const adaptiveShortPlan = createTradingPlan({
    ...input,
    strategy: adaptiveStrategy,
    signal: {
      ...executable,
      action: 'SHORT',
      stopLoss: '62000',
      targets: ['59000', '58000', '57000', '56000'].map(price => ({ min: price, max: price })),
    },
  });
  assert.deepEqual(adaptiveShortPlan.targetAllocationsPercent, ['50', '25', '12.5', '12.5']);
  assert.equal(adaptiveStopLossDecision(adaptiveShortPlan, 3).trigger, '59000');
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
  const coarseMarket = {
    ...input.market,
    priceTick: '1',
    markPrice: '60000.4',
  };
  const coarseStrategy = configuration();
  coarseStrategy.sizing.maxPositionNotional = '1000000';
  const coarseLong = createTradingPlan({
    ...input,
    strategy: coarseStrategy,
    market: coarseMarket,
    signal: {
      ...executable,
      entry: { type: 'range', min: '60000.2', max: '60000.4' },
      stopLoss: '59000.9',
    },
  });
  assert.equal(coarseLong.entryPrice, '60000', 'A long limit must round down before risk sizing.');
  assert.equal(coarseLong.stopPrice, '59000', 'A long stop must use the adverse lower tick before risk sizing.');
  assert.equal(coarseLong.quantity, '0.1', 'Quantity must be derived from the submitted tick-aligned prices.');
  const coarseShort = createTradingPlan({
    ...input,
    strategy: coarseStrategy,
    market: coarseMarket,
    signal: {
      ...executable,
      action: 'SHORT',
      entry: { type: 'range', min: '60000.2', max: '60000.4' },
      stopLoss: '62000.1',
    },
  });
  assert.equal(coarseShort.entryPrice, '60001', 'A short limit must round up before risk sizing.');
  assert.equal(coarseShort.stopPrice, '62001', 'A short stop must use the adverse upper tick.');
  assert.equal(coarseShort.quantity, '0.05');
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
  symbolBlocked.symbolPolicy = 'allowlist';
  symbolBlocked.allowedSymbols = ['ETHUSDT'];
  assert.throws(() => createTradingPlan({ ...input, strategy: symbolBlocked }), /does not allow BTCUSDT/);
  const noSymbols = configuration();
  noSymbols.symbolPolicy = 'none';
  assert.throws(() => createTradingPlan({ ...input, strategy: noSymbols }), /does not allow any symbols/);
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
  const legacyDraft = await createTradingStrategyDraft({
    name: 'Legacy exit configuration',
    configuration: configuration(),
  });
  const legacyStoredConfiguration = configuration();
  delete legacyStoredConfiguration.exits.targetAllocationMode;
  delete legacyStoredConfiguration.exits.stopLossMode;
  const legacyHash = strategyConfigurationSha256(legacyStoredConfiguration);
  await getDatabase().run(
    `UPDATE trading_strategy_versions SET configuration_json = ?, configuration_sha256 = ? WHERE id = ?`,
    [JSON.stringify(legacyStoredConfiguration), legacyHash, legacyDraft.id],
  );
  const loadedLegacy = await getTradingStrategyVersion(legacyDraft.id);
  assert.equal(loadedLegacy.configuration.exits.targetAllocationMode, 'manual');
  assert.equal(loadedLegacy.configuration.exits.stopLossMode, 'configured');
  assert.equal(loadedLegacy.configurationSha256, legacyHash, 'Normalization must not invalidate an immutable legacy hash.');
  await deleteTradingStrategyVersion(legacyDraft.id);

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

  const firstExternal = await createTradingAccount({
    name: 'Identity-bound account', exchange: 'bybit', mode: 'testnet', credentialRef: 'managed-secret',
  });
  const bound = await updateTradingAccountState(firstExternal.id, {
    status: 'ready', enabled: true, verifiedAt: Date.now(), externalAccountId: 'bybit:testnet:account-123',
  });
  assert.equal(bound.externalAccountId, 'bybit:testnet:account-123');
  const retainedBinding = await updateTradingAccountState(firstExternal.id, {
    status: 'error', enabled: false, error: 'verification unavailable', verifiedAt: null,
  });
  assert.equal(retainedBinding.externalAccountId, 'bybit:testnet:account-123', 'Omitted identity updates must preserve the binding.');
  const secondExternal = await createTradingAccount({
    name: 'Duplicate identity account', exchange: 'bybit', mode: 'testnet', credentialRef: 'managed-secret',
  });
  await assert.rejects(
    updateTradingAccountState(secondExternal.id, {
      status: 'ready', enabled: true, verifiedAt: Date.now(), externalAccountId: 'bybit:testnet:account-123',
    }),
    /UNIQUE constraint failed/,
    'One external exchange identity must not be bound to two local accounts.',
  );
  const cleared = await updateTradingAccountState(firstExternal.id, {
    status: 'unverified', enabled: false, verifiedAt: null, externalAccountId: null,
  });
  assert.equal(cleared.externalAccountId, null, 'Credential replacement must be able to clear the old identity binding.');
  await deleteTradingAccount(firstExternal.id);
  await deleteTradingAccount(secondExternal.id);
}

async function testDynamicContracts() {
  const standardDefinition = structuredClone(
    BUILTIN_SIGNAL_CONTRACTS.find(contract => contract.id === 'standard').definition,
  );
  const seededContracts = await listSignalContracts();
  assert.deepEqual(
    seededContracts.map(contract => contract.id).sort(),
    ['cryptodanielvip', 'loma', 'standard'],
  );

  const created = await createSignalContract({
    id: 'desk-alpha',
    name: 'Desk Alpha',
    description: 'Test contract',
    definition: standardDefinition,
  }, 1_700_000_100_000);
  assert.equal(created.versions[0].status, 'draft');
  await assert.rejects(
    createTradingSignalSchema({
      id: 'desk-alpha',
      name: 'Desk Alpha',
      description: '',
      contractVersionId: 'desk-alpha:v1',
      templateName: 'desk-alpha',
      enabled: true,
    }),
    /published signal contract/,
  );
  const published = await publishSignalContractVersion('desk-alpha:v1', 1_700_000_101_000);
  assert.equal(published.status, 'published');
  const profile = await createTradingSignalSchema({
    id: 'desk-alpha',
    name: 'Desk Alpha',
    description: '',
    contractVersionId: published.id,
    templateName: 'desk-alpha',
    enabled: true,
  });
  assert.equal(profile.contractVersionId, published.id);
  const validated = validateSignalXml(STANDARD_SIGNAL, profile.templateName, {
    id: profile.id,
    parserSchema: profile.parserSchema,
    contractVersionId: profile.contractVersionId,
    contractDefinition: profile.contractDefinition,
  });
  assert.equal(validated.execution.schema, 'desk-alpha');
  assert.equal(validated.execution.symbol, 'BTCUSDT');
  await assert.rejects(
    updateSignalContractDraft({
      contractId: 'desk-alpha',
      versionId: published.id,
      name: 'Tampered',
      description: '',
      definition: standardDefinition,
    }),
    /Only an existing draft/,
  );
  await updateTradingSignalSchema(profile.id, {
    name: profile.name,
    description: profile.description,
    contractVersionId: profile.contractVersionId,
    templateName: profile.templateName,
    enabled: false,
  });
  await assert.rejects(
    deleteSignalContractVersion(published.id),
    /Signal schema profiles must be moved or deleted/,
  );
  const next = await createSignalContractDraftVersion('desk-alpha', published.id);
  assert.equal(next.version, 2);
  assert.equal(await deleteSignalContractDraft(next.id), true);
  assert.equal(await deleteTradingSignalSchema(profile.id), true);
  assert.equal(await deleteSignalContractVersion(published.id), true);
  assert.equal((await listSignalContracts()).some(contract => contract.id === 'desk-alpha'), false);
}

async function testChannelRiskPolicies() {
  const fixed = await upsertChannelRiskPolicy({
    channelId: '-100-risk',
    mode: 'fixed',
    tiers: [{ riskPercent: '0.5' }, { riskPercent: '1' }, { riskPercent: '1.5' }],
    currentTier: 1,
    lookbackWeeks: 4,
    minimumClosedTrades: 5,
    lossThresholdPercent: '1',
    profitThresholdPercent: '1',
    weakChannelAction: 'reduce',
    weakWeeksBeforeBlock: 3,
  });
  assert.equal(fixed.policyVersion, 1);
  const fixedDecision = await resolveEffectiveChannelRisk({
    channelId: fixed.channelId,
    strategy: configuration(),
    currentEquity: '10000',
  });
  assert.equal(fixedDecision.riskPercent, '1');
  assert.equal(fixedDecision.blocked, false);

  const blocked = await upsertChannelRiskPolicy({
    channelId: fixed.channelId,
    mode: 'automatic',
    tiers: fixed.tiers,
    currentTier: 1,
    lookbackWeeks: 4,
    minimumClosedTrades: 5,
    lossThresholdPercent: '1',
    profitThresholdPercent: '1',
    weakChannelAction: 'block',
    weakWeeksBeforeBlock: 2,
    manuallyBlocked: true,
  });
  assert.equal(blocked.policyVersion, 2);
  const blockedDecision = await resolveEffectiveChannelRisk({
    channelId: blocked.channelId,
    strategy: configuration(),
    currentEquity: '10000',
  });
  assert.equal(blockedDecision.blocked, true);
  assert.match(blockedDecision.reason, /Manually blocked/);
  assert.equal((await listChannelRiskEvaluations()).length, 0);
  assert.equal(await deleteChannelRiskPolicy(blocked.channelId), true);
}

async function testDynamicContractsAndChannelRisk() {
  await testDynamicContracts();
  await testChannelRiskPolicies();
}

async function testSignalSchemaRepository() {
  const builtIns = await listTradingSignalSchemas();
  assert.deepEqual(
    builtIns.map(schema => schema.id).sort(),
    ['cryptodanielvip', 'loma', 'standard'],
  );
  assert.equal((await getTradingSignalSchemaForTemplate()).id, 'standard');
  const validSchemaInput = {
    name: 'Validation profile', description: '', parserSchema: 'standard',
    templateName: 'validation-template', enabled: true,
  };
  await assert.rejects(
    createTradingSignalSchema({ id: 'invalid-name', ...validSchemaInput, name: '' }),
    /name must contain/,
  );
  await assert.rejects(
    createTradingSignalSchema({ id: 'invalid-description', ...validSchemaInput, description: 'x'.repeat(501) }),
    /description must not exceed/,
  );
  await assert.rejects(
    createTradingSignalSchema({ id: 'invalid-template', ...validSchemaInput, templateName: 'bad template' }),
    /template name is invalid/,
  );
  await assert.rejects(
    createTradingSignalSchema({ id: 'invalid-contract', ...validSchemaInput, parserSchema: 'unknown' }),
    /parser contract is unsupported/,
  );
  await assert.rejects(
    createTradingSignalSchema({ id: 'invalid-state', ...validSchemaInput, enabled: 'yes' }),
    /enabled state must be boolean/,
  );
  await assert.rejects(
    updateTradingSignalSchema('missing-schema', validSchemaInput),
    /does not exist/,
  );
  const disabledCreated = await createTradingSignalSchema({
    id: 'disabled-profile', ...validSchemaInput, templateName: 'disabled-template', enabled: false,
  });
  assert.equal(disabledCreated.enabled, false);
  await deleteTradingSignalSchema(disabledCreated.id);

  const created = await createTradingSignalSchema({
    id: 'desk-alpha',
    name: 'Desk Alpha',
    description: 'Custom profile using the audited standard contract.',
    parserSchema: 'standard',
    templateName: 'desk-alpha-template',
    enabled: true,
  }, 1_700_000_000_010);
  assert.equal(created.id, 'desk-alpha');
  assert.equal((await getTradingSignalSchemaForTemplate('DESK-ALPHA-TEMPLATE')).id, 'desk-alpha');
  await assert.rejects(createTradingSignalSchema({
    id: 'desk-beta', name: 'Desk Beta', parserSchema: 'standard',
    templateName: 'DESK-ALPHA-TEMPLATE', enabled: true,
  }), /UNIQUE constraint failed/);

  const customConfiguration = configuration();
  customConfiguration.allowedSignalSchemas = ['desk-alpha'];
  const customDraft = await createTradingStrategyDraft({
    name: 'Custom schema strategy',
    configuration: customConfiguration,
  });
  assert.deepEqual(customDraft.configuration.allowedSignalSchemas, ['desk-alpha']);

  const disabled = await updateTradingSignalSchema('desk-alpha', {
    name: 'Desk Alpha',
    description: 'Temporarily disabled.',
    parserSchema: 'standard',
    templateName: 'desk-alpha-template',
    enabled: false,
  }, 1_700_000_000_020);
  assert.equal(disabled.enabled, false);
  assert.equal(await getTradingSignalSchemaForTemplate('desk-alpha-template'), null);
  await assert.rejects(publishTradingStrategyVersion(customDraft.id), /unavailable signal schemas: desk-alpha/);
  await deleteTradingStrategyVersion(customDraft.id);
  await assert.rejects(createTradingStrategyDraft({
    name: 'Unavailable schema strategy',
    configuration: customConfiguration,
  }), /unavailable signal schemas: desk-alpha/);

  await updateTradingSignalSchema('desk-alpha', {
    name: 'Desk Alpha v2',
    description: 'Enabled again.',
    parserSchema: 'loma',
    templateName: 'desk-alpha-v2',
    enabled: true,
  }, 1_700_000_000_030);
  assert.equal((await getTradingSignalSchemaForTemplate('desk-alpha-v2')).parserSchema, 'loma');
  assert.equal(await deleteTradingSignalSchema('desk-alpha'), true);
  assert.equal(await deleteTradingSignalSchema('desk-alpha'), false);
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
  await assert.rejects(updateTradingSignalSchema('standard', {
    name: 'Standard edited', description: '', parserSchema: 'standard', templateName: 'default', enabled: true,
  }), /enabled route uses it/);
  await assert.rejects(deleteTradingSignalSchema('standard'), /enabled route uses it/);
  const routes = await listTradingRoutes();
  assert.equal(routes.length, 2, 'Two channels must route in parallel.');
  assert.notEqual(routes[0].strategyVersionId, routes[1].strategyVersionId);
  await assert.rejects(deleteTradingStrategyVersion(published.id), /channel routes/);

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
  await assert.rejects(deleteTradingStrategyVersion(published.id), /retained trade history/);

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
  await assert.rejects(deleteTradingAccount('paper-default'), /all routes/);

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

async function testOperationalDatabaseClearPreservesTrading() {
  const database = getDatabase();
  await saveSignal('clear-unreferenced', '-100099', 99, STANDARD_SIGNAL, STANDARD_SIGNAL);
  await database.run(
    `INSERT INTO incoming_messages (chat_id, message_id, text, status, created_at)
     VALUES ('-100099', 99, 'clear me', 'processed', ?)`,
    [Date.now()],
  );
  await database.run(
    `INSERT INTO pending_tasks (id, type, status, added_at, updated_at)
     VALUES ('clear-task', 'message', 'completed', ?, ?)`,
    [Date.now(), Date.now()],
  );
  await database.run(
    `INSERT INTO media_group_buffer (group_id, from_chat_id, messages_json, added_at)
     VALUES ('clear-media', '-100099', '[]', ?)`,
    [Date.now()],
  );
  await database.run("UPDATE forwarding_stats SET value = 99 WHERE key = 'total_forwarded_count'");

  const cleared = await clearDb();
  assert.deepEqual(cleared, {
    deletedIncomingMessages: 1,
    deletedSignals: 1,
    retainedTradingSignals: 2,
    deletedPendingTasks: 1,
    deletedMediaGroups: 1,
  });
  assert.equal((await database.get('SELECT COUNT(*) AS count FROM incoming_messages')).count, 0);
  assert.equal((await database.get('SELECT COUNT(*) AS count FROM pending_tasks')).count, 0);
  assert.equal((await database.get('SELECT COUNT(*) AS count FROM media_group_buffer')).count, 0);
  assert.equal((await database.get('SELECT COUNT(*) AS count FROM signals')).count, 2);
  assert.equal((await database.get('SELECT COUNT(*) AS count FROM trading_trade_intents')).count, 2);
  assert.equal((await database.get('SELECT COUNT(*) AS count FROM trading_routes')).count, 2);
  assert.ok((await database.get('SELECT COUNT(*) AS count FROM trading_strategy_versions')).count > 0);
  assert.ok((await database.get('SELECT COUNT(*) AS count FROM trading_accounts')).count > 0);
  assert.equal((await database.get(
    "SELECT value FROM forwarding_stats WHERE key = 'total_forwarded_count'",
  )).value, 0);
}

async function runRepositoryTests() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'trading-core-'));
  try {
    await initDb(path.join(directory, 'forwarder.db'));
    assert.deepEqual(await listTradingStrategies(), []);
    assert.deepEqual(await listTradingAccounts(), []);
    assert.deepEqual(await listTradingSignalSchemas(), []);
    assert.deepEqual(await listSignalContracts(), []);
    assert.equal((await getDatabase().get('SELECT COUNT(*) AS count FROM trading_paper_accounts')).count, 0);
    await assert.rejects(
      createTradingAccount({ name: 'Explicit paper', exchange: 'paper', mode: 'paper' }),
      /explicitly entered initial balance/,
    );
    await seedTradingFixtures(1_700_000_000_000);
    const defaults = await listTradingStrategies();
    const accounts = await listTradingAccounts();
    assert.equal(defaults.length, 1);
    assert.equal(defaults[0].status, 'published');
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].mode, 'paper');
    const deletable = await createTradingStrategyDraft({
      name: 'Disposable strategy',
      configuration: configuration(),
    });
    assert.equal(await deleteTradingStrategyVersion(deletable.id), true);
    assert.equal(await deleteTradingStrategyVersion(deletable.id), false);
    await testSignalSchemaRepository();
    await testDynamicContractsAndChannelRisk();
    await testRepositoryValidation(defaults, accounts);
    await testRepositoryRouting(defaults, accounts);
    await testOperationalDatabaseClearPreservesTrading();
  } finally {
    await closeDb();
    await rm(directory, { recursive: true, force: true });
  }
}

testDecimalAndStrategyContracts();
testAdaptivePlanContracts();
testTradingPlanContracts();
await runRepositoryTests();
console.log('Trading core tests passed.');
