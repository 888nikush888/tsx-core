import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  closeDb,
  DATABASE_FEATURE_SET,
  getDatabase,
  initDb,
  LATEST_SCHEMA_VERSION,
  REQUIRED_DATABASE_TABLES,
} from '../src/db.js';
import {
  listSignalContracts,
  listTradingAccounts,
  listTradingStrategies,
} from '../src/trading_repository.js';
import {
  applyWorkflowBuilderHistory,
  clearWorkflowBuilderHistory,
  createWorkflowResourceDraft,
  getActiveWorkflow,
  getWorkflowBuilderHistoryStatus,
  previewWorkflowBuilderHistoryImpact,
  publishWorkflowResource,
  saveWorkflowRevision,
  WORKFLOW_BUILDER_HISTORY_LIMIT,
  WORKFLOW_IMPACT_CONFIRMATION,
} from '../src/workflow_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-workflow-history-'));
const databasePath = path.join(directory, 'forwarder.db');

try {
  await initDb(databasePath);
  await seedTradingFixtures();

  assert.equal(LATEST_SCHEMA_VERSION, 20);
  assert.ok(REQUIRED_DATABASE_TABLES.includes('workflow_builder_history'));
  assert.ok(DATABASE_FEATURE_SET.includes('server-persistent-workflow-builder-history'));
  assert.equal(WORKFLOW_BUILDER_HISTORY_LIMIT, 5);

  const initialStatus = await getWorkflowBuilderHistoryStatus();
  assert.deepEqual(initialStatus, {
    limit: 5,
    undoCount: 0,
    redoCount: 0,
    canUndo: false,
    canRedo: false,
    undoLabel: null,
    redoLabel: null,
  });

  const [account] = await listTradingAccounts();
  const [strategy] = await listTradingStrategies();
  const [contract] = await listSignalContracts();
  const contractVersion = contract.versions.find((candidate) => candidate.status === 'published');
  assert.ok(account && strategy && contractVersion);

  async function resource(kind, name, configuration, resourceId) {
    const draft = await createWorkflowResourceDraft({ resourceId, kind, name, configuration });
    return publishWorkflowResource(draft.id);
  }

  const resources = {
    channel: await resource('channel', 'History channel', { channelId: '-100-history' }),
    parser: await resource('parser', 'History parser', {
      templateName: 'default', timeoutMs: 120_000, saveToFile: false,
    }),
    schema: await resource('schema', 'History schema', { schemaId: 'standard' }),
    contract: await resource('contract', 'History contract', { contractVersionId: contractVersion.id }),
    strategy: await resource('strategy', 'History strategy', { strategyVersionId: strategy.id }),
    sizingV1: await resource('sizing', 'History sizing V1', {
      positionSizingMode: 'equity_percent_margin', riskPerTradePercent: '5',
      maxAdaptiveRiskPercent: '5', maxPositionNotional: '1000000', defaultLeverage: 3, maxLeverage: 10,
    }, 'history-sizing'),
    account: await resource('account', 'History account', { accountId: account.id }),
  };
  const sizingV2 = await resource('sizing', 'History sizing V2', {
    positionSizingMode: 'equity_percent_margin', riskPerTradePercent: '5',
    maxAdaptiveRiskPercent: '5', maxPositionNotional: '1000000', defaultLeverage: 7, maxLeverage: 10,
  }, resources.sizingV1.resourceId);

  const node = (id, kind, resourceVersionId) => ({ id, kind, resourceVersionId, position: { x: 0, y: 0 } });
  const nodes = [
    node('channel', 'channel', resources.channel.id),
    node('parser', 'parser', resources.parser.id),
    node('schema', 'schema', resources.schema.id),
    node('contract', 'contract', resources.contract.id),
    node('strategy', 'strategy', resources.strategy.id),
    node('sizing', 'sizing', resources.sizingV1.id),
    node('account', 'account', resources.account.id),
  ];
  const edges = nodes.slice(1).map((candidate, index) => ({
    id: `edge-${index + 1}`,
    source: nodes[index].id,
    target: candidate.id,
  }));
  const graphV1 = { schemaVersion: 1, nodes, edges };
  const graphV2 = {
    ...graphV1,
    nodes: graphV1.nodes.map((candidate) => candidate.id === 'sizing'
      ? { ...candidate, resourceVersionId: sizingV2.id }
      : candidate),
  };

  const revision1 = await saveWorkflowRevision({
    baseRevisionId: null,
    graph: graphV1,
    actorId: 'test:history',
    confirmation: WORKFLOW_IMPACT_CONFIRMATION,
    history: { mode: 'record', label: 'Ersten Workflow aktivieren' },
  }, 1_000);
  assert.equal(revision1.revision, 1);
  assert.deepEqual(await getWorkflowBuilderHistoryStatus(), {
    limit: 5,
    undoCount: 1,
    redoCount: 0,
    canUndo: true,
    canRedo: false,
    undoLabel: 'Ersten Workflow aktivieren',
    redoLabel: null,
  });

  const undoImpact = await previewWorkflowBuilderHistoryImpact({
    direction: 'undo', baseRevisionId: revision1.id,
  });
  assert.equal(undoImpact.destructive, true);
  assert.equal(undoImpact.removed.length, 1);
  const historyBeforeRejectedUndo = await getDatabase().get(
    'SELECT undo_json, redo_json FROM workflow_builder_history WHERE singleton_id = 1',
  );
  await assert.rejects(
    applyWorkflowBuilderHistory({
      direction: 'undo', baseRevisionId: revision1.id, actorId: 'test:history', confirmation: null,
    }),
    /WORKFLOW_IMPACT_CONFIRMATION_REQUIRED/,
  );
  assert.equal((await getActiveWorkflow()).id, revision1.id);
  assert.deepEqual(
    await getDatabase().get('SELECT undo_json, redo_json FROM workflow_builder_history WHERE singleton_id = 1'),
    historyBeforeRejectedUndo,
  );

  const undoResult = await applyWorkflowBuilderHistory({
    direction: 'undo', baseRevisionId: revision1.id, actorId: 'test:history',
    confirmation: WORKFLOW_IMPACT_CONFIRMATION,
  }, 2_000);
  assert.equal(undoResult.workflow.revision, 2);
  assert.deepEqual(undoResult.workflow.graph, { schemaVersion: 1, nodes: [], edges: [] });
  assert.equal(undoResult.workflow.baseRevisionId, revision1.id);
  assert.deepEqual(undoResult.history, {
    limit: 5,
    undoCount: 0,
    redoCount: 1,
    canUndo: false,
    canRedo: true,
    undoLabel: null,
    redoLabel: 'Ersten Workflow aktivieren',
  });

  const redoImpact = await previewWorkflowBuilderHistoryImpact({
    direction: 'redo', baseRevisionId: undoResult.workflow.id,
  });
  assert.equal(redoImpact.destructive, true);
  assert.equal(redoImpact.added.length, 1);
  await assert.rejects(
    applyWorkflowBuilderHistory({
      direction: 'redo', baseRevisionId: undoResult.workflow.id,
      actorId: 'test:history', confirmation: 'wrong',
    }),
    /WORKFLOW_IMPACT_CONFIRMATION_REQUIRED/,
  );
  const redoResult = await applyWorkflowBuilderHistory({
    direction: 'redo', baseRevisionId: undoResult.workflow.id,
    actorId: 'test:history', confirmation: WORKFLOW_IMPACT_CONFIRMATION,
  }, 3_000);
  assert.equal(redoResult.workflow.revision, 3);
  assert.equal(redoResult.workflow.baseRevisionId, undoResult.workflow.id);
  assert.deepEqual(redoResult.workflow.graph, revision1.graph);

  const storedRevision1 = await getDatabase().get(
    'SELECT graph_json, definition_sha256 FROM workflow_revisions WHERE id = ?', [revision1.id],
  );
  assert.deepEqual(JSON.parse(storedRevision1.graph_json), revision1.graph);
  assert.equal(storedRevision1.definition_sha256, revision1.definitionSha256);

  const revision4 = await saveWorkflowRevision({
    baseRevisionId: redoResult.workflow.id,
    graph: graphV2,
    actorId: 'test:history',
    confirmation: WORKFLOW_IMPACT_CONFIRMATION,
    history: { mode: 'record', label: 'Sizing V2 aktivieren' },
  }, 4_000);
  assert.equal(
    revision4.compiled.paths[0].effectiveConfiguration.strategyConfiguration.sizing.defaultLeverage,
    7,
  );
  const leverageUndo = await applyWorkflowBuilderHistory({
    direction: 'undo', baseRevisionId: revision4.id, actorId: 'test:history',
    confirmation: WORKFLOW_IMPACT_CONFIRMATION,
  }, 5_000);
  assert.equal(
    leverageUndo.workflow.compiled.paths[0].effectiveConfiguration.strategyConfiguration.sizing.defaultLeverage,
    3,
  );
  const leverageRedo = await applyWorkflowBuilderHistory({
    direction: 'redo', baseRevisionId: leverageUndo.workflow.id, actorId: 'test:history',
    confirmation: WORKFLOW_IMPACT_CONFIRMATION,
  }, 6_000);
  assert.equal(
    leverageRedo.workflow.compiled.paths[0].effectiveConfiguration.strategyConfiguration.sizing.defaultLeverage,
    7,
  );

  let active = leverageRedo.workflow;
  for (let index = 0; index < 6; index += 1) {
    active = await saveWorkflowRevision({
      baseRevisionId: active.id,
      graph: index % 2 === 0 ? graphV1 : graphV2,
      actorId: 'test:history',
      confirmation: WORKFLOW_IMPACT_CONFIRMATION,
      history: { mode: 'record', label: `Änderung ${index + 1}` },
    }, 7_000 + index);
  }
  assert.deepEqual(await getWorkflowBuilderHistoryStatus(), {
    limit: 5,
    undoCount: 5,
    redoCount: 0,
    canUndo: true,
    canRedo: false,
    undoLabel: 'Änderung 6',
    redoLabel: null,
  });

  const afterUndo = await applyWorkflowBuilderHistory({
    direction: 'undo', baseRevisionId: active.id, actorId: 'test:history',
    confirmation: WORKFLOW_IMPACT_CONFIRMATION,
  }, 8_000);
  assert.equal(afterUndo.history.undoCount, 4);
  assert.equal(afterUndo.history.redoCount, 1);
  const historyBeforeConflict = await getDatabase().get(
    'SELECT undo_json, redo_json FROM workflow_builder_history WHERE singleton_id = 1',
  );
  await assert.rejects(
    applyWorkflowBuilderHistory({
      direction: 'undo', baseRevisionId: active.id, actorId: 'test:stale',
      confirmation: WORKFLOW_IMPACT_CONFIRMATION,
    }),
    /WORKFLOW_REVISION_CONFLICT/,
  );
  assert.deepEqual(
    await getDatabase().get('SELECT undo_json, redo_json FROM workflow_builder_history WHERE singleton_id = 1'),
    historyBeforeConflict,
  );

  const normalEdit = await saveWorkflowRevision({
    baseRevisionId: afterUndo.workflow.id,
    graph: afterUndo.workflow.graph,
    actorId: 'test:history',
    confirmation: WORKFLOW_IMPACT_CONFIRMATION,
    history: { mode: 'record', label: 'Neue normale Änderung' },
  }, 9_000);
  const afterNormalEdit = await getWorkflowBuilderHistoryStatus();
  assert.equal(afterNormalEdit.redoCount, 0);
  assert.equal(afterNormalEdit.undoLabel, 'Neue normale Änderung');

  await assert.rejects(
    saveWorkflowRevision({
      baseRevisionId: normalEdit.id,
      graph: normalEdit.graph,
      actorId: 'test:history',
      history: { mode: 'record', label: 'Ungültig\nmehrzeilig' },
    }),
    /history label/i,
  );
  assert.equal((await getActiveWorkflow()).id, normalEdit.id);

  const persistedStatus = await getWorkflowBuilderHistoryStatus();
  await closeDb();
  await initDb(databasePath);
  assert.deepEqual(await getWorkflowBuilderHistoryStatus(), persistedStatus);

  await getDatabase().run(
    "UPDATE workflow_builder_history SET undo_json = '{broken' WHERE singleton_id = 1",
  );
  await assert.rejects(getWorkflowBuilderHistoryStatus(), /history.*invalid json/i);
  await assert.rejects(
    saveWorkflowRevision({
      baseRevisionId: normalEdit.id,
      graph: normalEdit.graph,
      actorId: 'test:history',
      history: { mode: 'record', label: 'Darf nicht schreiben' },
    }),
    /history.*invalid json/i,
  );
  assert.equal((await getActiveWorkflow()).id, normalEdit.id);

  await clearWorkflowBuilderHistory('test recovery', 10_000);
  assert.equal((await getWorkflowBuilderHistoryStatus()).undoCount, 0);
  const missingTargetEntry = JSON.stringify([{
    revisionId: 'missing-revision', label: 'Fehlendes Ziel', capturedAt: 10_001,
  }]);
  await getDatabase().run(
    'UPDATE workflow_builder_history SET undo_json = ? WHERE singleton_id = 1',
    [missingTargetEntry],
  );
  const activeBeforeMissingTarget = await getActiveWorkflow();
  await assert.rejects(
    applyWorkflowBuilderHistory({
      direction: 'undo', baseRevisionId: activeBeforeMissingTarget.id,
      actorId: 'test:history', confirmation: WORKFLOW_IMPACT_CONFIRMATION,
    }),
    /history target/i,
  );
  assert.equal((await getActiveWorkflow()).id, activeBeforeMissingTarget.id);
  assert.equal(
    (await getDatabase().get('SELECT undo_json FROM workflow_builder_history WHERE singleton_id = 1')).undo_json,
    missingTargetEntry,
  );

  console.log('Workflow builder history tests passed.');
} finally {
  await closeDb().catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}
