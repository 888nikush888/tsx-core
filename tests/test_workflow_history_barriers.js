import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, initDb } from '../src/db.js';
import {
  archiveSignalContractVersion,
  archiveTradingStrategyVersion,
  createSignalContract,
  createTradingAccount,
  createTradingSignalSchema,
  createTradingStrategyDraft,
  deleteSignalContractDraft,
  deleteSignalContractVersion,
  deleteTradingAccount,
  deleteTradingSignalSchema,
  deleteTradingStrategyVersion,
  listSignalContracts,
  listTradingStrategies,
  publishSignalContractVersion,
  publishTradingStrategyVersion,
} from '../src/trading_repository.js';
import {
  archiveWorkflowResource,
  archiveWorkflowResourceFamily,
  createWorkflowResourceDraft,
  getActiveWorkflow,
  getWorkflowBuilderHistoryStatus,
  publishWorkflowResource,
  saveWorkflowRevision,
} from '../src/workflow_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-workflow-history-barriers-'));
const emptyGraph = { schemaVersion: 1, nodes: [], edges: [] };

async function recordHistory(label) {
  const active = await getActiveWorkflow();
  await saveWorkflowRevision({
    baseRevisionId: active?.id ?? null,
    graph: active?.graph ?? emptyGraph,
    actorId: 'test:history-barrier',
    confirmation: null,
    history: { mode: 'record', label },
  });
  assert.equal((await getWorkflowBuilderHistoryStatus()).canUndo, true, `${label} must seed undo history.`);
}

async function assertResetAfter(label, operation) {
  await recordHistory(label);
  await operation();
  assert.deepEqual(await getWorkflowBuilderHistoryStatus(), {
    limit: 5,
    undoCount: 0,
    redoCount: 0,
    canUndo: false,
    canRedo: false,
    undoLabel: null,
    redoLabel: null,
  }, `${label} must reset workflow history after success.`);
}

async function publishedContract(id, definition) {
  await createSignalContract({ id, name: id, definition });
  return publishSignalContractVersion(`${id}:v1`);
}

try {
  await initDb(path.join(directory, 'forwarder.db'));
  await seedTradingFixtures();
  const referenceContract = (await listSignalContracts())[0].versions[0];
  const referenceStrategy = (await listTradingStrategies()).find(item => item.status === 'published');
  assert.ok(referenceContract && referenceStrategy);

  const resourceDraft = await createWorkflowResourceDraft({
    kind: 'output', name: 'Barrier single resource', configuration: { mode: 'none' },
  });
  const resource = await publishWorkflowResource(resourceDraft.id);
  await assertResetAfter('resource archive', () => archiveWorkflowResource(resource.id));

  const familyDraftV1 = await createWorkflowResourceDraft({
    kind: 'output', name: 'Barrier family v1', configuration: { mode: 'none' },
  });
  const familyV1 = await publishWorkflowResource(familyDraftV1.id);
  const familyDraftV2 = await createWorkflowResourceDraft({
    resourceId: familyV1.resourceId,
    kind: 'output',
    name: 'Barrier family v2',
    configuration: { mode: 'audit_only' },
  });
  await publishWorkflowResource(familyDraftV2.id);
  await assertResetAfter('resource family archive', () => archiveWorkflowResourceFamily(familyV1.resourceId));

  await assertResetAfter('strategy archive', () => archiveTradingStrategyVersion(referenceStrategy.id));

  const deletableStrategyDraft = await createTradingStrategyDraft({
    name: 'Barrier deletable strategy',
    configuration: referenceStrategy.configuration,
  });
  const deletableStrategy = await publishTradingStrategyVersion(deletableStrategyDraft.id);
  await assertResetAfter('published strategy delete', () => deleteTradingStrategyVersion(deletableStrategy.id));

  const schemaContract = await publishedContract('barrier-schema-contract', referenceContract.definition);
  const schema = await createTradingSignalSchema({
    id: 'barrier-schema',
    name: 'Barrier schema',
    contractVersionId: schemaContract.id,
    templateName: 'default',
    enabled: true,
  });
  await assertResetAfter('signal schema delete', () => deleteTradingSignalSchema(schema.id));

  const archivableContract = await publishedContract('barrier-archive-contract', referenceContract.definition);
  await assertResetAfter('published contract archive', () => archiveSignalContractVersion(archivableContract.id));

  const deletableContract = await publishedContract('barrier-delete-contract', referenceContract.definition);
  await assertResetAfter('published contract delete', () => deleteSignalContractVersion(deletableContract.id));

  const deletableAccount = await createTradingAccount({
    name: 'Barrier account', exchange: 'paper', mode: 'paper', initialBalance: '1000',
  });
  await assertResetAfter('trading account delete', () => deleteTradingAccount(deletableAccount.id));

  const draftContract = await createSignalContract({
    id: 'barrier-draft-contract', name: 'Barrier draft contract', definition: referenceContract.definition,
  });
  await recordHistory('draft delete is not a barrier');
  assert.equal(await deleteSignalContractDraft(draftContract.versions[0].id), true);
  assert.equal((await getWorkflowBuilderHistoryStatus()).canUndo, true,
    'Deleting an unpublished draft must not invalidate workflow history.');

  const beforeFailedBarrier = await getWorkflowBuilderHistoryStatus();
  await assert.rejects(archiveWorkflowResource('missing-resource'), /published workflow resource/);
  assert.deepEqual(await getWorkflowBuilderHistoryStatus(), beforeFailedBarrier,
    'A rejected invalidating operation must leave history unchanged.');

  console.log('Workflow history invalidation barrier tests passed.');
} finally {
  await closeDb().catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}
