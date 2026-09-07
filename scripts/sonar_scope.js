import { sonarGet } from './sonar_read.js';

export function sonarScope(environment) {
  const key = environment.SONAR_PULL_REQUEST?.trim();
  if (!key) return { branch: environment.SONAR_BRANCH?.trim() || 'main', pullRequest: null };
  const branch = environment.SONAR_PULL_REQUEST_BRANCH?.trim();
  const base = environment.SONAR_PULL_REQUEST_BASE?.trim();
  if (!/^[1-9]\d*$/u.test(key) || !branch || !base || environment.SONAR_BRANCH?.trim()) {
    throw new Error('SonarCloud pull request scope requires a numeric key, source and target; it cannot also select a branch.');
  }
  return { branch: null, pullRequest: { key, branch, base } };
}

export function scannerIdentity(context) {
  const properties = {};
  // Never persist the full scanner context: it can contain environment values.
  for (const line of String(context ?? '').split(/\r?\n/u)) {
    const match = /^\s*(?:-\s*)?(sonar\.(?:scm\.revision|pullrequest\.(?:key|branch|base)))=(.*)$/u.exec(line);
    if (match) {
      if (Object.hasOwn(properties, match[1])) throw new Error('SonarCloud scanner identity contains duplicate properties.');
      properties[match[1]] = match[2].trim();
    }
  }
  return {
    revision: properties['sonar.scm.revision'],
    pullRequest: properties['sonar.pullrequest.key'],
    branch: properties['sonar.pullrequest.branch'],
    base: properties['sonar.pullrequest.base']
  };
}

export function validatePullRequestTask(task, configuration) {
  const scope = configuration.pullRequest;
  const identity = task?.scannerIdentity;
  if (!task?.analysisId || identity?.revision !== configuration.expectedRevision
    || identity?.pullRequest !== scope.key || identity?.branch !== scope.branch || identity?.base !== scope.base) {
    throw new Error('SonarCloud compute task does not prove the expected pull request revision and scope.');
  }
}

export async function readPullRequestAnalysis(configuration, computeTask, options) {
  validatePullRequestTask(computeTask, configuration);
  const response = await sonarGet('/api/project_pull_requests/list', { project: configuration.projectKey }, options);
  const scope = configuration.pullRequest;
  const matches = response.pullRequests?.filter(request => request.key === scope.key);
  const request = matches?.[0];
  if (matches?.length !== 1 || request.branch !== scope.branch || request.base !== scope.base
    || request.commit?.sha !== configuration.expectedRevision || !Number.isFinite(Date.parse(request.analysisDate))) {
    throw new Error('Latest SonarCloud pull request analysis does not match the expected revision and scope.');
  }
  return { key: computeTask.analysisId, date: request.analysisDate, revision: request.commit.sha };
}

function metricValue(measures, metric) {
  const entries = measures.filter(measure => measure.metric === metric);
  if (entries.length !== 1) return null;
  const raw = entries[0].value ?? entries[0].period?.value;
  if (typeof raw !== 'string' || !/^\d+(?:\.\d+)?$/u.test(raw)) return null;
  return Number(raw);
}

export async function readPullRequestHotspotReview(configuration, options) {
  const response = await sonarGet('/api/measures/component', {
    component: configuration.projectKey, pullRequest: configuration.pullRequest.key,
    metricKeys: 'new_security_hotspots,new_security_hotspots_reviewed'
  }, options);
  const measures = response.component?.measures;
  if (response.component?.key !== configuration.projectKey || !Array.isArray(measures)) {
    throw new Error('SonarCloud pull request hotspot review evidence is unavailable.');
  }
  const count = metricValue(measures, 'new_security_hotspots');
  const reviewedPercent = metricValue(measures, 'new_security_hotspots_reviewed');
  if (!Number.isSafeInteger(count) || count < 0 || (count > 0 && reviewedPercent !== 100)) {
    throw new Error('SonarCloud pull request hotspots are unreviewed or their review status is unproven.');
  }
  return { pullRequest: configuration.pullRequest.key, count, reviewedPercent, source: 'api/measures/component' };
}
