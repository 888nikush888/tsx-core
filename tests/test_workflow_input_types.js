import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { workflowFixture } from './fixtures/ingress_workflow_fixture.js';
import assert from 'node:assert/strict';
import { createWorkflowResourceDraft, createWorkflowTradingIntents, validateGraph, validateAdaptiveRiskConfiguration } from '../src/workflow_repository.js';

// The execution consumer reuses the publishing contract, including enum and scalar checks.
for (const invalid of [null, [], "invalid", { mode: "outside" }, { weakChannelAction: "outside" },
  { enabled: "false" }, { tiers: [] }, { startingTier: 99 }, { lookbackWeeks: 0 }]) {
  assert.throws(() => validateAdaptiveRiskConfiguration(invalid));
}
const adaptive = validateAdaptiveRiskConfiguration({ mode: "shadow", tiers: [{ riskPercent: "1" }] });
assert.equal(adaptive.mode, "shadow");
assert.equal(adaptive.enabled, true);
assert.equal(adaptive.startingTier, 0);
assert.equal(adaptive.lockedTier, null);
assert.deepEqual(validateAdaptiveRiskConfiguration(adaptive), adaptive,
  "Published normalized risk configuration must retain its values during execution validation.");

let coercions = 0;
const numericObject = { trim() { coercions += 1; return '1'; } };
for (const field of ['riskPerTradePercent', 'maxAdaptiveRiskPercent', 'maxPositionNotional']) {
  await assert.rejects(createWorkflowResourceDraft({
    kind: 'sizing', name: 'Invalid scalar',
    configuration: { riskPerTradePercent: '1', [field]: numericObject },
  }), /must be a string/);
}
for (const field of ['lossThresholdPercent', 'profitThresholdPercent']) {
  await assert.rejects(createWorkflowResourceDraft({
    kind: 'adaptive_risk', name: 'Invalid threshold', configuration: { [field]: numericObject },
  }), /must be a string/);
}
await assert.rejects(createWorkflowResourceDraft({
  kind: 'adaptive_risk', name: 'Invalid tier', configuration: { tiers: [{ riskPercent: numericObject }] },
}), /must be a string/);
assert.equal(coercions, 0, 'Numeric fields must never call methods supplied by an input object.');
for (const schemaVersion of ['1', {}, null, 4]) {
  assert.throws(() => validateGraph({ schemaVersion, nodes: [], edges: [] }), /contract is invalid/);
}
for (const schemaVersion of [1, 2, 3]) {
  assert.deepEqual(validateGraph({ schemaVersion, nodes: [], edges: [] }), { schemaVersion, nodes: [], edges: [] });
}
const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-readback-'));
try {
  await initDb(path.join(directory, 'test.db'));
  const { first } = await workflowFixture();
  await saveSignal('missing-run', '-1001', 1, '<signal/>', '<signal/>');
  const database = getDatabase();
  const originalGet = database.get;
  try {
    database.get = function (sql, ...parameters) {
      if (String(sql) === 'SELECT id, created_at FROM workflow_signal_runs WHERE source_signal_id = ? AND workflow_revision_id = ?') {
        return Promise.resolve(undefined);
      }
      return originalGet.call(this, sql, ...parameters);
    };
    await assert.rejects(createWorkflowTradingIntents({
      sourceSignalId: 'missing-run', channelId: '-1001', sourceText: 'BTCUSDT LONG', workflowRevisionId: first.id,
      signal: { schema: 'standard', action: 'LONG', symbol: 'BTCUSDT', entry: { type: 'market' },
        targets: [{ min: '110', max: '110' }], stopLoss: '90' },
    }), /Created workflow signal run is missing/);
  } finally {
    database.get = originalGet;
  }
  assert.equal((await database.get('SELECT COUNT(*) AS count FROM workflow_signal_runs WHERE source_signal_id = ?', ['missing-run'])).count, 0,
    'A missing post-write run must roll back the created row.');
  assert.equal((await database.get('SELECT COUNT(*) AS count FROM trading_trade_intents WHERE source_signal_id = ?', ['missing-run'])).count, 0,
    'No partial trade intent may escape the failed transaction.');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
console.log('Workflow scalar, graph and transactional readback checks passed.');
