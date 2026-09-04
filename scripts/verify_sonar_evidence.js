import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isBlockingIssue } from './export_sonarcloud_findings.js';

const ARTIFACTS = ['issues.json', 'hotspots.json', 'issues.tsv', 'hotspots.tsv', 'open-issues.tsv', 'to-review-hotspots.tsv'];

function requireEvidence(condition, detail) {
  if (!condition) throw new Error(`SonarCloud evidence rejected: ${detail}.`);
}

function validateComputeTask(summary, projectKey) {
  requireEvidence(summary.computeTask?.status === 'SUCCESS' && summary.computeTask?.componentKey === projectKey
    && summary.computeTask?.analysisId === summary.analysis?.key, 'compute task is missing or differs');
}

function validateSummary(summary, expectedRevision, projectKey) {
  requireEvidence(/^[a-f0-9]{40}$/u.test(expectedRevision ?? ''), 'expected revision must be an exact SHA');
  requireEvidence(typeof projectKey === 'string' && projectKey.length > 0, 'expected project is required');
  requireEvidence(summary.schemaVersion === 1 && summary.complete === true, 'incomplete export');
  requireEvidence(summary.analysisStableDuringCapture === true, 'analysis stability is unproven');
  requireEvidence(summary.branch === 'main' && summary.projectKey === projectKey, 'project or branch differs');
  requireEvidence(summary.analysis?.revision === expectedRevision && summary.expectedRevision === expectedRevision
    && summary.revisionMatchesExpectation === true, 'revision differs');
  validateComputeTask(summary, projectKey);
  requireEvidence(summary.qualityGate?.status === 'OK', 'quality gate is not OK');
  requireEvidence(summary.toReviewHotspotCount === 0 && summary.blockerOrCriticalIssueCount === 0,
    'unreviewed hotspots or blocker/critical issues remain');
}

async function verifiedArtifacts(directory, summary) {
  const contents = {};
  for (const name of ARTIFACTS) {
    let bytes;
    try {
      bytes = await readFile(path.join(directory, name));
    } catch (error) {
      throw new Error('SonarCloud evidence rejected: artifact is missing or unreadable.', { cause: error });
    }
    const manifest = summary.artifacts?.[name];
    requireEvidence(manifest?.sha256 === createHash('sha256').update(bytes).digest('hex')
      && manifest.bytes === bytes.byteLength, 'artifact hash or size differs');
    contents[name] = bytes.toString('utf8');
  }
  return contents;
}

function partitionRecords(records, firstKeys, secondKeys) {
  requireEvidence(Array.isArray(records) && Array.isArray(firstKeys) && Array.isArray(secondKeys), 'invalid partitions');
  const keys = [...firstKeys, ...secondKeys];
  const recordKeys = records.map(record => record?.key);
  requireEvidence(keys.length === records.length && new Set(keys).size === records.length
    && new Set(recordKeys).size === records.length && recordKeys.every(key => keys.includes(key)), 'partition coverage differs');
  return records.filter(record => firstKeys.includes(record.key));
}

function validateCounts(summary, contents) {
  const issues = JSON.parse(contents['issues.json']);
  const hotspots = JSON.parse(contents['hotspots.json']);
  const partitions = summary.partitions ?? {};
  const openIssues = partitionRecords(issues, partitions.openIssueKeys, partitions.resolvedIssueKeys);
  const toReview = partitionRecords(hotspots, partitions.toReviewHotspotKeys, partitions.reviewedHotspotKeys);
  requireEvidence(summary.issueCount === issues.length && summary.hotspotCount === hotspots.length
    && summary.openIssueCount === openIssues.length, 'finding counts differ');
  requireEvidence(openIssues.filter(isBlockingIssue).length === summary.blockerOrCriticalIssueCount
    && toReview.length === summary.toReviewHotspotCount, 'gate counts differ');
  requireEvidence(hotspots.every(item => item.status === 'REVIEWED'), 'unreviewed or unknown hotspot status');
}

export async function verifySonarEvidence(directory, { expectedRevision, projectKey } = {}) {
  const summary = JSON.parse(await readFile(path.join(directory, 'summary.json'), 'utf8'));
  validateSummary(summary, expectedRevision, projectKey);
  const contents = await verifiedArtifacts(directory, summary);
  validateCounts(summary, contents);
  return { passed: true, revision: expectedRevision, issueCount: summary.issueCount, hotspotCount: summary.hotspotCount };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await verifySonarEvidence(path.resolve(process.env.SONAR_EXPORT_DIR || 'reports/sonarcloud'), {
      expectedRevision: process.env.SONAR_EXPECTED_REVISION, projectKey: process.env.SONAR_PROJECT_KEY
    });
    console.log('SonarCloud evidence gate passed for the expected main revision.');
  } catch {
    console.error('SonarCloud evidence gate failed: missing, inconsistent or blocking evidence.');
    process.exitCode = 1;
  }
}
