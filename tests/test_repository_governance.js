import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  resolveGitExecutable,
  riskLevel,
  scorePullRequest,
} from '../scripts/calculate_pr_risk.js';
import { evaluateGithubGovernance } from '../scripts/verify_github_governance.js';

const EXCLUDED_ENCODING_DIRECTORIES = new Set([
  '.git', 'coverage', 'coverage-modules', 'dist', 'node_modules', 'reports',
]);
const ANALYZED_TEXT_EXTENSIONS = new Set([
  '.css', '.html', '.in', '.js', '.json', '.lock', '.md', '.mjs', '.properties',
  '.py', '.sh', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml',
]);
const ANALYZED_TEXT_BASENAMES = new Set([
  '.dockerignore', '.editorconfig', '.env.example', '.gitattributes', '.gitignore', '.npmrc',
  'config.json.example', 'Dockerfile', 'LICENSE', 'Makefile',
]);

function isAnalyzedTextFile(fileName) {
  return ANALYZED_TEXT_BASENAMES.has(fileName)
    || ANALYZED_TEXT_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

async function assertUtf8Tree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_ENCODING_DIRECTORIES.has(entry.name)) continue;
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) await assertUtf8Tree(filePath);
    if (!entry.isFile() || !isAnalyzedTextFile(entry.name)) continue;
    const bytes = await readFile(filePath);
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    assert.doesNotMatch(
      content,
      /\uFFFD|\u00C3.|\u00E2\u20AC|\u00C2.|\u00F0\u0178/,
      `${filePath} contains damaged Unicode text.`
    );
  }
}

assert.equal(riskLevel(4), 'standard-review');
assert.equal(riskLevel(5), 'senior-review');
assert.equal(riskLevel(10), 'security-architecture-review-and-rollback');
assert.equal(riskLevel(15), 'critical-staging-and-explicit-approval');

assert.equal(
  resolveGitExecutable({
    platform: 'win32',
    fileExists: candidate => candidate === String.raw`C:\Program Files\Git\cmd\git.exe`,
  }),
  String.raw`C:\Program Files\Git\cmd\git.exe`,
  'Windows Git resolution must stay inside the protected Program Files locations.'
);
assert.equal(
  resolveGitExecutable({ platform: 'linux', fileExists: candidate => candidate === '/usr/bin/git' }),
  '/usr/bin/git',
  'POSIX Git resolution must use the protected system location.'
);
assert.throws(
  () => resolveGitExecutable({ platform: 'linux', fileExists: () => false }),
  /trusted absolute installation location/,
  'Missing protected Git installations must fail closed instead of falling back to PATH.'
);

const critical = scorePullRequest([
  { path: 'src/dashboard_auth.ts', status: 'M', additions: 400, deletions: 150 },
  { path: 'package.json', status: 'M', additions: 2, deletions: 1 },
]);
assert.ok(critical.score >= 15);
assert.ok(critical.factors.some(factor => factor.id === 'production-verification'));
assert.ok(critical.factors.some(factor => factor.id === 'large-change'));

const databaseChange = scorePullRequest([
  { path: 'src/db.ts', status: 'M', additions: 5, deletions: 1 },
]);
for (const untrustedTestMetadata of [
  { path: 'tests/test_unrelated.js', status: 'A', additions: 5, deletions: 0 },
  { path: 'tests/test_db.js', status: 'D', additions: 0, deletions: 5 },
  { path: 'tests/test_db.js', status: 'A', additions: 1, deletions: 0 },
]) {
  const attempt = scorePullRequest([
    { path: 'src/db.ts', status: 'M', additions: 5, deletions: 1 },
    untrustedTestMetadata,
  ]);
  assert.equal(attempt.score, databaseChange.score);
}

for (const criticalRuntimePath of [
  'src/secret_store.ts',
  'src/runtime_settings.ts',
  'src/trading_engine.ts',
  'src/mcp_control_bridge.ts',
  'src/mcp_server.ts',
  'src/mcp_repository.ts',
  'src/factory_reset_paths.ts',
  'src/exchange_stream_repository.ts',
  'src/trade_journal.ts',
  'src/signal_contract.ts',
  'src/trading_web_control.ts',
  'frontend/src/lib/api.ts',
  'frontend/src/components/dashboard-auth-gate.tsx',
]) {
  const evaluation = scorePullRequest([
    { path: criticalRuntimePath, status: 'M', additions: 1, deletions: 1 },
  ]);
  assert.ok(evaluation.score >= 10, `${criticalRuntimePath} must remain high risk.`);
  assert.ok(evaluation.factors.some(factor => factor.id === 'critical-domain'));
}

for (const governancePath of [
  '.github/workflows/quality.yml',
  '.github/workflows/staging.yml',
  '.github/workflows/production_evidence.yml',
  '.github/workflows/synthetic.yml',
  '.github/CODEOWNERS',
  '.github/dependabot.yml',
  '.gitleaks.toml',
  'sonar-project.properties',
  '.editorconfig',
  '.dockerignore',
  'package.json',
  'package-lock.json',
  'frontend/package.json',
  'frontend/package-lock.json',
  'frontend/index.html',
  'frontend/.oxlintrc.json',
  'frontend/postcss.config.js',
  'frontend/tailwind.config.js',
  'quality-baseline.json',
  'coverage-baseline.json',
  'c8.critical.json',
  'c8.modules.json',
  'stryker.config.mjs',
  'eslint.config.js',
  'tsconfig.json',
  'frontend/playwright.config.ts',
  'frontend/vite.config.ts',
  'tests/run_all.js',
  'tests/test_supply_chain.js',
  'monitoring/rules.yml',
  'monitoring/vex/example.openvex.json',
  'monitoring/alertmanager.Dockerfile',
  'Dockerfile',
  'docker-compose.yml',
  'exchange_executor/requirements.lock',
  'config/runtime-settings.json',
]) {
  const evaluation = scorePullRequest([
    { path: governancePath, status: 'M', additions: 1, deletions: 1 },
  ]);
  assert.ok(evaluation.score >= 10, `${governancePath} must remain high risk.`);
  assert.ok(evaluation.factors.some(factor => factor.id === 'governance-control'));
}

const REQUIRED_CONTEXTS = [
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
const validGovernance = {
  repository: {
    default_branch: 'main',
    allow_merge_commit: true,
    allow_squash_merge: false,
    allow_rebase_merge: false,
    security_and_analysis: {
      dependency_graph: { status: 'enabled' },
      secret_scanning: { status: 'enabled' },
      secret_scanning_push_protection: { status: 'enabled' },
    },
  },
  protection: {
    required_status_checks: {
      strict: true,
      contexts: REQUIRED_CONTEXTS,
      checks: REQUIRED_CONTEXTS.map(context => ({ context, app_id: 15368 })),
    },
    required_pull_request_reviews: {
      required_approving_review_count: 2,
      dismiss_stale_reviews: true,
      require_code_owner_reviews: true,
      require_last_push_approval: true,
    },
    enforce_admins: { enabled: true },
    required_conversation_resolution: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
  },
  environments: {
    environments: [
      { name: 'staging' },
      {
        name: 'production-observer',
        deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
      },
    ],
  },
  productionEnvironmentPolicies: {
    branch_policies: [{ name: 'main', type: 'branch' }],
  },
  codeowners: '* @888nikush888\n',
  codeownerErrors: [],
};

const governance = evaluateGithubGovernance(validGovernance);
assert.equal(governance.passed, true);
assert.equal(governance.checks.filter(item => item.name.startsWith('Required check:')).length, 14);
assert.equal(governance.checks.filter(item => item.name.startsWith('Required check source:')).length, 14);

const wrongSource = structuredClone(validGovernance);
wrongSource.protection.required_status_checks.checks[0].app_id = 999;
assert.equal(evaluateGithubGovernance(wrongSource).passed, false);
const wrongDefault = structuredClone(validGovernance);
wrongDefault.repository.default_branch = 'not-main';
assert.equal(evaluateGithubGovernance(wrongDefault).passed, false);
const tagPolicy = structuredClone(validGovernance);
tagPolicy.productionEnvironmentPolicies.branch_policies = [{ name: 'main', type: 'tag' }];
assert.equal(evaluateGithubGovernance(tagPolicy).passed, false);
const missingOwner = structuredClone(validGovernance);
missingOwner.codeowners = '# no owner\n';
assert.equal(evaluateGithubGovernance(missingOwner).passed, false);

const [workflow, codeowners, sonarCloud, editorConfig, gitAttributes, nodeVersion, pythonVersion, npmConfig] = await Promise.all([
  readFile('.github/workflows/quality.yml', 'utf8'),
  readFile('.github/CODEOWNERS', 'utf8'),
  readFile('sonar-project.properties', 'utf8'),
  readFile('.editorconfig', 'utf8'),
  readFile('.gitattributes', 'utf8'),
  readFile('.nvmrc', 'utf8'),
  readFile('.python-version', 'utf8'),
  readFile('.npmrc', 'utf8'),
]);
assert.equal(nodeVersion.trim(), '22', 'Local Node version managers must select the supported major.');
assert.equal(pythonVersion.trim(), '3.12', 'Local Python version managers must select the CI runtime.');
assert.match(npmConfig, /^engine-strict=true$/m, 'npm installs must reject unsupported runtimes.');
assert.match(codeowners, /^\*\s+@888nikush888\s*$/m);
assert.doesNotMatch(workflow, /^\s{2}release:\s*$/m);
assert.doesNotMatch(workflow, /create-github-app-token|PR risk approval gate|release-governance|pr-risk-publisher/);
assert.match(sonarCloud, /^sonar\.python\.version=3\.12$/m);
assert.match(sonarCloud, /^sonar\.javascript\.lcov\.reportPaths=coverage\/lcov\.info,frontend\/coverage\/lcov\.info$/m);
assert.match(sonarCloud, /^sonar\.python\.coverage\.reportPaths=exchange_executor\/coverage\.xml$/m);
assert.match(sonarCloud, /^sonar\.qualitygate\.wait=true$/m);
assert.match(workflow, /name: SonarQube Cloud quality gate/);
assert.match(workflow, /SonarSource\/sonarqube-scan-action@[a-f0-9]{40}/);
assert.match(workflow, /SONAR_EXPECTED_REVISION: \$\{\{ github\.sha \}\}/);
assert.match(workflow, /SONAR_REPORT_TASK_FILE: \.scannerwork\/report-task\.txt/);
const sonarPaths = name => sonarCloud.match(new RegExp(`^${name}=(.+)$`, 'm'))?.[1]
  .split(',').map(value => value.trim()).filter(Boolean) ?? [];
const sonarSources = sonarPaths('sonar\\.sources');
const sonarTests = sonarPaths('sonar\\.tests');
assert.ok(sonarSources.length > 0, 'Sonar production sources must be explicit.');
assert.ok(sonarTests.length > 0, 'Sonar test sources must be explicit.');
assert.ok(sonarSources.includes('src'), 'Sonar must analyze the Node/TypeScript production runtime.');
assert.ok(sonarSources.includes('frontend/src'), 'Sonar must analyze the frontend production runtime.');
assert.ok(sonarSources.includes('exchange_executor/server.py'), 'Sonar must analyze the Python executor runtime.');
for (const nonProductScope of ['scripts', '.github', 'Dockerfile', 'docker-compose.yml']) {
  assert.equal(sonarSources.includes(nonProductScope), false,
    `Sonar licensed LOC must stay scoped to product code; '${nonProductScope}' has an independent repository gate.`);
}
for (const configuredPath of [...sonarSources, ...sonarTests]) {
  await access(configuredPath);
}
const resolvedSources = sonarSources.map(value => path.resolve(value));
const resolvedTests = sonarTests.map(value => path.resolve(value));
for (const sourcePath of resolvedSources) {
  for (const testPath of resolvedTests) {
    assert.notEqual(sourcePath, testPath, `Sonar source/test scopes overlap at ${sourcePath}`);
    assert.equal(testPath.startsWith(`${sourcePath}${path.sep}`), false,
      `Sonar test path ${testPath} is nested below source path ${sourcePath}`);
  }
}
assert.match(editorConfig, /^charset = utf-8$/m);
assert.match(gitAttributes, /^\* text=auto eol=lf$/m);
for (const removedPath of [
  '.github/workflows/pr_risk.yml',
  '.github/workflows/release.yml',
  '.github/dependabot.yml',
  'scripts/publish_pr_risk_status.js',
  'scripts/reevaluate_open_pr_risks.js',
  'scripts/run_trusted_pr_risk.js',
]) {
  await assert.rejects(access(removedPath), /ENOENT/, `${removedPath} must not be shipped.`);
}

await assertUtf8Tree('.');
console.log('Repository governance tests passed.');
