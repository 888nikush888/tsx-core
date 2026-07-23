import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { riskLevel, scorePullRequest } from '../scripts/calculate_pr_risk.js';
import { evaluateGithubGovernance } from '../scripts/verify_github_governance.js';

const EXCLUDED_ENCODING_DIRECTORIES = new Set(['.git', 'coverage', 'coverage-modules', 'dist', 'node_modules', 'reports']);
const ANALYZED_TEXT_EXTENSIONS = new Set([
  '.css', '.html', '.in', '.js', '.json', '.lock', '.md', '.mjs', '.properties',
  '.py', '.sh', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml'
]);
const ANALYZED_TEXT_BASENAMES = new Set([
  '.dockerignore', '.env.example', '.gitignore', 'config.json.example', 'Dockerfile', 'LICENSE', 'Makefile'
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
    const content = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(filePath));
    assert.doesNotMatch(content, /\uFFFD|\u00C3.|\u00E2\u20AC|\u00C2.|\u00F0\u0178/, `${filePath} contains damaged Unicode text.`);
  }
}

assert.equal(riskLevel(4), 'standard-review');
assert.equal(riskLevel(5), 'senior-review');
assert.equal(riskLevel(10), 'security-architecture-review-and-rollback');
assert.equal(riskLevel(15), 'critical-staging-and-explicit-approval');

const critical = scorePullRequest([
  { path: 'src/dashboard_auth.ts', additions: 400, deletions: 150 },
  { path: 'package.json', additions: 2, deletions: 1 }
]);
assert.ok(critical.score >= 15);
assert.ok(critical.factors.some(factor => factor.id === 'test-gap'));
assert.ok(critical.factors.some(factor => factor.id === 'large-change'));
const tested = scorePullRequest([
  { path: 'src/config.ts', additions: 5, deletions: 2 },
  { path: 'tests/test_config.js', additions: 10, deletions: 0 }
]);
assert.ok(!tested.factors.some(factor => factor.id === 'test-gap'));
const managedSecretChange = scorePullRequest([
  { path: 'src/secret_store.ts', additions: 5, deletions: 1 },
  { path: 'tests/test_secret_store.js', additions: 8, deletions: 0 }
]);
assert.ok(managedSecretChange.factors.some(factor => factor.id === 'critical-domain'));
assert.ok(managedSecretChange.factors.some(factor => factor.id === 'auth-secrets'));
const runtimeSettingsChange = scorePullRequest([
  { path: 'src/runtime_settings.ts', additions: 5, deletions: 1 },
  { path: 'tests/test_runtime_settings.js', additions: 8, deletions: 0 }
]);
assert.ok(runtimeSettingsChange.factors.some(factor => factor.id === 'auth-secrets'));
const tradingChange = scorePullRequest([
  { path: 'src/trading_engine.ts', additions: 5, deletions: 1 },
  { path: 'tests/test_trading_engine.js', additions: 8, deletions: 0 }
]);
assert.ok(tradingChange.score >= 14, 'Trading execution changes require critical-domain, side-effect and concurrency review.');
assert.ok(tradingChange.factors.some(factor => factor.id === 'critical-domain'));
assert.ok(tradingChange.factors.some(factor => factor.id === 'ai-side-effect'));

const requiredContexts = [
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
const governance = evaluateGithubGovernance({
  repository: {
    security_and_analysis: {
      dependency_graph: { status: 'enabled' },
      secret_scanning: { status: 'enabled' },
      secret_scanning_push_protection: { status: 'enabled' }
    }
  },
  protection: {
    required_status_checks: { strict: true, contexts: requiredContexts },
    required_pull_request_reviews: {
      required_approving_review_count: 2,
      dismiss_stale_reviews: true,
      require_code_owner_reviews: true,
      require_last_push_approval: true
    },
    enforce_admins: { enabled: true },
    required_conversation_resolution: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false }
  },
  environments: { environments: [{ name: 'staging' }, { name: 'production-observer' }] },
  codeowners: '* @enterprise/forwarder-owners\n',
  codeownerErrors: []
});
assert.equal(governance.passed, true);

const [dependabot, workflow, securityPolicy, sonarCloud, editorConfig, gitAttributes] = await Promise.all([
  readFile('.github/dependabot.yml', 'utf8'),
  readFile('.github/workflows/quality.yml', 'utf8'),
  readFile('SECURITY.md', 'utf8'),
  readFile('.sonarcloud.properties', 'utf8'),
  readFile('.editorconfig', 'utf8'),
  readFile('.gitattributes', 'utf8')
]);
for (const ecosystem of ['npm', 'github-actions', 'docker']) {
  assert.match(dependabot, new RegExp(`package-ecosystem: ${ecosystem}`));
}
assert.match(workflow, /calculate_pr_risk\.js/);
assert.match(workflow, /verify_github_governance\.js/);
assert.match(securityPolicy, /Private Vulnerability Reporting/);
assert.match(sonarCloud, /^sonar\.sourceEncoding=UTF-8$/m);
assert.match(sonarCloud, /^sonar\.python\.version=3\.12$/m);
assert.match(sonarCloud, /^sonar\.tests=tests,frontend\/tests,frontend\/e2e,exchange_executor\/tests,monitoring\/rules\.test\.yml$/m);
assert.match(sonarCloud, /^sonar\.exclusions=tests,frontend\/tests,frontend\/e2e,exchange_executor\/tests,monitoring\/rules\.test\.yml$/m);
assert.doesNotMatch(sonarCloud, /[*?]/, 'Automatic-analysis paths must not use wildcard patterns.');
assert.match(editorConfig, /^charset = utf-8$/m);
assert.match(editorConfig, /^end_of_line = lf$/m);
assert.match(gitAttributes, /^\* text=auto$/m);
await assertUtf8Tree('.');

console.log('Repository governance and PR-risk tests passed.');
