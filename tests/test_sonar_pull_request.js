import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exportFindings } from '../scripts/export_sonarcloud_findings.js';
import { scannerIdentity, sonarScope } from '../scripts/sonar_scope.js';
import { verifySonarEvidence } from '../scripts/verify_sonar_evidence.js';

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
const task = { id: 'pr-task', componentKey: 'project', status: 'SUCCESS', analysisId: 'pr-analysis', scannerContext };
const request = { ...pullRequest, commit: { sha: revision }, analysisDate: '2026-09-07T10:00:00+0000' };
const calls = [];
const json = body => new Response(JSON.stringify(body));

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
      return json({ component: { key: 'project', measures: [{ metric: 'new_security_hotspots', period: { value: '0' } }] } });
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

try {
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
    { id: 'other-task' }, { componentKey: 'other-project' }, { analysisId: null }, { scannerContext: '' },
    { scannerContext: scannerContext.replace(revision, 'a'.repeat(40)) },
    { scannerContext: scannerContext.replace('key=28', 'key=29') },
    { scannerContext: scannerContext.replace('base=main', 'base=other') }
  ]) await rejectResponse('/api/ce/task', { task: { ...task, ...changedTask } }, /task/u);
  for (const changedRequest of [
    { key: '29' }, { base: 'other' }, { branch: 'other' }, { commit: { sha: 'b'.repeat(40) } }, { analysisDate: '' }
  ]) await rejectResponse('/api/project_pull_requests/list', { pullRequests: [{ ...request, ...changedRequest }] }, /analysis/u);
  for (const measures of [[], [{ metric: 'new_security_hotspots', value: 'unknown' }],
    [{ metric: 'new_security_hotspots', value: '1' }],
    [{ metric: 'new_security_hotspots', value: '1' }, { metric: 'new_security_hotspots_reviewed', value: '99.9' }]]) {
    await rejectResponse('/api/measures/component', { component: { key: 'project', measures } }, /hotspots/u);
  }
  await exportFindings({ environment, fetchImpl: url => new URL(url).pathname === '/api/measures/component'
    ? json({ component: { key: 'project', measures: [
      { metric: 'new_security_hotspots', period: { value: '2' } },
      { metric: 'new_security_hotspots_reviewed', period: { value: '100' } }
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
