import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_CHECKS = [
  'Lint, tests, coverage, build, supply chain',
  'SonarQube Cloud quality gate',
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
  'Container build, SBOM, vulnerability scan',
];
const GITHUB_ACTIONS_APP_ID = 15368;

function check(name, passed, actual) {
  return { name, passed: Boolean(passed), actual };
}

function statusCheckResults(protection) {
  const statusChecks = protection.required_status_checks || {};
  const configuredChecks = statusChecks.checks || [];
  const contexts = new Set([
    ...(statusChecks.contexts || []),
    ...configuredChecks.map(item => item.context),
  ]);
  return [
    check('Required status checks use the latest base branch', statusChecks.strict === true, statusChecks.strict),
    ...REQUIRED_CHECKS.map(required => check(`Required check: ${required}`, contexts.has(required), [...contexts])),
    ...REQUIRED_CHECKS.map(required => check(
      `Required check source: ${required}`,
      configuredChecks.some(item => item.context === required && item.app_id === GITHUB_ACTIONS_APP_ID),
      configuredChecks.find(item => item.context === required) ?? null
    )),
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
    check('Branch deletion is disabled', protection.allow_deletions?.enabled !== true, protection.allow_deletions?.enabled),
  ];
}

function repositoryResults(repository) {
  const security = repository.security_and_analysis || {};
  return [
    check('Default branch is main', repository.default_branch === 'main', repository.default_branch),
    check('Merge commits are enabled', repository.allow_merge_commit === true, repository.allow_merge_commit),
    check('Squash merges are disabled', repository.allow_squash_merge === false, repository.allow_squash_merge),
    check('Rebase merges are disabled', repository.allow_rebase_merge === false, repository.allow_rebase_merge),
    check('Dependency graph is enabled', security.dependency_graph?.status === 'enabled', security.dependency_graph?.status),
    check('Secret scanning is enabled', security.secret_scanning?.status === 'enabled', security.secret_scanning?.status),
    check('Secret push protection is enabled', security.secret_scanning_push_protection?.status === 'enabled', security.secret_scanning_push_protection?.status),
  ];
}

function usesCustomBranchPolicy(environment) {
  const policy = environment?.deployment_branch_policy;
  return policy?.custom_branch_policies === true && policy?.protected_branches === false;
}

function isRestrictedToMain(policies) {
  if (!Array.isArray(policies) || policies.length !== 1) return false;
  const [policy] = policies;
  return policy?.name === 'main' && policy?.type === 'branch';
}

function productionEnvironmentResults(environments, productionEnvironmentPolicies) {
  const configured = environments.environments || [];
  const names = new Set(configured.map(item => item.name));
  const production = configured.find(item => item.name === 'production-observer');
  const policies = productionEnvironmentPolicies?.branch_policies || [];
  return [
    check('Staging environment exists', names.has('staging'), [...names]),
    check('Production observer environment exists', Boolean(production), production?.name ?? null),
    check(
      'Production observer uses custom branch policies',
      usesCustomBranchPolicy(production),
      production?.deployment_branch_policy ?? null
    ),
    check(
      'Production observer is restricted exactly to main',
      isRestrictedToMain(policies),
      policies
    ),
  ];
}

export function evaluateGithubGovernance({
  repository,
  protection,
  environments,
  productionEnvironmentPolicies,
  codeowners,
  codeownerErrors,
}) {
  const hasOwnerRule = codeowners.split(/\r?\n/).some(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return false;
    return trimmed.split(/\s+/).slice(1).some(value => value.startsWith('@') && value.length > 1);
  });
  const checks = [
    check('CODEOWNERS exists and contains an owner rule', hasOwnerRule, codeowners ? 'present' : 'missing'),
    check('CODEOWNERS has no platform parse errors', Array.isArray(codeownerErrors) && codeownerErrors.length === 0, codeownerErrors),
    ...statusCheckResults(protection),
    ...reviewResults(protection),
    ...repositoryResults(repository),
    ...productionEnvironmentResults(environments, productionEnvironmentPolicies),
  ];
  return { passed: checks.every(item => item.passed), checks };
}

async function githubJson(pathSegments, token, query = {}) {
  const encodedPath = pathSegments.map(segment => encodeURIComponent(segment)).join('/');
  const url = new URL(encodedPath, 'https://api.github.com/');
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, String(value));
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2026-03-10',
      'User-Agent': 'tsx-core-quality-gate',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub governance query failed with HTTP ${response.status}.`);
  return response.json();
}

async function main() {
  const repositoryName = process.env.GITHUB_REPOSITORY || '';
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryName) || token.length < 20) {
    throw new Error('GITHUB_REPOSITORY and GH_TOKEN are required for the repository governance gate.');
  }
  const [owner, repositorySlug] = repositoryName.split('/');
  const repositoryPath = ['repos', owner, repositorySlug];
  const repository = await githubJson(repositoryPath, token);
  const branch = repository.default_branch;
  const [protection, environments, codeownerErrors, productionEnvironmentPolicies] = await Promise.all([
    githubJson([...repositoryPath, 'branches', branch, 'protection'], token),
    githubJson([...repositoryPath, 'environments'], token, { per_page: '100' }),
    githubJson([...repositoryPath, 'codeowners', 'errors'], token, { ref: branch }),
    githubJson([...repositoryPath, 'environments', 'production-observer', 'deployment-branch-policies'], token),
  ]);
  const codeowners = await readFile(path.resolve('.github', 'CODEOWNERS'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const result = evaluateGithubGovernance({
    repository,
    protection,
    environments,
    productionEnvironmentPolicies,
    codeowners,
    codeownerErrors,
  });
  const evidence = {
    schemaVersion: 1,
    repository: repositoryName,
    branch: repository.default_branch,
    evaluatedAt: new Date().toISOString(),
    ...result,
  };
  await mkdir(path.resolve('reports', 'governance'), { recursive: true });
  await writeFile(
    path.resolve('reports', 'governance', 'github-governance.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
  for (const item of result.checks) console.log(`${item.passed ? 'PASS' : 'FAIL'} ${item.name}`);
  if (!result.passed) throw new Error('GitHub repository governance gate failed.');
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    await main();
  } catch {
    console.error('GitHub governance gate failed.');
    process.exitCode = 1;
  }
}
