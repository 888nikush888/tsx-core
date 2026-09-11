import { sonarGet } from './sonar_read.js';

export function sonarScope(environment) {
  const key = environment.SONAR_PULL_REQUEST?.trim();
  if (!key) {
    if (environment.SONAR_BRANCH && /[\s\p{Cc}]|\$\{/u.test(environment.SONAR_BRANCH)) {
      throw new Error('SonarCloud branch refs contain whitespace, control characters or scanner property expressions.');
    }
    return { branch: environment.SONAR_BRANCH || 'main', pullRequest: null };
  }
  const branch = environment.SONAR_PULL_REQUEST_BRANCH?.trim();
  const base = environment.SONAR_PULL_REQUEST_BASE?.trim();
  if (!/^[1-9]\d*$/u.test(key) || !branch || !base || environment.SONAR_BRANCH?.trim()) {
    throw new Error('SonarCloud pull request scope requires a numeric key, source and target; it cannot also select a branch.');
  }
  // The scanner recursively expands ${...}, including inside environment values.
  // Such refs cannot be represented literally without changing their identity.
  if ([environment.SONAR_PULL_REQUEST_BRANCH, environment.SONAR_PULL_REQUEST_BASE]
    .some(ref => /[\s\p{Cc}]|\$\{/u.test(ref))) {
    throw new Error('SonarCloud pull request refs contain whitespace, control characters or scanner property expressions.');
  }
  return { branch: null, pullRequest: { key, branch, base } };
}

export function scannerIdentity(context) {
  const properties = {};
  // Never persist the full scanner context: it can contain environment values.
  for (const line of String(context ?? '').split(/\r?\n/u)) {
    const match = /^\s*(?:-\s*)?(sonar\.(?:scm\.revision|branch\.name|pullrequest\.(?:key|branch|base)))=(.*)$/u.exec(line);
    if (match) {
      if (Object.hasOwn(properties, match[1])) throw new Error('SonarCloud scanner identity contains duplicate properties.');
      properties[match[1]] = match[2].trim();
    }
  }
  return {
    revision: properties['sonar.scm.revision'],
    analysisBranch: properties['sonar.branch.name'],
    pullRequest: properties['sonar.pullrequest.key'],
    branch: properties['sonar.pullrequest.branch'],
    base: properties['sonar.pullrequest.base']
  };
}

export function validateBranchTask(task, configuration) {
  const { analysisId, scannerIdentity: identity = {}, pullRequest } = task ?? {};
  if (!analysisId || identity.revision !== configuration.expectedRevision
    || identity.analysisBranch !== configuration.branch || identity.pullRequest !== undefined
    || identity.branch !== undefined || identity.base !== undefined || pullRequest !== undefined) {
    throw new Error('SonarCloud compute task does not prove the expected branch revision and scope.');
  }
}

export async function readLongBranchIdentity(configuration, analysis, options) {
  const response = await sonarGet('/api/project_branches/list', { project: configuration.projectKey }, options);
  const matches = response.branches?.filter(branch => branch.name === configuration.branch);
  const branch = matches?.[0];
  if (matches?.length !== 1 || branch.type !== 'LONG' || branch.isMain !== false
    || branch.commit?.sha !== configuration.expectedRevision || !Number.isFinite(Date.parse(branch.analysisDate))
    || Date.parse(branch.analysisDate) !== Date.parse(analysis.date)) {
    throw new Error('SonarCloud branch does not prove a full long-lived analysis at the expected revision.');
  }
  return { name: branch.name, type: branch.type, revision: branch.commit.sha, analysisDate: branch.analysisDate };
}

export function validatePullRequestTask(task, configuration) {
  const scope = configuration.pullRequest;
  const { analysisId, scannerIdentity: identity = {} } = task ?? {};
  const checks = [
    ['analysisId', analysisId, Boolean(analysisId)],
    ['revision', identity.revision, identity.revision === configuration.expectedRevision],
    ['pullRequest', identity.pullRequest, identity.pullRequest === scope.key],
    ['branch', identity.branch, identity.branch === scope.branch],
    ['base', identity.base, identity.base === scope.base],
    ['analysisBranch', identity.analysisBranch, identity.analysisBranch === undefined]
  ];
  if (task?.pullRequest !== undefined) checks.push(['task.pullRequest', task.pullRequest, task.pullRequest === scope.key]);
  const failures = checks.filter(([, , matches]) => !matches);
  if (failures.length) {
    // Report only allowlisted field names and presence, never context or values.
    const detail = failures.map(([name, value]) => `${name} ${value ? 'differs' : 'missing'}`).join(', ');
    throw new Error(`SonarCloud compute task does not prove the expected pull request revision and scope: ${detail}.`);
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
  const entries = measures.filter(measure => measure?.metric === metric);
  if (entries.length !== 1) return null;
  const entry = entries[0];
  const shapes = ['value', 'period', 'periods'].filter(key => Object.hasOwn(entry, key));
  if (shapes.length !== 1) return null;
  let raw;
  if (shapes[0] === 'periods') {
    if (!Array.isArray(entry.periods) || entry.periods.length !== 1 || entry.periods[0]?.index !== 1) return null;
    raw = entry.periods[0].value;
  } else if (shapes[0] === 'period') {
    if (!entry.period || Array.isArray(entry.period) || (entry.period.index !== undefined && entry.period.index !== 1)) return null;
    raw = entry.period.value;
  } else raw = entry.value;
  if (typeof raw !== 'string' || !/^\d+(?:\.\d+)?$/u.test(raw)) return null;
  return Number(raw);
}

export async function readPullRequestHotspotReview(configuration, options) {
  const response = await sonarGet('/api/measures/component', {
    component: configuration.projectKey, pullRequest: configuration.pullRequest.key,
    metricKeys: 'new_security_hotspots,new_security_hotspots_reviewed'
  }, options);
  const measures = response.component?.measures;
  if (response.component?.key !== configuration.projectKey || response.component?.pullRequest !== configuration.pullRequest.key
    || !Array.isArray(measures)) {
    throw new Error('SonarCloud pull request hotspot review evidence is unavailable.');
  }
  const count = metricValue(measures, 'new_security_hotspots');
  const reviewedPercent = metricValue(measures, 'new_security_hotspots_reviewed');
  const hasReviewMeasure = measures.some(measure => measure?.metric === 'new_security_hotspots_reviewed');
  if (!Number.isSafeInteger(count) || count < 0 || (count > 0 && reviewedPercent !== 100)
    || (hasReviewMeasure && (reviewedPercent === null || !Number.isFinite(reviewedPercent) || reviewedPercent > 100))) {
    throw new Error('SonarCloud pull request hotspots are unreviewed or their review status is unproven.');
  }
  return { pullRequest: configuration.pullRequest.key, count, reviewedPercent, source: 'api/measures/component' };
}
