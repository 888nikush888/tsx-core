import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_SONAR_HOST_URL = 'https://sonarcloud.io';
const PAGE_SIZE = 500;

function requiredEnvironment(name, environment) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function sonarGet(endpoint, parameters, options) {
  const url = new URL(endpoint, options.hostUrl);
  for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, String(value));
  const response = await options.fetchImpl(url, {
    headers: { accept: 'application/json', authorization: `Bearer ${options.token}` },
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`SonarCloud ${endpoint} failed with HTTP ${response.status}.`);
  return response.json();
}

async function fetchPages(endpoint, parameters, collectionName, options) {
  const records = [];
  for (let page = 1; ; page += 1) {
    const response = await sonarGet(endpoint, { ...parameters, p: page, ps: PAGE_SIZE }, options);
    const pageRecords = response[collectionName] || [];
    records.push(...pageRecords);
    if (records.length >= (response.paging?.total ?? pageRecords.length) || pageRecords.length === 0) return records;
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
  return {
    token: requiredEnvironment('SONAR_TOKEN', environment),
    projectKey: requiredEnvironment('SONAR_PROJECT_KEY', environment),
    hostUrl: environment.SONAR_HOST_URL?.trim() || DEFAULT_SONAR_HOST_URL,
    branch: environment.SONAR_BRANCH?.trim() || 'main',
    expectedRevision: environment.SONAR_EXPECTED_REVISION?.trim(),
    outputDirectory: path.resolve(environment.SONAR_EXPORT_DIR?.trim() || 'reports/sonarcloud')
  };
}

function validatedAnalysis(analysisResponse, configuration) {
  const analysis = analysisResponse.analyses?.[0];
  if (!analysis?.revision) {
    throw new Error(`SonarCloud returned no revision for the latest '${configuration.branch}' analysis.`);
  }
  if (configuration.expectedRevision && analysis.revision !== configuration.expectedRevision) {
    throw new Error(`Latest SonarCloud revision '${analysis.revision}' does not match SONAR_EXPECTED_REVISION.`);
  }
  return analysis;
}

function exportSummary(configuration, analysis, issues, hotspots, qualityGate, generatedAt) {
  const expectedRevision = configuration.expectedRevision;
  return {
    generatedAt,
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
    openIssueCount: issues.length,
    toReviewHotspotCount: hotspots.length,
    qualityGate: qualityGate.projectStatus
  };
}

export async function exportFindings({ environment = process.env, fetchImpl = fetch, now = () => new Date() } = {}) {
  const configuration = exporterConfiguration(environment);
  const options = { fetchImpl, hostUrl: configuration.hostUrl, token: configuration.token };

  const analysisResponse = await sonarGet('/api/project_analyses/search', {
    project: configuration.projectKey, branch: configuration.branch, ps: 1
  }, options);
  const analysis = validatedAnalysis(analysisResponse, configuration);

  const issues = await fetchPages('/api/issues/search', {
    componentKeys: configuration.projectKey, branch: configuration.branch, resolved: false
  }, 'issues', options);
  const hotspots = await fetchPages('/api/hotspots/search', {
    projectKey: configuration.projectKey, branch: configuration.branch, status: 'TO_REVIEW'
  }, 'hotspots', options);
  const qualityGate = await sonarGet('/api/qualitygates/project_status', {
    projectKey: configuration.projectKey, branch: configuration.branch
  }, options);
  const summary = exportSummary(configuration, analysis, issues, hotspots, qualityGate, now().toISOString());

  await mkdir(configuration.outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(path.join(configuration.outputDirectory, 'open-issues.tsv'), toTsv(issues, [
      'key', 'type', 'severity', 'impacts', 'rule', 'component', 'line', 'message', 'status', 'creationDate', 'updateDate'
    ]), 'utf8'),
    writeFile(path.join(configuration.outputDirectory, 'to-review-hotspots.tsv'), toTsv(hotspots, [
      'key', 'vulnerabilityProbability', 'securityCategory', 'component', 'line', 'message', 'status', 'creationDate', 'updateDate'
    ]), 'utf8'),
    writeFile(path.join(configuration.outputDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  ]);
  return summary;
}

const isDirectExecution = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectExecution) {
  try {
    const summary = await exportFindings();
    console.log(`SonarCloud export complete: ${summary.openIssueCount} open issues, ${summary.toReviewHotspotCount} hotspots to review.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
