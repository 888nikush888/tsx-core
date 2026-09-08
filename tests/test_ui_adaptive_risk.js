import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb } from '../src/db.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { uiAdaptiveRisk, copyLegacyRiskPolicy } from '../src/ui_adaptive_risk.js';
import { upsertChannelRiskPolicy, workflowPolicyHash } from '../src/trading_channel_risk.js';
import { createWorkflowResourceDraft, getActiveWorkflow, publishWorkflowResource, saveWorkflowRevision } from '../src/workflow_repository.js';
import { moneyValueFromDecimal } from '../src/trading_money_value.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-ui-adaptive-'));
const read = values => uiAdaptiveRisk(new URLSearchParams(values));
const configuration = { enabled: true, mode: 'automatic', tiers: [{ riskPercent: '0.1' }, { riskPercent: '0.2' }], startingTier: 0, lockedTier: null,
  lookbackWeeks: 1, minimumClosedTrades: 5, lossThresholdPercent: '2', profitThresholdPercent: '3', weakChannelAction: 'block', weakWeeksBeforeBlock: 2, manuallyBlocked: false };
async function evaluationFixture(db, resource) {
  const stateKey = '1'.repeat(64); const hash = workflowPolicyHash(resource.configuration); const now = Date.now() - 1000;
  await db.run(`INSERT INTO workflow_adaptive_risk_state(state_key,channel_id,account_id,resource_id,current_tier,locked_tier,blocked,block_reason,policy_sha256,updated_at)
    VALUES (?,'adaptive-ui','paper-default',?,0,NULL,1,'Original money source changed',?,?)`, [stateKey, resource.resourceId, hash, now]);
  const source = { scope: { channelId: 'adaptive-ui', accountId: 'paper-default', since: 0, until: 1000 },
    capital: { equity: '10000', reportingCurrency: 'USDT', basis: 'current_bound_input', fingerprint: 'PRIVATE_IDENTITY', generation: 'PRIVATE_GENERATION' },
    positions: Array.from({ length: 55 }, (_, index) => ({ id: `position-${index}`, intentId: `intent-${index}`, closedAt: 900, projectionHash: 'original-projection', valuationHash: 'original-valuation' })) };
  const original = JSON.stringify(source); const sourceHash = createHash('sha256').update(original).digest('hex');
  for (let index = 0; index < 55; index++) await db.run(`INSERT INTO workflow_adaptive_risk_evaluations(id,state_key,policy_sha256,week_started_at,week_ended_at,
    closed_trades,wins,losses,realized_pnl,starting_equity,return_percent,previous_tier,recommended_tier,applied_tier,action,reason,created_at,
    realized_pnl_value_json,reporting_currency,source_hash,source_json,invalidated_at,invalidation_reason)
    VALUES (?,?,?,?,?,5,2,3,?,'10000',NULL,0,1,0,'hold','RISK_PRECISION_UNCERTAIN',?,?,'USDT',?,?,?,'A recorded money source changed')`,
  [`evaluation-${String(index).padStart(3, '0')}`, stateKey, hash, index, index + 1, '-0.000000000000000001', now,
    JSON.stringify(moneyValueFromDecimal('-0.000000000000000001')), sourceHash, original, now]);
  return { stateKey, hash, sourceHash };
}
async function testReadEvidence(db, resource) {
  const fixture = await evaluationFixture(db, resource); const originalState = await db.all('SELECT * FROM workflow_adaptive_risk_state');
  const originalEvaluations = await db.all('SELECT * FROM workflow_adaptive_risk_evaluations');
  const state = await read({ stateKey: fixture.stateKey });
  assert.equal(state.entries[0].currentTier, 0); assert.equal(state.entries[0].lockedTier, null); assert.equal(state.entries[0].blocked, true);
  assert.equal(state.entries[0].latestEvaluationId, 'evaluation-054');
  const first = await read({ kind: 'evaluations', stateKey: fixture.stateKey, limit: '50' });
  const last = await read({ kind: 'evaluations', stateKey: fixture.stateKey, limit: '50', cursor: first.nextCursor });
  assert.equal(first.entries.length, 50); assert.equal(last.entries.length, 5);
  assert.equal(new Set([...first.entries, ...last.entries].map(row => row.id)).size, 55);
  assert.equal(first.entries[0].realizedPnlValue.decimal, '-0.000000000000000001'); assert.equal(first.entries[0].returnPercentValue, null);
  assert.equal(first.entries[0].policySha256, fixture.hash); assert.equal(first.entries[0].matchesCurrentStatePolicy, true);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE_|fingerprint|generation|positions/);
  await db.run('UPDATE workflow_adaptive_risk_state SET policy_sha256=?', ['f'.repeat(64)]);
  assert.equal((await read({ kind: 'evaluations', id: 'evaluation-054' })).entries[0].matchesCurrentStatePolicy, false, 'Never relabel an old evaluation with the current policy.');
  await db.run('UPDATE workflow_adaptive_risk_state SET policy_sha256=?', [fixture.hash]);
  await assert.rejects(read({ kind: 'evaluations', accountId: 'other', limit: '50', cursor: first.nextCursor }), /match/);
  const sources = await read({ kind: 'sources', id: 'evaluation-054', limit: '50' });
  const sourcesNext = await read({ kind: 'sources', id: 'evaluation-054', limit: '50', cursor: sources.nextCursor });
  assert.equal(sources.entries.length, 50); assert.equal(sourcesNext.entries.length, 5);
  assert.equal(sources.integrityVerified, true); assert.equal(sources.sourceHash, fixture.sourceHash); assert.doesNotMatch(JSON.stringify(sources), /PRIVATE_|fingerprint|generation/);
  await assert.rejects(read({ kind: 'sources', id: 'evaluation-053', limit: '50', cursor: sources.nextCursor }), /match/);
  assert.equal((await read({ kind: 'paths', stateKey: fixture.stateKey })).entries.length, 0);
  assert.equal(await read({ kind: 'sources', id: 'absent' }), null);
  await assert.rejects(read({ kind: 'constructor' }), /Unsupported/); await assert.rejects(read({ limit: '51' }), /1–50/u);
  assert.deepEqual(await db.all('SELECT * FROM workflow_adaptive_risk_state'), originalState);
  assert.deepEqual(await db.all('SELECT * FROM workflow_adaptive_risk_evaluations'), originalEvaluations, 'UI reads must never evaluate or invalidate an original observation.');
}
async function testLegacyCopy(db) {
  await upsertChannelRiskPolicy({ ...configuration, channelId: 'old-channel', currentTier: 0 });
  await db.run("UPDATE trading_channel_risk_policies SET blocked=1,block_reason='Automatic legacy block' WHERE channel_id='old-channel'");
  const before = await db.get("SELECT * FROM trading_channel_risk_policies WHERE channel_id='old-channel'"); const active = await getActiveWorkflow();
  const preview = (await read({ kind: 'legacy', channelId: 'old-channel' })).entries[0];
  assert.equal(preview.configuration.manuallyBlocked, true, 'Migration must retain an existing automatic block as an explicit manual policy block.');
  assert.equal(preview.configuration.lockedTier, null); assert.equal(preview.configuration.startingTier, 0);
  await assert.rejects(copyLegacyRiskPolicy({ channelId: 'old-channel', copyHash: 'stale' }), /changed/);
  const first = await copyLegacyRiskPolicy({ channelId: 'old-channel', copyHash: preview.copyHash });
  const repeat = await copyLegacyRiskPolicy({ channelId: 'old-channel', copyHash: preview.copyHash });
  assert.equal(first.resource.status, 'draft'); assert.equal(first.activated, false); assert.equal(repeat.alreadyCopied, true); assert.equal(repeat.resource.id, first.resource.id);
  assert.equal((await read({ kind: 'legacy', channelId: 'old-channel' })).entries[0].copiedVersionId, first.resource.id);
  assert.deepEqual(await db.get("SELECT * FROM trading_channel_risk_policies WHERE channel_id='old-channel'"), before); assert.deepEqual(await getActiveWorkflow(), active);
}
async function testActivePathHashes(db, resource) {
  await publishWorkflowResource(resource.id);
  const revision = await saveWorkflowRevision({ baseRevisionId: null, graph: { schemaVersion: 3, nodes: [], edges: [] }, actorId: 'test:admin' });
  const strategy = await db.get("SELECT id FROM trading_strategy_versions WHERE status='published' LIMIT 1");
  for (let index = 0; index < 55; index++) await db.run(`INSERT INTO workflow_execution_paths(id,workflow_revision_id,path_key,channel_id,account_id,strategy_version_id,
    adaptive_risk_resource_version_id,node_ids_json,effective_configuration_json,created_at,route_group_key,fallback_rank,fallback_on_json)
    VALUES (?,?,?,'adaptive-ui','paper-default',?,?,'[]','{}',1000,'adaptive-group',0,'[]')`,
  [`adaptive-path-${String(index).padStart(3, '0')}`, revision.id, createHash('sha256').update(String(index)).digest('hex'), strategy.id, resource.id]);
  const first = await read({ kind: 'paths', stateKey: '1'.repeat(64), limit: '50' });
  const second = await read({ kind: 'paths', stateKey: '1'.repeat(64), limit: '50', cursor: first.nextCursor });
  assert.equal(first.entries.length, 50); assert.equal(second.entries.length, 5);
  assert.ok([...first.entries, ...second.entries].every(row => row.matchesStoredState && row.policySha256 === workflowPolicyHash(resource.configuration) && row.resource.id === resource.id));
  await db.run("UPDATE workflow_adaptive_risk_state SET policy_sha256=? WHERE state_key=?", ['0'.repeat(64), '1'.repeat(64)]);
  assert.equal((await read({ kind: 'paths', stateKey: '1'.repeat(64) })).entries[0].matchesStoredState, false);
  await db.run("UPDATE workflow_adaptive_risk_state SET policy_sha256=? WHERE state_key=?", [workflowPolicyHash(resource.configuration), '1'.repeat(64)]);
  await db.run("DELETE FROM workflow_execution_paths WHERE id LIKE 'adaptive-path-%'");
}
try {
  await initDb(path.join(directory, 'test.db')); await seedTradingFixtures();
  const resource = await createWorkflowResourceDraft({ kind: 'adaptive_risk', name: 'Original policy', configuration });
  await testReadEvidence(getDatabase(), resource); await testActivePathHashes(getDatabase(), resource); await testLegacyCopy(getDatabase());
  console.log('Adaptive original evidence, pagination, exact amounts and reviewed Legacy draft migration passed.');
} finally { await closeDb(); await rm(directory, { recursive: true, force: true }); }
