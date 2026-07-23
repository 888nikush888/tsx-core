import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exportFindings, toTsv } from '../scripts/export_sonarcloud_findings.js';

const revision = '0123456789abcdef0123456789abcdef01234567';
const calls = [];

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
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
    const page = Number(parsed.searchParams.get('p'));
    const issue = page === 1
      ? { key: 'issue-1', impacts: [{ softwareQuality: 'RELIABILITY', severity: 'HIGH' }] }
      : { key: 'issue-2', impacts: [{ softwareQuality: 'SECURITY', severity: 'MEDIUM' }] };
    return jsonResponse({ issues: [issue], paging: { total: 2 } });
  }
  if (parsed.pathname === '/api/hotspots/search') {
    return jsonResponse({ hotspots: [{ key: 'hotspot-1', status: 'TO_REVIEW' }], paging: { total: 1 } });
  }
  if (parsed.pathname === '/api/qualitygates/project_status') {
    return jsonResponse({ projectStatus: { status: 'OK', conditions: [] } });
  }
  return jsonResponse({ message: 'not found' }, 404);
}

const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'sonarcloud-export-'));
try {
  const environment = {
    SONAR_TOKEN: 'test-token',
    SONAR_PROJECT_KEY: 'organization_project',
    SONAR_BRANCH: 'main',
    SONAR_EXPECTED_REVISION: revision,
    SONAR_EXPORT_DIR: outputDirectory,
    SONAR_HOST_URL: 'https://sonarcloud.example'
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
  assert.equal(summary.toReviewHotspotCount, 1);
  assert.equal(summary.qualityGate.status, 'OK');
  assert.ok(calls.every(call => call.url.searchParams.get('branch') === 'main'));
  assert.equal(calls.filter(call => call.url.pathname === '/api/issues/search').length, 2);

  const issues = await readFile(path.join(outputDirectory, 'open-issues.tsv'), 'utf8');
  assert.match(issues, /^key\ttype\tseverity\timpacts\t/m);
  assert.match(issues, /"softwareQuality":"RELIABILITY","severity":"HIGH"/);
  const persistedSummary = JSON.parse(await readFile(path.join(outputDirectory, 'summary.json'), 'utf8'));
  assert.equal(persistedSummary.generatedAt, '2026-07-23T10:01:00.000Z');
  assert.equal(persistedSummary.analysis.key, 'analysis-1');

  await assert.rejects(
    exportFindings({
      environment: { ...environment, SONAR_EXPECTED_REVISION: 'different-revision' },
      fetchImpl: sonarFetch
    }),
    /does not match SONAR_EXPECTED_REVISION/
  );
  await assert.rejects(
    exportFindings({ environment, fetchImpl: async () => jsonResponse({}, 401) }),
    /HTTP 401/
  );
  assert.doesNotMatch(toTsv([{ message: 'line 1\nline 2\tvalue' }], ['message']), /\tvalue|line 1\nline 2/);
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}

console.log('SonarCloud export tests passed.');
