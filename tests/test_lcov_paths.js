import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeLcov } from '../scripts/normalize_lcov_paths.js';

const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'lcov-paths-'));
try {
  const sourceRoot = path.join(repositoryRoot, 'frontend');
  await mkdir(path.join(sourceRoot, 'src'), { recursive: true });
  await writeFile(path.join(sourceRoot, 'src', 'app.tsx'), 'export const app = 1;');
  const record = 'TN:\r\nSF:src/app.tsx\r\nDA:1,1\r\nLF:1\r\nLH:1\r\nend_of_record\r\n';
  const normalized = await normalizeLcov(record, { repositoryRoot, sourceRoot });
  assert.equal(normalized, record.replaceAll('\r\n', '\n').replace('SF:src/', 'SF:frontend/src/'));
  const absolute = record.replace('src/app.tsx', path.join(sourceRoot, 'src', 'app.tsx'));
  assert.equal(await normalizeLcov(absolute, { repositoryRoot, sourceRoot }), normalized);
  const windowsSeparators = record.replace('src/app.tsx', 'src\\app.tsx');
  assert.equal(await normalizeLcov(windowsSeparators, { repositoryRoot, sourceRoot }), normalized);
  for (const invalid of ['TN:\n', 'SF:\n', 'SF:../../outside.ts\n', 'SF:src/missing.ts\n', 'SF:src\n']) {
    await assert.rejects(normalizeLcov(invalid, { repositoryRoot, sourceRoot }));
  }
  const coverageConfig = await readFile('.coveragerc', 'utf8');
  assert.match(coverageConfig, /source = exchange_executor/u);
  assert.match(coverageConfig, /\*\/tests\/\*/u);
  assert.match(coverageConfig, /\*\/test_\*\.py/u);
  assert.match(coverageConfig, /fail_under = 60/u);
  const workflow = await readFile('.github/workflows/quality.yml', 'utf8');
  assert.equal(workflow.match(/unittest discover -s exchange_executor\/tests -v/gu).length, 2);
  assert.match(workflow, /node scripts\/normalize_lcov_paths\.js/u);
  const sonarCoverageCommand = workflow.split(/\r?\n/u).find(line => line.includes('./node_modules/.bin/c8 --all'));
  assert.match(sonarCoverageCommand, /--include="src\/\*\*\/\*\.ts"/u);
  assert.doesNotMatch(sonarCoverageCommand, /scripts\/\*\*\/\*\.js/u, 'Sonar LCOV must not add tooling outside the existing product source scope.');
  assert.match(sonarCoverageCommand, /node tests\/run_all\.js$/u, 'Coverage scope must not change complete test execution.');
  assert.match(workflow, /pull_request:\s+branches: \[main\]/u);
  assert.doesNotMatch(workflow, /pull_request_target/u);
  assert.match(workflow, /TRUSTED_SOURCE:/u);
  assert.match(workflow, /SONAR_EXPECTED_REVISION: \$\{\{ github.event.pull_request.head.sha \|\| github.sha \}\}/u);
  const codacyJob = workflow.split('  codacy_coverage:\n')[1]?.split('\n  mutation:')[0];
  assert.ok(codacyJob, 'Codacy must receive coverage from the exact tested source revision.');
  assert.match(codacyJob, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/u,
    'Coverage credentials must not be available to fork pull requests.');
  assert.match(codacyJob, /ref: \$\{\{ env\.CODACY_EXPECTED_REVISION \}\}/u);
  assert.match(codacyJob, /name: sonarcloud-evidence-\$\{\{ env\.CODACY_EXPECTED_REVISION \}\}/u);
  for (const report of ['coverage/lcov.info', 'coverage/b2-backup-gateway/lcov.info',
    'frontend/coverage/lcov.info', 'exchange_executor/coverage.xml']) {
    assert.ok(codacyJob.split(/\r?\n/u).some(line => line.trim() === `test -s ${report}`),
      `${report}: missing exact coverage-report check`);
  }
  assert.match(codacyJob, /secrets\.CODACY_PROJECT_TOKEN/u);
  assert.doesNotMatch(codacyJob, /secrets\.CODACY_API_TOKEN|--api-token|--project-token/u,
    'Only the repository-scoped token may authenticate coverage uploads.');
  assert.match(codacyJob, /sha512sum --check --status/u);
  assert.ok(codacyJob.includes('--prefix exchange_executor/ --force-coverage-parser cobertura -r exchange_executor/coverage.xml'),
    'Cobertura filenames must retain the exchange_executor/ separator when uploaded.');
  assert.match(codacyJob, /final --commit-uuid "\$CODACY_EXPECTED_REVISION"/u);
  const reportRoot = path.join(repositoryRoot, 'codacy-reports');
  await mkdir(path.join(reportRoot, 'coverage'), { recursive: true });
  await mkdir(path.join(reportRoot, 'coverage', 'b2-backup-gateway'), { recursive: true });
  await mkdir(path.join(reportRoot, 'frontend', 'coverage'), { recursive: true });
  await mkdir(path.join(reportRoot, 'exchange_executor'), { recursive: true });
  const backendReport = path.join(reportRoot, 'coverage', 'lcov.info');
  const gatewayReport = path.join(reportRoot, 'coverage', 'b2-backup-gateway', 'lcov.info');
  const pythonReport = path.join(reportRoot, 'exchange_executor', 'coverage.xml');
  await writeFile(backendReport, 'SF:src/alert_relay.ts\nDA:1,1\nend_of_record\n');
  await writeFile(gatewayReport, 'SF:services/b2-backup-gateway/gateway.js\nDA:1,1\nend_of_record\n');
  await writeFile(path.join(reportRoot, 'frontend', 'coverage', 'lcov.info'),
    'SF:frontend/src/app/operator-app.tsx\nDA:1,1\nend_of_record\n');
  await writeFile(pythonReport, '<coverage><packages><package><classes><class filename="account_log_reader.py"/></classes></package></packages></coverage>');
  const checkCodacyPaths = () => spawnSync('python', ['scripts/verify_codacy_coverage_paths.py', '--report-root', reportRoot],
    { encoding: 'utf8', windowsHide: true });
  assert.equal(checkCodacyPaths().status, 0, 'All four real repository path forms must validate.');
  await writeFile(gatewayReport, 'SF:services/b2-backup-gateway/../untracked.js\nDA:1,1\nend_of_record\n');
  assert.notEqual(checkCodacyPaths().status, 0, 'A gateway path outside tracked source must fail before upload.');
  await writeFile(gatewayReport, 'SF:services/b2-backup-gateway/gateway.js\nDA:1,1\nend_of_record\n');
  await writeFile(backendReport, 'SF:src/../untracked.ts\nDA:1,1\nend_of_record\n');
  assert.notEqual(checkCodacyPaths().status, 0, 'A path outside tracked source must fail before upload.');
  await writeFile(backendReport, 'SF:src/alert_relay.ts\nDA:1,1\nend_of_record\n');
  await writeFile(pythonReport, '<coverage><packages><package><classes><class filename="untracked.py"/></classes></package></packages></coverage>');
  assert.notEqual(checkCodacyPaths().status, 0, 'A stale Python class path must fail before upload.');
  await writeFile(pythonReport, '<!DOCTYPE coverage [<!ENTITY x SYSTEM "file:///etc/passwd">]><coverage><class filename="account_log_reader.py"/></coverage>');
  assert.notEqual(checkCodacyPaths().status, 0, 'Coverage XML must reject DTD and external entity expansion.');
} finally {
  await rm(repositoryRoot, { recursive: true, force: true });
}
console.log('Coverage scope and LCOV path tests passed.');
