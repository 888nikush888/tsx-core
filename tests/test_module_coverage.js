import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateModuleCoverage } from '../scripts/check_module_coverage.js';

const repositoryBaseline = JSON.parse(
  readFileSync(new URL('../coverage-baseline.json', import.meta.url), 'utf8'),
);
assert.deepEqual(
  repositoryBaseline.verifiedPlatforms,
  ['linux', 'win32'],
  'The shared ratchet must identify both platforms used to establish its conservative floor.',
);
assert.deepEqual(
  {
    statements: repositoryBaseline.statements,
    branches: repositoryBaseline.branches,
    functions: repositoryBaseline.functions,
    lines: repositoryBaseline.lines,
  },
  { statements: 95.01, branches: 83.33, functions: 99.09, lines: 95.01 },
  'A higher single-platform observation must not replace the verified cross-platform baseline.',
);

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
