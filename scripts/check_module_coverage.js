import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const metricNames = ['statements', 'branches', 'functions', 'lines'];

function evaluateMetric(metric, actual, minimum) {
  const violations = [];
  const improvements = [];
  if (!Number.isFinite(actual) || !Number.isFinite(minimum)) {
    violations.push(`${metric} coverage is missing or invalid`);
  } else if (actual < minimum) {
    violations.push(`${metric} coverage regressed: measured ${actual}%, baseline ${minimum}%`);
  } else if (actual > minimum) {
    improvements.push(`${metric}: ${minimum}% -> ${actual}%`);
  }
  return { violations, improvements };
}

export function evaluateModuleCoverage(summary, baseline) {
  const metrics = metricNames.map((metric) => evaluateMetric(
    metric, Number(summary?.total?.[metric]?.pct), Number(baseline?.[metric]),
  ));
  return {
    violations: metrics.flatMap((metric) => metric.violations),
    improvements: metrics.flatMap((metric) => metric.improvements),
  };
}

function reportCoverage({ violations, improvements }) {
  for (const improvement of improvements) {
    console.log(`COVERAGE IMPROVEMENT: ${improvement}; raise the baseline in this change.`);
  }
  if (violations.length > 0) {
    for (const violation of violations) console.error(`MODULE COVERAGE VIOLATION: ${violation}`);
    process.exitCode = 1;
  } else {
    console.log('Module coverage ratchet passed.');
  }
}

async function main() {
  const c8 = path.join(root, 'node_modules', 'c8', 'bin', 'c8.js');
  const result = spawnSync(
    process.execPath,
    [c8, '--config', 'c8.modules.json', 'node', 'tests/run_all.js'],
    {
      cwd: root,
      env: { ...process.env, TSX_MODULE_COVERAGE_WORKERS: '4' },
      stdio: 'inherit',
      shell: false,
      // Include coverage report generation after the complete test suite finishes.
      timeout: 600_000,
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status || 1;
    return;
  }

  const [summary, baseline] = await Promise.all([
    readFile(path.join(root, 'coverage-modules', 'coverage-summary.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'coverage-baseline.json'), 'utf8').then(JSON.parse),
  ]);
  reportCoverage(evaluateModuleCoverage(summary, baseline));
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  await main();
}
