import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
  { statements: 96.21, branches: 86.23, functions: 99.19, lines: 96.21 },
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

async function runCoverageCli(childStatus, fixtureSummary, fixtureBaseline) {
  const directory = await mkdtemp(path.join(tmpdir(), 'tsx-coverage-cli-'));
  try {
    await Promise.all(['scripts', 'node_modules/c8/bin', 'coverage-modules'].map(
      (relative) => mkdir(path.join(directory, relative), { recursive: true }),
    ));
    await Promise.all([
      writeFile(path.join(directory, 'package.json'), '{"type":"module"}'),
      writeFile(path.join(directory, 'scripts/check_module_coverage.js'),
        readFileSync(new URL('../scripts/check_module_coverage.js', import.meta.url))),
      writeFile(path.join(directory, 'node_modules/c8/bin/c8.js'), `process.exitCode = ${childStatus};`),
      writeFile(path.join(directory, 'coverage-modules/coverage-summary.json'), fixtureSummary),
      writeFile(path.join(directory, 'coverage-baseline.json'), fixtureBaseline),
    ]);
    const result = spawnSync(process.execPath, ['scripts/check_module_coverage.js'], {
      cwd: directory, encoding: 'utf8', timeout: 15_000, shell: false,
    });
    assert.equal(result.error);
    assert.equal(result.signal, null);
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const failedChild = await runCoverageCli(7, 'invalid stale summary', 'invalid stale baseline');
assert.equal(failedChild.status, 7, 'Preserve the failed test runner status.');
assert.equal(failedChild.stdout, '', 'Failed tests must not report coverage success.');
assert.equal(failedChild.stderr, '', 'Failed tests must return before parsing stale reports.');

const passedCli = await runCoverageCli(0, JSON.stringify(summary), JSON.stringify(baseline));
assert.equal(passedCli.status, 0);
assert.match(passedCli.stdout, /Module coverage ratchet passed\./u);
assert.equal(passedCli.stderr, '');

const regressedSummary = { ...summary, total: { ...summary.total, branches: { pct: 74 } } };
const regressedCli = await runCoverageCli(0, JSON.stringify(regressedSummary), JSON.stringify(baseline));
assert.equal(regressedCli.status, 1);
assert.match(regressedCli.stderr, /branches coverage regressed: measured 74%, baseline 75%/u);
assert.doesNotMatch(regressedCli.stdout, /ratchet passed/u);

console.log('Module coverage ratchet tests passed.');
