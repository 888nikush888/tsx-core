import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import {
  listTradingAccounts,
  listTradingStrategies,
} from '../src/trading_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { DEFAULT_STRATEGY_CONFIGURATION } from '../src/trading_strategy.js';
import {
  getChannelPerformanceAnalytics,
  getTradingExecutionAnalytics,
  listTradingEquityPoints,
  recordTradingEquitySnapshot,
  recordTradingExecutionEvent,
} from '../src/trading_telemetry.js';
import {
  getWorkflowAdaptiveRiskAnalytics,
  listChannelRiskEvaluations,
  resolveEffectiveChannelRisk,
  resolveWorkflowAdaptiveRisk,
  upsertChannelRiskPolicy,
} from '../src/trading_channel_risk.js';
import {
  createWorkflowResourceDraft,
  publishWorkflowResource,
} from '../src/workflow_repository.js';

async function insertIntentFixture({
  id,
  channelId,
  accountId,
  strategyVersionId,
  status = 'completed',
  realizedPnl,
  plannedPrice,
  planJson = '{"entryPrice":"100"}',
  fillPrice,
  closedAt,
}) {
  await saveSignal(`signal-${id}`, channelId, Number(id.replace(/\D/g, '')) || 1, '<signal/>', `<signal id="${id}"/>`);
  await getDatabase().run(
    `INSERT INTO trading_trade_intents (
       id, source_signal_id, root_source_signal_id, channel_id, strategy_version_id, account_id,
       exchange, mode, symbol, side, status, signal_json, plan_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'paper', 'paper', 'BTCUSD', 'LONG', ?, '{}', ?, ?, ?)`,
    [id, `signal-${id}`, `signal-${id}`, channelId, strategyVersionId, accountId, status, planJson, closedAt - 2_000, closedAt],
  );
  if (realizedPnl !== undefined) {
    await getDatabase().run(
      `INSERT INTO trading_positions (
         id, intent_id, account_id, strategy_version_id, channel_id, symbol, side,
         status, quantity, average_entry_price, stop_price, realized_pnl,
         opened_at, closed_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'BTCUSD', 'LONG', 'closed', '1', '100', '90', ?, ?, ?, ?)`,
      [`position-${id}`, id, accountId, strategyVersionId, channelId, realizedPnl, closedAt - 1_000, closedAt, closedAt],
    );
  }
  if (fillPrice === undefined) return;
  await getDatabase().run(
    `INSERT INTO trading_orders (
       id, intent_id, account_id, client_order_id, role, side, order_type, status,
       price, quantity, filled_quantity, reduce_only, request_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'entry', 'buy', 'limit', 'filled', ?, '1', '1', 0, '{}', ?, ?)`,
    [`order-${id}`, id, accountId, `client-${id}`, plannedPrice ?? null, closedAt - 500, closedAt],
  );
  await getDatabase().run(
    `INSERT INTO trading_fills (
       id, order_id, account_id, exchange_fill_id, price, quantity, fee, filled_at, raw_json
     ) VALUES (?, ?, ?, ?, ?, '1', '0.1', ?, '{}')`,
    [`fill-${id}`, `order-${id}`, accountId, `exchange-fill-${id}`, fillPrice, closedAt],
  );
}

function policyInput(channelId, overrides = {}) {
  return {
    channelId,
    mode: 'automatic',
    tiers: [{ riskPercent: '0.5' }, { riskPercent: '1' }, { riskPercent: '1.5' }],
    currentTier: 1,
    lookbackWeeks: 1,
    minimumClosedTrades: 3,
    lossThresholdPercent: '0.1',
    profitThresholdPercent: '0.1',
    weakChannelAction: 'none',
    weakWeeksBeforeBlock: 2,
    ...overrides,
  };
}

function workflowRiskConfiguration(overrides = {}) {
  return {
    enabled: true,
    mode: 'automatic',
    tiers: [{ riskPercent: '0.5' }, { riskPercent: '1' }, { riskPercent: '1.5' }],
    startingTier: 1,
    lockedTier: null,
    lookbackWeeks: 1,
    minimumClosedTrades: 3,
    lossThresholdPercent: '0.1',
    profitThresholdPercent: '0.1',
    weakChannelAction: 'none',
    weakWeeksBeforeBlock: 2,
    manuallyBlocked: false,
    ...overrides,
  };
}

async function publishedAdaptiveRiskResource(name, configuration, resourceId) {
  const draft = await createWorkflowResourceDraft({
    resourceId,
    kind: 'adaptive_risk',
    name,
    configuration,
  });
  return publishWorkflowResource(draft.id);
}

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-trading-analytics-'));
try {
  await initDb(path.join(directory, 'forwarder.db'));
  await seedTradingFixtures();
  const account = (await listTradingAccounts())[0];
  const strategy = (await listTradingStrategies()).find(candidate => candidate.status === 'published');
  assert.ok(account);
  assert.ok(strategy);
  const evaluationNow = Date.UTC(2026, 6, 27, 12);
  const closedAt = evaluationNow - 24 * 60 * 60 * 1_000;

  await insertIntentFixture({
    id: 'profit-1', channelId: 'profit-channel', accountId: account.id,
    strategyVersionId: strategy.id, realizedPnl: '100', plannedPrice: '100',
    fillPrice: '101', closedAt,
  });
  await insertIntentFixture({
    id: 'profit-2', channelId: 'profit-channel', accountId: account.id,
    strategyVersionId: strategy.id, realizedPnl: '-20', plannedPrice: null,
    planJson: '{"entryPrice":"200"}', fillPrice: '198', closedAt: closedAt + 1,
  });
  await insertIntentFixture({
    id: 'profit-3', channelId: 'profit-channel', accountId: account.id,
    strategyVersionId: strategy.id, realizedPnl: '0', plannedPrice: null,
    planJson: '{bad-json', fillPrice: '100', closedAt: closedAt + 2,
  });
  for (let index = 1; index <= 3; index += 1) {
    await insertIntentFixture({
      id: `loss-${index}`, channelId: 'loss-channel', accountId: account.id,
      strategyVersionId: strategy.id, realizedPnl: '-100', closedAt: closedAt + 10 + index,
    });
  }
  await insertIntentFixture({
    id: 'blocked-1', channelId: 'profit-channel', accountId: account.id,
    strategyVersionId: strategy.id, status: 'blocked', closedAt: closedAt + 20,
  });
  await insertIntentFixture({
    id: 'neutral-1', channelId: 'neutral-channel', accountId: account.id,
    strategyVersionId: strategy.id, realizedPnl: '1', closedAt: closedAt + 30,
  });

  await recordTradingEquitySnapshot(account.id, {
    equity: '10000', availableBalance: '9000', unrealizedPnl: '0', marginUsed: '1000',
  }, closedAt - 60_000);
  await recordTradingEquitySnapshot(account.id, {
    equity: '9000', availableBalance: '8500', unrealizedPnl: '-500', marginUsed: '500',
  }, closedAt + 60_000);
  await recordTradingExecutionEvent({
    eventType: 'intent_created',
    intentId: 'profit-1',
    channelId: 'profit-channel',
    accountId: account.id,
    exchange: 'paper',
    mode: 'paper',
    occurredAt: closedAt - 1_000,
    details: { signalReceivedAt: closedAt - 2_000 },
  });
  await recordTradingExecutionEvent({
    eventType: 'submit_started', intentId: 'profit-1', occurredAt: closedAt - 500, details: {},
  });
  await recordTradingExecutionEvent({
    eventType: 'first_fill', intentId: 'profit-1', occurredAt: closedAt - 250, details: {},
  });

  const execution = await getTradingExecutionAnalytics(closedAt - 5_000);
  assert.equal(execution.funnel.intent_created, 1);
  assert.equal(execution.latencyMs.signalToSubmit.p50, 1_500);
  assert.equal(execution.latencyMs.signalToFirstFill.p95, 1_750);
  const performance = await getChannelPerformanceAnalytics(closedAt - 120_000);
  const profitChannel = performance.channels.find(channel => channel.id === 'profit-channel');
  assert.equal(profitChannel.closedTrades, 3);
  assert.equal(profitChannel.realizedPnl, 80);
  assert.ok(Number(profitChannel.averageEntrySlippageBps) > 0);
  assert.equal(performance.exchanges[0].id, 'paper/paper');
  assert.ok(performance.equity.some(point => Number(point.drawdownPercent) === 10));
  assert.equal((await listTradingEquityPoints(account.id, closedAt - 120_000, 10)).length, 2);
  await assert.rejects(listTradingEquityPoints(undefined, -1), /history start is invalid/);
  await assert.rejects(listTradingEquityPoints(undefined, 0, 0), /history limit is invalid/);
  await assert.rejects(recordTradingEquitySnapshot(account.id, {
    equity: '1', availableBalance: '1', unrealizedPnl: '0', marginUsed: '0',
  }, 0), /timestamp is invalid/);
  await assert.rejects(recordTradingExecutionEvent({
    eventType: 'unknown_event',
  }), /event type is invalid/);
  await assert.rejects(recordTradingExecutionEvent({
    eventType: 'signal_received',
    occurredAt: 0,
  }), /timestamp is invalid/);
  await assert.rejects(recordTradingExecutionEvent({
    eventType: 'signal_received',
    details: { text: 'x'.repeat(17 * 1024) },
  }), /details exceed/);
  assert.equal(await recordTradingExecutionEvent({
    eventType: 'signal_validated',
    channelId: 'profit-channel',
  }), true);
  await getDatabase().run(
    `INSERT INTO trading_execution_events (
       id, intent_id, event_type, occurred_at, details_json
     ) VALUES ('malformed-intent-event', 'profit-2', 'intent_created', ?, '{')`,
    [closedAt - 900],
  );
  await assert.rejects(getTradingExecutionAnalytics(closedAt - 5_000), /JSON/);

  const strategyConfiguration = structuredClone(DEFAULT_STRATEGY_CONFIGURATION);
  await assert.rejects(upsertChannelRiskPolicy(policyInput('', {})), /identifier is invalid/);
  await assert.rejects(upsertChannelRiskPolicy(policyInput('invalid-mode', { mode: 'invalid' })), /mode is invalid/);
  await assert.rejects(
    upsertChannelRiskPolicy(policyInput('invalid-action', { weakChannelAction: 'invalid' })),
    /action is invalid/,
  );
  await assert.rejects(upsertChannelRiskPolicy(policyInput('invalid-tiers', { tiers: [] })), /requires between/);
  await assert.rejects(
    upsertChannelRiskPolicy(policyInput('invalid-tier-record', { tiers: [null] })),
    /tier 1 is invalid/,
  );
  await assert.rejects(upsertChannelRiskPolicy(policyInput('invalid-tier-order', {
    tiers: [{ riskPercent: '1' }, { riskPercent: '0.5' }],
  })), /strictly increasing/);
  await assert.rejects(
    upsertChannelRiskPolicy(policyInput('invalid-manual-state', { manuallyBlocked: 'yes' })),
    /must be boolean/,
  );
  await assert.rejects(
    upsertChannelRiskPolicy(policyInput('invalid-loss-threshold', { lossThresholdPercent: {} })),
    /must be a decimal number/,
  );
  const numericThresholdPolicy = await upsertChannelRiskPolicy(policyInput('numeric-thresholds', {
    lossThresholdPercent: 1,
    profitThresholdPercent: 2,
  }));
  assert.equal(numericThresholdPolicy.lossThresholdPercent, '1');
  assert.equal(numericThresholdPolicy.profitThresholdPercent, '2');
  const baseline = await resolveEffectiveChannelRisk({
    channelId: 'unconfigured-channel',
    strategy: strategyConfiguration,
    currentEquity: '10000',
    now: evaluationNow,
  });
  assert.equal(baseline.riskPercent, strategyConfiguration.sizing.riskPerTradePercent);

  await upsertChannelRiskPolicy(policyInput('profit-channel'), evaluationNow - 10_000);
  const increased = await resolveEffectiveChannelRisk({
    channelId: 'profit-channel', strategy: strategyConfiguration, currentEquity: '10000', now: evaluationNow,
  });
  assert.equal(increased.riskPercent, '1.5');
  await resolveEffectiveChannelRisk({
    channelId: 'profit-channel', strategy: strategyConfiguration, currentEquity: '10000', now: evaluationNow,
  });

  await upsertChannelRiskPolicy(policyInput('profit-channel', {
    mode: 'shadow',
    lockedTier: 0,
  }), evaluationNow + 1);
  const shadow = await resolveEffectiveChannelRisk({
    channelId: 'profit-channel', strategy: strategyConfiguration, currentEquity: '10000', now: evaluationNow,
  });
  assert.equal(shadow.riskPercent, strategyConfiguration.sizing.riskPerTradePercent);

  await upsertChannelRiskPolicy(policyInput('neutral-channel', {
    currentTier: undefined,
    minimumClosedTrades: 1,
    lossThresholdPercent: '99',
    profitThresholdPercent: '99',
  }), evaluationNow - 10_000);
  const neutral = await resolveEffectiveChannelRisk({
    channelId: 'neutral-channel', strategy: strategyConfiguration, currentEquity: '10000', now: evaluationNow,
  });
  assert.equal(neutral.blocked, false);
  assert.match(neutral.reason, /tier 0/);

  await upsertChannelRiskPolicy(policyInput('loss-channel', {
    weakChannelAction: 'block',
    weakWeeksBeforeBlock: 1,
  }), evaluationNow - 10_000);
  const blocked = await resolveEffectiveChannelRisk({
    channelId: 'loss-channel', strategy: strategyConfiguration, currentEquity: '10000', now: evaluationNow,
  });
  assert.equal(blocked.blocked, true);
  assert.match(blocked.reason, /consecutive weak evaluations/);
  const evaluations = await listChannelRiskEvaluations();
  assert.ok(evaluations.some(evaluation => evaluation.channelId === 'profit-channel'));
  assert.ok(evaluations.some(evaluation => evaluation.action === 'block'));

  const automaticResource = await publishedAdaptiveRiskResource(
    'Automatic workflow risk',
    workflowRiskConfiguration(),
  );
  const workflowStrategyConfiguration = structuredClone(strategyConfiguration);
  workflowStrategyConfiguration.sizing.maxAdaptiveRiskPercent = '10';
  const automaticInput = {
    channelId: 'profit-channel',
    accountId: account.id,
    adaptiveResourceVersionId: automaticResource.id,
    configuration: workflowRiskConfiguration(),
    strategy: workflowStrategyConfiguration,
    currentEquity: '10000',
    now: evaluationNow,
  };
  const automatic = await resolveWorkflowAdaptiveRisk(automaticInput);
  assert.equal(automatic.riskPercent, '1.5');
  assert.equal(automatic.blocked, false);
  assert.match(automatic.reason, /account/);
  await resolveWorkflowAdaptiveRisk(automaticInput);

  const shortenedConfiguration = workflowRiskConfiguration({
    tiers: [{ riskPercent: '0.5' }, { riskPercent: '1' }],
    minimumClosedTrades: 99,
  });
  const shortenedResource = await publishedAdaptiveRiskResource(
    'Shortened workflow risk',
    shortenedConfiguration,
    automaticResource.resourceId,
  );
  const shortened = await resolveWorkflowAdaptiveRisk({
    ...automaticInput,
    adaptiveResourceVersionId: shortenedResource.id,
    configuration: shortenedConfiguration,
  });
  assert.equal(shortened.riskPercent, '1');

  const shadowConfiguration = workflowRiskConfiguration({ mode: 'shadow', startingTier: 0, minimumClosedTrades: 1 });
  const shadowResource = await publishedAdaptiveRiskResource('Shadow workflow risk', shadowConfiguration);
  const shadowWorkflow = await resolveWorkflowAdaptiveRisk({
    ...automaticInput,
    channelId: 'neutral-channel',
    adaptiveResourceVersionId: shadowResource.id,
    configuration: shadowConfiguration,
  });
  assert.equal(shadowWorkflow.riskPercent, strategyConfiguration.sizing.riskPerTradePercent);

  const fixedConfiguration = workflowRiskConfiguration({ mode: 'fixed', lockedTier: 0 });
  const fixedResource = await publishedAdaptiveRiskResource('Fixed workflow risk', fixedConfiguration);
  const fixedWorkflow = await resolveWorkflowAdaptiveRisk({
    ...automaticInput,
    adaptiveResourceVersionId: fixedResource.id,
    configuration: fixedConfiguration,
  });
  assert.equal(fixedWorkflow.blocked, false);
  assert.equal(fixedWorkflow.riskPercent, strategyConfiguration.sizing.riskPerTradePercent);

  const blockedConfiguration = workflowRiskConfiguration({
    weakChannelAction: 'block',
    weakWeeksBeforeBlock: 1,
  });
  const blockedResource = await publishedAdaptiveRiskResource('Blocking workflow risk', blockedConfiguration);
  const blockedWorkflow = await resolveWorkflowAdaptiveRisk({
    ...automaticInput,
    channelId: 'loss-channel',
    adaptiveResourceVersionId: blockedResource.id,
    configuration: blockedConfiguration,
  });
  assert.equal(blockedWorkflow.blocked, true);
  assert.match(blockedWorkflow.reason, /consecutive weak evaluations/);

  const manualConfiguration = workflowRiskConfiguration({ mode: 'fixed', manuallyBlocked: true });
  const manualResource = await publishedAdaptiveRiskResource('Manual workflow block', manualConfiguration);
  const manualBlock = await resolveWorkflowAdaptiveRisk({
    ...automaticInput,
    adaptiveResourceVersionId: manualResource.id,
    configuration: manualConfiguration,
  });
  assert.equal(manualBlock.blocked, true);
  assert.match(manualBlock.reason, /workflow policy/i);

  await assert.rejects(
    resolveWorkflowAdaptiveRisk({ ...automaticInput, adaptiveResourceVersionId: 'missing-resource-version' }),
    /resource is unavailable/,
  );
  await assert.rejects(getWorkflowAdaptiveRiskAnalytics(0), /between 1 and 1000/);
  const workflowAnalytics = await getWorkflowAdaptiveRiskAnalytics();
  assert.ok(workflowAnalytics.states.some(state => state.resourceName === 'Shortened workflow risk'));
  assert.ok(workflowAnalytics.evaluations.some(evaluation => evaluation.action === 'block'));
  assert.ok(workflowAnalytics.evaluations.some(evaluation => evaluation.reason.startsWith('Shadow only:')));
  console.log('Trading analytics and adaptive channel-risk tests passed.');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
