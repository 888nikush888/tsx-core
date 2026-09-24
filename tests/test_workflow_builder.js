import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import {
  createSignalContract, createTradingAccount, createTradingStrategyDraft, getTradingStrategyVersion,
  getTradingIntent,
  listSignalContracts, listTradingAccounts, listTradingStrategies, publishSignalContractVersion,
  publishTradingStrategyVersion, updateTradingRuntimeState, updateTradingStrategyDraft,
} from '../src/trading_repository.js';
import {
  WORKFLOW_IMPACT_CONFIRMATION,
  archiveWorkflowResource,
  archiveWorkflowResourceFamily,
  createWorkflowResourceDraft,
  createWorkflowTradingIntents as createPinnedWorkflowTradingIntents,
  deleteWorkflowResourceFamily,
  deleteWorkflowResourceDraft,
  getActiveWorkflow,
  getWorkflowResourceById,
  getWorkflowRevisionById,
  getWorkflowSignalPlans,
  listWorkflowResources,
  previewWorkflowImpact,
  publishWorkflowResource,
  saveWorkflowRevision,
  simulateWorkflow,
  updateWorkflowResourceDraft,
} from '../src/workflow_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { TradingEngine } from '../src/trading_engine.js';
import { uiWorkflowDetail } from '../src/ui_workflow_reads.js';
import { resolveWorkflowAdaptiveRisk } from '../src/trading_channel_risk.js';
import { recordTradingEquitySnapshot } from '../src/trading_telemetry.js';
import { bindAccountReportingCurrency } from '../src/trading_money_ledger.js';
import { createEntryPriceBoundary, createTradingPlan, resolveDailyLossLimit, resolveEntryExpiresAt } from '../src/trading_risk.js';


// Persisted shapes from the historical pre-route-group and pre-policy writers.
// Hash the exact fragments, then require the reader to reconcile actual path rows.
async function assertHistoricalWorkflowHashes(workflow) {
  assert.ok(workflow.graph.schemaVersion < 3);
  assert.ok(workflow.compiled.paths.length > 0);
  const db = getDatabase();
  const original = await db.get('SELECT graph_json,compiled_json,definition_sha256 FROM workflow_revisions WHERE id=?', [workflow.id]);
  const originalCompiled = JSON.parse(original.compiled_json);
  const withoutPolicy = path => { const { fallbackOn: _policy, ...rest } = path; return rest; };
  const withoutRouteGroup = path => {
    const { routeGroupKey: _group, fallbackRank: _rank, fallbackOn: _policy, ...rest } = path;
    return rest;
  };
  const variants = [
    { paths: originalCompiled.paths.map(withoutRouteGroup), warnings: originalCompiled.warnings },
    { paths: originalCompiled.paths.map(withoutPolicy), warnings: originalCompiled.warnings,
      routeGroups: originalCompiled.routeGroups.map(group => ({ ...group, candidates: group.candidates.map(withoutPolicy) })) },
    originalCompiled,
  ];
  const canonical = value => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    }
    return value;
  };
  const digest = value => createHash('sha256').update(value).digest('hex');
  // Simulate retained databases / external corruption only in this disposable DB.
  // Production triggers still forbid changing committed definitions.
  const triggers = await db.all("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('workflow_revisions','workflow_execution_paths')");
  for (const trigger of triggers) { assert.match(trigger.name, /^[a-z_]+$/); await db.exec(`DROP TRIGGER ${trigger.name}`); }
  const target = workflow.compiled.paths[0];
  try {
    for (const compiled of variants) {
      const compiledJson = JSON.stringify(canonical(compiled));
      const graphJson = JSON.stringify(canonical(workflow.graph));
      const hash = digest(`{"compiled":${compiledJson},"graph":${graphJson}}`);
      await db.run('UPDATE workflow_revisions SET compiled_json=?,graph_json=?,definition_sha256=? WHERE id=?', [compiledJson, graphJson, hash, workflow.id]);
      assert.equal((await getActiveWorkflow()).definitionSha256, hash);
      assert.deepEqual(await db.get('SELECT graph_json,compiled_json,definition_sha256 FROM workflow_revisions WHERE id=?', [workflow.id]),
        { graph_json: graphJson, compiled_json: compiledJson, definition_sha256: hash });
      await db.run('UPDATE workflow_execution_paths SET enabled=? WHERE id=?', [target.enabled ? 0 : 1, target.id]);
      await assert.rejects(getActiveWorkflow(), /failed its integrity check/);
      await db.run('UPDATE workflow_execution_paths SET enabled=? WHERE id=?', [target.enabled ? 1 : 0, target.id]);
      await db.run('UPDATE workflow_revisions SET graph_json=? WHERE id=?', [graphJson.replace('"schemaVersion":1', '"schemaVersion":2'), workflow.id]);
      await assert.rejects(getActiveWorkflow(), /failed its integrity check/);
      await db.run('UPDATE workflow_revisions SET graph_json=? WHERE id=?', [graphJson, workflow.id]);
      const alteredCompiled = { ...compiled, warnings: ['tampered'] };
      await db.run('UPDATE workflow_revisions SET compiled_json=? WHERE id=?', [JSON.stringify(canonical(alteredCompiled)), workflow.id]);
      await assert.rejects(getActiveWorkflow(), /failed its integrity check/);
    }
  } finally {
    await db.run('UPDATE workflow_execution_paths SET enabled=? WHERE id=?', [target.enabled ? 1 : 0, target.id]);
    await db.run('UPDATE workflow_revisions SET graph_json=?,compiled_json=?,definition_sha256=? WHERE id=?',
      [original.graph_json, original.compiled_json, original.definition_sha256, workflow.id]);
    for (const trigger of triggers) await db.exec(trigger.sql);
  }
  assert.equal((await getActiveWorkflow()).id, workflow.id);
}

// These direct-call fixtures pin at creation; production pins when Telegram ingress is committed.
async function createWorkflowTradingIntents(input, now) {
  return createPinnedWorkflowTradingIntents({ ...input, workflowRevisionId: (await getActiveWorkflow()).id }, now);
}

async function assertPinnedPathDetail(workflow, account, strategy, sizing) {
  const executionPath = workflow.compiled.paths.find(candidate => candidate.accountId === account.id);
  const detail = await uiWorkflowDetail('paths', executionPath.id);
  assert.equal(detail.integrityVerified, true);
  assert.equal(detail.revision.id, workflow.id);
  assert.equal(detail.revision.definitionSha256, workflow.definitionSha256);
  assert.equal(detail.path.accountId, account.id);
  assert.equal(detail.path.strategyVersionId, strategy.id);
  assert.deepEqual(detail.sources.map(source => source.nodeId).toSorted(), executionPath.nodeIds.toSorted());
  assert.ok(detail.sources.some(source => source.resource.id === sizing.id));
  const field = name => detail.parameterEffects.find(parameter => parameter.field === name);
  const risk = field('sizing.riskPerTradePercent');
  assert.equal(risk.value, sizing.configuration.riskPerTradePercent);
  assert.equal(risk.strategyValue, strategy.configuration.sizing.riskPerTradePercent);
  assert.equal(risk.strategyValuePresent, true);
  assert.equal(risk.sourceVersionId, sizing.id);
  assert.equal(risk.resourceId, sizing.resourceId);
  assert.equal(risk.overridesStrategy, true);
  assert.equal(risk.unit, '%');
  assert.equal(field('sizing.defaultLeverage').value, sizing.configuration.defaultLeverage);
  assert.equal(field('sizing.defaultLeverage').unit, '×');
  assert.equal(field('sizing.maxPositionNotional').unit, 'Quote-Währung des Markts; Auflösung im Tradeplan');
  assert.equal(field('safety.maxDailyLoss').value, strategy.configuration.safety.maxDailyLoss);
  assert.equal(field('safety.maxDailyLoss').sourceVersionId, strategy.id);
  assert.equal(field('safety.maxDailyLoss').overridesStrategy, false);
  assert.ok(detail.parameterEffects.every(parameter => parameter.scope.includes(workflow.id) && parameter.scope.includes(account.id)));
  return detail.parameterEffects;
}

async function assertDisabledAdaptiveRiskEnginePlan(disabled, sizingResourceId, account, riskSignal, automaticRisk, databasePath) {
  const originalIntent = await getDatabase().get('SELECT * FROM trading_trade_intents WHERE id = ?', [disabled.intent.id]);
  const safeSizingDraft = await createWorkflowResourceDraft({ resourceId: sizingResourceId, kind: 'sizing',
    name: 'Bounded disabled-risk engine probe', configuration: {
      positionSizingMode: 'risk_percent', riskPerTradePercent: '1', maxAdaptiveRiskPercent: '4',
      maxPositionNotional: '5000', defaultLeverage: 3, maxLeverage: 8,
    } });
  const safeSizing = await publishWorkflowResource(safeSizingDraft.id);
  const graph = { ...disabled.graph, nodes: disabled.graph.nodes.map(candidate => candidate.id === 'sizing-b'
    ? { ...candidate, resourceVersionId: safeSizing.id } : candidate) };
  const revision = await saveWorkflowRevision({ baseRevisionId: disabled.revision.id, graph,
    actorId: 'test:disabled-risk-engine', confirmation: WORKFLOW_IMPACT_CONFIRMATION });
  const path = revision.compiled.paths.find(candidate => candidate.accountId === account.id);
  assert.equal(path.adaptiveRiskResourceVersionId, disabled.version.id,
    'The new path must keep the exact disabled adaptive policy while changing only sizing.');
  await saveSignal('workflow-signal-disabled-engine', '-100-workflow', 9, '<signal/>', '<signal/>');
  const intents = await createWorkflowTradingIntents({ sourceSignalId: 'workflow-signal-disabled-engine',
    channelId: '-100-workflow', sourceText: 'BTCUSDT LONG', signal: riskSignal });
  const newIntent = intents.find(candidate => candidate.accountId === account.id);
  assert.equal(newIntent.workflowRevisionId, revision.id);
  assert.equal(newIntent.executionPathId, path.id);
  class NoOrderPaper extends PaperExchangeAdapter {
    submitOrder() { return Promise.reject(new Error(`${this.constructor.name} must not submit an order.`)); }
    submitProtectedEntry() { return Promise.reject(new Error(`${this.constructor.name} must not submit a protected entry.`)); }
    cancelOrder() { return Promise.reject(new Error(`${this.constructor.name} must not cancel an order.`)); }
  }
  const paper = new NoOrderPaper();
  await paper.setMarket(account.id, {
    symbol: 'BTCUSDT', markPrice: '100', priceTick: '0.1', quantityStep: '0.001',
    minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 20,
  });
  const intent = await getTradingIntent(newIntent.id);
  const engine = new TradingEngine([paper]);
  const before = await getDatabase().get('SELECT * FROM workflow_adaptive_risk_state WHERE resource_id = ? AND account_id = ?',
    [disabled.version.resourceId, account.id]);
  const evaluationsBefore = await getDatabase().get('SELECT COUNT(*) AS n FROM workflow_adaptive_risk_evaluations');
  const prepared = await engine.preparePendingIntent(intent, engine.mutations.entryEpoch(account.id));
  const strategy = path.effectiveConfiguration.strategyConfiguration;
  const baseline = strategy.sizing.riskPerTradePercent;
  assert.equal(prepared.effectiveRiskPercent, baseline,
    'A pinned disabled policy must use fixed sizing in the actual TradingEngine preparation path.');
  const planInput = { intentId: intent.id, signal: riskSignal, strategy,
    account: await paper.accountSnapshot(account), market: await paper.marketSnapshot(account, 'BTCUSDT') };
  const baselinePlan = createTradingPlan({ ...planInput, effectiveRiskPercent: baseline });
  const automaticPlan = createTradingPlan({ ...planInput, effectiveRiskPercent: automaticRisk.riskPercent });
  assert.equal(prepared.plan.riskAmount, baselinePlan.riskAmount);
  assert.equal(prepared.plan.quantity, baselinePlan.quantity,
    'The actual engine plan must match baseline sizing for the same pinned path and market.');
  assert.notEqual(prepared.plan.quantity, automaticPlan.quantity,
    'Disabled policy must not use the earlier automatic tier in the new trade plan.');
  assert.deepEqual(await getDatabase().get('SELECT * FROM workflow_adaptive_risk_state WHERE resource_id = ? AND account_id = ?',
    [disabled.version.resourceId, account.id]), before,
  'Disabled policy must bypass adaptive state evaluation and mutation.');
  assert.deepEqual(await getDatabase().get('SELECT COUNT(*) AS n FROM workflow_adaptive_risk_evaluations'),
    evaluationsBefore, 'Disabled policy must not create an adaptive evaluation.');
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS n FROM trading_paper_orders')).n, 0,
    'No paper-provider order may be sent during risk preparation.');
  assert.deepEqual(await getDatabase().get('SELECT * FROM trading_trade_intents WHERE id = ?', [disabled.intent.id]),
    originalIntent, 'A later sizing version and Engine preparation must leave the earlier disabled intent unchanged.');
  assert.deepEqual((await getWorkflowRevisionById(disabled.revision.id)).graph, disabled.revision.graph,
    'The earlier disabled graph must remain immutable.');
  await closeDb();
  await initDb(databasePath);
  assert.equal((await getActiveWorkflow()).id, revision.id);
  assert.deepEqual((await getWorkflowRevisionById(revision.id)).compiled, revision.compiled);
  assert.deepEqual(await getDatabase().get('SELECT * FROM trading_trade_intents WHERE id = ?', [disabled.intent.id]),
    originalIntent, 'The earlier intent must still be pinned after restart.');
  assert.deepEqual(await getDatabase().get(
    'SELECT workflow_revision_id,execution_path_id FROM trading_trade_intents WHERE id = ?', [intent.id],
  ), { workflow_revision_id: revision.id, execution_path_id: path.id },
  'The new intent must retain its activated path after restart.');
}

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-workflow-'));
try {
  await initDb(path.join(directory, 'forwarder.db'));
  await seedTradingFixtures();
  const [firstAccount] = await listTradingAccounts();
  const secondAccount = await createTradingAccount({
    name: 'Parallel paper account', exchange: 'paper', mode: 'paper', initialBalance: '25000', maxConcurrentPositions: 7,
  });
  const [strategy] = await listTradingStrategies();
  const [baseContract] = await listSignalContracts();
  const baseContractVersion = baseContract.versions.find(version => version.status === 'published');
  const alternateContract = await createSignalContract({
    id: 'workflow-alt', name: 'Independent workflow contract', definition: baseContractVersion.definition,
  });
  const alternateContractVersion = await publishSignalContractVersion(alternateContract.versions[0].id);
  await updateTradingRuntimeState({ executionEnabled: true });

  async function resource(kind, name, configuration) {
    const draft = await createWorkflowResourceDraft({ kind, name, configuration });
    return publishWorkflowResource(draft.id);
  }

  const invalidResourceCases = [
    ['channel', null, /must be an object/],
    ['channel', [], /must be an object/],
    ['channel', { channelId: 1 }, /identifier is invalid/],
    ['channel', { channelId: '' }, /identifier is invalid/],
    ['channel', { channelId: 'x'.repeat(129) }, /identifier is invalid/],
    ['channel', { channelId: 'invalid\nchannel' }, /identifier is invalid/],
    ['content_filter', { allowedTypes: 'text' }, /bounded string array/],
    ['content_filter', { allowedTypes: Array(21).fill('text') }, /bounded string array/],
    ['content_filter', { allowedTypes: ['text', 1] }, /bounded string array/],
    ['keyword_filter', { allowedKeywords: ['LONG', 'LONG'], blockedKeywords: [] }, /duplicates/],
    ['regex', { patterns: ['('] }, /Invalid regex pattern/],
    ['regex', { patterns: [], mode: 'some' }, /mode must be all or any/],
    ['parser', { timeoutMs: 2.5 }, /between 2000 and 120000/],
    ['parser', { timeoutMs: 1_999 }, /between 2000 and 120000/],
    ['parser', { timeoutMs: 120_001 }, /between 2000 and 120000/],
    ['parser', { saveToFile: true }, /may not save signals to files/],
    ['parser', { prompt: ' ' }, /between 1 and 50000 characters/],
    ['parser', { prompt: 'x'.repeat(50_001) }, /between 1 and 50000 characters/],
    ['sizing', { positionSizingMode: 'cash', riskPerTradePercent: '1' }, /mode is unsupported/],
    ['sizing', { riskPerTradePercent: '2', maxAdaptiveRiskPercent: '1' }, /below the baseline/],
    ['sizing', { riskPerTradePercent: '1', maxLeverage: 1.5 }, /between 1 and 50/],
    ['sizing', { riskPerTradePercent: '1', maxLeverage: 0 }, /between 1 and 50/],
    ['sizing', { riskPerTradePercent: '1', maxLeverage: 51 }, /between 1 and 50/],
    ['sizing', { riskPerTradePercent: '1', defaultLeverage: 0, maxLeverage: 10 }, /Default leverage must be between 1 and 50/],
    ['sizing', { riskPerTradePercent: '1', defaultLeverage: 51, maxLeverage: 50 }, /Default leverage must be between 1 and 50/],
    ['sizing', { riskPerTradePercent: '1', defaultLeverage: 11, maxLeverage: 10 }, /Default leverage must not exceed maximum leverage/],
    ['adaptive_risk', { tiers: '5' }, /between one and twenty tiers/],
    ['adaptive_risk', { tiers: [] }, /between one and twenty tiers/],
    ['adaptive_risk', { tiers: Array.from({ length: 21 }, () => ({ riskPercent: '1' })) }, /between one and twenty tiers/],
    ['adaptive_risk', { tiers: [null] }, /must be an object/],
    ['adaptive_risk', { tiers: [{ riskPercent: '1' }, { riskPercent: '1' }] }, /increase strictly/],
    ['adaptive_risk', { enabled: 'yes' }, /must be boolean/],
    ['adaptive_risk', { manuallyBlocked: 'yes' }, /must be boolean/],
    ['adaptive_risk', { mode: 'dynamic' }, /mode is invalid/],
    ['adaptive_risk', { startingTier: -1 }, /starting tier is invalid/],
    ['adaptive_risk', { startingTier: 1 }, /starting tier is invalid/],
    ['adaptive_risk', { lockedTier: 1 }, /locked tier is invalid/],
    ['adaptive_risk', { weakChannelAction: 'pause' }, /action is invalid/],
    ['adaptive_risk', { lookbackWeeks: 13 }, /lookback weeks is invalid/],
    ['adaptive_risk', { minimumClosedTrades: 0 }, /minimum closed trades is invalid/],
    ['adaptive_risk', { weakWeeksBeforeBlock: 53 }, /weak weeks is invalid/],
    ['dedupe', { cooldownHours: 'not-a-number' }, /between 0 and 8760/],
    ['dedupe', { cooldownHours: -1 }, /between 0 and 8760/],
    ['dedupe', { cooldownHours: 8_761 }, /between 0 and 8760/],
    ['output', { mode: 'exchange' }, /output mode is invalid/],
    ['output', { mode: 'audit_only', extra: 'x'.repeat(100_001) }, /configuration is too large/],
  ];
  for (const [kind, configuration, expected] of invalidResourceCases) {
    await assert.rejects(
      createWorkflowResourceDraft({ kind, name: 'Invalid resource', configuration }),
      expected,
    );
  }
  await assert.rejects(
    createWorkflowResourceDraft({ kind: 'not-a-kind', name: 'Invalid kind', configuration: {} }),
    /Unsupported workflow resource kind/,
  );
  await assert.rejects(
    createWorkflowResourceDraft({
      kind: 'output', name: 'Oversized description', description: 'x'.repeat(501), configuration: { mode: 'none' },
    }),
    /description must not exceed 500/,
  );
  await assert.rejects(
    updateWorkflowResourceDraft('missing-resource', { name: 'Missing', configuration: {} }),
    /Only a workflow resource draft can be edited/,
  );
  await assert.rejects(publishWorkflowResource('missing-resource'), /Only a workflow resource draft can be published/);
  const draftForArchive = await createWorkflowResourceDraft({
    kind: 'output', name: 'Draft cannot archive', configuration: { mode: 'none' },
  });
  await assert.rejects(archiveWorkflowResource(draftForArchive.id), /Only a published workflow resource can be archived/);
  await assert.rejects(
    archiveWorkflowResourceFamily('missing-resource-family'),
    /No published workflow resource versions/,
  );
  assert.equal(await deleteWorkflowResourceDraft(draftForArchive.id), true);
  assert.equal(await deleteWorkflowResourceDraft(draftForArchive.id), false);
  const defaultResourceCases = [
    ['content_filter', {}],
    ['keyword_filter', {}],
    ['regex', { patterns: [] }],
    ['parser', {}],
    ['parser', { primaryModel: 'test/primary', fallbackModel: 'test/fallback' }],
    ['sizing', { riskPerTradePercent: '1' }],
    ['dedupe', {}],
    ['dedupe', { enabled: false, cooldownHours: 0 }],
    ['output', {}],
  ];
  for (const [kind, configuration] of defaultResourceCases) {
    const draft = await createWorkflowResourceDraft({ kind, name: `Defaults for ${kind}`, configuration });
    if (kind === 'sizing') {
      assert.equal(draft.configuration.defaultLeverage, draft.configuration.maxLeverage);
    }
    assert.equal(await deleteWorkflowResourceDraft(draft.id), true);
  }

  const resources = {
    channel: await resource('channel', 'VIP channel', { channelId: '-100-workflow' }),
    channelB: await resource('channel', 'Second VIP channel', { channelId: '-100-workflow-b' }),
    content: await resource('content_filter', 'Text signals', { allowedTypes: ['text'] }),
    keywords: await resource('keyword_filter', 'Directional signals', {
      allowedKeywords: ['long'], blockedKeywords: ['scam'],
    }),
    regex: await resource('regex', 'Signal regex', { patterns: ['(?:LONG|SHORT)'], mode: 'any' }),
    parser: await resource('parser', 'AI parser', {
      templateName: 'default', primaryModel: 'test/primary', fallbackModel: 'test/fallback',
      timeoutMs: 120000, saveToFile: false, prompt: 'Immutable workflow parser prompt.',
    }),
    schema: await resource('schema', 'Standard schema', { schemaId: 'standard' }),
    contract: await resource('contract', 'Independent contract', { contractVersionId: alternateContractVersion.id }),
    dedupe: await resource('dedupe', 'Path deduplication', { enabled: false, cooldownHours: 0 }),
    strategy: await resource('strategy', 'Execution strategy', { strategyVersionId: strategy.id }),
    sizingA: await resource('sizing', 'Hyper-style fixed 10%', {
      positionSizingMode: 'equity_percent_margin', riskPerTradePercent: '10', maxAdaptiveRiskPercent: '10',
      maxPositionNotional: '1000000000', defaultLeverage: 3, maxLeverage: 10,
    }),
    sizingB: await resource('sizing', 'Kraken-style adaptive 5%', {
      positionSizingMode: 'equity_percent_margin', riskPerTradePercent: '5', maxAdaptiveRiskPercent: '10',
      maxPositionNotional: '1000000000', maxLeverage: 50,
    }),
    adaptive: await resource('adaptive_risk', 'Adaptive channel risk', { enabled: true }),
    accountA: await resource('account', 'Primary account', { accountId: firstAccount.id }),
    accountB: await resource('account', 'Secondary account', { accountId: secondAccount.id }),
    output: await resource('output', 'Audit output', { mode: 'audit_only' }),
  };
  assert.ok((await listWorkflowResources('channel')).every(item => item.kind === 'channel'));
  const outputV2Draft = await createWorkflowResourceDraft({
    resourceId: resources.output.resourceId,
    kind: 'output',
    name: 'Output v2 draft',
    configuration: { mode: 'none' },
  });
  assert.equal(outputV2Draft.version, 2);
  await assert.rejects(
    updateWorkflowResourceDraft(outputV2Draft.id, {
      name: 'Output v2 draft', description: 'x'.repeat(501), configuration: { mode: 'none' },
    }),
    /description must not exceed 500/,
  );
  const outputV2Updated = await updateWorkflowResourceDraft(outputV2Draft.id, {
    name: 'Output v2', description: 'Immutable output version', configuration: { mode: 'none' },
  });
  const outputV2 = await publishWorkflowResource(outputV2Updated.id);
  await assert.rejects(
    previewWorkflowImpact({
      baseRevisionId: null,
      graph: {
        schemaVersion: 1,
        nodes: [
          { id: 'output-v1-placement', kind: 'output', resourceVersionId: resources.output.id, position: { x: 0, y: 0 } },
          { id: 'output-v2-placement', kind: 'output', resourceVersionId: outputV2.id, position: { x: 0, y: 150 } },
        ],
        edges: [],
      },
    }),
    /may only be placed once/,
  );
  const equivalentOutput = await resource(
    'output',
    'Equivalent audit output',
    { mode: 'audit_only' },
  );
  await assert.rejects(
    previewWorkflowImpact({
      baseRevisionId: null,
      graph: {
        schemaVersion: 1,
        nodes: [
          { id: 'output-primary', kind: 'output', resourceVersionId: resources.output.id, position: { x: 0, y: 0 } },
          { id: 'output-equivalent', kind: 'output', resourceVersionId: equivalentOutput.id, position: { x: 0, y: 150 } },
        ],
        edges: [],
      },
    }),
    /identical behavior and may only be placed once/,
  );
  await assert.rejects(
    updateWorkflowResourceDraft(outputV2.id, { name: 'Published', configuration: { mode: 'none' } }),
    /Only a workflow resource draft can be edited/,
  );
  await assert.rejects(publishWorkflowResource(outputV2.id), /Only a workflow resource draft can be published/);
  assert.equal((await archiveWorkflowResource(outputV2.id)).status, 'archived');
  assert.equal(await deleteWorkflowResourceDraft(outputV2.id), false);

  const removableV1 = await resource('output', 'Removable family v1', { mode: 'none' });
  const removableV2Draft = await createWorkflowResourceDraft({
    resourceId: removableV1.resourceId,
    kind: 'output',
    name: 'Removable family v2',
    configuration: { mode: 'audit_only' },
  });
  await publishWorkflowResource(removableV2Draft.id);
  assert.equal((await archiveWorkflowResourceFamily(removableV1.resourceId)).length, 2);
  assert.equal(
    (await listWorkflowResources('output')).filter(item => item.resourceId === removableV1.resourceId && item.status === 'published').length,
    0,
  );

  const deletableV1 = await resource('output', 'Deletable family v1', { mode: 'none' });
  const deletableV2Draft = await createWorkflowResourceDraft({
    resourceId: deletableV1.resourceId,
    kind: 'output',
    name: 'Deletable family v2',
    configuration: { mode: 'audit_only' },
  });
  await publishWorkflowResource(deletableV2Draft.id);
  assert.equal(await deleteWorkflowResourceFamily(deletableV1.resourceId), 2);
  assert.equal(
    (await listWorkflowResources('output')).filter(item => item.resourceId === deletableV1.resourceId).length,
    0,
  );

  const node = (id, kind, resourceVersionId, x, y) => ({ id, kind, resourceVersionId, position: { x, y } });
  const nodes = [
    node('channel', 'channel', resources.channel.id, 0, 0),
    node('content', 'content_filter', resources.content.id, 300, 0),
    node('keywords', 'keyword_filter', resources.keywords.id, 600, 0),
    node('regex', 'regex', resources.regex.id, 900, 0),
    node('parser', 'parser', resources.parser.id, 1200, 0),
    node('schema', 'schema', resources.schema.id, 1500, 0),
    node('contract', 'contract', resources.contract.id, 1800, 0),
    node('dedupe', 'dedupe', resources.dedupe.id, 2100, 0),
    node('strategy', 'strategy', resources.strategy.id, 2400, 0),
    node('sizing-a', 'sizing', resources.sizingA.id, 2700, -120),
    node('sizing-b', 'sizing', resources.sizingB.id, 2700, 120),
    node('adaptive', 'adaptive_risk', resources.adaptive.id, 3000, 120),
    node('account-a', 'account', resources.accountA.id, 3300, -120),
    node('account-b', 'account', resources.accountB.id, 3300, 120),
    node('output', 'output', resources.output.id, 3600, -120),
  ];
  const edge = (source, target) => ({ id: `${source}-${target}`, source, target });

  const graphValidationCases = [
    [null, /must be an object/],
    [{ schemaVersion: 4, nodes: [], edges: [] }, /contract is invalid/],
    [{ schemaVersion: 1, nodes: {}, edges: [] }, /contract is invalid/],
    [{ schemaVersion: 1, nodes: [], edges: {} }, /contract is invalid/],
    [{ schemaVersion: 1, nodes: Array(1_001).fill({}), edges: [] }, /exceeds its size limit/],
    [{ schemaVersion: 1, nodes: [node('-bad', 'channel', resources.channel.id, 0, 0)], edges: [] }, /identifier.*invalid/],
    [{
      schemaVersion: 1,
      nodes: [node('duplicate', 'channel', resources.channel.id, 0, 0), node('duplicate', 'channel', resources.channel.id, 1, 1)],
      edges: [],
    }, /invalid or duplicated/],
    [{ schemaVersion: 1, nodes: [node('unknown', 'unknown', resources.channel.id, 0, 0)], edges: [] }, /unsupported kind/],
    [{ schemaVersion: 1, nodes: [node('bad-position', 'channel', resources.channel.id, Number.NaN, 0)], edges: [] }, /position is invalid/],
    [{
      schemaVersion: 1,
      nodes: [node('source', 'channel', resources.channel.id, 0, 0), node('target', 'content_filter', resources.content.id, 1, 0)],
      edges: [{ id: '-bad', source: 'source', target: 'target' }],
    }, /edge .* invalid or duplicated/],
    [{
      schemaVersion: 1,
      nodes: [node('source', 'channel', resources.channel.id, 0, 0), node('target', 'content_filter', resources.content.id, 1, 0)],
      edges: [{ id: 'same', source: 'source', target: 'target' }, { id: 'same', source: 'source', target: 'target' }],
    }, /invalid or duplicated/],
    [{
      schemaVersion: 1,
      nodes: [node('source', 'channel', resources.channel.id, 0, 0), node('target', 'content_filter', resources.content.id, 1, 0)],
      edges: [{ id: 'first', source: 'source', target: 'target' }, { id: 'second', source: 'source', target: 'target' }],
    }, /invalid or duplicated/],
    [{
      schemaVersion: 1,
      nodes: [node('source', 'channel', resources.channel.id, 0, 0)],
      edges: [{ id: 'missing', source: 'source', target: 'absent' }],
    }, /invalid endpoint/],
    [{
      schemaVersion: 1,
      nodes: [node('source', 'channel', resources.channel.id, 0, 0)],
      edges: [{ id: 'self', source: 'source', target: 'source' }],
    }, /invalid endpoint/],
    [{ schemaVersion: 1, nodes: [node('mismatch', 'account', resources.channel.id, 0, 0)], edges: [] }, /kind does not match/],
    [{
      schemaVersion: 1,
      nodes: [node('source', 'channel', resources.channel.id, 0, 0), node('target', 'content_filter', resources.content.id, 1, 0)],
      edges: [{ id: 'empty-scope', source: 'source', target: 'target', channelNodeIds: [] }],
    }, /channel scope must contain at least one/],
    [{
      schemaVersion: 1,
      nodes: [node('source', 'channel', resources.channel.id, 0, 0), node('target', 'content_filter', resources.content.id, 1, 0)],
      edges: [{ id: 'wrong-scope', source: 'source', target: 'target', channelNodeIds: ['target'] }],
    }, /channel scope must reference channel nodes/],
    [{
      schemaVersion: 1,
      nodes: [node('source', 'channel', resources.channel.id, 0, 0), node('target', 'content_filter', resources.content.id, 1, 0)],
      edges: [{ id: 'duplicate-scope', source: 'source', target: 'target', channelNodeIds: ['source', 'source'] }],
    }, /channel scope must not contain duplicates/],
    [{
      schemaVersion: 1,
      nodes: [node('source', 'channel', resources.channel.id, 0, 0), node('target', 'content_filter', resources.content.id, 1, 0)],
      edges: [{ id: 'reverse', source: 'target', target: 'source' }],
    }, /earlier processing column/],
  ];
  for (const [candidate, expected] of graphValidationCases) {
    await assert.rejects(previewWorkflowImpact({ baseRevisionId: null, graph: candidate }), expected);
  }
  const configurableFallbackBase = {
    schemaVersion: 3,
    nodes: [
      node('fallback-channel', 'channel', resources.channel.id, 0, 0),
      node('fallback-account-a', 'account', resources.accountA.id, 316, 0),
      node('fallback-account-b', 'account', resources.accountB.id, 316, 150),
    ],
    edges: [
      { id: 'fallback-flow', kind: 'flow', source: 'fallback-channel', target: 'fallback-account-a' },
    ],
  };
  const configurableFallbackValidationCases = [
    [{
      ...configurableFallbackBase,
      edges: [...configurableFallbackBase.edges, {
        id: 'fallback-missing-policy', kind: 'account_fallback', source: 'fallback-account-a',
        target: 'fallback-account-b', channelNodeIds: ['fallback-channel'],
      }],
    }, /fallback policy/i],
    [{
      ...configurableFallbackBase,
      edges: [...configurableFallbackBase.edges, {
        id: 'fallback-empty-policy', kind: 'account_fallback', source: 'fallback-account-a',
        target: 'fallback-account-b', channelNodeIds: ['fallback-channel'], fallbackOn: [],
      }],
    }, /fallback policy/i],
    [{
      ...configurableFallbackBase,
      edges: [...configurableFallbackBase.edges, {
        id: 'fallback-duplicate-policy', kind: 'account_fallback', source: 'fallback-account-a',
        target: 'fallback-account-b', channelNodeIds: ['fallback-channel'],
        fallbackOn: ['SYMBOL_UNAVAILABLE', 'SYMBOL_UNAVAILABLE'],
      }],
    }, /duplicate/i],
    [{
      ...configurableFallbackBase,
      edges: [...configurableFallbackBase.edges, {
        id: 'fallback-unknown-policy', kind: 'account_fallback', source: 'fallback-account-a',
        target: 'fallback-account-b', channelNodeIds: ['fallback-channel'], fallbackOn: ['EXECUTOR_UNAVAILABLE'],
      }],
    }, /fallback reason/i],
    [{
      ...configurableFallbackBase,
      edges: [{ ...configurableFallbackBase.edges[0], fallbackOn: ['SYMBOL_UNAVAILABLE'] }],
    }, /flow edge.*fallback policy/i],
  ];
  for (const [candidate, expected] of configurableFallbackValidationCases) {
    await assert.rejects(previewWorkflowImpact({ baseRevisionId: null, graph: candidate }), expected);
  }
  await previewWorkflowImpact({
    baseRevisionId: null,
    graph: {
      ...configurableFallbackBase,
      edges: [...configurableFallbackBase.edges, {
        id: 'fallback-full-policy', kind: 'account_fallback', source: 'fallback-account-a',
        target: 'fallback-account-b', channelNodeIds: ['fallback-channel'],
        fallbackOn: ['SYMBOL_UNAVAILABLE', 'MAX_CONCURRENT_POSITIONS', 'SYMBOL_ALREADY_OWNED'],
      }],
    },
  });
  const unpublishedChannel = await createWorkflowResourceDraft({
    kind: 'channel', name: 'Unpublished channel', configuration: { channelId: '-100-unpublished' },
  });
  await assert.rejects(
    previewWorkflowImpact({
      baseRevisionId: null,
      graph: { schemaVersion: 1, nodes: [node('unpublished', 'channel', unpublishedChannel.id, 0, 0)], edges: [] },
    }),
    /must reference a published resource/,
  );
  assert.equal(await deleteWorkflowResourceDraft(unpublishedChannel.id), true);

  const graph = { schemaVersion: 1, nodes, edges: [
    edge('channel', 'content'), edge('content', 'keywords'), edge('keywords', 'regex'),
    edge('regex', 'parser'), edge('parser', 'schema'), edge('schema', 'contract'),
    edge('contract', 'dedupe'), edge('dedupe', 'strategy'), edge('strategy', 'sizing-a'), edge('strategy', 'sizing-b'),
    edge('sizing-a', 'account-a'), edge('account-a', 'output'),
    edge('sizing-b', 'adaptive'), edge('adaptive', 'account-b'),
  ] };

  assert.deepEqual(
    await simulateWorkflow({ channelId: '-100-workflow', text: 'BTCUSDT LONG' }),
    { active: false, paths: [], warnings: ['No active workflow revision.'] },
  );
  assert.deepEqual(
    await getWorkflowSignalPlans({ channelId: '-100-workflow', text: 'BTCUSDT LONG', contentType: 'text' }),
    [],
  );
  assert.match(
    (await previewWorkflowImpact({
      baseRevisionId: null,
      graph: { schemaVersion: 1, nodes: [node('orphan-output', 'output', resources.output.id, 0, 0)], edges: [] },
    })).warnings.join(' '),
    /No channel node is present/,
  );
  assert.match(
    (await previewWorkflowImpact({
      baseRevisionId: null,
      graph: { schemaVersion: 1, nodes: [node('orphan-channel', 'channel', resources.channel.id, 0, 0)], edges: [] },
    })).warnings.join(' '),
    /not connected to an exchange account/,
  );

  async function graphWithReplacement(kind, configuration) {
    const replacement = await resource(kind, `Invalid ${kind} dependency`, configuration);
    let replaced = false;
    return {
      ...graph,
      nodes: graph.nodes.map(candidate => {
        if (candidate.kind !== kind || replaced) return candidate;
        replaced = true;
        return { ...candidate, resourceVersionId: replacement.id };
      }),
    };
  }
  await assert.rejects(
    previewWorkflowImpact({
      baseRevisionId: null,
      graph: await graphWithReplacement('account', { accountId: 'missing-account' }),
    }),
    /does not exist/,
  );
  await assert.rejects(
    previewWorkflowImpact({
      baseRevisionId: null,
      graph: await graphWithReplacement('strategy', { strategyVersionId: 'missing-strategy' }),
    }),
    /is not published/,
  );
  await assert.rejects(
    previewWorkflowImpact({
      baseRevisionId: null,
      graph: await graphWithReplacement('schema', { schemaId: 'missing-schema' }),
    }),
    /is unavailable/,
  );
  await assert.rejects(
    previewWorkflowImpact({
      baseRevisionId: null,
      graph: await graphWithReplacement('contract', { contractVersionId: 'missing-contract' }),
    }),
    /must reference a published contract/,
  );
  const secondOutput = await resource('output', 'Second output', { mode: 'none' });
  await assert.rejects(
    previewWorkflowImpact({
      baseRevisionId: null,
      graph: {
        ...graph,
        nodes: [...graph.nodes, node('output-two', 'output', secondOutput.id, 3600, 120)],
        edges: [...graph.edges, edge('account-a', 'output-two')],
      },
    }),
    /may connect to at most one output node/,
  );

  const integrityDraft = await createWorkflowResourceDraft({
    kind: 'output', name: 'Integrity probe', configuration: { mode: 'none' },
  });
  const integrityRow = await getDatabase().get(
    'SELECT configuration_json FROM workflow_resource_versions WHERE id = ?', [integrityDraft.id],
  );
  await getDatabase().run(
    'UPDATE workflow_resource_versions SET configuration_json = ? WHERE id = ?',
    ['{"mode":"audit_only"}', integrityDraft.id],
  );
  await assert.rejects(listWorkflowResources('output'), /failed its integrity check/);
  await getDatabase().run(
    'UPDATE workflow_resource_versions SET configuration_json = ? WHERE id = ?',
    [integrityRow.configuration_json, integrityDraft.id],
  );
  assert.equal(await deleteWorkflowResourceDraft(integrityDraft.id), true);

  const initialImpact = await previewWorkflowImpact({ baseRevisionId: null, graph });
  assert.equal(initialImpact.added.length, 2);
  assert.equal(initialImpact.destructive, true);
  await assert.rejects(
    saveWorkflowRevision({ baseRevisionId: null, graph, actorId: 'test:no-initial-confirmation' }),
    /WORKFLOW_IMPACT_CONFIRMATION_REQUIRED/,
  );
  const workflow = await saveWorkflowRevision({
    baseRevisionId: null, graph, actorId: 'test:admin', confirmation: WORKFLOW_IMPACT_CONFIRMATION,
  });
  await assertHistoricalWorkflowHashes(workflow);
  assert.equal(workflow.compiled.paths.length, 2);
  const originalParameterEffects = await assertPinnedPathDetail(workflow, firstAccount, strategy, resources.sizingA);
  await assertPinnedPathDetail(workflow, secondAccount, strategy, resources.sizingB);
  assert.equal(await uiWorkflowDetail('paths', 'missing-execution-path'), null);
  const primarySizing = workflow.compiled.paths.find(path => path.accountId === firstAccount.id)
    .effectiveConfiguration.strategyConfiguration.sizing;
  assert.equal(primarySizing.defaultLeverage, 3);
  assert.equal(primarySizing.maxLeverage, 10);
  assert.equal(workflow.compiled.paths.find(path => path.accountId === secondAccount.id)
    .effectiveConfiguration.strategyConfiguration.sizing.defaultLeverage, 50,
  'Legacy workflow sizing resources must retain default=max semantics.');
  assert.deepEqual(
    workflow.graph.nodes.find(candidate => candidate.id === 'sizing-a').position,
    { x: 9 * 316, y: 0 },
    'Workflow revisions must persist the fixed stage grid.',
  );
  assert.deepEqual(
    workflow.graph.nodes.find(candidate => candidate.id === 'sizing-b').position,
    { x: 9 * 316, y: 150 },
  );
  assert.equal((await getActiveWorkflow()).definitionSha256, workflow.definitionSha256);
  await assert.rejects(
    saveWorkflowRevision({ baseRevisionId: null, graph, actorId: 'test:stale' }),
    /WORKFLOW_REVISION_CONFLICT/,
  );
  const simulation = await simulateWorkflow({ channelId: '-100-workflow', text: 'BTCUSDT LONG' });
  assert.equal(simulation.paths.length, 2);
  assert.ok(simulation.paths.every(item => item.allowed));
  const sharedGraph = {
    ...graph,
    nodes: [...graph.nodes, node('channel-b', 'channel', resources.channelB.id, 0, 150)],
    edges: [...graph.edges, edge('channel-b', 'content')],
  };
  const sharedImpact = await previewWorkflowImpact({ baseRevisionId: workflow.id, graph: sharedGraph });
  assert.equal(sharedImpact.added.length, 2, 'An unscoped shared branch must continue forwarding every channel.');
  assert.equal(sharedImpact.removed.length, 0);
  const scopedGraph = {
    ...sharedGraph,
    edges: sharedGraph.edges.map(candidate => {
      if (candidate.source === 'strategy' && candidate.target === 'sizing-a') {
        return { ...candidate, channelNodeIds: ['channel'] };
      }
      if (candidate.source === 'strategy' && candidate.target === 'sizing-b') {
        return { ...candidate, channelNodeIds: ['channel-b'] };
      }
      return candidate;
    }),
  };
  const scopedImpact = await previewWorkflowImpact({ baseRevisionId: workflow.id, graph: scopedGraph });
  assert.deepEqual(
    scopedImpact.added.map(item => [item.channelId, item.accountId]),
    [['-100-workflow-b', secondAccount.id]],
    'Origin-channel scope must survive shared blocks and select only the configured branch.',
  );
  assert.deepEqual(
    scopedImpact.removed.map(item => [item.channelId, item.accountId]),
    [['-100-workflow', secondAccount.id]],
  );
  assert.ok((await simulateWorkflow({
    channelId: '-100-workflow', text: 'BTCUSDT LONG', contentType: 'photo',
  })).paths.every(item => item.reason === 'CONTENT_TYPE_FILTERED'));
  assert.ok((await simulateWorkflow({
    channelId: '-100-workflow', text: 'BTCUSDT SHORT', contentType: 'text',
  })).paths.every(item => item.reason === 'ALLOWED_KEYWORD_MISSING'));
  assert.ok((await simulateWorkflow({
    channelId: '-100-workflow', text: 'BTCUSDT LONG scam', contentType: 'text',
  })).paths.every(item => item.reason === 'BLOCKED_KEYWORD'));
  assert.ok((await simulateWorkflow({
    channelId: '-100-workflow', text: `${'x'.repeat(8_100)} long`, contentType: 'text',
  })).paths.every(item => item.reason === 'REGEX_FILTERED'));
  const plans = await getWorkflowSignalPlans({ channelId: '-100-workflow', text: 'BTCUSDT LONG', contentType: 'text' });
  assert.equal(plans.length, 1, 'Identical parser/schema/contract paths should parse only once.');
  assert.deepEqual(plans[0].outputModes, ['audit_only']);
  assert.equal(plans[0].executionPathIds.length, 2);
  assert.equal(plans[0].prompt, 'Immutable workflow parser prompt.');
  assert.equal(plans[0].contractVersionId, alternateContractVersion.id, 'Contract nodes must compose independently from schema defaults.');

  await saveSignal('workflow-signal', '-100-workflow', 1, '<signal/>', '<signal/>');
  const signal = {
    schema: 'standard', action: 'LONG', symbol: 'BTCUSDT', entry: { type: 'market' },
    targets: [{ min: '110', max: '110' }], stopLoss: '90',
  };
  const intents = await createWorkflowTradingIntents({
    sourceSignalId: 'workflow-signal', channelId: '-100-workflow', sourceText: 'BTCUSDT LONG', signal,
  });
  assert.equal(intents.length, 2);
  assert.equal(new Set(intents.map(intent => intent.accountId)).size, 2);
  assert.ok(intents.every(intent => intent.workflowRevisionId === workflow.id && intent.executionPathId));
  const repeated = await createWorkflowTradingIntents({
    sourceSignalId: 'workflow-signal', channelId: '-100-workflow', sourceText: 'BTCUSDT LONG', signal,
  });
  assert.deepEqual(repeated.map(intent => intent.id).sort(), intents.map(intent => intent.id).sort());
  assert.equal(secondAccount.maxConcurrentPositions, 7);
  assert.deepEqual(
    await getWorkflowSignalPlans({ channelId: '-100-other', text: 'BTCUSDT LONG', contentType: 'text' }),
    [],
  );
  assert.deepEqual(
    await getWorkflowSignalPlans({ channelId: '-100-workflow', text: 'BTCUSDT SHORT', contentType: 'text' }),
    [],
  );
  await assert.rejects(
    createWorkflowTradingIntents({
      sourceSignalId: 'workflow-signal-invalid-path', channelId: '-100-workflow', sourceText: 'BTCUSDT LONG', signal,
      executionPathIds: ['missing-execution-path'],
    }),
    /selection is stale or invalid/,
  );
  assert.deepEqual(
    await createWorkflowTradingIntents({
      sourceSignalId: 'workflow-signal-other-channel', channelId: '-100-other', sourceText: 'BTCUSDT LONG', signal,
    }),
    [],
  );

  const changedSizing = await resource('sizing', 'Primary sizing changed', {
    positionSizingMode: 'equity_percent_margin', riskPerTradePercent: '9', maxAdaptiveRiskPercent: '10',
    maxPositionNotional: '1000000000', maxLeverage: 50,
  });
  const changedGraph = {
    ...graph,
    nodes: graph.nodes.map(candidate => candidate.id === 'sizing-a'
      ? { ...candidate, resourceVersionId: changedSizing.id }
      : candidate),
  };
  const impact = await previewWorkflowImpact({ baseRevisionId: workflow.id, graph: changedGraph });
  assert.equal(impact.destructive, true);
  assert.equal(impact.changed.length, 1);
  assert.equal(impact.confirmation, WORKFLOW_IMPACT_CONFIRMATION);
  await assert.rejects(
    saveWorkflowRevision({ baseRevisionId: workflow.id, graph: changedGraph, actorId: 'test:no-confirmation' }),
    /WORKFLOW_IMPACT_CONFIRMATION_REQUIRED/,
  );
  const changedWorkflow = await saveWorkflowRevision({
    baseRevisionId: workflow.id,
    graph: changedGraph,
    actorId: 'test:confirmed',
    confirmation: WORKFLOW_IMPACT_CONFIRMATION,
  });
  assert.equal(changedWorkflow.revision, 2);
  await assertPinnedPathDetail(changedWorkflow, firstAccount, strategy, changedSizing);
  assert.deepEqual(await assertPinnedPathDetail(workflow, firstAccount, strategy, resources.sizingA), originalParameterEffects,
    'Reading an earlier path after activation keeps its original sizing, strategy and source versions.');
  assert.equal((await getActiveWorkflow()).id, changedWorkflow.id, 'Path detail reads cannot reactivate a historical revision.');
  await assert.rejects(
    archiveWorkflowResource(resources.channel.id),
    /must stop referencing this resource/,
  );
  await assert.rejects(
    archiveWorkflowResourceFamily(resources.channel.resourceId),
    /must stop referencing this resource/,
  );
  await assert.rejects(
    deleteWorkflowResourceFamily(resources.channel.resourceId),
    /historical workflow revisions reference it/i,
  );

  // Four operator-editable safety values take effect only after a new version is pinned
  // by an activated graph. Draft and publication alone must leave existing intents alone.
  const historicalWorkflow = await getWorkflowRevisionById(changedWorkflow.id);
  assert.ok(historicalWorkflow);
  const historicalIntentRows = await Promise.all(intents.map(intent => getDatabase().get(
    'SELECT * FROM trading_trade_intents WHERE id = ?', [intent.id],
  )));
  assert.ok(historicalIntentRows.every(Boolean));
  async function assertHistoricalSafetyPinned() {
    const reloadedWorkflow = await getWorkflowRevisionById(changedWorkflow.id);
    assert.deepEqual(reloadedWorkflow.graph, historicalWorkflow.graph,
      'The prior revision must retain its persisted graph after strategy activation.');
    assert.deepEqual(reloadedWorkflow.compiled, historicalWorkflow.compiled,
      'The prior revision must retain its persisted effective strategy values.');
    assert.equal(reloadedWorkflow.definitionSha256, historicalWorkflow.definitionSha256);
    assert.deepEqual(await Promise.all(intents.map(intent => getDatabase().get(
      'SELECT * FROM trading_trade_intents WHERE id = ?', [intent.id],
    ))), historicalIntentRows, 'Original persisted intent rows must remain unchanged.');
  }
  const safetyDraftConfiguration = structuredClone(strategy.configuration);
  safetyDraftConfiguration.safety.maxDailyLossMode = 'equity_percent';
  const safetyDraft = await createTradingStrategyDraft({
    strategyId: strategy.strategyId, name: 'Safety limits v2', configuration: safetyDraftConfiguration,
  });
  const safetyConfiguration = structuredClone(safetyDraft.configuration);
  Object.assign(safetyConfiguration.safety, {
    maxDailyLossMode: 'equity_percent', maxDailyLoss: '2.5',
    maxSlippagePercent: '1.25', entryOrderTtlSeconds: 45,
  });
  Object.assign(safetyConfiguration, {
    allowedSignalSchemas: ['standard'], allowedSymbols: ['BTCUSDT'], allowedSides: ['LONG'],
  });
  Object.assign(safetyConfiguration.entry, {
    orderType: 'limit', rangePrice: 'far', postOnly: true, timeoutSeconds: 12,
  });
  const updatedSafetyDraft = await updateTradingStrategyDraft(safetyDraft.id, {
    name: 'Safety limits v2', configuration: safetyConfiguration,
  });
  assert.deepEqual(updatedSafetyDraft.configuration.safety, safetyConfiguration.safety);
  assert.equal((await getActiveWorkflow()).id, changedWorkflow.id);
  const publishedSafety = await publishTradingStrategyVersion(safetyDraft.id);
  assert.equal(publishedSafety.status, 'published');
  assert.equal((await getActiveWorkflow()).id, changedWorkflow.id,
    'Publishing strategy limits alone must not change the active graph.');
  const safetyResourceDraft = await createWorkflowResourceDraft({
    resourceId: resources.strategy.resourceId, kind: 'strategy',
    name: 'Safety limits resource v2', configuration: { strategyVersionId: publishedSafety.id },
  });
  const safetyResource = await publishWorkflowResource(safetyResourceDraft.id);
  const safetyGraph = { ...changedGraph, nodes: changedGraph.nodes.map(candidate => candidate.id === 'strategy'
    ? { ...candidate, resourceVersionId: safetyResource.id } : candidate) };
  await assert.rejects(saveWorkflowRevision({
    baseRevisionId: changedWorkflow.id, graph: safetyGraph, actorId: 'test:safety-no-confirmation',
  }), /WORKFLOW_IMPACT_CONFIRMATION_REQUIRED/);
  assert.equal((await getActiveWorkflow()).id, changedWorkflow.id,
    'Missing impact confirmation must preserve the old active graph.');
  const safetyWorkflow = await saveWorkflowRevision({
    baseRevisionId: changedWorkflow.id, graph: safetyGraph,
    actorId: 'test:safety-confirmed', confirmation: WORKFLOW_IMPACT_CONFIRMATION,
  });
  assert.equal((await getActiveWorkflow()).id, safetyWorkflow.id);
  const safetyPath = safetyWorkflow.compiled.paths.find(candidate => candidate.accountId === firstAccount.id);
  assert.ok(safetyPath);
  const accessEntryStrategy = safetyPath.effectiveConfiguration.strategyConfiguration;
  for (const key of ['allowedSignalSchemas', 'allowedSymbols', 'allowedSides', 'entry']) {
    assert.deepEqual(accessEntryStrategy[key], publishedSafety.configuration[key],
      `${key} must come from the newly pinned strategy version.`);
  }
  const safetyDetail = await uiWorkflowDetail('paths', safetyPath.id);
  for (const [field, expected] of Object.entries({
    'safety.maxDailyLossMode': 'equity_percent', 'safety.maxDailyLoss': '2.5',
    'safety.maxSlippagePercent': '1.25', 'safety.entryOrderTtlSeconds': 45,
  })) {
    const parameter = safetyDetail.parameterEffects.find(item => item.field === field);
    assert.equal(parameter.value, expected, `${field} must be visible as an effective value.`);
    assert.equal(parameter.sourceVersionId, publishedSafety.id);
    assert.equal(parameter.overridesStrategy, false);
  }
  assert.equal(safetyPath.effectiveConfiguration.strategyConfiguration.safety.requireProtectiveStop, true);
  assert.equal(resolveDailyLossLimit(publishedSafety.configuration.safety, '10000'), '250');
  assert.equal(createEntryPriceBoundary({ side: 'LONG', referencePrice: '100', priceTick: '0.1',
    maxSlippagePercent: publishedSafety.configuration.safety.maxSlippagePercent }).limitPrice, '101.2');
  assert.equal(resolveEntryExpiresAt(1_700_000_000_000,
    publishedSafety.configuration.safety.entryOrderTtlSeconds), 1_700_000_045_000);
  await assertHistoricalSafetyPinned();
  await saveSignal('workflow-signal-safety', '-100-workflow', 2, '<signal/>', '<signal/>');
  const safetyIntents = await createWorkflowTradingIntents({
    sourceSignalId: 'workflow-signal-safety', channelId: '-100-workflow', sourceText: 'BTCUSDT LONG', signal,
  });
  assert.equal(safetyIntents.length, 2);
  assert.ok(safetyIntents.every(intent => intent.strategyVersionId === publishedSafety.id
    && intent.workflowRevisionId === safetyWorkflow.id));
  const entrySignal = {
    ...signal, entry: { type: 'range', min: '95', max: '99' },
    targets: [{ min: '110', max: '110' }, { min: '120', max: '120' }],
  };
  const entryInput = {
    intentId: 'synthetic-access-entry-plan',
    signal: entrySignal, strategy: accessEntryStrategy,
    account: { equity: '10000', availableBalance: '10000' },
    market: { symbol: 'BTCUSDT', markPrice: '100', priceTick: '0.1', quantityStep: '0.001',
      minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 20, observedAt: Date.now() },
  };
  const entryPlan = createTradingPlan(entryInput);
  assert.equal(entryPlan.entryPrice, '95', 'The selected far range price must set the entry price.');
  assert.equal(entryPlan.orders[0].orderType, 'limit');
  assert.equal(entryPlan.orders[0].postOnly, true);
  assert.equal(entryPlan.entryTimeoutSeconds, 12);
  const withEntry = changes => ({ ...accessEntryStrategy, entry: { ...accessEntryStrategy.entry, ...changes } });
  assert.notEqual(createTradingPlan({ ...entryInput, strategy: withEntry({ rangePrice: 'midpoint' }) }).entryPrice,
    entryPlan.entryPrice);
  assert.equal(createTradingPlan({ ...entryInput, strategy: withEntry({ postOnly: false }) }).orders[0].postOnly, false);
  assert.equal(createTradingPlan({ ...entryInput, strategy: withEntry({ timeoutSeconds: 10 }) }).entryTimeoutSeconds, 10);
  const marketPlan = createTradingPlan({ ...entryInput,
    strategy: withEntry({ orderType: 'market', postOnly: false }) });
  assert.equal(marketPlan.orders[0].timeInForce, 'IOC', 'Market entry uses the bounded IOC contract.');
  assert.notEqual(marketPlan.entryPrice, entryPlan.entryPrice);
  for (const [property, value, error] of [
    ['schema', 'loma', /does not allow loma/],
    ['symbol', 'ETHUSDT', /does not allow ETHUSDT/],
    ['action', 'SHORT', /does not allow SHORT/],
  ]) {
    assert.throws(() => createTradingPlan({ ...entryInput,
      signal: { ...entrySignal, [property]: value } }), error);
  }
  const storedSafety = await getDatabase().get(
    'SELECT configuration_json, configuration_sha256 FROM trading_strategy_versions WHERE id = ?', [publishedSafety.id]);
  assert.deepEqual(JSON.parse(storedSafety.configuration_json).safety, publishedSafety.configuration.safety);
  assert.equal(storedSafety.configuration_sha256, publishedSafety.configurationSha256);
  await closeDb();
  await initDb(path.join(directory, 'forwarder.db'));
  assert.equal((await getActiveWorkflow()).id, safetyWorkflow.id);
  assert.equal((await getTradingStrategyVersion(publishedSafety.id)).configuration.safety.maxDailyLoss, '2.5');
  const reloadedStrategy = (await getWorkflowRevisionById(safetyWorkflow.id)).compiled.paths
    .find(candidate => candidate.accountId === firstAccount.id).effectiveConfiguration.strategyConfiguration;
  for (const key of ['allowedSignalSchemas', 'allowedSymbols', 'allowedSides', 'entry']) {
    assert.deepEqual(reloadedStrategy[key], accessEntryStrategy[key]);
  }
  await assertHistoricalSafetyPinned();

  // A sizing block is mandatory and overrides all six strategy sizing defaults.
  // Persist and activate a changed strategy to prove that the UI-authored values
  // remain visible as source values but cannot silently change the trade plan.
  const safetyIntentRows = await Promise.all(safetyIntents.map(intent => getDatabase().get(
    'SELECT * FROM trading_trade_intents WHERE id = ?', [intent.id],
  )));
  const historicalSafetyWorkflow = await getWorkflowRevisionById(safetyWorkflow.id);
  const authoredSizing = {
    positionSizingMode: 'risk_percent', riskPerTradePercent: '1.25', maxAdaptiveRiskPercent: '3.5',
    maxPositionNotional: '2500', defaultLeverage: 4, maxLeverage: 8,
  };
  const sizingStrategyConfiguration = structuredClone(publishedSafety.configuration);
  Object.assign(sizingStrategyConfiguration.sizing, authoredSizing);
  const sizingStrategyDraft = await createTradingStrategyDraft({
    strategyId: strategy.strategyId, name: 'Sizing defaults v3', configuration: sizingStrategyConfiguration,
  });
  assert.equal((await getActiveWorkflow()).id, safetyWorkflow.id);
  const sizingStrategy = await publishTradingStrategyVersion(sizingStrategyDraft.id);
  assert.deepEqual(sizingStrategy.configuration.sizing, authoredSizing);
  assert.equal((await getActiveWorkflow()).id, safetyWorkflow.id);
  const sizingStrategyResourceDraft = await createWorkflowResourceDraft({
    resourceId: resources.strategy.resourceId, kind: 'strategy',
    name: 'Sizing defaults resource v3', configuration: { strategyVersionId: sizingStrategy.id },
  });
  const sizingStrategyResource = await publishWorkflowResource(sizingStrategyResourceDraft.id);
  const sizingGraph = { ...safetyGraph, nodes: safetyGraph.nodes.map(candidate => candidate.id === 'strategy'
    ? { ...candidate, resourceVersionId: sizingStrategyResource.id } : candidate) };
  const sizingWorkflow = await saveWorkflowRevision({
    baseRevisionId: safetyWorkflow.id, graph: sizingGraph,
    actorId: 'test:sizing-override-confirmed', confirmation: WORKFLOW_IMPACT_CONFIRMATION,
  });
  const activeSizingPath = sizingWorkflow.compiled.paths.find(candidate => candidate.accountId === firstAccount.id);
  const previouslyEffectiveSizing = safetyPath.effectiveConfiguration.strategyConfiguration.sizing;
  assert.deepEqual(activeSizingPath.effectiveConfiguration.strategyConfiguration.sizing, previouslyEffectiveSizing,
    'The mandatory sizing resource, not the newly published strategy defaults, sets active risk sizing.');
  const sizingDetail = await uiWorkflowDetail('paths', activeSizingPath.id);
  for (const [field, authoredValue] of Object.entries(authoredSizing)) {
    const parameter = sizingDetail.parameterEffects.find(item => item.field === `sizing.${field}`);
    assert.equal(parameter.strategyValue, authoredValue, `The strategy source for ${field} must remain visible.`);
    assert.equal(parameter.value, previouslyEffectiveSizing[field], `The effective ${field} must remain resource-pinned.`);
    assert.equal(parameter.sourceVersionId, changedSizing.id);
    assert.equal(parameter.overridesStrategy, true);
  }
  await saveSignal('workflow-signal-sizing', '-100-workflow', 3, '<signal/>', '<signal/>');
  const sizingIntents = await createWorkflowTradingIntents({
    sourceSignalId: 'workflow-signal-sizing', channelId: '-100-workflow', sourceText: 'BTCUSDT LONG', signal,
  });
  assert.equal(sizingIntents.length, 2);
  assert.ok(sizingIntents.every(intent => intent.strategyVersionId === sizingStrategy.id
    && intent.workflowRevisionId === sizingWorkflow.id));
  const riskInput = {
    intentId: sizingIntents.find(intent => intent.accountId === firstAccount.id).id,
    signal: { ...signal, targets: [{ min: '110', max: '110' }, { min: '120', max: '120' }] },
    account: { equity: '10000', availableBalance: '10000' },
    market: { symbol: 'BTCUSDT', markPrice: '100', priceTick: '0.1', quantityStep: '0.001',
      minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 20, observedAt: Date.now() },
  };
  const priorPlan = createTradingPlan({ ...riskInput, strategy: safetyPath.effectiveConfiguration.strategyConfiguration });
  const activePlan = createTradingPlan({ ...riskInput, strategy: activeSizingPath.effectiveConfiguration.strategyConfiguration });
  assert.deepEqual([activePlan.quantity, activePlan.riskAmount, activePlan.leverage],
    [priorPlan.quantity, priorPlan.riskAmount, priorPlan.leverage],
    'A strategy-only sizing edit must not change the effective trade-risk plan.');
  const strategyOnlyPlan = createTradingPlan({ ...riskInput, strategy: sizingStrategy.configuration });
  assert.notEqual(strategyOnlyPlan.quantity, activePlan.quantity,
    'The authored strategy defaults differ from the active graph sizing source.');
  await closeDb();
  await initDb(path.join(directory, 'forwarder.db'));
  assert.equal((await getActiveWorkflow()).id, sizingWorkflow.id);
  assert.deepEqual((await getTradingStrategyVersion(sizingStrategy.id)).configuration.sizing, authoredSizing);
  assert.deepEqual((await getWorkflowRevisionById(sizingWorkflow.id)).compiled.paths
    .find(candidate => candidate.accountId === firstAccount.id).effectiveConfiguration.strategyConfiguration.sizing,
  previouslyEffectiveSizing);
  const reloadedSafetyWorkflow = await getWorkflowRevisionById(safetyWorkflow.id);
  assert.deepEqual(reloadedSafetyWorkflow.graph, historicalSafetyWorkflow.graph);
  assert.deepEqual(reloadedSafetyWorkflow.compiled, historicalSafetyWorkflow.compiled);
  assert.deepEqual(await Promise.all(safetyIntents.map(intent => getDatabase().get(
    'SELECT * FROM trading_trade_intents WHERE id = ?', [intent.id],
  ))), safetyIntentRows, 'A later strategy-only sizing activation must preserve older intent rows.');
  for (const intent of sizingIntents) {
    assert.deepEqual(await getDatabase().get(
      'SELECT strategy_version_id, workflow_revision_id FROM trading_trade_intents WHERE id = ?', [intent.id],
    ), { strategy_version_id: sizingStrategy.id, workflow_revision_id: sizingWorkflow.id });
  }
  await assertHistoricalSafetyPinned();

  // Unlike strategy sizing defaults, all six fields on the required sizing
  // resource become effective for new intents only after a graph revision pins it.
  const historicalSizingWorkflow = await getWorkflowRevisionById(sizingWorkflow.id);
  const historicalSizingIntentRows = await Promise.all(sizingIntents.map(intent => getDatabase().get(
    'SELECT * FROM trading_trade_intents WHERE id = ?', [intent.id],
  )));
  const effectiveSizingValues = {
    positionSizingMode: 'risk_percent', riskPerTradePercent: '2', maxAdaptiveRiskPercent: '4',
    maxPositionNotional: '5000', defaultLeverage: 3, maxLeverage: 8,
  };
  const effectiveSizingDraft = await createWorkflowResourceDraft({
    resourceId: changedSizing.resourceId, kind: 'sizing', name: 'Effective sizing draft',
    configuration: changedSizing.configuration,
  });
  const updatedEffectiveSizingDraft = await updateWorkflowResourceDraft(effectiveSizingDraft.id, {
    name: 'Effective sizing v2', configuration: effectiveSizingValues,
  });
  assert.deepEqual(updatedEffectiveSizingDraft.configuration, effectiveSizingValues);
  assert.equal((await getActiveWorkflow()).id, sizingWorkflow.id);
  const publishedEffectiveSizing = await publishWorkflowResource(effectiveSizingDraft.id);
  assert.equal(publishedEffectiveSizing.status, 'published');
  assert.equal((await getActiveWorkflow()).id, sizingWorkflow.id,
    'Publishing a sizing resource alone must not change the active risk source.');
  const effectiveSizingGraph = { ...sizingGraph, nodes: sizingGraph.nodes.map(candidate => candidate.id === 'sizing-a'
    ? { ...candidate, resourceVersionId: publishedEffectiveSizing.id } : candidate) };
  await assert.rejects(saveWorkflowRevision({
    baseRevisionId: sizingWorkflow.id, graph: effectiveSizingGraph, actorId: 'test:sizing-unconfirmed',
  }), /WORKFLOW_IMPACT_CONFIRMATION_REQUIRED/);
  assert.equal((await getActiveWorkflow()).id, sizingWorkflow.id);
  const effectiveSizingWorkflow = await saveWorkflowRevision({
    baseRevisionId: sizingWorkflow.id, graph: effectiveSizingGraph,
    actorId: 'test:sizing-confirmed', confirmation: WORKFLOW_IMPACT_CONFIRMATION,
  });
  const effectiveSizingPath = effectiveSizingWorkflow.compiled.paths.find(candidate => candidate.accountId === firstAccount.id);
  assert.deepEqual(effectiveSizingPath.effectiveConfiguration.strategyConfiguration.sizing, effectiveSizingValues);
  assert.equal(effectiveSizingPath.sizingResourceVersionId, publishedEffectiveSizing.id);
  assert.deepEqual(effectiveSizingWorkflow.compiled.paths.find(candidate => candidate.accountId === secondAccount.id)
    .effectiveConfiguration.strategyConfiguration.sizing,
  sizingWorkflow.compiled.paths.find(candidate => candidate.accountId === secondAccount.id)
    .effectiveConfiguration.strategyConfiguration.sizing,
  'A different account path must retain its independently pinned sizing resource.');
  const effectiveSizingDetail = await uiWorkflowDetail('paths', effectiveSizingPath.id);
  for (const [field, value] of Object.entries(effectiveSizingValues)) {
    const parameter = effectiveSizingDetail.parameterEffects.find(item => item.field === `sizing.${field}`);
    assert.equal(parameter.value, value);
    assert.equal(parameter.strategyValue, authoredSizing[field]);
    assert.equal(parameter.sourceVersionId, publishedEffectiveSizing.id);
    assert.equal(parameter.overridesStrategy, true);
  }
  await saveSignal('workflow-signal-effective-sizing', '-100-workflow', 4, '<signal/>', '<signal/>');
  const effectiveSizingIntents = await createWorkflowTradingIntents({
    sourceSignalId: 'workflow-signal-effective-sizing', channelId: '-100-workflow', sourceText: 'BTCUSDT LONG', signal,
  });
  assert.equal(effectiveSizingIntents.length, 2);
  const firstEffectiveIntent = effectiveSizingIntents.find(intent => intent.accountId === firstAccount.id);
  assert.equal(firstEffectiveIntent.workflowRevisionId, effectiveSizingWorkflow.id);
  assert.equal(firstEffectiveIntent.strategyVersionId, sizingStrategy.id);
  assert.equal(firstEffectiveIntent.executionPathId, effectiveSizingPath.id);
  const effectiveRiskInput = { ...riskInput, intentId: firstEffectiveIntent.id };
  const effectiveStrategy = effectiveSizingPath.effectiveConfiguration.strategyConfiguration;
  const plan = (sizing = {}, extras = {}) => createTradingPlan({
    ...effectiveRiskInput, ...extras,
    strategy: { ...effectiveStrategy, sizing: { ...effectiveStrategy.sizing, ...sizing } },
  });
  const activeSizingPlan = plan();
  assert.notEqual(activeSizingPlan.quantity, plan({ positionSizingMode: 'equity_percent_margin' }).quantity);
  assert.notEqual(activeSizingPlan.quantity, plan({ riskPerTradePercent: '1' }).quantity);
  assert.notEqual(plan({}, { effectiveRiskPercent: '9' }).quantity,
    plan({ maxAdaptiveRiskPercent: '2' }, { effectiveRiskPercent: '9' }).quantity);
  const closeStopSignal = { ...effectiveRiskInput.signal, stopLoss: '99' };
  assert.notEqual(plan({}, { signal: closeStopSignal }).quantity,
    plan({ maxPositionNotional: '10000' }, { signal: closeStopSignal }).quantity);
  assert.notEqual(activeSizingPlan.leverage, plan({ defaultLeverage: 5 }).leverage);
  const highLeverageSignal = { ...effectiveRiskInput.signal, suggestedLeverage: 15 };
  assert.notEqual(plan({}, { signal: highLeverageSignal }).leverage,
    plan({ maxLeverage: 12 }, { signal: highLeverageSignal }).leverage);
  assert.notDeepEqual([activeSizingPlan.quantity, activeSizingPlan.riskAmount, activeSizingPlan.leverage],
    [strategyOnlyPlan.quantity, strategyOnlyPlan.riskAmount, strategyOnlyPlan.leverage],
    'The new sizing resource must affect the trade-risk plan relative to the strategy defaults.');
  await closeDb();
  await initDb(path.join(directory, 'forwarder.db'));
  assert.equal((await getActiveWorkflow()).id, effectiveSizingWorkflow.id);
  assert.deepEqual((await getWorkflowResourceById(publishedEffectiveSizing.id)).configuration, effectiveSizingValues);
  assert.deepEqual((await getWorkflowRevisionById(effectiveSizingWorkflow.id)).compiled.paths
    .find(candidate => candidate.accountId === firstAccount.id).effectiveConfiguration.strategyConfiguration.sizing,
  effectiveSizingValues);
  assert.deepEqual((await getWorkflowRevisionById(sizingWorkflow.id)).graph, historicalSizingWorkflow.graph);
  assert.deepEqual((await getWorkflowRevisionById(sizingWorkflow.id)).compiled, historicalSizingWorkflow.compiled);
  assert.deepEqual(await Promise.all(sizingIntents.map(intent => getDatabase().get(
    'SELECT * FROM trading_trade_intents WHERE id = ?', [intent.id],
  ))), historicalSizingIntentRows, 'Original strategy-only intents must remain unchanged after sizing activation.');
  assert.deepEqual(await getDatabase().get(
    'SELECT workflow_revision_id, strategy_version_id, execution_path_id FROM trading_trade_intents WHERE id = ?',
    [firstEffectiveIntent.id],
  ), { workflow_revision_id: effectiveSizingWorkflow.id, strategy_version_id: sizingStrategy.id,
    execution_path_id: effectiveSizingPath.id });
  await assertHistoricalSafetyPinned();
  const historicalAdaptiveBaseWorkflow = await getWorkflowRevisionById(effectiveSizingWorkflow.id);
  const priorIntents = [...intents, ...safetyIntents, ...sizingIntents, ...effectiveSizingIntents];
  const originalAdaptiveBaseIntentRows = await Promise.all(priorIntents.map(intent => getDatabase().get(
    'SELECT * FROM trading_trade_intents WHERE id = ?', [intent.id],
  )));
  const riskNow = Date.UTC(2026, 8, 24, 20);
  await bindAccountReportingCurrency({
    accountId: secondAccount.id, accountFingerprint: `paper:${secondAccount.id}`,
    profile: 'paper', reportingCurrency: 'USDT', settlementAssets: ['USDT'],
    source: 'paper-contract-v1', verifiedAt: riskNow - 120_000,
  });
  await recordTradingEquitySnapshot(secondAccount.id, {
    equity: '25000', availableBalance: '25000', unrealizedPnl: '0', marginUsed: '0',
    accounting: { reportingCurrency: 'USDT', source: 'original-paper-observation' },
  }, riskNow - 60_000);
  const automaticConfiguration = {
    enabled: true, mode: 'automatic',
    tiers: [{ riskPercent: '1' }, { riskPercent: '2' }, { riskPercent: '3' }],
    startingTier: 1, lockedTier: null, minimumClosedTrades: 1000, weakChannelAction: 'none',
  };
  const automaticDraft = await createWorkflowResourceDraft({
    resourceId: resources.adaptive.resourceId, kind: 'adaptive_risk',
    name: 'Adaptive controls v2', configuration: automaticConfiguration,
  });
  assert.equal((await getActiveWorkflow()).id, effectiveSizingWorkflow.id);
  const automaticResource = await publishWorkflowResource(automaticDraft.id);
  assert.equal((await getActiveWorkflow()).id, effectiveSizingWorkflow.id);
  const automaticGraph = { ...effectiveSizingGraph, nodes: effectiveSizingGraph.nodes.map(candidate => candidate.id === 'adaptive'
    ? { ...candidate, resourceVersionId: automaticResource.id } : candidate) };
  await assert.rejects(saveWorkflowRevision({
    baseRevisionId: effectiveSizingWorkflow.id, graph: automaticGraph, actorId: 'test:adaptive-no-confirmation',
  }), /WORKFLOW_IMPACT_CONFIRMATION_REQUIRED/);
  const automaticWorkflow = await saveWorkflowRevision({
    baseRevisionId: effectiveSizingWorkflow.id, graph: automaticGraph,
    actorId: 'test:adaptive-confirmed', confirmation: WORKFLOW_IMPACT_CONFIRMATION,
  });
  const automaticPath = automaticWorkflow.compiled.paths.find(candidate => candidate.accountId === secondAccount.id);
  assert.equal(automaticPath.adaptiveRiskResourceVersionId, automaticResource.id);
  assert.equal(automaticPath.effectiveConfiguration.resources.adaptive_risk.startingTier, 1);
  await saveSignal('workflow-signal-adaptive', '-100-workflow', 5, '<signal/>', '<signal/>');
  const automaticIntents = await createWorkflowTradingIntents({
    sourceSignalId: 'workflow-signal-adaptive', channelId: '-100-workflow', sourceText: 'BTCUSDT LONG', signal,
  });
  const automaticIntent = automaticIntents.find(intent => intent.accountId === secondAccount.id);
  assert.equal(automaticIntent.workflowRevisionId, automaticWorkflow.id);
  assert.equal(automaticIntent.executionPathId, automaticPath.id);
  const historicalAdaptiveRows = new Map();
  const readIntentRow = intentId => getDatabase().get(
    'SELECT * FROM trading_trade_intents WHERE id = ?', [intentId],
  );
  async function assertAdaptiveIntentHistory() {
    for (const [intentId, originalRow] of historicalAdaptiveRows) {
      assert.deepEqual(await readIntentRow(intentId), originalRow,
        `A later adaptive policy activation must not rewrite historical intent ${intentId}.`);
    }
  }
  historicalAdaptiveRows.set(automaticIntent.id, await readIntentRow(automaticIntent.id));
  const automaticRisk = await resolveWorkflowAdaptiveRisk({
    channelId: automaticIntent.channelId, accountId: automaticIntent.accountId,
    adaptiveResourceVersionId: automaticPath.adaptiveRiskResourceVersionId,
    configuration: automaticPath.effectiveConfiguration.resources.adaptive_risk,
    strategy: automaticPath.effectiveConfiguration.strategyConfiguration,
    currentEquity: '25000', reportingCurrency: 'USDT', now: riskNow,
  });
  assert.equal(automaticRisk.blocked, false, automaticRisk.reason);
  assert.equal(automaticRisk.riskPercent, '2');
  const originalAdaptiveState = await getDatabase().get(
    'SELECT current_tier, locked_tier FROM workflow_adaptive_risk_state WHERE resource_id = ? AND account_id = ?',
    [resources.adaptive.resourceId, secondAccount.id],
  );
  assert.deepEqual(originalAdaptiveState, { current_tier: 1, locked_tier: null },
    'A fresh resource family must initialize its persisted state from startingTier.');
  const riskSignal = { ...signal, targets: [{ min: '110', max: '110' }, { min: '120', max: '120' }] };
  const adaptiveRiskInput = {
    signal: riskSignal, account: { equity: '25000', availableBalance: '25000' },
    market: { symbol: 'BTCUSDT', markPrice: '100', priceTick: '0.1', quantityStep: '0.001',
      minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 20, observedAt: riskNow },
  };
  const automaticPlan = createTradingPlan({ ...adaptiveRiskInput, intentId: automaticIntent.id,
    strategy: automaticPath.effectiveConfiguration.strategyConfiguration,
    effectiveRiskPercent: automaticRisk.riskPercent });
  const baselinePlan = createTradingPlan({ ...adaptiveRiskInput, intentId: automaticIntent.id,
    strategy: automaticPath.effectiveConfiguration.strategyConfiguration,
    effectiveRiskPercent: automaticPath.effectiveConfiguration.strategyConfiguration.sizing.riskPerTradePercent });
  assert.notEqual(automaticPlan.quantity, baselinePlan.quantity,
    'Automatic tier selection must change the synthetic risk plan for the new intent.');

  async function activateAdaptivePolicy(base, baseGraph, configuration, label, signalId, sequence, executionSignal = signal) {
    const draft = await createWorkflowResourceDraft({
      resourceId: resources.adaptive.resourceId, kind: 'adaptive_risk', name: label, configuration,
    });
    const version = await publishWorkflowResource(draft.id);
    assert.equal((await getActiveWorkflow()).id, base.id,
      'Publishing another adaptive policy must preserve the active graph.');
    const nextGraph = { ...baseGraph, nodes: baseGraph.nodes.map(candidate => candidate.id === 'adaptive'
      ? { ...candidate, resourceVersionId: version.id } : candidate) };
    const revision = await saveWorkflowRevision({ baseRevisionId: base.id, graph: nextGraph,
      actorId: `test:${label}`, confirmation: WORKFLOW_IMPACT_CONFIRMATION });
    await assertAdaptiveIntentHistory();
    const path = revision.compiled.paths.find(candidate => candidate.accountId === secondAccount.id);
    assert.equal(path.adaptiveRiskResourceVersionId, version.id);
    await saveSignal(signalId, '-100-workflow', sequence, '<signal/>', '<signal/>');
    const newIntents = await createWorkflowTradingIntents({
      sourceSignalId: signalId, channelId: '-100-workflow', sourceText: 'BTCUSDT LONG', signal: executionSignal,
    });
    const intent = newIntents.find(candidate => candidate.accountId === secondAccount.id);
    assert.equal(intent.workflowRevisionId, revision.id);
    assert.equal(intent.executionPathId, path.id);
    await assertAdaptiveIntentHistory();
    historicalAdaptiveRows.set(intent.id, await readIntentRow(intent.id));
    return { version, revision, path, intent, graph: nextGraph };
  }
  const shadow = await activateAdaptivePolicy(automaticWorkflow, automaticGraph,
    { ...automaticConfiguration, mode: 'shadow', startingTier: 0 },
    'Adaptive shadow v3', 'workflow-signal-adaptive-shadow', 6);
  const resolvePinnedRisk = (entry, timestamp) => resolveWorkflowAdaptiveRisk({
    channelId: entry.intent.channelId, accountId: entry.intent.accountId,
    adaptiveResourceVersionId: entry.path.adaptiveRiskResourceVersionId,
    configuration: entry.path.effectiveConfiguration.resources.adaptive_risk,
    strategy: entry.path.effectiveConfiguration.strategyConfiguration,
    currentEquity: '25000', reportingCurrency: 'USDT', now: timestamp,
  });
  const shadowRisk = await resolvePinnedRisk(shadow, riskNow);
  assert.equal(shadowRisk.blocked, false, shadowRisk.reason);
  assert.equal(shadowRisk.riskPercent, shadow.path.effectiveConfiguration.strategyConfiguration.sizing.riskPerTradePercent,
    'Shadow mode must leave the baseline trade risk unchanged.');
  const shadowPlan = createTradingPlan({ ...adaptiveRiskInput, intentId: shadow.intent.id,
    strategy: shadow.path.effectiveConfiguration.strategyConfiguration,
    effectiveRiskPercent: shadowRisk.riskPercent });
  assert.notEqual(shadowPlan.quantity, automaticPlan.quantity,
    'Changing the pinned policy from automatic to shadow must alter the new-intent risk plan.');
  assert.equal((await getDatabase().get(
    'SELECT current_tier FROM workflow_adaptive_risk_state WHERE resource_id = ? AND account_id = ?',
    [resources.adaptive.resourceId, secondAccount.id],
  )).current_tier, 1, 'Changing startingTier on an existing policy family must not reset the persisted tier.');
  const locked = await activateAdaptivePolicy(shadow.revision, shadow.graph,
    { ...automaticConfiguration, startingTier: 0, lockedTier: 2 },
    'Adaptive locked v4', 'workflow-signal-adaptive-locked', 7);
  const lockedRisk = await resolvePinnedRisk(locked, riskNow);
  assert.equal(lockedRisk.blocked, false, lockedRisk.reason);
  assert.equal(lockedRisk.riskPercent, '3');
  assert.deepEqual(await getDatabase().get(
    'SELECT current_tier, locked_tier FROM workflow_adaptive_risk_state WHERE resource_id = ? AND account_id = ?',
    [resources.adaptive.resourceId, secondAccount.id],
  ), { current_tier: 1, locked_tier: 2 }, 'Locking a tier must not rewrite the previously earned state tier.');
  const lockedPlan = createTradingPlan({ ...adaptiveRiskInput, intentId: locked.intent.id,
    strategy: locked.path.effectiveConfiguration.strategyConfiguration,
    effectiveRiskPercent: lockedRisk.riskPercent });
  assert.notEqual(lockedPlan.quantity, automaticPlan.quantity);
  const disabled = await activateAdaptivePolicy(locked.revision, locked.graph,
    { ...automaticConfiguration, enabled: false, startingTier: 0 },
    'Adaptive disabled v5', 'workflow-signal-adaptive-disabled', 8, riskSignal);
  assert.equal(disabled.path.effectiveConfiguration.resources.adaptive_risk.enabled, false);
  assert.equal(disabled.path.adaptiveRiskResourceVersionId, disabled.version.id);
  assert.deepEqual((await getWorkflowResourceById(disabled.version.id)).configuration,
    disabled.path.effectiveConfiguration.resources.adaptive_risk);
  assert.equal(historicalAdaptiveRows.size, 4);
  await closeDb();
  await initDb(path.join(directory, 'forwarder.db'));
  assert.equal((await getActiveWorkflow()).id, disabled.revision.id);
  assert.deepEqual((await getWorkflowRevisionById(effectiveSizingWorkflow.id)).graph, historicalAdaptiveBaseWorkflow.graph);
  assert.deepEqual((await getWorkflowRevisionById(effectiveSizingWorkflow.id)).compiled, historicalAdaptiveBaseWorkflow.compiled);
  assert.deepEqual(await Promise.all(priorIntents.map(intent => getDatabase().get(
    'SELECT * FROM trading_trade_intents WHERE id = ?', [intent.id],
  ))), originalAdaptiveBaseIntentRows, 'Original intents must retain their pre-adaptive graph pins.');
  assert.deepEqual((await getWorkflowResourceById(disabled.version.id)).configuration,
    disabled.path.effectiveConfiguration.resources.adaptive_risk);
  for (const entry of [
    { revision: automaticWorkflow, path: automaticPath, intent: automaticIntent },
    shadow, locked, disabled,
  ]) {
    const persisted = await getWorkflowRevisionById(entry.revision.id);
    assert.deepEqual(persisted.graph, entry.revision.graph);
    assert.deepEqual(persisted.compiled, entry.revision.compiled);
    assert.equal(persisted.compiled.paths.find(candidate => candidate.accountId === secondAccount.id)
      .adaptiveRiskResourceVersionId, entry.path.adaptiveRiskResourceVersionId);
    assert.equal((await getDatabase().get('SELECT workflow_revision_id FROM trading_trade_intents WHERE id = ?',
      [entry.intent.id])).workflow_revision_id, entry.revision.id);
  }
  await assertAdaptiveIntentHistory();
  assert.equal((await getDatabase().get('SELECT workflow_revision_id FROM trading_trade_intents WHERE id = ?',
    [disabled.intent.id])).workflow_revision_id, disabled.revision.id);
  await assertDisabledAdaptiveRiskEnginePlan(disabled, resources.sizingB.resourceId, secondAccount, riskSignal, automaticRisk,
    path.join(directory, 'forwarder.db'));
  console.log('Workflow builder tests passed.');
} finally {
  await (async () => closeDb())().catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}
