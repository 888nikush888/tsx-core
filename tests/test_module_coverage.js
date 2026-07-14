import assert from 'node:assert/strict';
import { evaluateModuleCoverage } from '../scripts/check_module_coverage.js';

const baseline = { statements: 88, branches: 75, functions: 95, lines: 88 };
const summary = {
  total: {
    statements: { pct: 88 },
    branches: { pct: 75 },
    functions: { pct: 95 },
    lines: { pct: 88 },
  },
};

assert.deepEqual(evaluateModuleCoverage(summary, baseline), {
  violations: [],
  improvements: [],
});
assert.ok(
  evaluateModuleCoverage(
    { ...summary, total: { ...summary.total, branches: { pct: 74.99 } } },
    baseline
  ).violations.some((message) => message.includes('branches coverage regressed'))
);
assert.ok(
  evaluateModuleCoverage(
    { ...summary, total: { ...summary.total, functions: { pct: 96 } } },
    baseline
  ).improvements.some((message) => message.includes('functions'))
);
assert.ok(
  evaluateModuleCoverage(
    { ...summary, total: { ...summary.total, lines: { pct: 'unknown' } } },
    baseline
  ).violations.some((message) => message.includes('lines coverage is missing'))
);

console.log('Module coverage ratchet tests passed.');
