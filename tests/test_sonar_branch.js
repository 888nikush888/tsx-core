import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exportFindings } from '../scripts/export_sonarcloud_findings.js';
import { sonarScanArguments } from '../scripts/sonar_scan_arguments.js';
import { verifySonarEvidence } from '../scripts/verify_sonar_evidence.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'sonar-branch-'));
const revision = 'd'.repeat(40);
const branch = 'branch-sonar-cleanup';
const environment = {
  SONAR_TOKEN: 'fake-only', SONAR_PROJECT_KEY: 'project', SONAR_EXPECTED_REVISION: revision,
  SONAR_EXPORT_DIR: directory, SONAR_REPORT_TASK_FILE: path.join(directory, 'report-task.txt'),
  SONAR_HOST_URL: 'https://sonarcloud.example', SONAR_BRANCH: branch
};
const verification = { expectedRevision: revision, projectKey: 'project', branch };
const scannerContext = `sonar.scm.revision=${revision}\nsonar.branch.name=${branch}\nsonar.token=NEVER-PERSIST`;
const task = { id: 'branch-task', componentKey: 'project', status: 'SUCCESS', analysisId: 'branch-analysis', scannerContext };
const branchIdentity = { name: branch, type: 'LONG', isMain: false, commit: { sha: revision }, analysisDate: '2026-09-07T12:00:00+0200' };
const json = value => new Response(JSON.stringify(value));
let openIssues = [{ key: 'existing-issue', severity: 'MINOR' }];

async function fakeFetch(url) {
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.has('pullRequest'), false);
  switch (parsed.pathname) {
    case '/api/ce/task':
      assert.equal(parsed.searchParams.get('additionalFields'), 'scannerContext');
      return json({ task });
    case '/api/project_analyses/search':
      assert.equal(parsed.searchParams.get('branch'), branch);
      return json({ analyses: [{ key: 'branch-analysis', revision, date: '2026-09-07T10:00:00+0000' }] });
    case '/api/project_branches/list': return json({ branches: [branchIdentity] });
    case '/api/issues/search': {
      assert.equal(parsed.searchParams.get('branch'), branch);
      const issues = parsed.searchParams.get('resolved') === 'false' ? openIssues : [];
      return json({ issues, paging: { total: issues.length } });
    }
    case '/api/hotspots/search':
      assert.equal(parsed.searchParams.get('branch'), branch);
      return json({ hotspots: [], paging: { total: 0 } });
    case '/api/qualitygates/project_status':
      assert.equal(parsed.searchParams.get('analysisId'), 'branch-analysis');
      return json({ projectStatus: { status: 'OK', conditions: [] } });
    default: throw new Error('Unexpected branch endpoint');
  }
}

try {
  const args = '-Dsonar.scm.revision=${env.SONAR_EXPECTED_REVISION} -Dsonar.branch.name=${env.SONAR_BRANCH}';
  assert.equal(sonarScanArguments(environment), args);
  for (const ref of ['codex/quote\'"', 'codex/$(touch-pwned);`id`', 'codex/a=b&c|d', 'codex/ä-ß']) {
    assert.equal(sonarScanArguments({ ...environment, SONAR_BRANCH: ref }), args);
  }
  for (const ref of ['codex/${env.SONAR_TOKEN}', 'codex/a\n-Dsonar.token=x', 'codex/a b', ' codex/a', 'codex/a\n']) {
    assert.throws(() => sonarScanArguments({ ...environment, SONAR_BRANCH: ref }), /refs contain/u);
  }
  await writeFile(environment.SONAR_REPORT_TASK_FILE, 'ceTaskUrl=https://sonarcloud.example/api/ce/task?id=branch-task');
  const summary = await exportFindings({ environment, fetchImpl: fakeFetch });
  assert.equal(summary.openIssueCount, 1, 'Full branch export must include pre-existing minor issues.');
  assert.equal((await verifySonarEvidence(directory, verification)).passed, true);
  await assert.rejects(verifySonarEvidence(directory, { ...verification, branch: 'main' }), /branch differs/u);
  await assert.rejects(verifySonarEvidence(directory, { ...verification, branch: 'other' }), /branch differs/u);
  for (const name of ['summary.json', 'ce-task.json']) {
    assert.doesNotMatch(await readFile(path.join(directory, name), 'utf8'), /NEVER-PERSIST|sonar.token/u);
  }
  for (const changes of [
    { type: 'SHORT' }, { isMain: true }, { name: 'other' }, { commit: { sha: 'a'.repeat(40) } },
    { analysisDate: 'invalid' }, { analysisDate: '2026-09-07T10:01:00+0000' }
  ]) {
    await assert.rejects(exportFindings({ environment, fetchImpl: url => new URL(url).pathname === '/api/project_branches/list'
      ? json({ branches: [{ ...branchIdentity, ...changes }] }) : fakeFetch(url) }), /full long-lived/u);
    await assert.rejects(readFile(path.join(directory, 'summary.json')), /ENOENT/u);
  }
  for (const changes of [
    { analysisId: 'other' }, { scannerContext: '' }, { pullRequest: '28' },
    { scannerContext: scannerContext.replace(revision, 'a'.repeat(40)) },
    { scannerContext: scannerContext.replace(branch, 'main') },
    { scannerContext: `${scannerContext}\nsonar.pullrequest.key=28` },
    { scannerContext: `${scannerContext}\nsonar.pullrequest.branch=${branch}` },
    { scannerContext: `${scannerContext}\nsonar.branch.name=${branch}` }
  ]) {
    await assert.rejects(exportFindings({ environment, fetchImpl: url => new URL(url).pathname === '/api/ce/task'
      ? json({ task: { ...task, ...changes } }) : fakeFetch(url) }), /task|duplicate/u);
    await assert.rejects(readFile(path.join(directory, 'summary.json')), /ENOENT/u);
  }
  openIssues = [{ key: 'blocking', severity: 'CRITICAL' }];
  await exportFindings({ environment, fetchImpl: fakeFetch });
  await assert.rejects(verifySonarEvidence(directory, verification), /blocker\/critical/u);
  await rm(environment.SONAR_REPORT_TASK_FILE);
  await assert.rejects(exportFindings({ environment, fetchImpl: fakeFetch }), /ENOENT/u);
} finally {
  await rm(directory, { recursive: true, force: true });
}
console.log('SonarCloud full branch scope and evidence tests passed.');
