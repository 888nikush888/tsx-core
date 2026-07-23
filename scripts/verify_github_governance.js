import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_CHECKS = [
  'Lint, tests, coverage, build, supply chain',
  'Critical mutation gate (queue)',
  'Critical mutation gate (retry)',
  'Critical mutation gate (schema)',
  'Critical mutation gate (trading-risk)',
  'Browser and accessibility gate (chromium)',
  'Browser and accessibility gate (firefox)',
  'Browser and accessibility gate (webkit)',
  'Browser and accessibility gate (mobile-chromium)',
  'CodeQL SAST',
  'Secret history scan',
  'Dependency review',
  'Container build, SBOM, vulnerability scan'
];

function check(name, passed, actual) {
  return { name, passed: Boolean(passed), actual };
}

function statusCheckResults(protection) {
  const statusChecks = protection.required_status_checks || {};
  const contexts = new Set([...(statusChecks.contexts || []), ...(statusChecks.checks || []).map(item => item.context)]);
  return [
    check('Required status checks use the latest base branch', statusChecks.strict === true, statusChecks.strict),
    ...REQUIRED_CHECKS.map(required => check(`Required check: ${required}`, contexts.has(required), [...contexts]))
  ];
}

function reviewResults(protection) {
  const reviews = protection.required_pull_request_reviews || {};
  return [
    check('At least two approvals are required', reviews.required_approving_review_count >= 2, reviews.required_approving_review_count),
    check('Stale approvals are dismissed', reviews.dismiss_stale_reviews === true, reviews.dismiss_stale_reviews),
    check('CODEOWNERS approval is required', reviews.require_code_owner_reviews === true, reviews.require_code_owner_reviews),
    check('Last-push approval is required', reviews.require_last_push_approval === true, reviews.require_last_push_approval),
    check('Administrators are protected', protection.enforce_admins?.enabled === true, protection.enforce_admins?.enabled),
    check('Conversation resolution is required', protection.required_conversation_resolution?.enabled === true, protection.required_conversation_resolution?.enabled),
    check('Force pushes are disabled', protection.allow_force_pushes?.enabled !== true, protection.allow_force_pushes?.enabled),
    check('Branch deletion is disabled', protection.allow_deletions?.enabled !== true, protection.allow_deletions?.enabled)
  ];
}

function securityResults(repository) {
  const security = repository.security_and_analysis || {};
  return [
    check('Dependency graph is enabled', security.dependency_graph?.status === 'enabled', security.dependency_graph?.status),
    check('Secret scanning is enabled', security.secret_scanning?.status === 'enabled', security.secret_scanning?.status),
    check('Secret push protection is enabled', security.secret_scanning_push_protection?.status === 'enabled', security.secret_scanning_push_protection?.status)
  ];
}

function environmentResults(environments) {
  const environmentNames = new Set((environments.environments || []).map(item => item.name));
  return [
    check('Staging environment exists', environmentNames.has('staging'), [...environmentNames]),
    check('Production observer environment exists', environmentNames.has('production-observer'), [...environmentNames])
  ];
}

export function evaluateGithubGovernance({ repository, protection, environments, codeowners, codeownerErrors }) {
  const checks = [
    check('CODEOWNERS exists and contains an owner rule', /^(?!#).*\s+@[^\s]+/m.test(codeowners), codeowners ? 'present' : 'missing'),
    check('CODEOWNERS has no platform parse errors', Array.isArray(codeownerErrors) && codeownerErrors.length === 0, codeownerErrors),
    ...statusCheckResults(protection),
    ...reviewResults(protection),
    ...securityResults(repository),
    ...environmentResults(environments)
  ];
  return { passed: checks.every(item => item.passed), checks };
}

async function githubJson(endpoint, token) {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2026-03-10',
      'User-Agent': 'telegram-forwarder-quality-gate'
    },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`GitHub governance query ${endpoint} failed with HTTP ${response.status}.`);
  return response.json();
}

async function main() {
  const repositoryName = process.env.GITHUB_REPOSITORY || '';
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryName) || token.length < 20) {
    throw new Error('GITHUB_REPOSITORY and GH_TOKEN are required for the repository governance gate.');
  }
  const repository = await githubJson(`/repos/${repositoryName}`, token);
  const branch = encodeURIComponent(repository.default_branch);
  const [protection, environments, codeownerErrors] = await Promise.all([
    githubJson(`/repos/${repositoryName}/branches/${branch}/protection`, token),
    githubJson(`/repos/${repositoryName}/environments?per_page=100`, token),
    githubJson(`/repos/${repositoryName}/codeowners/errors?ref=${branch}`, token)
  ]);
  const codeowners = await readFile(path.resolve('.github', 'CODEOWNERS'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const result = evaluateGithubGovernance({ repository, protection, environments, codeowners, codeownerErrors });
  const evidence = { schemaVersion: 1, repository: repositoryName, branch: repository.default_branch, evaluatedAt: new Date().toISOString(), ...result };
  await mkdir(path.resolve('reports', 'governance'), { recursive: true });
  await writeFile(path.resolve('reports', 'governance', 'github-governance.json'), `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  for (const item of result.checks) console.log(`${item.passed ? 'PASS' : 'FAIL'} ${item.name}`);
  if (!result.passed) throw new Error('GitHub repository governance gate failed.');
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
