import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import {
  createSignalContract, createTradingAccount, listSignalContracts, listTradingAccounts, listTradingStrategies,
  publishSignalContractVersion, updateTradingRuntimeState,
} from '../src/trading_repository.js';
import {
  WORKFLOW_IMPACT_CONFIRMATION,
  archiveWorkflowResource,
  archiveWorkflowResourceFamily,
  createWorkflowResourceDraft,
  createWorkflowTradingIntents,
  deleteWorkflowResourceDraft,
  getActiveWorkflow,
  getWorkflowSignalPlans,
  listWorkflowResources,
  previewWorkflowImpact,
  publishWorkflowResource,
  saveWorkflowRevision,
  simulateWorkflow,
  updateWorkflowResourceDraft,
} from '../src/workflow_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';

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
    assert.equal(await deleteWorkflowResourceDraft(draft.id), true);
  }

  const resources = {
    channel: await resource('channel', 'VIP channel', { channelId: '-100-workflow' }),
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
      maxPositionNotional: '1000000000', maxLeverage: 50,
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
    [{ schemaVersion: 2, nodes: [], edges: [] }, /contract is invalid/],
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
      edges: [{ id: 'reverse', source: 'target', target: 'source' }],
    }, /earlier processing column/],
  ];
  for (const [candidate, expected] of graphValidationCases) {
    await assert.rejects(previewWorkflowImpact({ baseRevisionId: null, graph: candidate }), expected);
  }
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
  assert.equal(workflow.compiled.paths.length, 2);
  assert.equal((await getActiveWorkflow()).definitionSha256, workflow.definitionSha256);
  await assert.rejects(
    saveWorkflowRevision({ baseRevisionId: null, graph, actorId: 'test:stale' }),
    /WORKFLOW_REVISION_CONFLICT/,
  );
  const simulation = await simulateWorkflow({ channelId: '-100-workflow', text: 'BTCUSDT LONG' });
  assert.equal(simulation.paths.length, 2);
  assert.ok(simulation.paths.every(item => item.allowed));
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
  await assert.rejects(
    archiveWorkflowResource(resources.channel.id),
    /must stop referencing this resource/,
  );
  await assert.rejects(
    archiveWorkflowResourceFamily(resources.channel.resourceId),
    /must stop referencing this resource/,
  );
  console.log('Workflow builder tests passed.');
} finally {
  await closeDb().catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}
