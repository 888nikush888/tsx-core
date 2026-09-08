import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { evaluateSnykCode, evidenceDigest } from '../scripts/check_snyk_code_review.js';

const source = 'export const value = "fixture";\n';
const hash = createHash('sha256').update(source).digest('hex');
const physical = file => ({ physicalLocation: { artifactLocation: { uri: file } } });
function fixture() {
  const finding = { ruleId: 'javascript/Example', fingerprints: { identity: 'finding-1', 'snyk/asset/finding/v1': 'finding-1' },
    locations: [physical('src/example.ts')], suppressions: [{ kind: 'external' }] };
  return { scannerExit: 1, readSource: () => source,
    sarif: { version: '2.1.0', runs: [{ tool: { driver: { name: 'SnykCode', version: '1.1307.1' } }, results: [finding] }] },
    review: { schemaVersion: 1, scannerVersion: '1.1307.1', reviewedRevision: 'a'.repeat(40), sarifSha256: 'b'.repeat(64),
      entries: [{ findingId: 'finding-1', ruleId: finding.ruleId, path: 'src/example.ts', reviewedSourceSha256: hash,
        fingerprints: structuredClone(finding.fingerprints), evidenceSha256: evidenceDigest(finding),
        disposition: 'false-positive', rationale: 'The independent fixture review verifies the explicit local security boundary.', contextPaths: [] }] } };
}

test('reviewed unchanged findings pass while the raw finding remains in evidence', async () => {
  const result = await evaluateSnykCode(fixture());
  assert.equal(result.resultCount, 1);
  assert.equal(result.reviewedFalsePositives, 1);
  assert.equal(result.remaining, 0);
});

test('organization suppression alone cannot pass the gate', async () => {
  const input = fixture();
  input.review.entries = [];
  assert.equal((await evaluateSnykCode(input)).remaining, 1);
});

for (const disposition of ['open', 'accepted-risk', 'proposed-false-positive']) {
  test(`${disposition} cannot be treated as a confirmed false positive`, async () => {
    const input = fixture();
    input.review.entries[0].disposition = disposition;
    assert.equal((await evaluateSnykCode(input)).remaining, 1);
  });
}

test('changing the reviewed source invalidates the disposition', async () => {
  const input = fixture();
  input.readSource = () => 'changed source';
  const result = await evaluateSnykCode(input);
  assert.equal(result.findings[0].disposition, 'reviewed-source-changed');
});

test('a changed helper invalidates an otherwise unchanged finding', async () => {
  const input = fixture();
  input.review.entries[0].contextPaths.push({ path: 'src/boundary.ts', sha256: hash });
  input.readSource = file => file === 'src/boundary.ts' ? 'boundary removed' : source;
  assert.equal((await evaluateSnykCode(input)).remaining, 1);
});

test('every dataflow file needs its own verified binding', async () => {
  const input = fixture();
  input.sarif.runs[0].results[0].codeFlows = [{ threadFlows: [{ locations: [{ location: physical('src/boundary.ts') }] }] }];
  input.review.entries[0].evidenceSha256 = evidenceDigest(input.sarif.runs[0].results[0]);
  assert.equal((await evaluateSnykCode(input)).findings[0].disposition, 'unreviewed-dataflow-source');
  input.review.entries[0].contextPaths.push({ path: 'src/boundary.ts', sha256: hash });
  assert.equal((await evaluateSnykCode(input)).remaining, 0);
});

test('the same identity with a changed rule or primary path stays unresolved', async () => {
  for (const change of [result => { result.ruleId = 'javascript/NewRule'; }, result => { result.locations = [physical('src/other.ts')]; }]) {
    const input = fixture();
    change(input.sarif.runs[0].results[0]);
    assert.equal((await evaluateSnykCode(input)).remaining, 1);
  }
});

test('duplicates, missing identities and contradictory identities fail closed', async () => {
  for (const change of [
    input => input.sarif.runs[0].results.push(input.sarif.runs[0].results[0]),
    input => { input.sarif.runs[0].results[0].fingerprints = {}; },
    input => { input.sarif.runs[0].results[0].fingerprints.identity = 'other'; },
    input => input.review.entries.push(input.review.entries[0]),
  ]) {
    const input = fixture();
    change(input);
    await assert.rejects(evaluateSnykCode(input));
  }
});

test('scanner failures and incomplete or foreign SARIF are not clean scans', async () => {
  for (const change of [
    input => { input.scannerExit = 2; }, input => { input.sarif.version = '1.0'; },
    input => { input.sarif.runs = []; }, input => { delete input.sarif.runs[0].results; },
    input => { input.sarif.runs[0].tool.driver.name = 'Other'; },
    input => { input.sarif.runs[0].invocations = [{ executionSuccessful: false }]; },
    input => { input.sarif.runs[0].invocations = [{ exitCode: 2 }]; },
    input => { input.sarif.runs[0].invocations = [{ toolExecutionNotifications: [{ level: 'error' }] }]; },
    input => { input.sarif.runs[0].invocations = [{ toolConfigurationNotifications: [{ level: 'error' }] }]; },
    input => { input.sarif.runs[0].results = []; },
  ]) {
    const input = fixture();
    change(input);
    await assert.rejects(evaluateSnykCode(input));
  }
});

test('same identity and source cannot authorize changed fingerprint or flow evidence', async () => {
  for (const change of [
    result => { result.fingerprints['0'] = 'new fingerprint'; },
    result => { result.locations[0].physicalLocation.region = { startLine: 77 }; },
  ]) {
    const input = fixture();
    change(input.sarif.runs[0].results[0]);
    assert.equal((await evaluateSnykCode(input)).findings[0].disposition, 'reviewed-flow-changed');
  }
});

test('malformed or truncated dataflows fail even when a review lacks their paths', async () => {
  for (const flows of [{}, [], [{}], [{ threadFlows: [] }], [{ threadFlows: [{}] }], [{ threadFlows: [{ locations: [] }] }]]) {
    const input = fixture();
    input.sarif.runs[0].results[0].codeFlows = flows;
    await assert.rejects(evaluateSnykCode(input));
  }
});

test('clean successful scans do not require false-positive decisions', async () => {
  const input = fixture();
  input.scannerExit = 0;
  input.sarif.runs[0].results = [];
  input.review = null;
  assert.equal((await evaluateSnykCode(input)).remaining, 0);
});

test('review paths and dataflow paths cannot traverse or use encoded aliases', async () => {
  for (const file of ['../outside', '/absolute', 'src/../outside', 'C:/outside', 'src\\outside', 'src/%2e%2e/outside']) {
    const input = fixture();
    input.review.entries[0].contextPaths.push({ path: file, sha256: hash });
    await assert.rejects(evaluateSnykCode(input));
  }
});
