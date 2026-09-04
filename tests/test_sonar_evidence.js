import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exportFindings } from '../scripts/export_sonarcloud_findings.js';
import { verifySonarEvidence } from '../scripts/verify_sonar_evidence.js';

const revision = 'a'.repeat(40);
const directory = await mkdtemp(path.join(os.tmpdir(), 'sonar-evidence-'));
const environment = {
  SONAR_TOKEN: 'fake-only', SONAR_PROJECT_KEY: 'project', SONAR_EXPECTED_REVISION: revision,
  SONAR_EXPORT_DIR: directory, SONAR_REPORT_TASK_FILE: path.join(directory, 'report-task.txt'),
  SONAR_HOST_URL: 'https://sonarcloud.example', SONAR_REQUIRE_COMPUTE_TASK: 'true'
};
const verification = { expectedRevision: revision, projectKey: 'project' };
const response = value => new Response(JSON.stringify(value));
const workflow = await readFile('.github/workflows/quality.yml', 'utf8');
assert.match(workflow, /id: sonar_scan/u);
assert.match(workflow, /SONAR_REQUIRE_COMPUTE_TASK: 'true'/u);
assert.match(workflow, /node scripts\/verify_sonar_evidence\.js/u);
assert.match(workflow, /test "\$\{\{ steps\.sonar_scan\.outcome \}\}" = "success"/u);
const sonarProperties = await readFile('sonar-project.properties', 'utf8');
const sources = sonarProperties.match(/^sonar\.sources=(.+)$/mu)[1].split(',');
for (const entry of await readdir('exchange_executor', { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.py')) {
    assert.ok(sources.includes(`exchange_executor/${entry.name}`), `Sonar must include production module ${entry.name}.`);
  }
}
assert.ok(sources.every(source => !source.includes('/tests/')));
async function fakeFetch(url) {
  switch (new URL(url).pathname) {
    case '/api/ce/task': return response({ task: { id: 'task', componentKey: 'project', status: 'SUCCESS', analysisId: 'analysis' } });
    case '/api/project_analyses/search': return response({ analyses: [{ key: 'analysis', revision }] });
    case '/api/issues/search': return response({ issues: [], paging: { total: 0 } });
    case '/api/hotspots/search': return response({ hotspots: [], paging: { total: 0 } });
    case '/api/qualitygates/project_status': return response({ projectStatus: { status: 'OK', conditions: [] } });
    default: throw new Error('Unexpected fake-only endpoint');
  }
}
try {
  await writeFile(environment.SONAR_REPORT_TASK_FILE, 'ceTaskUrl=https://sonarcloud.example/api/ce/task?id=task');
  await exportFindings({ environment, fetchImpl: fakeFetch });
  const verified = await verifySonarEvidence(directory, verification);
  assert.equal(verified.passed, true);
  const runCli = () => spawnSync(process.execPath, ['scripts/verify_sonar_evidence.js'], {
    cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, ...environment }, encoding: 'utf8', windowsHide: true
  });
  assert.equal(runCli().status, 0);
  const summaryFile = path.join(directory, 'summary.json');
  const original = JSON.parse(await readFile(summaryFile, 'utf8'));
  for (const changes of [
    { complete: false }, { expectedRevision: 'b'.repeat(40) }, { projectKey: 'other' }, { branch: 'other' },
    { qualityGate: { status: 'ERROR' } }, { toReviewHotspotCount: 1 }, { blockerOrCriticalIssueCount: 1 },
    { computeTask: null }, { partitions: {} }, { issueCount: 1 }, { artifacts: {} },
    { analysis: { ...original.analysis, revision: 'b'.repeat(40) } }
  ]) {
    await writeFile(summaryFile, JSON.stringify({ ...original, ...changes }));
    await assert.rejects(verifySonarEvidence(directory, verification), /SonarCloud evidence/);
  }
  await writeFile(summaryFile, JSON.stringify(original));
  await writeFile(path.join(directory, 'issues.json'), '[{"key":"omitted"}]');
  await assert.rejects(verifySonarEvidence(directory, verification), /artifact/);
  await rm(path.join(directory, 'issues.json'));
  await assert.rejects(verifySonarEvidence(directory, verification), /artifact/);
  const failedCli = runCli();
  assert.equal(failedCli.status, 1);
  assert.match(failedCli.stderr, /SonarCloud evidence gate failed/);
} finally {
  await rm(directory, { recursive: true, force: true });
}
console.log('SonarCloud evidence gate tests passed.');
