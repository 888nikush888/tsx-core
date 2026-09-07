import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exportFindings } from '../scripts/export_sonarcloud_findings.js';
import { scannerIdentity, sonarScope } from '../scripts/sonar_scope.js';
import { sonarScanArguments } from '../scripts/sonar_scan_arguments.js';
import { verifySonarEvidence } from '../scripts/verify_sonar_evidence.js';
import { sonarCliEnvironment } from './fixtures/sonar_cli_environment.js';

const revision = 'c'.repeat(40);
const pullRequest = { key: '28', branch: 'codex/release-audit', base: 'main' };
const directory = await mkdtemp(path.join(os.tmpdir(), 'sonar-pr-'));
const environment = {
  SONAR_TOKEN: 'fake-only', SONAR_PROJECT_KEY: 'project', SONAR_EXPECTED_REVISION: revision,
  SONAR_EXPORT_DIR: directory, SONAR_REPORT_TASK_FILE: path.join(directory, 'report-task.txt'),
  SONAR_HOST_URL: 'https://sonarcloud.example', SONAR_PULL_REQUEST: pullRequest.key,
  SONAR_PULL_REQUEST_BRANCH: pullRequest.branch, SONAR_PULL_REQUEST_BASE: pullRequest.base
};
const verification = { expectedRevision: revision, projectKey: 'project', pullRequest };
const scannerContext = [
  'Scanner properties:', `  - sonar.scm.revision=${revision}`, `  - sonar.pullrequest.key=${pullRequest.key}`,
  `  - sonar.pullrequest.branch=${pullRequest.branch}`, `  - sonar.pullrequest.base=${pullRequest.base}`,
  '  - sonar.token=NEVER-PERSIST', '  - environment.SECRET=NEVER-PERSIST'
].join('\n');
const task = { id: 'pr-task', componentKey: 'project', status: 'SUCCESS', analysisId: 'pr-analysis', pullRequest: '28', scannerContext };
const request = { ...pullRequest, commit: { sha: revision }, analysisDate: '2026-09-07T10:00:00+0000' };
const calls = [];
const json = body => new Response(JSON.stringify(body));
// The public PR API returned this plural-period shape on 2026-09-07.
const hotspotResponse = { component: { key: 'project', pullRequest: '28', measures: [
  { metric: 'new_security_hotspots', periods: [{ index: 1, value: '0', bestValue: true }] },
  { metric: 'new_security_hotspots_reviewed', periods: [{ index: 1, value: '100.0', bestValue: true }] }
] } };

async function fakeFetch(url) {
  const parsed = new URL(url);
  calls.push(parsed);
  switch (parsed.pathname) {
    case '/api/ce/task':
      assert.equal(parsed.searchParams.get('id'), 'pr-task');
      assert.equal(parsed.searchParams.get('additionalFields'), 'scannerContext');
      return json({ task });
    case '/api/project_pull_requests/list': return json({ pullRequests: [request] });
    case '/api/issues/search':
      assert.equal(parsed.searchParams.get('pullRequest'), pullRequest.key);
      assert.equal(parsed.searchParams.has('branch'), false);
      return json({ issues: [], paging: { total: 0 } });
    case '/api/measures/component':
      assert.equal(parsed.searchParams.get('pullRequest'), pullRequest.key);
      return json(hotspotResponse);
    case '/api/qualitygates/project_status':
      assert.equal(parsed.searchParams.get('analysisId'), 'pr-analysis');
      return json({ projectStatus: { status: 'OK', conditions: [] } });
    default: throw new Error('PR export must never read main analysis or unscoped hotspot endpoints');
  }
}

async function rejectResponse(endpoint, body, message) {
  await assert.rejects(exportFindings({ environment, fetchImpl: url => new URL(url).pathname === endpoint ? json(body) : fakeFetch(url) }), message);
  await assert.rejects(readFile(path.join(directory, 'summary.json')), /ENOENT/u);
}

async function assertExplicitScannerArguments() {
  const mainArgs = sonarScanArguments({ SONAR_EXPECTED_REVISION: revision });
  assert.equal(mainArgs, '-Dsonar.scm.revision=${env.SONAR_EXPECTED_REVISION}');
  const prArgs = sonarScanArguments(environment);
  assert.equal(prArgs, [mainArgs, '-Dsonar.pullrequest.key=${env.SONAR_PULL_REQUEST}',
    '-Dsonar.pullrequest.branch=${env.SONAR_PULL_REQUEST_BRANCH}', '-Dsonar.pullrequest.base=${env.SONAR_PULL_REQUEST_BASE}'].join(' '));
  // These valid Git ref characters must never be interpolated into action args.
  for (const ref of ['codex/quote\'"', 'codex/$(touch-pwned);`id`', 'codex/a=b&c|d', 'codex/ä-ß']) {
    const scoped = { ...environment, SONAR_PULL_REQUEST_BRANCH: ref, SONAR_PULL_REQUEST_BASE: ref };
    assert.equal(sonarScope(scoped).pullRequest.branch, ref);
    assert.equal(sonarScanArguments(scoped), prArgs);
  }
  for (const field of ['SONAR_PULL_REQUEST_BRANCH', 'SONAR_PULL_REQUEST_BASE']) {
    for (const ref of ['codex/${env.SONAR_TOKEN}', 'codex/a\n-Dsonar.token=x', 'codex/a b', ' codex/a', 'codex/a\n']) {
      assert.throws(() => sonarScanArguments({ ...environment, [field]: ref }), /refs contain/u);
    }
  }
  assert.throws(() => sonarScanArguments({ ...environment, SONAR_EXPECTED_REVISION: 'main' }), /exact/u);
  const outputFile = path.join(directory, 'github-output.txt');
  const result = spawnSync(process.execPath, ['scripts/sonar_scan_arguments.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: sonarCliEnvironment({ ...environment, GITHUB_OUTPUT: outputFile }), encoding: 'utf8', windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(outputFile, 'utf8'), `args=${prArgs}\n`);
  const workflow = await readFile('.github/workflows/quality.yml', 'utf8');
  assert.match(workflow, /id: sonar_scope\s+run: node scripts\/sonar_scan_arguments\.js/u);
  assert.match(workflow, /args: \$\{\{ steps\.sonar_scope\.outputs\.args \}\}/u);
  assert.doesNotMatch(workflow, /-Dsonar\.pullrequest\.[^\n]*\$\{\{[^\n]*(?:head_ref|base_ref)/u);
}

try {
  await assertExplicitScannerArguments();
  await writeFile(environment.SONAR_REPORT_TASK_FILE, 'ceTaskId=pr-task\nceTaskUrl=https://sonarcloud.example/api/ce/task?id=pr-task');
  await exportFindings({ environment, fetchImpl: fakeFetch });
  assert.equal((await verifySonarEvidence(directory, verification)).passed, true);
  await assert.rejects(verifySonarEvidence(directory, { ...verification, pullRequest: undefined }), /branch differs/u);
  await assert.rejects(verifySonarEvidence(directory, { ...verification, pullRequest: { ...pullRequest, key: '29' } }), /scope differs/u);
  assert.deepEqual(scannerIdentity(scannerContext), { revision, pullRequest: '28', branch: pullRequest.branch, base: 'main' });
  for (const name of ['summary.json', 'ce-task.json']) {
    assert.doesNotMatch(await readFile(path.join(directory, name), 'utf8'), /NEVER-PERSIST|sonar.token|environment.SECRET/u);
  }
  assert.equal(calls.filter(call => call.pathname === '/api/project_pull_requests/list').length, 2);
  for (const invalidScope of [{ SONAR_PULL_REQUEST: 'x' }, { SONAR_PULL_REQUEST_BASE: '' }, { SONAR_BRANCH: 'main' }]) {
    assert.throws(() => sonarScope({ ...environment, ...invalidScope }), /scope requires/u);
  }
  assert.throws(() => scannerIdentity(`${scannerContext}\nsonar.scm.revision=${revision}`), /duplicate/u);
  for (const changedTask of [
    { id: 'other-task' }, { componentKey: 'other-project' }, { analysisId: null }, { scannerContext: '' }, { pullRequest: '29' },
    { scannerContext: scannerContext.replace(revision, 'a'.repeat(40)) },
    { scannerContext: scannerContext.replace('key=28', 'key=29') },
    { scannerContext: scannerContext.replace('base=main', 'base=other') }
  ]) await rejectResponse('/api/ce/task', { task: { ...task, ...changedTask } }, /task/u);
  await rejectResponse('/api/ce/task', { task: { ...task, scannerContext: `  - sonar.scm.revision=${revision}\n  - sonar.token=NEVER-PERSIST` } },
    /scope: pullRequest missing, branch missing, base missing/u);
  for (const changedRequest of [
    { key: '29' }, { base: 'other' }, { branch: 'other' }, { commit: { sha: 'b'.repeat(40) } }, { analysisDate: '' }
  ]) await rejectResponse('/api/project_pull_requests/list', { pullRequests: [{ ...request, ...changedRequest }] }, /analysis/u);
  for (const measures of [[], [{ metric: 'new_security_hotspots', value: 'unknown' }],
    [{ metric: 'new_security_hotspots', value: '1' }],
    [{ metric: 'new_security_hotspots', value: '1' }, { metric: 'new_security_hotspots_reviewed', value: '99.9' }]]) {
    await rejectResponse('/api/measures/component', { component: { key: 'project', pullRequest: '28', measures } }, /hotspots/u);
  }
  for (const measure of [
    { periods: [] }, { periods: {} }, { periods: [null] }, { periods: [{ value: '0' }] },
    { periods: [{ index: 2, value: '0' }] }, { periods: [{ index: 1, value: '0' }, { index: 1, value: '1' }] },
    { periods: [{ index: 1, value: '0' }, { index: 2, value: '0' }] },
    { periods: [{ index: 1, value: '0' }], value: '1' },
    { periods: [{ index: 1, value: '0' }], period: { value: '1' } },
    { periods: [{ index: 1, value: 0 }] }, { periods: [{ index: 1, value: '-1' }] },
    { periods: [{ index: 1, value: '0.5' }] }, { period: { index: 2, value: '0' } }, { value: '9007199254740992' }
  ]) await rejectResponse('/api/measures/component', { component: { key: 'project', pullRequest: '28',
    measures: [{ metric: 'new_security_hotspots', ...measure }] } }, /hotspots/u);
  for (const reviewed of [
    { periods: [{ index: 1, value: '101' }] }, { periods: [] }, { value: 'unknown' },
    { periods: [{ index: 1, value: '100' }], value: '99' }
  ]) await rejectResponse('/api/measures/component', { component: { key: 'project', pullRequest: '28', measures: [
    hotspotResponse.component.measures[0], { metric: 'new_security_hotspots_reviewed', ...reviewed }
  ] } }, /hotspots/u);
  for (const scope of [{ key: 'other' }, { pullRequest: '29' }, { pullRequest: undefined }]) {
    await rejectResponse('/api/measures/component', { component: { ...hotspotResponse.component, ...scope } }, /evidence is unavailable/u);
  }
  for (const metric of hotspotResponse.component.measures) {
    await rejectResponse('/api/measures/component', { component: { ...hotspotResponse.component,
      measures: [...hotspotResponse.component.measures, metric] } }, /hotspots/u);
  }
  await exportFindings({ environment, fetchImpl: url => new URL(url).pathname === '/api/measures/component'
    ? json({ component: { key: 'project', pullRequest: '28', measures: [
      { metric: 'new_security_hotspots', period: { value: '2' } },
      { metric: 'new_security_hotspots_reviewed', period: { value: '100' } }
    ] } }) : fakeFetch(url) });
  assert.equal((await verifySonarEvidence(directory, verification)).passed, true);
  await exportFindings({ environment, fetchImpl: url => new URL(url).pathname === '/api/measures/component'
    ? json({ component: { key: 'project', pullRequest: '28', measures: [
      { metric: 'new_security_hotspots', periods: [{ index: 1, value: '2' }] },
      { metric: 'new_security_hotspots_reviewed', periods: [{ index: 1, value: '100' }] }
    ] } }) : fakeFetch(url) });
  assert.equal((await verifySonarEvidence(directory, verification)).passed, true);
  await writeFile(path.join(directory, 'hotspot-review.json'), '{}');
  await assert.rejects(verifySonarEvidence(directory, verification), /artifact/u);
  let snapshotCount = 0;
  await assert.rejects(exportFindings({ environment, fetchImpl: url => {
    if (new URL(url).pathname === '/api/project_pull_requests/list' && ++snapshotCount === 2) {
      return json({ pullRequests: [{ ...request, analysisDate: '2026-09-07T10:01:00+0000' }] });
    }
    return fakeFetch(url);
  } }), /analysis changed/u);
  for (const blockingEndpoint of ['/api/issues/search', '/api/qualitygates/project_status']) {
    await exportFindings({ environment, fetchImpl: url => {
      const parsed = new URL(url);
      if (parsed.pathname !== blockingEndpoint) return fakeFetch(url);
      if (blockingEndpoint === '/api/qualitygates/project_status') return json({ projectStatus: { status: 'ERROR', conditions: [] } });
      return parsed.searchParams.get('resolved') === 'false'
        ? json({ issues: [{ key: 'critical', severity: 'CRITICAL' }], paging: { total: 1 } }) : fakeFetch(url);
    } });
    await assert.rejects(verifySonarEvidence(directory, verification), /quality gate|blocker\/critical/u);
  }
  await exportFindings({ environment, fetchImpl: fakeFetch });
  const summaryPath = path.join(directory, 'summary.json');
  const original = JSON.parse(await readFile(summaryPath, 'utf8'));
  for (const changed of [{ hotspotReview: null }, { hotspotReview: { ...original.hotspotReview, count: 1 } },
    { computeTask: { ...original.computeTask, analysisId: 'unrelated' } }, { artifacts: {} }]) {
    await writeFile(summaryPath, JSON.stringify({ ...original, ...changed }));
    await assert.rejects(verifySonarEvidence(directory, verification), /evidence rejected/u);
  }
  await rm(environment.SONAR_REPORT_TASK_FILE);
  await assert.rejects(exportFindings({ environment, fetchImpl: fakeFetch }), /ENOENT/u);
} finally {
  await rm(directory, { recursive: true, force: true });
}
console.log('SonarCloud pull request scope and evidence tests passed.');
