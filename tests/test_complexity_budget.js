import assert from 'node:assert/strict';
import {
  evaluateComplexityBudget,
  measureEslint,
  measureStructuralMetrics,
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

const structural = measureStructuralMetrics([
  { ruleId: 'complexity', message: "Function 'small' has a complexity of 3. Maximum allowed is 0." },
  { ruleId: 'complexity', message: "Function 'large' has a complexity of 15. Maximum allowed is 0." },
  { ruleId: 'max-lines-per-function', message: "Function 'small' has too many lines (10). Maximum allowed is 0." },
  { ruleId: 'max-lines-per-function', message: "Function 'large' has too many lines (67). Maximum allowed is 0." },
  { ruleId: 'max-depth', message: 'Blocks are nested too deeply (4). Maximum allowed is 1.' },
]);
assert.deepEqual(structural, {
  functionsMeasured: 2,
  averageFunctionLength: 38.5,
  functionsOver30Lines: 1,
  functionsOver50Lines: 1,
  functionsOver100Lines: 0,
  worstFunctionLength: 67,
  averageCyclomaticComplexity: 9,
  worstCyclomaticComplexity: 15,
  maximumNestingDepth: 4,
});

console.log('Complexity budget ratchet tests passed.');
