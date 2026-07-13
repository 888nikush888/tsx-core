import assert from 'node:assert/strict';
import {
  evaluateComplexityBudget,
  measureEslint,
} from '../scripts/check_complexity_budget.js';

const messages = [
  { ruleId: 'complexity', severity: 1, message: "Function 'x' has a complexity of 20." },
  { ruleId: 'max-depth', severity: 1, message: 'Blocks are nested too deeply.' },
];
const measurement = measureEslint(messages);
const baseline = {
  eslintWarnings: 2,
  rules: { complexity: 1, 'max-depth': 1, 'max-lines-per-function': 0 },
  worstCyclomaticComplexity: 20,
};
assert.deepEqual(evaluateComplexityBudget(measurement, baseline), []);
assert.ok(
  evaluateComplexityBudget({ ...measurement, warnings: 3 }, baseline).some((message) =>
    message.includes('warning budget regressed')
  )
);
assert.ok(
  evaluateComplexityBudget({ ...measurement, warnings: 1 }, baseline).some((message) =>
    message.includes('lower the baseline')
  )
);

console.log('Complexity budget ratchet tests passed.');
