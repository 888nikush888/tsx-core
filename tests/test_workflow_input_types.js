import assert from 'node:assert/strict';
import { createWorkflowResourceDraft, validateGraph } from '../src/workflow_repository.js';

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
console.log('Workflow input scalar and graph version checks passed.');
