import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { TradingEngine } from '../src/trading_engine.js';
import { TradingWebControl } from '../src/trading_web_control.js';
import { TradingCredentialStore } from '../src/trading_credentials.js';
import {
  createTradingAccount,
  createTradingStrategyDraft,
  getTradingIntent,
  listSignalContracts,
  listTradingAccounts,
  publishTradingStrategyVersion,
  updateTradingRuntimeState,
} from '../src/trading_repository.js';
import { DEFAULT_STRATEGY_CONFIGURATION } from '../src/trading_strategy.js';
import {
  WORKFLOW_IMPACT_CONFIRMATION,
  applyWorkflowBuilderHistory,
  createWorkflowResourceDraft,
  createWorkflowTradingIntents as createPinnedWorkflowTradingIntents,
  getActiveWorkflow,
  getWorkflowBuilderHistoryStatus,
  listWorkflowFallbackRuns,
  publishWorkflowResource,
  previewWorkflowImpact,
  previewWorkflowBuilderHistoryImpact,
  saveWorkflowRevision,
  simulateWorkflow,
} from '../src/workflow_repository.js';
import { getFilteredTradingAnalytics } from '../src/trading_telemetry.js';
import { listTradingNotificationEvents } from '../src/viewer_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';

// New direct test signals bind once to the explicit revision, never inside an intent retry.
async function createWorkflowTradingIntents(input, now) {
  return createPinnedWorkflowTradingIntents({ ...input, workflowRevisionId: (await getActiveWorkflow()).id }, now);
}

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-workflow-fallback-'));

try {
  await initDb(path.join(directory, 'forwarder.db'));
  await seedTradingFixtures();
  const [primaryAccount] = await listTradingAccounts();
  const fallbackAccount = await createTradingAccount({
    name: 'Fallback paper account', exchange: 'paper', mode: 'paper',
    initialBalance: '25000', maxConcurrentPositions: 10,
  });
  const thirdAccount = await createTradingAccount({
    name: 'Third paper account', exchange: 'paper', mode: 'paper',
    initialBalance: '50000', maxConcurrentPositions: 10,
  });
  const standardContract = (await listSignalContracts())
    .find(contract => contract.id === 'standard')
    .versions.find(version => version.status === 'published');
  const strategyDraft = await createTradingStrategyDraft({
    name: 'Fallback strategy',
    description: 'Deterministic fallback test strategy.',
    configuration: {
      ...structuredClone(DEFAULT_STRATEGY_CONFIGURATION),
      sizing: {
        positionSizingMode: 'equity_percent_margin', riskPerTradePercent: '10',
        maxAdaptiveRiskPercent: '10', maxPositionNotional: '1000000000', defaultLeverage: 1, maxLeverage: 1,
      },
      safety: { ...structuredClone(DEFAULT_STRATEGY_CONFIGURATION.safety), maxDailyLoss: '100000' },
    },
  });
  const strategy = await publishTradingStrategyVersion(strategyDraft.id);
  await updateTradingRuntimeState({ executionEnabled: true });

  async function resource(kind, name, configuration) {
    const draft = await createWorkflowResourceDraft({ kind, name, configuration });
    return publishWorkflowResource(draft.id);
  }

  const resources = {
    channelA: await resource('channel', 'Fallback channel A', { channelId: '-100-fallback-a' }),
    channelB: await resource('channel', 'Fallback channel B', { channelId: '-100-fallback-b' }),
    parser: await resource('parser', 'Fallback parser', { templateName: 'default', timeoutMs: 120000 }),
    schema: await resource('schema', 'Fallback schema', { schemaId: 'standard' }),
    contract: await resource('contract', 'Fallback contract', { contractVersionId: standardContract.id }),
    strategy: await resource('strategy', 'Fallback strategy', { strategyVersionId: strategy.id }),
    sizing: await resource('sizing', 'Ten percent margin', {
      positionSizingMode: 'equity_percent_margin', riskPerTradePercent: '10',
      maxAdaptiveRiskPercent: '10', maxPositionNotional: '1000000000', maxLeverage: 1,
    }),
    adaptive: await resource('adaptive_risk', 'Account-specific fallback risk', {
      enabled: true, mode: 'automatic', tiers: [{ riskPercent: '10' }], startingTier: 0,
      lockedTier: null, lookbackWeeks: 1, minimumClosedTrades: 99,
      lossThresholdPercent: '2', profitThresholdPercent: '2', weakChannelAction: 'none',
      weakWeeksBeforeBlock: 3, manuallyBlocked: false,
    }),
    primary: await resource('account', 'Primary account', { accountId: primaryAccount.id }),
    fallback: await resource('account', 'Fallback account', { accountId: fallbackAccount.id }),
    third: await resource('account', 'Third account', { accountId: thirdAccount.id }),
    output: await resource('output', 'Fallback audit', { mode: 'audit_only' }),
  };
  const node = (id, kind, resourceVersionId, y = 0) => ({
    id, kind, resourceVersionId, position: { x: 0, y },
  });
  const flow = (source, target, channelNodeIds) => ({
    id: `${source}-${target}`, kind: 'flow', source, target,
    ...(channelNodeIds ? { channelNodeIds } : {}),
  });
  const fullFallbackPolicy = [
    'SYMBOL_UNAVAILABLE', 'MAX_CONCURRENT_POSITIONS', 'SYMBOL_ALREADY_OWNED',
  ];
  const pairOnlyFallbackPolicy = ['SYMBOL_UNAVAILABLE'];
  const fallback = (source, target, channelNodeIds, fallbackOn = fullFallbackPolicy) => ({
    id: `${source}-${target}-fallback`, kind: 'account_fallback', source, target,
    ...(channelNodeIds ? { channelNodeIds } : {}),
    fallbackOn,
  });
  const nodes = [
    node('channel-a', 'channel', resources.channelA.id, 0),
    node('channel-b', 'channel', resources.channelB.id, 150),
    node('parser', 'parser', resources.parser.id),
    node('schema', 'schema', resources.schema.id),
    node('contract', 'contract', resources.contract.id),
    node('strategy', 'strategy', resources.strategy.id),
    node('sizing', 'sizing', resources.sizing.id),
    node('adaptive', 'adaptive_risk', resources.adaptive.id),
    node('account-a', 'account', resources.primary.id, 0),
    node('account-b', 'account', resources.fallback.id, 150),
    node('account-c', 'account', resources.third.id, 300),
    node('output', 'output', resources.output.id),
  ];
  const baseEdges = [
    flow('channel-a', 'parser'), flow('channel-b', 'parser'), flow('parser', 'schema'),
    flow('schema', 'contract'), flow('contract', 'strategy'), flow('strategy', 'sizing'),
    flow('sizing', 'adaptive'), flow('adaptive', 'account-a'), flow('account-a', 'output'),
  ];
  const graph = {
    schemaVersion: 3,
    nodes,
    edges: [
      ...baseEdges,
      fallback('account-a', 'account-b', ['channel-a']),
      fallback('account-b', 'account-c', ['channel-a'], pairOnlyFallbackPolicy),
    ],
  };

  const impact = await previewWorkflowImpact({ baseRevisionId: null, graph });
  assert.equal(impact.added.length, 4);
  const workflow = await saveWorkflowRevision({
    baseRevisionId: null, graph, actorId: 'test:fallback', confirmation: WORKFLOW_IMPACT_CONFIRMATION,
  });
  assert.equal(workflow.graph.schemaVersion, 3);
  assert.equal(workflow.compiled.routeGroups.length, 2);
  const fallbackGroup = workflow.compiled.routeGroups.find(group => group.channelId === '-100-fallback-a');
  const directGroup = workflow.compiled.routeGroups.find(group => group.channelId === '-100-fallback-b');
  assert.deepEqual(
    fallbackGroup.candidates.map(candidate => candidate.accountId),
    [primaryAccount.id, fallbackAccount.id, thirdAccount.id],
  );
  assert.deepEqual(fallbackGroup.candidates.map(candidate => candidate.rank), [0, 1, 2]);
  assert.deepEqual(fallbackGroup.candidates.map(candidate => candidate.fallbackOn), [
    fullFallbackPolicy, pairOnlyFallbackPolicy, [],
  ]);
  assert.deepEqual(directGroup.candidates.map(candidate => candidate.accountId), [primaryAccount.id]);
  const fallbackPath = workflow.compiled.paths.find(candidate => candidate.accountId === fallbackAccount.id);
  assert.equal(fallbackPath.fallbackRank, 1);
  assert.equal(fallbackPath.routeGroupKey, fallbackGroup.key);
  assert.equal(fallbackPath.effectiveConfiguration.strategyConfiguration.sizing.riskPerTradePercent, '10');
  assert.equal((await getActiveWorkflow()).definitionSha256, workflow.definitionSha256);
  const simulation = await simulateWorkflow({ channelId: '-100-fallback-a', text: 'BTCUSDT LONG' });
  assert.deepEqual(simulation.paths.map(path => ({
    accountId: path.accountId,
    fallbackRank: path.fallbackRank,
    fallbackOn: path.fallbackOn,
    routeGroupKey: path.routeGroupKey,
  })), [
    { accountId: primaryAccount.id, fallbackRank: 0, fallbackOn: fullFallbackPolicy, routeGroupKey: fallbackGroup.key },
    { accountId: fallbackAccount.id, fallbackRank: 1, fallbackOn: pairOnlyFallbackPolicy, routeGroupKey: fallbackGroup.key },
    { accountId: thirdAccount.id, fallbackRank: 2, fallbackOn: [], routeGroupKey: fallbackGroup.key },
  ]);

  async function seedActivePosition(account, symbol, suffix) {
    const sourceSignalId = `capacity-seed-${suffix}`;
    await saveSignal(sourceSignalId, '-100-fallback-a', 100 + suffix.length, '<signal/>', '<signal/>');
    await paper.setMarket(account.id, {
      symbol, markPrice: '1', priceTick: '0.001', quantityStep: '0.001',
      minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 50,
    });
    const [intent] = await createWorkflowTradingIntents({
      sourceSignalId, channelId: '-100-fallback-a', sourceText: `${symbol} LONG`,
      signal: { schema: 'standard', action: 'LONG', symbol, entry: { type: 'market' },
        targets: [{ min: '1.1', max: '1.1' }, { min: '1.2', max: '1.2' }], stopLoss: '0.5' },
    });
    assert.equal(intent.accountId, account.id);
    await new TradingEngine([paper]).processIntent(intent.id);
    const opened = await getTradingIntent(intent.id);
    assert.equal(opened.status, 'monitoring', JSON.stringify(opened));
    assert.ok((await paper.openState(account)).positions.some(position => position.symbol === symbol));
    return intent.id;
  }

  await assert.rejects(
    previewWorkflowImpact({
      baseRevisionId: workflow.id,
      graph: { ...graph, edges: [...graph.edges, fallback('account-a', 'account-c', ['channel-a'])] },
    }),
    /linear|successor|branch/i,
  );
  await assert.rejects(
    previewWorkflowImpact({
      baseRevisionId: workflow.id,
      graph: { ...graph, edges: [...graph.edges, fallback('account-c', 'account-a', ['channel-a'])] },
    }),
    /cycle/i,
  );
  await assert.rejects(
    previewWorkflowImpact({
      baseRevisionId: workflow.id,
      graph: { ...graph, edges: [...graph.edges, flow('sizing', 'account-b', ['channel-a'])] },
    }),
    /parallel|direct|fallback/i,
  );

  const signal = {
    schema: 'standard', action: 'LONG', symbol: 'BTCUSDT', entry: { type: 'market' },
    targets: [{ min: '110', max: '110' }, { min: '120', max: '120' }], stopLoss: '90',
  };
  await saveSignal('fallback-success', '-100-fallback-a', 1, '<signal/>', '<signal/>');
  const fallbackOrigin = Date.now() - DEFAULT_STRATEGY_CONFIGURATION.safety.entryOrderTtlSeconds * 1_000 * 0.9;
  const initial = await createWorkflowTradingIntents({
    sourceSignalId: 'fallback-success', channelId: '-100-fallback-a', sourceText: 'BTCUSDT LONG', signal,
  }, fallbackOrigin);
  assert.equal(initial.length, 1, 'Only the primary account may receive an intent before market resolution.');
  assert.equal(initial[0].accountId, primaryAccount.id);
  assert.deepEqual(
    await getDatabase().get('SELECT status, current_rank AS currentRank FROM trading_fallback_runs'),
    { status: 'probing', currentRank: 0 },
  );
  assert.equal(Number((await getDatabase().get('SELECT COUNT(*) AS count FROM trading_fallback_candidates')).count), 3);

  const paper = new PaperExchangeAdapter();
  await paper.setMarket(fallbackAccount.id, {
    symbol: 'BTCUSDT', markPrice: '100', priceTick: '0.1', quantityStep: '0.001',
    minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 50,
  });
  const engine = new TradingEngine([paper]);
  await engine.processIntent(initial[0].id);
  const primaryResult = await getTradingIntent(initial[0].id);
  assert.equal(primaryResult.status, 'blocked');
  assert.equal(primaryResult.blockReason, 'SYMBOL_UNAVAILABLE');
  const promoted = await getDatabase().get(
    `SELECT intent.* FROM trading_trade_intents AS intent
     JOIN trading_fallback_candidates AS candidate ON candidate.intent_id = intent.id
     WHERE candidate.fallback_run_id = (SELECT id FROM trading_fallback_runs LIMIT 1)
       AND candidate.rank = 1`,
  );
  assert.equal(promoted.status, 'pending');
  assert.equal(promoted.account_id, fallbackAccount.id);
  assert.equal(promoted.created_at, initial[0].createdAt, 'Fallback attempts must share the original TTL origin.');
  assert.equal(Number((await getDatabase().get(
    'SELECT COUNT(*) AS count FROM trading_orders WHERE account_id = ?', [primaryAccount.id],
  )).count), 0);

  // A legacy promoted intent could have a newer timestamp; the pinned run still proves the earlier origin.
  await getDatabase().run('UPDATE trading_trade_intents SET created_at = ? WHERE id = ?', [Date.now(), promoted.id]);
  await engine.processIntent(promoted.id);
  const selected = await getTradingIntent(promoted.id);
  assert.ok(selected.plan, 'The supported fallback account must receive the trading plan.');
  assert.equal(selected.plan.entryExpiresAt, fallbackOrigin + DEFAULT_STRATEGY_CONFIGURATION.safety.entryOrderTtlSeconds * 1_000,
    'A fallback promoted after 90 percent of its TTL must retain only the original remaining lifetime.');
  assert.equal(selected.plan.leverageTierDecision.maximumNotional, '2500', 'Margin budget must use the selected fallback account equity.');
  assert.equal(selected.plan.notional, '2487.5', 'Quantity reserves the real IOC cap cost and rounds down without increasing margin.');
  assert.deepEqual(
    await getDatabase().all(
      'SELECT account_id AS accountId FROM workflow_adaptive_risk_state ORDER BY account_id',
    ),
    [{ accountId: fallbackAccount.id }],
    'Adaptive-risk state must be evaluated for the selected account, never shared with the unavailable primary.',
  );
  assert.equal(Number((await getDatabase().get(
    'SELECT COUNT(*) AS count FROM trading_orders WHERE account_id = ? AND role = ?', [fallbackAccount.id, 'entry'],
  )).count), 1);
  assert.equal((await getDatabase().get('SELECT status FROM trading_fallback_runs')).status, 'selected');

  await saveSignal('fallback-exhausted', '-100-fallback-a', 2, '<signal/>', '<signal/>');
  const unavailableSignal = {
    ...signal, symbol: 'ETHUSDT',
    targets: [{ min: '210', max: '210' }, { min: '220', max: '220' }], stopLoss: '190',
  };
  const [unavailablePrimary] = await createWorkflowTradingIntents({
    sourceSignalId: 'fallback-exhausted', channelId: '-100-fallback-a',
    sourceText: 'ETHUSDT LONG', signal: unavailableSignal,
  });
  await engine.processIntent(unavailablePrimary.id);
  const unavailableFallback = await getDatabase().get(
    `SELECT intent.id FROM trading_trade_intents AS intent
     JOIN trading_fallback_candidates AS candidate ON candidate.intent_id = intent.id
     JOIN trading_fallback_runs AS run ON run.id = candidate.fallback_run_id
     WHERE run.source_signal_id = ? AND candidate.rank = 1`,
    ['fallback-exhausted'],
  );
  await engine.processIntent(unavailableFallback.id);
  const unavailableThird = await getDatabase().get(
    `SELECT intent.id FROM trading_trade_intents AS intent
     JOIN trading_fallback_candidates AS candidate ON candidate.intent_id = intent.id
     JOIN trading_fallback_runs AS run ON run.id = candidate.fallback_run_id
     WHERE run.source_signal_id = ? AND candidate.rank = 2`,
    ['fallback-exhausted'],
  );
  await engine.processIntent(unavailableThird.id);
  assert.deepEqual(
    await getDatabase().get(
      'SELECT status, stop_reason AS stopReason FROM trading_fallback_runs WHERE source_signal_id = ?',
      ['fallback-exhausted'],
    ),
    { status: 'exhausted', stopReason: 'SYMBOL_UNAVAILABLE' },
  );
  assert.equal(Number((await getDatabase().get(
    'SELECT COUNT(*) AS count FROM trading_orders WHERE intent_id IN (?, ?, ?)',
    [unavailablePrimary.id, unavailableFallback.id, unavailableThird.id],
  )).count), 0);
  const visibleRuns = await listWorkflowFallbackRuns();
  assert.equal(visibleRuns.length, 2);
  assert.deepEqual(visibleRuns.map(run => run.status).sort(), ['exhausted', 'selected']);
  assert.deepEqual(visibleRuns.find(run => run.status === 'selected').candidates.map(candidate => candidate.status), [
    'unavailable', 'selected', 'stopped',
  ]);
  const analytics = await getFilteredTradingAnalytics({
    since: 0, until: Date.now(), channelIds: ['-100-fallback-a'], accountIds: [],
    exchanges: [], modes: [], statuses: [],
  });
  assert.deepEqual(
    {
      runs: analytics.fallback.runs,
      selected: analytics.fallback.selected,
      exhausted: analytics.fallback.exhausted,
      unavailableCandidates: analytics.fallback.unavailableCandidates,
    },
    { runs: 2, selected: 1, exhausted: 1, unavailableCandidates: 4 },
  );
  const primaryAccountAnalytics = await getFilteredTradingAnalytics({
    since: 0, until: Date.now(), channelIds: [], accountIds: [primaryAccount.id],
    exchanges: [], modes: [], statuses: [],
  });
  assert.deepEqual(
    {
      runs: primaryAccountAnalytics.fallback.runs,
      selected: primaryAccountAnalytics.fallback.selected,
      exhausted: primaryAccountAnalytics.fallback.exhausted,
      unavailableCandidates: primaryAccountAnalytics.fallback.unavailableCandidates,
    },
    { runs: 2, selected: 0, exhausted: 1, unavailableCandidates: 2 },
    'Account-filtered analytics must not attribute another candidate account selection to the filtered account.',
  );

  await saveSignal('fallback-technical-stop', '-100-fallback-a', 3, '<signal/>', '<signal/>');
  const [technicalPrimary] = await createWorkflowTradingIntents({
    sourceSignalId: 'fallback-technical-stop', channelId: '-100-fallback-a',
    sourceText: 'SOLUSDT LONG', signal: { ...signal, symbol: 'SOLUSDT' },
  });
  const technicalAdapter = {
    exchange: 'paper',
    accountSnapshot: (...args) => paper.accountSnapshot(...args),
    marketSnapshot: async () => { throw new Error('Exchange executor request failed (502): simulated timeout'); },
    submitOrder: (...args) => paper.submitOrder(...args),
    submitProtectedEntry: (...args) => paper.submitProtectedEntry(...args),
    cancelOrder: (...args) => paper.cancelOrder(...args),
    openState: (...args) => paper.openState(...args),
  };
  await new TradingEngine([technicalAdapter]).processIntent(technicalPrimary.id);
  assert.equal((await getTradingIntent(technicalPrimary.id)).status, 'unknown');
  const technicalRun = await getDatabase().get(
    `SELECT id, status, stop_reason AS stopReason FROM trading_fallback_runs WHERE source_signal_id = ?`,
    ['fallback-technical-stop'],
  );
  assert.deepEqual(
    { status: technicalRun.status, stopReason: technicalRun.stopReason },
    { status: 'stopped', stopReason: 'ORDER_OUTCOME_UNKNOWN' },
  );
  assert.equal(Number((await getDatabase().get(
    `SELECT COUNT(*) AS count FROM trading_fallback_candidates
     WHERE fallback_run_id = ? AND rank > 0 AND intent_id IS NOT NULL`,
    [technicalRun.id],
  )).count), 0, 'Technical failures must never promote a fallback account.');
  await getDatabase().run(
    `UPDATE trading_risk_events SET acknowledged_at = ? WHERE intent_id = ?`,
    [Date.now(), technicalPrimary.id],
  );

  await saveSignal('fallback-account-stop', '-100-fallback-a', 6, '<signal/>', '<signal/>');
  const [accountFailurePrimary] = await createWorkflowTradingIntents({
    sourceSignalId: 'fallback-account-stop', channelId: '-100-fallback-a',
    sourceText: 'DOGEUSDT LONG', signal: { ...signal, symbol: 'DOGEUSDT' },
  });
  let marketCallsAfterAccountFailure = 0;
  const accountFailureAdapter = {
    ...technicalAdapter,
    accountSnapshot: async () => { throw new Error('Exchange executor request failed (503): account unavailable'); },
    marketSnapshot: async () => { marketCallsAfterAccountFailure += 1; throw new Error('must not run'); },
  };
  await new TradingEngine([accountFailureAdapter]).processIntent(accountFailurePrimary.id);
  assert.equal((await getTradingIntent(accountFailurePrimary.id)).status, 'unknown');
  const accountFailureRun = await getDatabase().get(
    `SELECT id, status, stop_reason AS stopReason
     FROM trading_fallback_runs WHERE source_signal_id = ?`,
    ['fallback-account-stop'],
  );
  assert.deepEqual(
    { status: accountFailureRun.status, stopReason: accountFailureRun.stopReason },
    { status: 'stopped', stopReason: 'ORDER_OUTCOME_UNKNOWN' },
  );
  assert.equal(marketCallsAfterAccountFailure, 0, 'Account health must be established before symbol fallback is evaluated.');
  assert.equal(Number((await getDatabase().get(
    `SELECT COUNT(*) AS count FROM trading_fallback_candidates
     WHERE fallback_run_id = ? AND rank > 0 AND intent_id IS NOT NULL`,
    [accountFailureRun.id],
  )).count), 0);
  await getDatabase().run(
    `UPDATE trading_risk_events SET acknowledged_at = ? WHERE intent_id = ?`,
    [Date.now(), accountFailurePrimary.id],
  );

  await saveSignal('fallback-risk-stop', '-100-fallback-a', 7, '<signal/>', '<signal/>');
  const [riskPrimary] = await createWorkflowTradingIntents({
    sourceSignalId: 'fallback-risk-stop', channelId: '-100-fallback-a',
    sourceText: 'AVAXUSDT LONG', signal: { ...signal, symbol: 'AVAXUSDT' },
  });
  await updateTradingRuntimeState({ executionEnabled: false });
  await engine.processIntent(riskPrimary.id);
  assert.equal((await getTradingIntent(riskPrimary.id)).blockReason, 'EXECUTION_DISABLED');
  const riskRun = await getDatabase().get(
    `SELECT id, status, stop_reason AS stopReason
     FROM trading_fallback_runs WHERE source_signal_id = ?`,
    ['fallback-risk-stop'],
  );
  assert.deepEqual(
    { status: riskRun.status, stopReason: riskRun.stopReason },
    { status: 'stopped', stopReason: 'EXECUTION_DISABLED' },
  );
  assert.equal(Number((await getDatabase().get(
    `SELECT COUNT(*) AS count FROM trading_fallback_candidates
     WHERE fallback_run_id = ? AND rank > 0 AND intent_id IS NOT NULL`,
    [riskRun.id],
  )).count), 0, 'Risk and runtime gates must stop the route instead of activating fallback.');
  await updateTradingRuntimeState({ executionEnabled: true });

  const capacitySeedIntentId = await seedActivePosition(primaryAccount, 'OTHERUSDT', 'full');
  await getDatabase().run(
    'UPDATE trading_accounts SET max_concurrent_positions = 1 WHERE id = ?',
    [primaryAccount.id],
  );
  await paper.setMarket(fallbackAccount.id, {
    symbol: 'LTCUSDT', markPrice: '100', priceTick: '0.1', quantityStep: '0.001',
    minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 50,
  });
  const capacityCalls = { account: 0, market: 0 };
  const capacityAdapter = {
    exchange: 'paper',
    accountSnapshot: account => {
      if (account.id === primaryAccount.id) capacityCalls.account += 1;
      return paper.accountSnapshot(account);
    },
    marketSnapshot: (account, symbol) => {
      if (account.id === primaryAccount.id) capacityCalls.market += 1;
      return paper.marketSnapshot(account, symbol);
    },
    submitOrder: (...args) => paper.submitOrder(...args),
    submitProtectedEntry: (...args) => paper.submitProtectedEntry(...args),
    cancelOrder: (...args) => paper.cancelOrder(...args),
    openState: (...args) => paper.openState(...args),
  };
  await saveSignal('fallback-capacity', '-100-fallback-a', 20, '<signal/>', '<signal/>');
  const [capacityPrimary] = await createWorkflowTradingIntents({
    sourceSignalId: 'fallback-capacity', channelId: '-100-fallback-a',
    sourceText: 'LTCUSDT LONG', signal: { ...signal, symbol: 'LTCUSDT' },
  });
  await new TradingEngine([capacityAdapter]).processIntent(capacityPrimary.id);
  assert.equal((await getTradingIntent(capacityPrimary.id)).blockReason, 'MAX_CONCURRENT_POSITIONS');
  assert.deepEqual(capacityCalls, { account: 0, market: 0 },
    'Local capacity fallback must happen before exchange account and market calls.');
  const capacityPromoted = await getDatabase().get(
    `SELECT candidate.status, candidate.intent_id AS intentId FROM trading_fallback_candidates AS candidate
     JOIN trading_fallback_runs AS run ON run.id = candidate.fallback_run_id
     WHERE run.source_signal_id = 'fallback-capacity' AND candidate.rank = 1`,
  );
  assert.equal(capacityPromoted.status, 'pending');
  await getDatabase().run(
    'UPDATE trading_accounts SET max_concurrent_positions = 1 WHERE id = ?',
    [fallbackAccount.id],
  );
  await new TradingEngine([capacityAdapter]).processIntent(capacityPromoted.intentId);
  assert.equal((await getTradingIntent(capacityPromoted.intentId)).blockReason, 'MAX_CONCURRENT_POSITIONS');
  assert.deepEqual(
    await getDatabase().get(
      `SELECT status, stop_reason AS stopReason FROM trading_fallback_runs WHERE source_signal_id = 'fallback-capacity'`,
    ),
    { status: 'stopped', stopReason: 'MAX_CONCURRENT_POSITIONS' },
    'The A→B full-capacity policy must not leak into the pair-only B→C edge.',
  );
  assert.equal(Number((await getDatabase().get(
    `SELECT COUNT(*) AS count FROM trading_fallback_candidates AS candidate
     JOIN trading_fallback_runs AS run ON run.id = candidate.fallback_run_id
     WHERE run.source_signal_id = 'fallback-capacity' AND candidate.rank = 2 AND candidate.intent_id IS NOT NULL`,
  )).count), 0);
  await getDatabase().run(
    'UPDATE trading_accounts SET max_concurrent_positions = 10 WHERE id = ?',
    [fallbackAccount.id],
  );
  await paper.setMarket(thirdAccount.id, {
    symbol: 'MATICUSDT', markPrice: '100', priceTick: '0.1', quantityStep: '0.001',
    minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 50,
  });
  await saveSignal('fallback-mixed-chain', '-100-fallback-a', 28, '<signal/>', '<signal/>');
  const [mixedPrimary] = await createWorkflowTradingIntents({
    sourceSignalId: 'fallback-mixed-chain', channelId: '-100-fallback-a',
    sourceText: 'MATICUSDT LONG', signal: { ...signal, symbol: 'MATICUSDT' },
  });
  const mixedEngine = new TradingEngine([capacityAdapter]);
  await mixedEngine.processIntent(mixedPrimary.id);
  const mixedFallback = await getDatabase().get(
    `SELECT candidate.intent_id AS intentId FROM trading_fallback_candidates AS candidate
     JOIN trading_fallback_runs AS run ON run.id = candidate.fallback_run_id
     WHERE run.source_signal_id = 'fallback-mixed-chain' AND candidate.rank = 1`,
  );
  await mixedEngine.processIntent(mixedFallback.intentId);
  const mixedThird = await getDatabase().get(
    `SELECT candidate.intent_id AS intentId FROM trading_fallback_candidates AS candidate
     JOIN trading_fallback_runs AS run ON run.id = candidate.fallback_run_id
     WHERE run.source_signal_id = 'fallback-mixed-chain' AND candidate.rank = 2`,
  );
  await mixedEngine.processIntent(mixedThird.intentId);
  assert.deepEqual(
    await getDatabase().get(
      `SELECT status, current_rank AS currentRank, selected_intent_id AS selectedIntentId
       FROM trading_fallback_runs WHERE source_signal_id = 'fallback-mixed-chain'`,
    ),
    { status: 'selected', currentRank: 2, selectedIntentId: mixedThird.intentId },
    'A full → B symbol unavailable → C free must select C with each edge using its own policy.',
  );
  await getDatabase().run(
    'UPDATE trading_accounts SET max_concurrent_positions = 1 WHERE id = ?',
    [thirdAccount.id],
  );
  await saveSignal('fallback-last-full', '-100-fallback-a', 29, '<signal/>', '<signal/>');
  const [lastFullPrimary] = await createWorkflowTradingIntents({
    sourceSignalId: 'fallback-last-full', channelId: '-100-fallback-a',
    sourceText: 'AVAXUSDT LONG', signal: { ...signal, symbol: 'AVAXUSDT' },
  });
  await mixedEngine.processIntent(lastFullPrimary.id);
  const lastFullFallback = await getDatabase().get(
    `SELECT candidate.intent_id AS intentId FROM trading_fallback_candidates AS candidate
     JOIN trading_fallback_runs AS run ON run.id = candidate.fallback_run_id
     WHERE run.source_signal_id = 'fallback-last-full' AND candidate.rank = 1`,
  );
  await mixedEngine.processIntent(lastFullFallback.intentId);
  const lastFullThird = await getDatabase().get(
    `SELECT candidate.intent_id AS intentId FROM trading_fallback_candidates AS candidate
     JOIN trading_fallback_runs AS run ON run.id = candidate.fallback_run_id
     WHERE run.source_signal_id = 'fallback-last-full' AND candidate.rank = 2`,
  );
  await mixedEngine.processIntent(lastFullThird.intentId);
  assert.deepEqual(
    await getDatabase().get(
      `SELECT status, stop_reason AS stopReason FROM trading_fallback_runs
       WHERE source_signal_id = 'fallback-last-full'`,
    ),
    { status: 'exhausted', stopReason: 'MAX_CONCURRENT_POSITIONS' },
    'An eligible failure on the final candidate must exhaust the run with its exact reason.',
  );
  await getDatabase().run(
    'UPDATE trading_accounts SET max_concurrent_positions = 10 WHERE id = ?',
    [thirdAccount.id],
  );

  await getDatabase().run(
    `INSERT INTO trading_orders (
       id, intent_id, account_id, client_order_id, exchange_order_id, role, side, order_type,
       status, price, trigger_price, quantity, filled_quantity, reduce_only, request_json,
       response_json, last_error, created_at, updated_at
     ) VALUES ('capacity-unknown-order', ?, ?, 'capacity-unknown-client', NULL, 'entry', 'buy',
               'limit', 'unknown', '1', NULL, '1', '0', 0, '{}', NULL, 'unknown', ?, ?)`,
    [capacitySeedIntentId, primaryAccount.id, Date.now(), Date.now()],
  );
  await saveSignal('fallback-hard-safety', '-100-fallback-a', 21, '<signal/>', '<signal/>');
  const [hardSafetyPrimary] = await createWorkflowTradingIntents({
    sourceSignalId: 'fallback-hard-safety', channelId: '-100-fallback-a',
    sourceText: 'LINKUSDT LONG', signal: { ...signal, symbol: 'LINKUSDT' },
  });
  await new TradingEngine([capacityAdapter]).processIntent(hardSafetyPrimary.id);
  assert.equal((await getTradingIntent(hardSafetyPrimary.id)).blockReason, 'UNRESOLVED_ORDER',
    'An unresolved order must win over an otherwise eligible capacity fallback.');
  assert.deepEqual(
    await getDatabase().get(
      `SELECT status, stop_reason AS stopReason FROM trading_fallback_runs WHERE source_signal_id = 'fallback-hard-safety'`,
    ),
    { status: 'stopped', stopReason: 'UNRESOLVED_ORDER' },
  );
  assert.equal(Number((await getDatabase().get(
    `SELECT COUNT(*) AS count FROM trading_fallback_candidates AS candidate
     JOIN trading_fallback_runs AS run ON run.id = candidate.fallback_run_id
     WHERE run.source_signal_id = 'fallback-hard-safety' AND candidate.rank > 0 AND candidate.intent_id IS NOT NULL`,
  )).count), 0);
  await getDatabase().run("DELETE FROM trading_orders WHERE id = 'capacity-unknown-order'");

  await getDatabase().run(
    'UPDATE trading_accounts SET max_concurrent_positions = 10 WHERE id = ?',
    [primaryAccount.id],
  );
  await getDatabase().run(
    `INSERT INTO trading_risk_events (
       id, severity, code, account_id, intent_id, details_json, created_at, acknowledged_at
     ) VALUES ('fallback-critical-risk', 'critical', 'TEST_CRITICAL', ?, NULL, '{}', ?, NULL)`,
    [primaryAccount.id, Date.now()],
  );
  await saveSignal('fallback-critical-owned', '-100-fallback-a', 23, '<signal/>', '<signal/>');
  const [criticalOwnedPrimary] = await createWorkflowTradingIntents({
    sourceSignalId: 'fallback-critical-owned', channelId: '-100-fallback-a',
    sourceText: 'OTHERUSDT LONG', signal: { ...signal, symbol: 'OTHERUSDT' },
  });
  await new TradingEngine([capacityAdapter]).processIntent(criticalOwnedPrimary.id);
  assert.equal((await getTradingIntent(criticalOwnedPrimary.id)).blockReason, 'UNACKNOWLEDGED_CRITICAL_RISK');
  assert.equal(Number((await getDatabase().get(
    `SELECT COUNT(*) AS count FROM trading_fallback_candidates AS candidate
     JOIN trading_fallback_runs AS run ON run.id = candidate.fallback_run_id
     WHERE run.source_signal_id = 'fallback-critical-owned' AND candidate.rank > 0 AND candidate.intent_id IS NOT NULL`,
  )).count), 0, 'Critical risk must win over an otherwise eligible owned-symbol fallback.');
  await getDatabase().run(
    "UPDATE trading_risk_events SET acknowledged_at = ? WHERE id = 'fallback-critical-risk'",
    [Date.now()],
  );

  await getDatabase().run(
    "UPDATE trading_accounts SET kill_switch_active = 1, kill_switch_reason = 'test' WHERE id = ?",
    [primaryAccount.id],
  );
  await saveSignal('fallback-account-kill', '-100-fallback-a', 24, '<signal/>', '<signal/>');
  const [accountKillPrimary] = await createWorkflowTradingIntents({
    sourceSignalId: 'fallback-account-kill', channelId: '-100-fallback-a',
    sourceText: 'ATOMUSDT LONG', signal: { ...signal, symbol: 'ATOMUSDT' },
  });
  await new TradingEngine([capacityAdapter]).processIntent(accountKillPrimary.id);
  assert.equal((await getTradingIntent(accountKillPrimary.id)).blockReason, 'ACCOUNT_KILL_SWITCH_ACTIVE');
  await getDatabase().run(
    'UPDATE trading_accounts SET kill_switch_active = 0, kill_switch_reason = NULL WHERE id = ?',
    [primaryAccount.id],
  );

  await updateTradingRuntimeState({ killSwitchActive: true, killSwitchReason: 'fallback test' });
  await saveSignal('fallback-global-kill', '-100-fallback-a', 25, '<signal/>', '<signal/>');
  const [globalKillPrimary] = await createWorkflowTradingIntents({
    sourceSignalId: 'fallback-global-kill', channelId: '-100-fallback-a',
    sourceText: 'NEARUSDT LONG', signal: { ...signal, symbol: 'NEARUSDT' },
  });
  await new TradingEngine([capacityAdapter]).processIntent(globalKillPrimary.id);
  assert.equal((await getTradingIntent(globalKillPrimary.id)).blockReason, 'KILL_SWITCH_ACTIVE');
  await updateTradingRuntimeState({
    executionEnabled: true,
    killSwitchActive: false,
    killSwitchReason: null,
  });

  await paper.setMarket(primaryAccount.id, {
    symbol: 'UNIUSDT', markPrice: '10', priceTick: '0.01', quantityStep: '0.01',
    minimumQuantity: '0.01', minimumNotional: '10', maxLeverage: 50,
  });
  const dailyLossAdapter = {
    ...capacityAdapter,
    accountSnapshot: async account => ({
      ...(await paper.accountSnapshot(account)),
      unrealizedPnl: account.id === primaryAccount.id ? '-100000' : '0',
    }),
  };
  await saveSignal('fallback-daily-loss', '-100-fallback-a', 26, '<signal/>', '<signal/>');
  const [dailyLossPrimary] = await createWorkflowTradingIntents({
    sourceSignalId: 'fallback-daily-loss', channelId: '-100-fallback-a',
    sourceText: 'UNIUSDT LONG', signal: {
      ...signal, symbol: 'UNIUSDT',
      targets: [{ min: '11', max: '11' }, { min: '12', max: '12' }], stopLoss: '9',
    },
  });
  await new TradingEngine([dailyLossAdapter]).processIntent(dailyLossPrimary.id);
  assert.equal((await getTradingIntent(dailyLossPrimary.id)).blockReason, 'MAX_DAILY_LOSS');

  const originalSeedPlan = (await getDatabase().get(
    'SELECT plan_json FROM trading_trade_intents WHERE id = ?', [capacitySeedIntentId],
  )).plan_json;
  await getDatabase().run(
    "UPDATE trading_trade_intents SET plan_json = 'not-json' WHERE id = ?",
    [capacitySeedIntentId],
  );
  await saveSignal('fallback-daily-risk', '-100-fallback-a', 27, '<signal/>', '<signal/>');
  const [dailyRiskPrimary] = await createWorkflowTradingIntents({
    sourceSignalId: 'fallback-daily-risk', channelId: '-100-fallback-a',
    sourceText: 'UNIUSDT LONG', signal: {
      ...signal, symbol: 'UNIUSDT',
      targets: [{ min: '11', max: '11' }, { min: '12', max: '12' }], stopLoss: '9',
    },
  });
  await new TradingEngine([capacityAdapter]).processIntent(dailyRiskPrimary.id);
  assert.equal((await getTradingIntent(dailyRiskPrimary.id)).blockReason, 'ENTRY_SAFETY_UNPROVEN',
    'A corrupted existing plan fails the account safety proof before risk sizing and must not trigger fallback.');
  assert.equal(Number((await getDatabase().get(
    `SELECT COUNT(*) AS count FROM trading_fallback_candidates AS candidate
     JOIN trading_fallback_runs AS run ON run.id = candidate.fallback_run_id
     WHERE run.source_signal_id = 'fallback-daily-risk' AND candidate.rank > 0 AND candidate.intent_id IS NOT NULL`,
  )).count), 0);
  await getDatabase().run(
    'UPDATE trading_trade_intents SET plan_json = ? WHERE id = ?',
    [originalSeedPlan, capacitySeedIntentId],
  );
  const releaseControl = new TradingWebControl(new TradingCredentialStore(directory), paper, [], engine);
  await releaseControl.releaseAccountKillSwitch({ id: primaryAccount.id, confirmation: 'RELEASE ACCOUNT KILL SWITCH' });

  await seedActivePosition(primaryAccount, 'DOTUSDT', 'owned');
  await paper.setMarket(fallbackAccount.id, {
    symbol: 'DOTUSDT', markPrice: '10', priceTick: '0.01', quantityStep: '0.01',
    minimumQuantity: '0.01', minimumNotional: '10', maxLeverage: 50,
  });
  await saveSignal('fallback-owned', '-100-fallback-a', 22, '<signal/>', '<signal/>');
  const [ownedPrimary] = await createWorkflowTradingIntents({
    sourceSignalId: 'fallback-owned', channelId: '-100-fallback-a',
    sourceText: 'DOTUSDT LONG', signal: { ...signal, symbol: 'DOTUSDT' },
  });
  await new TradingEngine([capacityAdapter]).processIntent(ownedPrimary.id);
  assert.equal((await getTradingIntent(ownedPrimary.id)).blockReason, 'SYMBOL_ALREADY_OWNED');
  assert.equal((await getDatabase().get(
    `SELECT candidate.status FROM trading_fallback_candidates AS candidate
     JOIN trading_fallback_runs AS run ON run.id = candidate.fallback_run_id
     WHERE run.source_signal_id = 'fallback-owned' AND candidate.rank = 1`,
  )).status, 'pending');
  const skipAnalytics = await getFilteredTradingAnalytics({
    since: 0, until: Date.now(), channelIds: ['-100-fallback-a'], accountIds: [],
    exchanges: [], modes: [], statuses: [],
  });
  assert.deepEqual(skipAnalytics.fallback.skippedByReason, {
    SYMBOL_UNAVAILABLE: 6,
    MAX_CONCURRENT_POSITIONS: 4,
    SYMBOL_ALREADY_OWNED: 1,
  });
  const fallbackEvents = (await listTradingNotificationEvents({ afterSeq: 0, limit: 1000 })).events
    .filter(event => event.eventType === 'workflow_fallback_candidate_skipped');
  assert.ok(fallbackEvents.some(event => event.intentId === capacityPrimary.id
    && event.details.reason === 'MAX_CONCURRENT_POSITIONS'
    && event.details.fromAccountId === primaryAccount.id
    && event.details.toAccountId === fallbackAccount.id));
  assert.ok(fallbackEvents.some(event => event.intentId === ownedPrimary.id
    && event.details.reason === 'SYMBOL_ALREADY_OWNED'));

  // The genuinely protected capacity positions remain open; later admission must prove them too.
  // TTL is independent of the unresolved-dispatch account incident tested next.
  await saveSignal('fallback-expired', '-100-fallback-a', 4, '<signal/>', '<signal/>');
  const expiredOrigin = Date.now() - (DEFAULT_STRATEGY_CONFIGURATION.safety.entryOrderTtlSeconds + 1) * 1_000;
  const [expiredPrimary] = await createWorkflowTradingIntents({
    sourceSignalId: 'fallback-expired', channelId: '-100-fallback-a',
    sourceText: 'XRPUSDT LONG', signal: { ...signal, symbol: 'XRPUSDT' },
  }, expiredOrigin);
  await engine.processIntent(expiredPrimary.id);
  assert.equal((await getTradingIntent(expiredPrimary.id)).blockReason, 'ENTRY_INTENT_EXPIRED');
  const expiredRun = await getDatabase().get(
    `SELECT id, status, stop_reason AS stopReason FROM trading_fallback_runs WHERE source_signal_id = ?`,
    ['fallback-expired'],
  );
  assert.deepEqual(
    { status: expiredRun.status, stopReason: expiredRun.stopReason },
    { status: 'stopped', stopReason: 'ENTRY_INTENT_EXPIRED' },
  );
  assert.equal(Number((await getDatabase().get(
    `SELECT COUNT(*) AS count FROM trading_fallback_candidates
     WHERE fallback_run_id = ? AND rank > 0 AND intent_id IS NOT NULL`,
    [expiredRun.id],
  )).count), 0, 'The original entry TTL must never reset for fallback accounts.');

  await saveSignal('fallback-submit-stop', '-100-fallback-a', 5, '<signal/>', '<signal/>');
  await paper.setMarket(primaryAccount.id, {
    symbol: 'ADAUSDT', markPrice: '1', priceTick: '0.001', quantityStep: '1',
    minimumQuantity: '1', minimumNotional: '10', maxLeverage: 50,
  });
  const [submitPrimary] = await createWorkflowTradingIntents({
    sourceSignalId: 'fallback-submit-stop', channelId: '-100-fallback-a',
    sourceText: 'ADAUSDT LONG', signal: {
      ...signal, symbol: 'ADAUSDT',
      targets: [{ min: '1.1', max: '1.1' }, { min: '1.2', max: '1.2' }], stopLoss: '0.9',
    },
  });
  const submitFailureAdapter = {
    exchange: 'paper',
    accountSnapshot: (...args) => paper.accountSnapshot(...args),
    marketSnapshot: (...args) => paper.marketSnapshot(...args),
    submitOrder: async () => { throw new Error('simulated submit timeout'); },
    submitProtectedEntry: async () => { throw new Error('simulated submit timeout'); },
    cancelOrder: (...args) => paper.cancelOrder(...args),
    openState: (...args) => paper.openState(...args),
  };
  await new TradingEngine([submitFailureAdapter]).processIntent(submitPrimary.id);
  const submitResult = await getTradingIntent(submitPrimary.id);
  assert.equal(submitResult.status, 'unknown', JSON.stringify({
    blockReason: submitResult.blockReason,
    lastError: submitResult.lastError,
  }));
  const submitRun = await getDatabase().get(
    `SELECT id, status, selected_intent_id AS selectedIntentId
     FROM trading_fallback_runs WHERE source_signal_id = ?`,
    ['fallback-submit-stop'],
  );
  assert.deepEqual(
    { status: submitRun.status, selectedIntentId: submitRun.selectedIntentId },
    { status: 'selected', selectedIntentId: submitPrimary.id },
    'Once a supported market is selected, even an uncertain submit outcome must never fall through.',
  );
  assert.equal(Number((await getDatabase().get(
    `SELECT COUNT(*) AS count FROM trading_fallback_candidates
     WHERE fallback_run_id = ? AND rank > 0 AND intent_id IS NOT NULL`,
    [submitRun.id],
  )).count), 0);

  const pairOnlyGraph = structuredClone(graph);
  pairOnlyGraph.edges.find(edge => edge.id === 'account-a-account-b-fallback').fallbackOn = pairOnlyFallbackPolicy;
  const policyImpact = await previewWorkflowImpact({ baseRevisionId: workflow.id, graph: pairOnlyGraph });
  assert.equal(policyImpact.destructive, true, 'A policy-only edit must be treated as a behavior change.');
  assert.ok(policyImpact.changed.length > 0);
  await assert.rejects(
    saveWorkflowRevision({ baseRevisionId: workflow.id, graph: pairOnlyGraph, actorId: 'test:policy-no-confirmation' }),
    /WORKFLOW_IMPACT_CONFIRMATION_REQUIRED/,
  );
  const policyWorkflow = await saveWorkflowRevision({
    baseRevisionId: workflow.id,
    graph: pairOnlyGraph,
    actorId: 'test:policy-edit',
    confirmation: WORKFLOW_IMPACT_CONFIRMATION,
    history: { mode: 'record', label: 'Fallback-Regel aktualisiert' },
  });
  assert.equal((await getWorkflowBuilderHistoryStatus()).canUndo, true);
  assert.equal((await previewWorkflowBuilderHistoryImpact({
    direction: 'undo', baseRevisionId: policyWorkflow.id,
  })).destructive, true);
  const undone = await applyWorkflowBuilderHistory({
    direction: 'undo', baseRevisionId: policyWorkflow.id, actorId: 'test:policy-undo',
    confirmation: WORKFLOW_IMPACT_CONFIRMATION,
  });
  assert.equal(undone.workflow.revision, policyWorkflow.revision + 1);
  assert.deepEqual(
    undone.workflow.graph.edges.find(edge => edge.id === 'account-a-account-b-fallback').fallbackOn,
    fullFallbackPolicy,
  );
  const redone = await applyWorkflowBuilderHistory({
    direction: 'redo', baseRevisionId: undone.workflow.id, actorId: 'test:policy-redo',
    confirmation: WORKFLOW_IMPACT_CONFIRMATION,
  });
  assert.equal(redone.workflow.revision, undone.workflow.revision + 1);
  assert.deepEqual(
    redone.workflow.graph.edges.find(edge => edge.id === 'account-a-account-b-fallback').fallbackOn,
    pairOnlyFallbackPolicy,
  );

  console.log('Workflow fallback tests passed.');
} finally {
  await closeDb().catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}
