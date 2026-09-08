import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDatabase } from '../src/db.js';
import { listTradingStrategies } from '../src/trading_repository.js';
import { resolveWorkflowAdaptiveRisk } from '../src/trading_channel_risk.js';
import { validateAdaptiveRiskConfiguration } from '../src/workflow_repository.js';
import { workflowFixture } from './fixtures/ingress_workflow_fixture.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'risk-state-readback-'));
try {
  await initDb(path.join(directory, 'test.db'));
  const fixture = await workflowFixture();
  const resource = await fixture.resource('adaptive_risk', 'Readback policy', { mode: 'fixed' });
  const [strategy] = await listTradingStrategies();
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
