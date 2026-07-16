import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function evaluateComplexityBudget(measurement, baseline) {
  const violations = [];
  if (measurement.errors > 0) violations.push(`ESLint reported ${measurement.errors} error(s)`);
  if (measurement.warnings !== baseline.eslintWarnings) {
    const direction = measurement.warnings > baseline.eslintWarnings ? 'regressed' : 'improved';
    violations.push(
      `warning budget ${direction}: measured ${measurement.warnings}, baseline ${baseline.eslintWarnings}; update code or lower the baseline`
    );
  }
  for (const [rule, expected] of Object.entries(baseline.rules)) {
    const actual = measurement.rules[rule] ?? 0;
    if (actual !== expected) {
      const direction = actual > expected ? 'regressed' : 'improved';
      violations.push(
        `${rule} budget ${direction}: measured ${actual}, baseline ${expected}; update code or lower the baseline`
      );
    }
  }
  if (measurement.worstCyclomaticComplexity !== baseline.worstCyclomaticComplexity) {
    const direction =
      measurement.worstCyclomaticComplexity > baseline.worstCyclomaticComplexity
        ? 'regressed'
        : 'improved';
    violations.push(
      `worst complexity ${direction}: measured ${measurement.worstCyclomaticComplexity}, baseline ${baseline.worstCyclomaticComplexity}; update code or lower the baseline`
    );
  }
  return violations;
}

export function measureEslint(messages) {
  const complexityValues = messages
    .filter((message) => message.ruleId === 'complexity')
    .map((message) => Number(message.message.match(/complexity of (\d+)/)?.[1]))
    .filter(Number.isFinite);
  const rules = Object.fromEntries(
    ['complexity', 'max-depth', 'max-lines-per-function'].map((rule) => [
      rule,
      messages.filter((message) => message.ruleId === rule).length,
    ])
  );
  return {
    errors: messages.filter((message) => message.severity === 2).length,
    warnings: messages.filter((message) => message.severity === 1).length,
    rules,
    worstCyclomaticComplexity: complexityValues.length > 0 ? Math.max(...complexityValues) : 0,
  };
}

export function measureStructuralMetrics(messages) {
  const extract = (ruleId, pattern) => messages
    .filter((message) => message.ruleId === ruleId)
    .map((message) => Number(message.message.match(pattern)?.[1]))
    .filter(Number.isFinite);
  const complexities = extract('complexity', /complexity of (\d+)/);
  const functionLengths = extract('max-lines-per-function', /too many lines \((\d+)\)/);
  const nestingDepths = extract('max-depth', /deeply \((\d+)\)/);
  const average = (values) => values.length > 0
    ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2))
    : 0;
  return {
    functionsMeasured: functionLengths.length,
    averageFunctionLength: average(functionLengths),
    functionsOver30Lines: functionLengths.filter((value) => value > 30).length,
    functionsOver50Lines: functionLengths.filter((value) => value > 50).length,
    functionsOver100Lines: functionLengths.filter((value) => value > 100).length,
    worstFunctionLength: Math.max(0, ...functionLengths),
    averageCyclomaticComplexity: average(complexities),
    worstCyclomaticComplexity: Math.max(0, ...complexities),
    maximumNestingDepth: Math.max(1, ...nestingDepths),
  };
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  const result = spawnSync(
    process.execPath,
    [
      'node_modules/eslint/bin/eslint.js',
      'src/**/*.ts',
      'tests/**/*.js',
      'scripts/**/*.js',
      '*.js',
      '--format',
      'json',
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, shell: false }
  );
  if (result.error) throw result.error;
  if (!result.stdout) throw new Error(result.stderr || 'ESLint produced no JSON report.');
  const messages = JSON.parse(result.stdout).flatMap((report) => report.messages);
  const measurement = measureEslint(messages);
  const structuralResult = spawnSync(
    process.execPath,
    [
      'node_modules/eslint/bin/eslint.js',
      'src/**/*.ts',
      '--format',
      'json',
      '--rule',
      'complexity: [1, 0]',
      '--rule',
      'max-lines-per-function: [1, {"max": 0, "skipBlankLines": true, "skipComments": true}]',
      '--rule',
      'max-depth: [1, 1]',
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, shell: false }
  );
  if (structuralResult.error) throw structuralResult.error;
  if (!structuralResult.stdout) throw new Error(structuralResult.stderr || 'ESLint produced no structural metrics.');
  const structuralMessages = JSON.parse(structuralResult.stdout).flatMap((report) => report.messages);
  const structural = measureStructuralMetrics(structuralMessages);
  measurement.worstCyclomaticComplexity = structural.worstCyclomaticComplexity;
  const baseline = JSON.parse(await readFile(path.join(root, 'quality-baseline.json'), 'utf8'));
  const violations = evaluateComplexityBudget(measurement, baseline);
  if (violations.length > 0) {
    for (const violation of violations) console.error(`COMPLEXITY BUDGET VIOLATION: ${violation}`);
    process.exitCode = 1;
  } else {
    console.log(
      `Complexity budget passed (${measurement.warnings} warnings, ${measurement.rules.complexity} threshold violations; ` +
      `cyclomatic avg/worst ${structural.averageCyclomaticComplexity}/${structural.worstCyclomaticComplexity}; ` +
      `function LOC avg/worst ${structural.averageFunctionLength}/${structural.worstFunctionLength}; ` +
      `>30/>50/>100 LOC ${structural.functionsOver30Lines}/${structural.functionsOver50Lines}/${structural.functionsOver100Lines}; ` +
      `max nesting ${structural.maximumNestingDepth}).`
    );
  }
}
