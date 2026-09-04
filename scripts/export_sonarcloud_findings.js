import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readOptions, sonarGet } from './sonar_read.js';

const DEFAULT_SONAR_HOST_URL = 'https://sonarcloud.io';
const PAGE_SIZE = 500;

function requiredEnvironment(name, environment) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function validatedPage(response, collectionName, page, total) {
  const records = response[collectionName];
  const paging = response.paging;
  if (!Array.isArray(records) || !Number.isSafeInteger(paging?.total) || paging.total < 0) {
    throw new Error(`SonarCloud returned an invalid ${collectionName} page schema.`);
  }
  if ((paging.pageIndex !== undefined && paging.pageIndex !== page)
    || (total !== undefined && total !== paging.total)) {
    throw new Error(`SonarCloud ${collectionName} pagination changed during export.`);
  }
  if (records.some(record => !record || typeof record.key !== 'string' || !record.key.trim())) {
    throw new Error(`SonarCloud returned an invalid ${collectionName} record.`);
  }
  return records;
}

async function fetchPages(endpoint, parameters, collectionName, options) {
  const records = new Map();
  let total;
  for (let page = 1; ; page += 1) {
    const response = await sonarGet(endpoint, { ...parameters, p: page, ps: PAGE_SIZE }, options);
    const pageRecords = validatedPage(response, collectionName, page, total);
    total = response.paging.total;
    const previousSize = records.size;
    for (const record of pageRecords) {
      if (records.has(record.key)) throw new Error(`SonarCloud ${collectionName} contains duplicate identities.`);
      records.set(record.key, record);
    }
    if (records.size === total) return [...records.values()];
    if (records.size > total || records.size === previousSize) {
      throw new Error(`SonarCloud ${collectionName} pagination is incomplete.`);
    }
  }
}

function tsvValue(value) {
  const serialized = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
  return serialized.replaceAll('\t', ' ').replaceAll('\r', ' ').replaceAll('\n', ' ');
}

export function toTsv(records, columns) {
  const header = columns.join('\t');
  const rows = records.map(record => columns.map(column => tsvValue(record[column])).join('\t'));
  return `${[header, ...rows].join('\n')}\n`;
}

function exporterConfiguration(environment) {
  const hostUrl = new URL(environment.SONAR_HOST_URL?.trim() || DEFAULT_SONAR_HOST_URL);
  if (hostUrl.protocol !== 'https:' || hostUrl.username || hostUrl.password || hostUrl.search || hostUrl.hash) {
    throw new Error('SONAR_HOST_URL must be an HTTPS origin without credentials or query parameters.');
  }
  const expectedRevision = requiredEnvironment('SONAR_EXPECTED_REVISION', environment);
  if (!/^[a-f0-9]{40}$/u.test(expectedRevision)) throw new Error('SONAR_EXPECTED_REVISION must be an exact 40-character SHA.');
  return {
    token: requiredEnvironment('SONAR_TOKEN', environment),
    projectKey: requiredEnvironment('SONAR_PROJECT_KEY', environment),
    hostUrl: hostUrl.origin,
    branch: environment.SONAR_BRANCH?.trim() || 'main',
    expectedRevision,
    outputDirectory: path.resolve(environment.SONAR_EXPORT_DIR?.trim() || 'reports/sonarcloud'),
    reportTaskFile: path.resolve(environment.SONAR_REPORT_TASK_FILE?.trim() || '.scannerwork/report-task.txt')
  };
}

function parseReportTask(text) {
  const properties = {};
  for (const line of text.split(/\r?\n/u)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    properties[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return properties;
}

function safeDiagnosticMessage(value, token = '') {
  let text = String(value ?? '').replaceAll(/https?:\/\/[^\s]+/gu, '[redacted URL]')
    .replaceAll(/\b(?:Bearer|Basic)\s+\S+/giu, '[redacted authorization]')
    .replaceAll(/authorization\s*[:=]\s*\S+/giu, '[redacted authorization]');
  if (token) text = text.replaceAll(token, '[redacted]').replaceAll(encodeURIComponent(token), '[redacted]');
  return text.replaceAll('\r', ' ').replaceAll('\n', ' ').slice(0, 4_000);
}

function computeTaskEvidence(task, token) {
  return {
    id: task.id,
    type: task.type,
    componentKey: task.componentKey,
    analysisId: task.analysisId,
    status: task.status,
    submittedAt: task.submittedAt,
    startedAt: task.startedAt,
    executedAt: task.executedAt,
    executionTimeMs: task.executionTimeMs,
    warningCount: task.warningCount,
    errorMessage: task.errorMessage ? safeDiagnosticMessage(task.errorMessage, token) : null,
    hasErrorStacktrace: Boolean(task.errorStacktrace)
  };
}

function validatedComputeTaskUrl(properties, configuration) {
  if (!properties.ceTaskUrl) throw new Error('SonarCloud report-task.txt contains no ceTaskUrl.');
  const taskUrl = new URL(properties.ceTaskUrl);
  const allowedOrigin = new URL(configuration.hostUrl).origin;
  if (taskUrl.origin !== allowedOrigin || taskUrl.pathname !== '/api/ce/task' || taskUrl.username || taskUrl.password) {
    throw new Error('SonarCloud report-task.txt contains an untrusted ceTaskUrl.');
  }
  return taskUrl;
}

async function readComputeTask(configuration, options) {
  let reportTask;
  try {
    reportTask = await readFile(configuration.reportTaskFile, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' && !options.requireComputeTask) return null;
    throw error;
  }

  const properties = parseReportTask(reportTask);
  const taskUrl = validatedComputeTaskUrl(properties, configuration);

  const response = await sonarGet(taskUrl.toString(), {}, options);
  if (!response.task?.id || !response.task.status) throw new Error('SonarCloud returned an invalid compute task.');
  if (response.task.componentKey && response.task.componentKey !== configuration.projectKey) {
    throw new Error('SonarCloud compute task belongs to a different project.');
  }

  const evidence = computeTaskEvidence(response.task, configuration.token);
  await writeFile(path.join(configuration.outputDirectory, 'ce-task.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  if (evidence.status !== 'SUCCESS') {
    const detail = evidence.errorMessage || `terminal status is '${evidence.status}'`;
    throw new Error(`SonarCloud compute task '${evidence.id}' failed: ${detail}`);
  }
  return evidence;
}

function validatedAnalysis(analysisResponse, configuration) {
  const analysis = analysisResponse.analyses?.[0];
  if (!analysis?.key || !/^[a-f0-9]{40}$/u.test(analysis?.revision ?? '')) {
    throw new Error(`SonarCloud returned no revision for the latest '${configuration.branch}' analysis.`);
  }
  if (configuration.expectedRevision && analysis.revision !== configuration.expectedRevision) {
    throw new Error('Latest SonarCloud revision does not match SONAR_EXPECTED_REVISION.');
  }
  return analysis;
}

function exportSummary(configuration, analysis, findings, qualityGate, computeTask, generatedAt) {
  const expectedRevision = configuration.expectedRevision;
  return {
    generatedAt,
    schemaVersion: 1,
    complete: true,
    analysisStableDuringCapture: true,
    host: configuration.hostUrl,
    projectKey: configuration.projectKey,
    branch: configuration.branch,
    analysis: {
      key: analysis.key,
      date: analysis.date,
      revision: analysis.revision,
      projectVersion: analysis.projectVersion
    },
    expectedRevision: expectedRevision || null,
    revisionMatchesExpectation: expectedRevision ? analysis.revision === expectedRevision : null,
    computeTask,
    issueCount: findings.issues.length,
    hotspotCount: findings.hotspots.length,
    openIssueCount: findings.openIssues.length,
    blockerOrCriticalIssueCount: findings.openIssues.filter(isBlockingIssue).length,
    toReviewHotspotCount: findings.toReviewHotspots.length,
    partitions: findings.partitions,
    qualityGate: qualityGate.projectStatus
  };
}

export function isBlockingIssue(issue) {
  return ['BLOCKER', 'CRITICAL'].includes(issue.severity)
    || (issue.impacts ?? []).some(impact => ['BLOCKER', 'HIGH'].includes(impact.severity));
}

function validateFindings(issues, hotspots) {
  const legacySeverities = ['INFO', 'MINOR', 'MAJOR', 'CRITICAL', 'BLOCKER'];
  const impactSeverities = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'BLOCKER'];
  for (const issue of issues) {
    const validImpacts = Array.isArray(issue.impacts)
      && issue.impacts.every(impact => impact && impactSeverities.includes(impact.severity));
    const classified = legacySeverities.includes(issue.severity) || (validImpacts && issue.impacts.length > 0);
    if (!classified || (issue.impacts !== undefined && !validImpacts)) {
      throw new Error('SonarCloud returned an invalid issue severity schema.');
    }
  }
  if (hotspots.some(hotspot => !['TO_REVIEW', 'REVIEWED'].includes(hotspot.status))) {
    throw new Error('SonarCloud returned an invalid hotspot status schema.');
  }
  for (const records of [issues, hotspots]) {
    if (new Set(records.map(record => record.key)).size !== records.length) {
      throw new Error('SonarCloud contains duplicate identities across status partitions.');
    }
  }
}

async function collectFindings(configuration, options) {
  const issueParameters = { componentKeys: configuration.projectKey, branch: configuration.branch };
  const hotspotParameters = { projectKey: configuration.projectKey, branch: configuration.branch };
  const openIssues = await fetchPages('/api/issues/search', { ...issueParameters, resolved: false }, 'issues', options);
  const resolvedIssues = await fetchPages('/api/issues/search', { ...issueParameters, resolved: true }, 'issues', options);
  const toReviewHotspots = await fetchPages('/api/hotspots/search', { ...hotspotParameters, status: 'TO_REVIEW' }, 'hotspots', options);
  const reviewedHotspots = await fetchPages('/api/hotspots/search', { ...hotspotParameters, status: 'REVIEWED' }, 'hotspots', options);
  const issues = [...openIssues, ...resolvedIssues];
  const hotspots = [...toReviewHotspots, ...reviewedHotspots];
  validateFindings(issues, hotspots);
  if (toReviewHotspots.some(item => item.status !== 'TO_REVIEW') || reviewedHotspots.some(item => item.status !== 'REVIEWED')) {
    throw new Error('SonarCloud hotspot status does not match its requested partition.');
  }
  return {
    issues, hotspots, openIssues, toReviewHotspots,
    partitions: {
      openIssueKeys: openIssues.map(item => item.key), resolvedIssueKeys: resolvedIssues.map(item => item.key),
      toReviewHotspotKeys: toReviewHotspots.map(item => item.key), reviewedHotspotKeys: reviewedHotspots.map(item => item.key)
    }
  };
}

async function writeArtifacts(configuration, findings, summary) {
  const issueColumns = ['key', 'type', 'severity', 'impacts', 'rule', 'component', 'line', 'message', 'status', 'creationDate', 'updateDate'];
  const hotspotColumns = ['key', 'vulnerabilityProbability', 'securityCategory', 'component', 'line', 'message', 'status', 'creationDate', 'updateDate'];
  const artifacts = {
    'issues.json': `${JSON.stringify(findings.issues, null, 2)}\n`,
    'hotspots.json': `${JSON.stringify(findings.hotspots, null, 2)}\n`,
    'issues.tsv': toTsv(findings.issues, issueColumns),
    'hotspots.tsv': toTsv(findings.hotspots, hotspotColumns),
    'open-issues.tsv': toTsv(findings.openIssues, issueColumns),
    'to-review-hotspots.tsv': toTsv(findings.toReviewHotspots, hotspotColumns)
  };
  summary.artifacts = {};
  for (const [name, content] of Object.entries(artifacts)) {
    await writeFile(path.join(configuration.outputDirectory, name), content, 'utf8');
    summary.artifacts[name] = { sha256: createHash('sha256').update(content).digest('hex'), bytes: Buffer.byteLength(content) };
  }
  // The completion marker is written only after every artifact is persisted.
  await writeFile(path.join(configuration.outputDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
}

export async function exportFindings({ environment = process.env, fetchImpl = fetch, now = () => new Date(), ...dependencies } = {}) {
  const configuration = exporterConfiguration(environment);
  const options = readOptions(configuration, {
    ...dependencies, fetchImpl, now, requireComputeTask: environment.SONAR_REQUIRE_COMPUTE_TASK === 'true'
  });
  await mkdir(configuration.outputDirectory, { recursive: true });
  await rm(path.join(configuration.outputDirectory, 'summary.json'), { force: true });
  const computeTask = await readComputeTask(configuration, options);
  const analysisParameters = { project: configuration.projectKey, branch: configuration.branch, ps: 1 };
  const analysisResponse = await sonarGet('/api/project_analyses/search', analysisParameters, options);
  const analysis = validatedAnalysis(analysisResponse, configuration);
  if (computeTask && computeTask.analysisId !== analysis.key) throw new Error('SonarCloud compute task analysis does not match the latest revision.');
  const findings = await collectFindings(configuration, options);
  const qualityGate = await sonarGet('/api/qualitygates/project_status', { analysisId: analysis.key }, options);
  if (!['OK', 'WARN', 'ERROR', 'NONE'].includes(qualityGate.projectStatus?.status)
    || !Array.isArray(qualityGate.projectStatus.conditions)) throw new Error('SonarCloud returned an invalid quality gate schema.');
  const finalAnalysis = validatedAnalysis(await sonarGet('/api/project_analyses/search', analysisParameters, options), configuration);
  if (analysis.key !== finalAnalysis.key) throw new Error('SonarCloud analysis changed during export.');
  const summary = exportSummary(configuration, analysis, findings, qualityGate, computeTask, now().toISOString());
  await writeArtifacts(configuration, findings, summary);
  return summary;
}

const isDirectExecution = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectExecution) {
  try {
    const summary = await exportFindings();
    console.log(`SonarCloud export complete: ${summary.openIssueCount} open issues, ${summary.toReviewHotspotCount} hotspots to review.`);
  } catch (error) {
    console.error(`SonarCloud export failed: ${safeDiagnosticMessage(error?.message || error, process.env.SONAR_TOKEN)}`);
    process.exitCode = 1;
  }
}
