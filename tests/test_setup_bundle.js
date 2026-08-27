import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, initDb } from '../src/db.js';
import {
  createTradingAccount,
  listSignalContracts,
  listTradingAccounts,
  listTradingSignalSchemas,
  listTradingStrategies,
  updateTradingAccountState,
} from '../src/trading_repository.js';
import {
  createWorkflowResourceDraft,
  getActiveWorkflow,
  listWorkflowResources,
  publishWorkflowResource,
  saveWorkflowRevision,
  WORKFLOW_IMPACT_CONFIRMATION,
} from '../src/workflow_repository.js';
import {
  applyPortableSetupBundle,
  assertSetupBundleContainsNoSecrets,
  exportPortableSetupBundle,
  suggestPortableAccountMappings,
  validatePortableSetupBundle,
} from '../src/setup_bundle.js';
import { seedTradingFixtures } from './trading_fixtures.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-setup-bundle-'));
try {
  await initDb(path.join(directory, 'forwarder.db'));
  await seedTradingFixtures();
  const [account] = await listTradingAccounts();
  const fallbackAccount = await createTradingAccount({
    name: 'Bundle fallback account', exchange: 'paper', mode: 'paper', initialBalance: '25000',
  });
  const [strategy] = (await listTradingStrategies()).filter(item => item.status === 'published');
  const [schema] = (await listTradingSignalSchemas()).filter(item => item.enabled);
  const contract = (await listSignalContracts()).flatMap(item => item.versions)
    .find(item => item.id === schema.contractVersionId);
  assert.ok(account && strategy && schema && contract);

  const resource = async (kind, name, configuration) => {
    const draft = await createWorkflowResourceDraft({ kind, name, configuration });
    return publishWorkflowResource(draft.id);
  };
  const resources = [
    await resource('channel', 'Bundle channel', { channelId: '-100-bundle' }),
    await resource('parser', 'Bundle parser', { templateName: 'default', timeoutMs: 120_000, saveToFile: false, prompt: 'Return a grounded signal.' }),
    await resource('schema', 'Bundle schema', { schemaId: schema.id }),
    await resource('contract', 'Bundle contract', { contractVersionId: contract.id }),
    await resource('strategy', 'Bundle strategy', { strategyVersionId: strategy.id }),
    await resource('sizing', 'Bundle sizing', { positionSizingMode: 'equity_percent_margin', riskPerTradePercent: '5', maxAdaptiveRiskPercent: '10', maxPositionNotional: '1000000', maxLeverage: 50 }),
    await resource('account', 'Bundle account', { accountId: account.id }),
    await resource('account', 'Bundle fallback account', { accountId: fallbackAccount.id }),
  ];
  const nodeIds = ['channel', 'parser', 'schema', 'contract', 'strategy', 'sizing', 'account', 'account-fallback'];
  const graph = {
    schemaVersion: 2,
    nodes: resources.map((item, index) => ({
      id: nodeIds[index], kind: item.kind, resourceVersionId: item.id, position: { x: index * 316, y: 0 },
    })),
    edges: [
      ...nodeIds.slice(0, -2).map((source, index) => ({
        id: `edge-${index}`, kind: 'flow', source, target: nodeIds[index + 1],
      })),
      {
        id: 'account-fallback-edge', kind: 'account_fallback', source: 'account',
        target: 'account-fallback', channelNodeIds: ['channel'],
      },
    ],
  };
  const initial = await saveWorkflowRevision({
    baseRevisionId: null,
    graph,
    actorId: 'test:setup-export',
    confirmation: WORKFLOW_IMPACT_CONFIRMATION,
  });
  const bundle = await exportPortableSetupBundle({
    apiId: 123,
    xmlParsing: { timeout: 120_000, aiLimits: { dailyTokenLimit: 10_000 } },
  });
  assert.equal(bundle.schemaVersion, 2);
  assert.equal(bundle.mode, 'replace');
  assert.equal(bundle.workflow.resources.length, resources.length);
  assert.equal(bundle.accountReferences.length, 2);
  assert.equal(bundle.workflow.graph.schemaVersion, 2);
  assert.equal(bundle.workflow.graph.edges.at(-1).kind, 'account_fallback');
  assert.doesNotMatch(JSON.stringify(bundle), /credentialRef|apiSecret|privateKey|bearerToken/i);
  assert.deepEqual(validatePortableSetupBundle(bundle), bundle);

  const tampered = structuredClone(bundle);
  tampered.workflow.resources[0].name = 'Tampered';
  assert.throws(() => validatePortableSetupBundle(tampered), /checksum verification failed/);
  const secretLeak = structuredClone(bundle);
  secretLeak.systemConfig.apiKey = 'must-never-import';
  assert.throws(() => validatePortableSetupBundle(secretLeak), /forbidden secret field/);
  const disguisedSecretLeak = structuredClone(bundle);
  disguisedSecretLeak.systemConfig.notes = `Bearer ${'x'.repeat(32)}`;
  assert.throws(() => validatePortableSetupBundle(disguisedSecretLeak), /secret-like value/);
  const danglingGraph = structuredClone(bundle);
  danglingGraph.workflow.graph.edges[0].target = 'missing-node';
  assert.throws(() => validatePortableSetupBundle(danglingGraph), /dangling/);
  const missingStrategySchema = structuredClone(bundle);
  missingStrategySchema.models.strategies[0].configuration.allowedSignalSchemas = ['missing-schema'];
  assert.throws(() => validatePortableSetupBundle(missingStrategySchema), /missing parser schema/);
  const invalidRiskPolicy = structuredClone(bundle);
  invalidRiskPolicy.models.channelRiskPolicies.push({ channelId: '-100-invalid', mode: 'unsafe' });
  assert.throws(() => validatePortableSetupBundle(invalidRiskPolicy), /mode is invalid/);

  const invalidBundleCases = [
    {
      label: 'unknown root fields',
      mutate: candidate => { candidate.unknown = true; },
      error: /unsupported root field/,
    },
    {
      label: 'unsupported versions',
      mutate: candidate => { candidate.schemaVersion = 3; },
      error: /schema or version is unsupported/,
    },
    {
      label: 'negative timestamps',
      mutate: candidate => { candidate.exportedAt = -1; },
      error: /timestamp is invalid/,
    },
    {
      label: 'non-object system configuration',
      mutate: candidate => { candidate.systemConfig = []; },
      error: /system configuration must be an object/,
    },
    {
      label: 'non-array workflow resources',
      mutate: candidate => { candidate.workflow.resources = {}; },
      error: /resources are invalid/,
    },
    {
      label: 'unsupported graph schemas',
      mutate: candidate => { candidate.workflow.graph.schemaVersion = 3; },
      error: /graph structure is invalid/,
    },
    {
      label: 'non-array graph nodes',
      mutate: candidate => { candidate.workflow.graph.nodes = {}; },
      error: /graph structure is invalid/,
    },
    {
      label: 'non-array graph edges',
      mutate: candidate => { candidate.workflow.graph.edges = {}; },
      error: /graph structure is invalid/,
    },
    {
      label: 'too many graph nodes',
      mutate: candidate => { candidate.workflow.graph.nodes = Array.from({ length: 1_001 }, () => ({})); },
      error: /graph structure is invalid/,
    },
    {
      label: 'too many graph edges',
      mutate: candidate => { candidate.workflow.graph.edges = Array.from({ length: 4_001 }, () => ({})); },
      error: /graph structure is invalid/,
    },
    {
      label: 'duplicate graph node ids',
      mutate: candidate => { candidate.workflow.graph.nodes[1].id = candidate.workflow.graph.nodes[0].id; },
      error: /node is invalid or duplicated/,
    },
    {
      label: 'unknown graph node kinds',
      mutate: candidate => { candidate.workflow.graph.nodes[0].kind = 'unknown'; },
      error: /node is invalid or duplicated/,
    },
    {
      label: 'invalid graph positions',
      mutate: candidate => { candidate.workflow.graph.nodes[0].position.x = null; },
      error: /node position is invalid/,
    },
    {
      label: 'non-object graph positions',
      mutate: candidate => { candidate.workflow.graph.nodes[0].position = []; },
      error: /node position must be an object/,
    },
    {
      label: 'duplicate graph edge ids',
      mutate: candidate => { candidate.workflow.graph.edges.push(structuredClone(candidate.workflow.graph.edges[0])); },
      error: /edge is invalid, duplicated or dangling/,
    },
    {
      label: 'non-array graph edge scopes',
      mutate: candidate => { candidate.workflow.graph.edges[0].channelNodeIds = 'channel'; },
      error: /edge channel scope is invalid/,
    },
    {
      label: 'dangling graph edge scopes',
      mutate: candidate => { candidate.workflow.graph.edges[0].channelNodeIds = ['missing-channel']; },
      error: /edge channel scope is invalid/,
    },
    {
      label: 'missing graph resource versions',
      mutate: candidate => { candidate.workflow.graph.nodes[0].resourceVersionId = 'missing-version'; },
      error: /missing resource version/,
    },
    {
      label: 'duplicate resource versions',
      mutate: candidate => { candidate.workflow.resources[1].sourceVersionId = candidate.workflow.resources[0].sourceVersionId; },
      error: /resource is invalid or duplicated/,
    },
    {
      label: 'unknown resource kinds',
      mutate: candidate => { candidate.workflow.resources[0].kind = 'unknown'; },
      error: /resource is invalid or duplicated/,
    },
    {
      label: 'empty resource names',
      mutate: candidate => { candidate.workflow.resources[0].name = ' '; },
      error: /resource name is invalid/,
    },
    {
      label: 'overlong resource names',
      mutate: candidate => { candidate.workflow.resources[0].name = 'x'.repeat(161); },
      error: /resource name is invalid/,
    },
    {
      label: 'non-object resource configurations',
      mutate: candidate => { candidate.workflow.resources[0].configuration = []; },
      error: /resource configuration must be an object/,
    },
    {
      label: 'too many workflow resources',
      mutate: candidate => { candidate.workflow.resources = Array.from({ length: 1_001 }, () => ({})); },
      error: /resources are invalid/,
    },
    {
      label: 'invalid parser enabled state',
      mutate: candidate => { candidate.models.schemas[0].enabled = 'yes'; },
      error: /enabled state is invalid/,
    },
    {
      label: 'duplicate contract identifiers',
      mutate: candidate => { candidate.models.contracts.push(structuredClone(candidate.models.contracts[0])); },
      error: /contract identifiers are duplicated/,
    },
    {
      label: 'invalid model collections',
      mutate: candidate => { candidate.models.strategies = {}; },
      error: /model collections are invalid/,
    },
    {
      label: 'missing schema contracts',
      mutate: candidate => { candidate.models.schemas[0].sourceContractVersionId = 'missing-contract'; },
      error: /schema references a missing contract/,
    },
    {
      label: 'non-array account references',
      mutate: candidate => { candidate.accountReferences = {}; },
      error: /account references are invalid/,
    },
    {
      label: 'too many account references',
      mutate: candidate => { candidate.accountReferences = Array.from({ length: 101 }, () => structuredClone(candidate.accountReferences[0])); },
      error: /account references are invalid/,
    },
    {
      label: 'invalid account names',
      mutate: candidate => { candidate.accountReferences[0].name = ''; },
      error: /account name is invalid/,
    },
    {
      label: 'non-object account references',
      mutate: candidate => { candidate.accountReferences = [null]; },
      error: /account reference must be an object/,
    },
    {
      label: 'invalid checksum format',
      mutate: candidate => { candidate.checksum = 'invalid'; },
      error: /checksum is invalid/,
    },
  ];
  assert.throws(() => validatePortableSetupBundle(null), /Setup bundle must be an object/);
  for (const { label, mutate, error } of invalidBundleCases) {
    const candidate = structuredClone(bundle);
    mutate(candidate);
    assert.throws(() => validatePortableSetupBundle(candidate), error, label);
  }
  let nested = {};
  for (let depth = 0; depth < 42; depth += 1) nested = { nested };
  assert.throws(() => assertSetupBundleContainsNoSecrets(nested), /nesting exceeds the safety limit/);

  const suggestion = await suggestPortableAccountMappings(bundle);
  assert.deepEqual(suggestion.unresolved, []);
  assert.equal(suggestion.automatic[account.id], account.id);
  assert.equal(suggestion.automatic[fallbackAccount.id], fallbackAccount.id);
  const fallbackReference = {
    sourceAccountId: 'remote-account',
    name: account.name,
    exchange: account.exchange,
    mode: account.mode,
  };
  const fallbackSuggestion = await suggestPortableAccountMappings({
    ...bundle,
    accountReferences: [fallbackReference],
  });
  assert.equal(fallbackSuggestion.automatic['remote-account'], account.id);
  const missingSuggestion = await suggestPortableAccountMappings({
    ...bundle,
    accountReferences: [{ ...fallbackReference, sourceAccountId: 'missing-account', name: 'No match' }],
  });
  assert.deepEqual(missingSuggestion.unresolved, ['missing-account']);

  const duplicateAccount = await createTradingAccount({
    name: account.name,
    exchange: account.exchange,
    mode: account.mode,
    ...(account.exchange === 'paper'
      ? { initialBalance: '10000' }
      : { credentialRef: 'duplicate-mapping-candidate' }),
  });
  await updateTradingAccountState(duplicateAccount.id, {
    status: 'ready',
    enabled: true,
    verifiedAt: Date.now(),
    externalAccountId: 'duplicate-external-account',
  });
  const ambiguousSuggestion = await suggestPortableAccountMappings({
    ...bundle,
    accountReferences: [{ ...fallbackReference, sourceAccountId: 'ambiguous-account' }],
  });
  assert.deepEqual(ambiguousSuggestion.unresolved, ['ambiguous-account']);
  await assert.rejects(
    applyPortableSetupBundle({ bundle, accountMappings: {}, actorId: 'test:missing-map' }),
    /not mapped to a verified compatible local account/,
  );
  const applied = await applyPortableSetupBundle({
    bundle,
    accountMappings: suggestion.automatic,
    actorId: 'test:setup-import',
  });
  assert.equal(applied.importedResources, resources.length);
  const active = await getActiveWorkflow();
  assert.equal(active.revision, initial.revision + 1);
  assert.notEqual(active.id, initial.id);
  assert.equal(active.graph.nodes.length, graph.nodes.length);
  assert.equal(active.graph.schemaVersion, 2);
  assert.equal(active.graph.edges.at(-1).kind, 'account_fallback');
  assert.equal(active.compiled.routeGroups[0].candidates.length, 2);
  const activeResourceIds = new Set(active.graph.nodes.map(node => node.resourceVersionId));
  assert.equal(activeResourceIds.size, resources.length);
  assert.ok((await listWorkflowResources()).filter(item => item.status === 'published').every(item => activeResourceIds.has(item.id)));
  assert.equal((await listTradingStrategies()).find(item => item.id === strategy.id)?.status, 'archived');
  assert.equal((await listTradingSignalSchemas()).find(item => item.id === schema.id)?.enabled, false);
  assert.equal(
    (await listSignalContracts()).flatMap(item => item.versions).find(item => item.id === contract.id)?.status,
    'archived',
  );

  const beforeRollback = active.id;
  await assert.rejects(
    applyPortableSetupBundle({
      bundle,
      accountMappings: suggestion.automatic,
      actorId: 'test:rollback',
      beforeCommit: () => { throw new Error('simulated configuration failure'); },
    }),
    /simulated configuration failure/,
  );
  assert.equal((await getActiveWorkflow()).id, beforeRollback, 'A failed setup application must roll back its workflow revision.');
  console.log('Portable setup bundle tests passed.');
} finally {
  await closeDb().catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}
