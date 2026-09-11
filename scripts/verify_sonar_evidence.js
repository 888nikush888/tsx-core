import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isBlockingIssue } from './export_sonarcloud_findings.js';
import { sonarScope, validateBranchTask, validatePullRequestTask } from './sonar_scope.js';

const ARTIFACTS = ['issues.json', 'hotspots.json', 'issues.tsv', 'hotspots.tsv', 'open-issues.tsv', 'to-review-hotspots.tsv'];

function requireEvidence(condition, detail) {
  if (!condition) throw new Error(`SonarCloud evidence rejected: ${detail}.`);
}

function validateComputeTask(summary, projectKey) {
  requireEvidence(summary.computeTask?.status === 'SUCCESS' && summary.computeTask?.componentKey === projectKey,
    'compute task is missing or differs');
  requireEvidence(summary.computeTask.analysisId === summary.analysis?.key, 'compute task is missing or differs');
}

function hotspotReviewComplete(review) {
  return Number.isSafeInteger(review.count) && review.count >= 0
    && (review.count === 0 || review.reviewedPercent === 100);
}

function validatePullRequestHotspots(review, pullRequest) {
  requireEvidence(review?.source === 'api/measures/component' && review?.pullRequest === pullRequest.key,
    'pull request hotspot review is unproven');
  requireEvidence(hotspotReviewComplete(review), 'pull request hotspot review is unproven');
}

function validatePullRequestIdentity(summary, pullRequest) {
  const identity = summary.pullRequest ?? {};
  requireEvidence(summary.branch === null && identity.key === pullRequest.key
    && identity.branch === pullRequest.branch && identity.base === pullRequest.base,
    'pull request scope differs');
}

function validateScope(summary, { expectedRevision, projectKey, pullRequest, branch = 'main' }) {
  requireEvidence(summary.projectKey === projectKey, 'project differs');
  if (!pullRequest) {
    requireEvidence(summary.branch === branch && !summary.pullRequest, 'project or branch differs');
    if (branch !== 'main') validateLongBranchScope(summary, expectedRevision, branch);
    return;
  }
  validatePullRequestIdentity(summary, pullRequest);
  validatePullRequestTask(summary.computeTask, { expectedRevision, pullRequest });
  validatePullRequestHotspots(summary.hotspotReview, pullRequest);
}

function validateLongBranchScope(summary, expectedRevision, branch) {
  validateBranchTask(summary.computeTask, { expectedRevision, branch });
  const identity = summary.branchAnalysis ?? {};
  requireEvidence(identity.name === branch && identity.type === 'LONG' && identity.revision === expectedRevision,
    'full long-lived branch analysis is unproven');
  validateLongBranchDate(identity.analysisDate, summary.analysis?.date);
}

function validateLongBranchDate(branchDate, analysisDate) {
  requireEvidence(Number.isFinite(Date.parse(branchDate)) && Date.parse(branchDate) === Date.parse(analysisDate),
    'full long-lived branch analysis is unproven');
}

function validateSummaryHeader(summary, { expectedRevision, projectKey }) {
  requireEvidence(/^[a-f0-9]{40}$/u.test(expectedRevision ?? ''), 'expected revision must be an exact SHA');
  requireEvidence(typeof projectKey === 'string' && projectKey.length > 0, 'expected project is required');
  requireEvidence(summary.schemaVersion === 1 && summary.complete === true, 'incomplete export');
  requireEvidence(summary.analysisStableDuringCapture === true, 'analysis stability is unproven');
}

function validateRevision(summary, expectedRevision) {
  requireEvidence(summary.analysis?.revision === expectedRevision && summary.expectedRevision === expectedRevision
    && summary.revisionMatchesExpectation === true, 'revision differs');
}

function validateGate(summary) {
  requireEvidence(summary.qualityGate?.status === 'OK', 'quality gate is not OK');
  requireEvidence(summary.toReviewHotspotCount === 0 && summary.blockerOrCriticalIssueCount === 0,
    'unreviewed hotspots or blocker/critical issues remain');
}

function validateSummary(summary, options) {
  validateSummaryHeader(summary, options);
  validateScope(summary, options);
  validateRevision(summary, options.expectedRevision);
  validateComputeTask(summary, options.projectKey);
  validateGate(summary);
}

async function verifiedArtifact(directory, summary, name) {
  let artifact = null;
  try {
    artifact = await readFile(path.join(directory, name));
  } catch (error) {
    throw new Error('SonarCloud evidence rejected: artifact is missing or unreadable.', { cause: error });
  }
  const manifest = summary.artifacts?.[name];
  requireEvidence(manifest?.sha256 === createHash('sha256').update(artifact).digest('hex')
    && manifest.bytes === artifact.byteLength, 'artifact hash or size differs');
  return artifact.toString('utf8');
}

async function verifiedArtifacts(directory, summary) {
  const contents = {};
  const names = summary.pullRequest ? [...ARTIFACTS, 'hotspot-review.json'] : ARTIFACTS;
  for (const name of names) contents[name] = await verifiedArtifact(directory, summary, name);
  return contents;
}

function partitionRecords(records, firstKeys, secondKeys) {
  requireEvidence(Array.isArray(records) && Array.isArray(firstKeys) && Array.isArray(secondKeys), 'invalid partitions');
  const keys = [...firstKeys, ...secondKeys];
  const recordKeys = records.map(record => record?.key);
  requireEvidence(keys.length === records.length && new Set(keys).size === records.length, 'partition coverage differs');
  requireEvidence(new Set(recordKeys).size === records.length && recordKeys.every(key => keys.includes(key)),
    'partition coverage differs');
  return records.filter(record => firstKeys.includes(record.key));
}

function validateFindingCounts(summary, issues, hotspots, openIssues) {
  requireEvidence(summary.issueCount === issues.length && summary.hotspotCount === hotspots.length
    && summary.openIssueCount === openIssues.length, 'finding counts differ');
}

function validateCounts(summary, contents) {
  const issues = JSON.parse(contents['issues.json']);
  const hotspots = JSON.parse(contents['hotspots.json']);
  const partitions = summary.partitions ?? {};
  const openIssues = partitionRecords(issues, partitions.openIssueKeys, partitions.resolvedIssueKeys);
  const toReview = partitionRecords(hotspots, partitions.toReviewHotspotKeys, partitions.reviewedHotspotKeys);
  validateFindingCounts(summary, issues, hotspots, openIssues);
  requireEvidence(openIssues.filter(isBlockingIssue).length === summary.blockerOrCriticalIssueCount
    && toReview.length === summary.toReviewHotspotCount, 'gate counts differ');
  requireEvidence(hotspots.every(item => item.status === 'REVIEWED'), 'unreviewed or unknown hotspot status');
  if (summary.pullRequest) {
    requireEvidence(JSON.stringify(JSON.parse(contents['hotspot-review.json'])) === JSON.stringify(summary.hotspotReview),
      'pull request hotspot review artifact differs');
  }
}

export async function verifySonarEvidence(directory, options = {}) {
  const { expectedRevision } = options;
  const summary = JSON.parse(await readFile(path.join(directory, 'summary.json'), 'utf8'));
  validateSummary(summary, options);
  const contents = await verifiedArtifacts(directory, summary);
  validateCounts(summary, contents);
  return { passed: true, revision: expectedRevision, issueCount: summary.issueCount, hotspotCount: summary.hotspotCount };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await verifySonarEvidence(path.resolve(process.env.SONAR_EXPORT_DIR || 'reports/sonarcloud'), {
      expectedRevision: process.env.SONAR_EXPECTED_REVISION, projectKey: process.env.SONAR_PROJECT_KEY,
      ...sonarScope(process.env)
    });
    console.log('SonarCloud evidence gate passed for the expected revision and analysis scope.');
  } catch {
    console.error('SonarCloud evidence gate failed: missing, inconsistent or blocking evidence.');
    process.exitCode = 1;
  }
}
