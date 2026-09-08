import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDatabase } from '../src/db.js';
import { listTradingStrategies } from '../src/trading_repository.js';
import { resolveWorkflowAdaptiveRisk, upsertChannelRiskPolicy, resolveEffectiveChannelRisk } from '../src/trading_channel_risk.js';
import { validateAdaptiveRiskConfiguration } from '../src/workflow_repository.js';
import { workflowFixture } from './fixtures/ingress_workflow_fixture.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'risk-state-readback-'));
try {
  await initDb(path.join(directory, 'test.db'));
  const fixture = await workflowFixture();
  const resource = await fixture.resource('adaptive_risk', 'Readback policy', { mode: 'fixed' });
  const [strategy] = await listTradingStrategies();
  const policy = { channelId: '-1001', mode: 'fixed', tiers: [{ riskPercent: '1' }], currentTier: 0,
    lookbackWeeks: 1, minimumClosedTrades: 5, lossThresholdPercent: '2', profitThresholdPercent: '2',
    weakChannelAction: 'reduce', weakWeeksBeforeBlock: 3 };
  let coercions = 0;
  await assert.rejects(upsertChannelRiskPolicy({ ...policy,
    tiers: [{ riskPercent: { toString() { coercions += 1; return '1'; } } }] }), /must be a decimal number/);
  assert.equal(coercions, 0, 'Tier input objects must never supply numeric values through coercion.');
  const createdPolicy = await upsertChannelRiskPolicy({ ...policy, tiers: [{ riskPercent: 1 }, { riskPercent: '2' }] });
  assert.deepEqual(createdPolicy.tiers, [{ riskPercent: '1' }, { riskPercent: '2' }]);
  await getDatabase().run('UPDATE trading_channel_risk_policies SET tiers_json = ? WHERE channel_id = ?', ['[]', policy.channelId]);
  await assert.rejects(resolveEffectiveChannelRisk({ channelId: policy.channelId,
    strategy: strategy.configuration, currentEquity: '10000' }), /between one and twenty tiers/);

  const request = { channelId: '-1001', accountId: 'paper-default', adaptiveResourceVersionId: resource.id,
    configuration: validateAdaptiveRiskConfiguration({ mode: 'fixed' }), strategy: strategy.configuration,
    currentEquity: '10000' };
  const db = getDatabase();
  const originalGet = db.get;
  try {
    db.get = function (sql, ...parameters) {
      if (sql === 'SELECT * FROM workflow_adaptive_risk_state WHERE state_key = ?') return Promise.resolve(undefined);
      return originalGet.call(this, sql, ...parameters);
    };
    await assert.rejects(resolveWorkflowAdaptiveRisk(request), /state is missing after persistence/);
  } finally { db.get = originalGet; }
  assert.equal((await db.get('SELECT COUNT(*) AS count FROM workflow_adaptive_risk_state')).count, 0,
    'Missing create readback must roll back the risk state.');
  const valid = await resolveWorkflowAdaptiveRisk(request);
  assert.equal(valid.blocked, false);
  const before = await db.get('SELECT * FROM workflow_adaptive_risk_state');
  let reads = 0;
  try {
    db.get = function (sql, ...parameters) {
      if (sql === 'SELECT * FROM workflow_adaptive_risk_state WHERE state_key = ?' && ++reads === 2) return Promise.resolve(undefined);
      return originalGet.call(this, sql, ...parameters);
    };
    await assert.rejects(resolveWorkflowAdaptiveRisk({ ...request,
      configuration: { ...request.configuration, manuallyBlocked: true } }), /state is missing after persistence/);
  } finally { db.get = originalGet; }
  assert.deepEqual(await db.get('SELECT * FROM workflow_adaptive_risk_state'), before,
    'Missing update readback must roll back policy hash, tier and blocked state together.');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
console.log('Workflow risk create/update readback failures roll back complete state.');
