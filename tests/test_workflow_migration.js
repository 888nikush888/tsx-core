import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb } from '../src/db.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import {
  listTradingAccounts,
  listTradingStrategies,
  setTradingRoute,
} from '../src/trading_repository.js';
import {
  getActiveWorkflow,
  getWorkflowBuilderHistoryStatus,
  migrateLegacyTradingRoutesToWorkflow,
  previewWorkflowImpact,
  WORKFLOW_IMPACT_CONFIRMATION,
} from '../src/workflow_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-workflow-migration-'));
try {
  await initDb(path.join(directory, 'forwarder.db'));
  await seedTradingFixtures();
  const [account] = await listTradingAccounts();
  const [strategy] = await listTradingStrategies();
  await setTradingRoute({
    channelId: '-1002255000000', strategyVersionId: strategy.id, accountId: account.id, enabled: true,
  });
  const config = structuredClone(DEFAULT_CONFIG);
  config.sourceChannels = ['-1002255000000'];
  config.sourceAliases['-1002255000000'] = 'Migrated VIP';
  config.sourceFilters['-1002255000000'] = { regexPatterns: ['(?:LONG|SHORT)'] };
  config.filters.allowedTypes = ['text'];
  config.xmlParsing.enabled = true;
  config.xmlParsing.saveToFile = true;
  config.xmlParsing.aiLimits.requestTimeoutMs = 120_000;

  await getDatabase().run(
    `UPDATE workflow_builder_history SET undo_json = ?, redo_json = ?, updated_at = ? WHERE singleton_id = 1`,
    [JSON.stringify([{ revisionId: null, label: 'Vor Legacy-Migration', capturedAt: Date.now() }]), '[]', Date.now()],
  );
  assert.equal((await getWorkflowBuilderHistoryStatus()).undoCount, 1);

  const migrated = await migrateLegacyTradingRoutesToWorkflow(config);
  assert.deepEqual(migrated, { migrated: true, paths: 1, skipped: [] });
  const active = await getActiveWorkflow();
  assert.ok(active);
  assert.equal(active.compiled.paths.length, 1);
  assert.deepEqual(
    active.graph.nodes.map(node => node.kind),
    ['channel', 'content_filter', 'keyword_filter', 'regex', 'parser', 'schema', 'contract', 'dedupe', 'strategy', 'sizing', 'account', 'output'],
  );
  const resources = active.compiled.paths[0].effectiveConfiguration.resources;
  assert.equal(resources.parser.timeoutMs, 120_000);
  assert.equal(resources.parser.saveToFile, false);
  assert.match(resources.parser.prompt, /Extract a cryptocurrency trading signal/);
  assert.deepEqual(resources.regex.patterns, ['(?:LONG|SHORT)']);
  assert.equal(resources.output.mode, 'telegram_original');
  assert.equal((await getWorkflowBuilderHistoryStatus()).undoCount, 0,
    'A successful legacy migration must invalidate pre-migration builder history.');

  assert.deepEqual(
    await migrateLegacyTradingRoutesToWorkflow(config),
    { migrated: false, paths: 0, skipped: [] },
  );

  const moved = structuredClone(active.graph);
  moved.nodes[0].position.y += 100;
  const harmless = await previewWorkflowImpact({ baseRevisionId: active.id, graph: moved });
  assert.equal(harmless.destructive, false);
  assert.equal(harmless.confirmation, null);

  const removed = structuredClone(active.graph);
  removed.nodes = [];
  removed.edges = [];
  const destructive = await previewWorkflowImpact({ baseRevisionId: active.id, graph: removed });
  assert.equal(destructive.destructive, true);
  assert.equal(destructive.removed.length, 1);
  assert.equal(destructive.confirmation, WORKFLOW_IMPACT_CONFIRMATION);
  console.log('Legacy workflow migration and impact tests passed.');
} finally {
  await closeDb().catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}
