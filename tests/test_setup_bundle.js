import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, initDb } from '../src/db.js';
import {
  listSignalContracts,
  listTradingAccounts,
  listTradingSignalSchemas,
  listTradingStrategies,
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
  ];
  const nodeIds = ['channel', 'parser', 'schema', 'contract', 'strategy', 'sizing', 'account'];
  const graph = {
    schemaVersion: 1,
    nodes: resources.map((item, index) => ({
      id: nodeIds[index], kind: item.kind, resourceVersionId: item.id, position: { x: index * 316, y: 0 },
    })),
    edges: nodeIds.slice(0, -1).map((source, index) => ({ id: `edge-${index}`, source, target: nodeIds[index + 1] })),
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
  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.mode, 'replace');
  assert.equal(bundle.workflow.resources.length, resources.length);
  assert.equal(bundle.accountReferences.length, 1);
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

  const suggestion = await suggestPortableAccountMappings(bundle);
  assert.deepEqual(suggestion.unresolved, []);
  assert.equal(suggestion.automatic[account.id], account.id);
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
