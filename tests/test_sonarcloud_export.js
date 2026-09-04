import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exportFindings, toTsv } from '../scripts/export_sonarcloud_findings.js';

const revision = '0123456789abcdef0123456789abcdef01234567';
const calls = [];

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

async function sonarFetch(url, options) {
  calls.push({ url: new URL(url), options });
  assert.equal(options.headers.authorization, 'Bearer test-token');
  const parsed = new URL(url);
  if (parsed.pathname === '/api/project_analyses/search') {
    return jsonResponse({ analyses: [{ key: 'analysis-1', date: '2026-07-23T10:00:00+0000', revision }] });
  }
  if (parsed.pathname === '/api/issues/search') {
    if (parsed.searchParams.get('resolved') === 'true') {
      return jsonResponse({ issues: [{ key: 'resolved-1', severity: 'MINOR', status: 'CLOSED' }], paging: { total: 1 } });
    }
    const page = Number(parsed.searchParams.get('p'));
    const issue = page === 1
      ? { key: 'issue-1', severity: 'CRITICAL', impacts: [{ softwareQuality: 'RELIABILITY', severity: 'HIGH' }] }
      : { key: 'issue-2', impacts: [{ softwareQuality: 'SECURITY', severity: 'MEDIUM' }] };
    return jsonResponse({ issues: [issue], paging: { total: 2 } });
  }
  if (parsed.pathname === '/api/hotspots/search') {
    if (parsed.searchParams.get('status') === 'REVIEWED') {
      return jsonResponse({ hotspots: [{ key: 'reviewed-1', status: 'REVIEWED' }], paging: { total: 1 } });
    }
    return jsonResponse({ hotspots: [{ key: 'hotspot-1', status: 'TO_REVIEW' }], paging: { total: 1 } });
  }
  if (parsed.pathname === '/api/qualitygates/project_status') {
    return jsonResponse({ projectStatus: { status: 'OK', conditions: [] } });
  }
  return jsonResponse({ message: 'not found' }, 404);
}

function retryClock() {
  let elapsed = 0;
  const delays = [];
  return {
    delays,
    monotonicNow: () => elapsed,
    sleepImpl: async milliseconds => { delays.push(milliseconds); elapsed += milliseconds; },
    random: () => 0,
    advance: milliseconds => { elapsed += milliseconds; }
  };
}

async function assertReadRetries(environment) {
  for (const failure of ['network', 'timeout', 429, 502, 503, 504]) {
    const clock = retryClock();
    let attempts = 0;
    await exportFindings({
      environment, ...clock,
      fetchImpl: async (url, options) => {
        attempts += 1;
        if (attempts > 1) return sonarFetch(url, options);
        if (failure === 'network') throw new TypeError('socket failed: test-token');
        if (failure === 'timeout') throw new DOMException('request timeout', 'TimeoutError');
        return jsonResponse({}, failure);
      }
    });
    assert.equal(attempts, 9, `${failure}: exactly one read retry and eight normal reads`);
    assert.deepEqual(clock.delays, [250]);
  }
  const clock = retryClock();
  let attempts = 0;
  await assert.rejects(exportFindings({
    environment, ...clock,
    fetchImpl: async () => { attempts += 1; throw new TypeError('test-token'); }
  }), /failed after 3 attempts/);
  assert.equal(attempts, 3);
  assert.deepEqual(clock.delays, [250, 500]);
}

async function assertHardFailures(environment) {
  for (const [makeResponse, message] of [
    [() => jsonResponse({}, 401), /HTTP 401/],
    [() => jsonResponse({}, 403), /HTTP 403/],
    [() => jsonResponse({}, 500), /HTTP 500/],
    [() => new Response('test-token invalid JSON'), /invalid JSON/],
    [() => jsonResponse(null), /invalid JSON object/],
    [() => jsonResponse({ analyses: [{ key: 'analysis-1', revision: 'f'.repeat(40) }] }), /does not match/]
  ]) {
    const clock = retryClock();
    let attempts = 0;
    await assert.rejects(exportFindings({
      environment, ...clock, fetchImpl: async () => { attempts += 1; return makeResponse(); }
    }), message);
    assert.equal(attempts, 1);
    assert.deepEqual(clock.delays, []);
    await assert.rejects(readFile(path.join(environment.SONAR_EXPORT_DIR, 'summary.json')), /ENOENT/);
  }
}

async function assertRetryBudgets(environment) {
  for (const retryAfter of ['61', 'Thu, 23 Jul 2026 10:02:01 GMT']) {
    const clock = retryClock();
    let attempts = 0;
    await assert.rejects(exportFindings({
      environment, ...clock, now: () => new Date('2026-07-23T10:01:00Z'),
      fetchImpl: async () => { attempts += 1; return jsonResponse({}, 429, { 'retry-after': retryAfter }); }
    }), /60-second read budget/);
    assert.equal(attempts, 1);
    assert.deepEqual(clock.delays, []);
  }
  const clock = retryClock();
  let attempts = 0;
  await assert.rejects(exportFindings({
    environment, ...clock,
    sleepImpl: async () => { clock.advance(60_000); },
    fetchImpl: async () => { attempts += 1; return jsonResponse({}, 503); }
  }), /60-second read budget/);
  assert.equal(attempts, 1, 'No new attempt may start after the overall deadline.');
  for (const retryAfter of ['2', 'Thu, 23 Jul 2026 10:01:02 GMT']) {
    const delayedClock = retryClock();
    let count = 0;
    await exportFindings({
      environment, ...delayedClock, now: () => new Date('2026-07-23T10:01:00Z'),
      fetchImpl: async (url, options) => {
        count += 1;
        return count === 1 ? jsonResponse({}, 429, { 'retry-after': retryAfter }) : sonarFetch(url, options);
      }
    });
    assert.equal(count, 9);
    assert.deepEqual(delayedClock.delays, [2_000]);
  }
}

async function assertPaginationSafety(environment) {
  let pageTwoAttempts = 0;
  const clock = retryClock();
  await exportFindings({
    environment, ...clock,
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/issues/search' && parsed.searchParams.get('p') === '2') {
        pageTwoAttempts += 1;
        if (pageTwoAttempts === 1) return jsonResponse({}, 503);
      }
      return sonarFetch(url, options);
    }
  });
  assert.equal(pageTwoAttempts, 2);
  assert.equal(JSON.parse(await readFile(path.join(environment.SONAR_EXPORT_DIR, 'issues.json'), 'utf8')).length, 3);
  for (const invalidPage of [
    {}, { issues: [], paging: { total: 1 } }, { issues: [{ key: '' }], paging: { total: 1 } },
    { issues: [{ key: 'dup' }, { key: 'dup' }], paging: { total: 2 } },
    { issues: [{ key: 'issue', severity: 'UNKNOWN' }], paging: { total: 1 } }
  ]) {
    let issueRequests = 0;
    await assert.rejects(exportFindings({
      environment, ...retryClock(),
      fetchImpl: async (url, options) => {
        if (new URL(url).pathname !== '/api/issues/search') return sonarFetch(url, options);
        issueRequests += 1;
        return jsonResponse(invalidPage);
      }
    }), /invalid|incomplete|duplicate/u);
    assert.ok(issueRequests <= 2, 'Schema failures must not be retried.');
  }
  let analysisRequests = 0;
  await assert.rejects(exportFindings({
    environment,
    fetchImpl: async (url, options) => {
      if (new URL(url).pathname === '/api/project_analyses/search' && ++analysisRequests === 2) {
        return jsonResponse({ analyses: [{ key: 'changed-analysis', revision }] });
      }
      return sonarFetch(url, options);
    }
  }), /analysis changed during export/);
  assert.equal(analysisRequests, 2);
  await assert.rejects(exportFindings({
    environment,
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/issues/search' && parsed.searchParams.get('resolved') === 'false') {
        return jsonResponse({ issues: [{ key: 'malformed', severity: 'MAJOR', impacts: 'invalid' }], paging: { total: 1 } });
      }
      return sonarFetch(url, options);
    }
  }), /invalid issue severity schema/);
}

function assertErrorRedaction(environment) {
  const result = spawnSync(process.execPath, [
    '--import', './tests/fixtures/sonar_export_failure.js', 'scripts/export_sonarcloud_findings.js'
  ], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, ...environment }, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SonarCloud export failed: SonarCloud read failed before a valid response/);
  assert.doesNotMatch(result.stdout + result.stderr, /test-token|authorization|secret=|Bearer/u);
}

const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'sonarcloud-export-'));
try {
  const environment = {
    SONAR_TOKEN: 'test-token',
    SONAR_PROJECT_KEY: 'organization_project',
    SONAR_BRANCH: 'main',
    SONAR_EXPECTED_REVISION: revision,
    SONAR_EXPORT_DIR: outputDirectory,
    SONAR_HOST_URL: 'https://sonarcloud.example',
    SONAR_REPORT_TASK_FILE: path.join(outputDirectory, 'missing-report-task.txt')
  };
  const summary = await exportFindings({
    environment,
    fetchImpl: sonarFetch,
    now: () => new Date('2026-07-23T10:01:00.000Z')
  });

  assert.equal(summary.analysis.revision, revision);
  assert.equal(summary.expectedRevision, revision);
  assert.equal(summary.revisionMatchesExpectation, true);
  assert.equal(summary.openIssueCount, 2);
  assert.equal(summary.blockerOrCriticalIssueCount, 1);
  assert.equal(summary.toReviewHotspotCount, 1);
  assert.equal(summary.issueCount, 3);
  assert.equal(summary.hotspotCount, 2);
  assert.equal(summary.complete, true);
  assert.equal(summary.qualityGate.status, 'OK');
  assert.ok(calls.every(call => call.url.pathname === '/api/qualitygates/project_status'
    ? call.url.searchParams.get('analysisId') === 'analysis-1' : call.url.searchParams.get('branch') === 'main'));
  assert.equal(calls.filter(call => call.url.pathname === '/api/issues/search').length, 3);

  const issues = await readFile(path.join(outputDirectory, 'open-issues.tsv'), 'utf8');
  assert.match(issues, /^key\ttype\tseverity\timpacts\t/m);
  assert.match(issues, /"softwareQuality":"RELIABILITY","severity":"HIGH"/);
  const persistedSummary = JSON.parse(await readFile(path.join(outputDirectory, 'summary.json'), 'utf8'));
  assert.equal(persistedSummary.generatedAt, '2026-07-23T10:01:00.000Z');
  assert.equal(persistedSummary.analysis.key, 'analysis-1');
  const allIssues = JSON.parse(await readFile(path.join(outputDirectory, 'issues.json'), 'utf8'));
  const allHotspots = JSON.parse(await readFile(path.join(outputDirectory, 'hotspots.json'), 'utf8'));
  assert.deepEqual(allIssues.map(issue => issue.key), ['issue-1', 'issue-2', 'resolved-1']);
  assert.deepEqual(allHotspots.map(hotspot => hotspot.key), ['hotspot-1', 'reviewed-1']);
  assert.ok(calls.every(call => call.options.method === 'GET' && call.options.redirect === 'error'));
  await assertReadRetries(environment);
  await assertRetryBudgets(environment);
  await assertHardFailures(environment);
  await assertPaginationSafety(environment);
  assertErrorRedaction(environment);

  await assert.rejects(
    exportFindings({
      environment: { ...environment, SONAR_EXPECTED_REVISION: 'f'.repeat(40) },
      fetchImpl: sonarFetch
    }),
    /does not match SONAR_EXPECTED_REVISION/
  );
  await assert.rejects(
    exportFindings({ environment, fetchImpl: async () => jsonResponse({}, 401) }),
    /HTTP 401/
  );

  const failedTaskFile = path.join(outputDirectory, 'failed-report-task.txt');
  await writeFile(failedTaskFile, [
    'projectKey=organization_project',
    'ceTaskId=task-failed',
    'ceTaskUrl=https://sonarcloud.example/api/ce/task?id=task-failed'
  ].join('\n'), 'utf8');
  const failedTaskCalls = [];
  await assert.rejects(
    exportFindings({
      environment: { ...environment, SONAR_REPORT_TASK_FILE: failedTaskFile },
      fetchImpl: async (url, options) => {
        failedTaskCalls.push(new URL(url));
        assert.equal(options.headers.authorization, 'Bearer test-token');
        return jsonResponse({
          task: {
            id: 'task-failed',
            type: 'REPORT',
            componentKey: 'organization_project',
            status: 'FAILED',
            submittedAt: '2026-07-23T10:00:00+0000',
            errorMessage: 'Maximum allowed lines of code exceeded. test-token https://sonarcloud.example/task?secret=hidden authorization: Bearer test-token Authorization: Basic ZmFrZS1zZWNyZXQ=',
            errorStacktrace: 'internal stack details must not be persisted'
          }
        });
      }
    }),
    /compute task 'task-failed' failed: Maximum allowed lines of code exceeded\./
  );
  assert.deepEqual(failedTaskCalls.map(call => call.pathname), ['/api/ce/task']);
  const failedTaskEvidence = JSON.parse(await readFile(path.join(outputDirectory, 'ce-task.json'), 'utf8'));
  assert.equal(failedTaskEvidence.id, 'task-failed');
  assert.equal(failedTaskEvidence.status, 'FAILED');
  assert.match(failedTaskEvidence.errorMessage, /^Maximum allowed lines of code exceeded\./u);
  assert.doesNotMatch(JSON.stringify(failedTaskEvidence), /test-token|secret=|hidden|Bearer|ZmFrZS1zZWNyZXQ/u);
  assert.equal(failedTaskEvidence.hasErrorStacktrace, true);
  assert.equal('errorStacktrace' in failedTaskEvidence, false);

  assert.doesNotMatch(toTsv([{ message: 'line 1\nline 2\tvalue' }], ['message']), /\tvalue|line 1\nline 2/);
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}

console.log('SonarCloud export tests passed.');
