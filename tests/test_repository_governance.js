import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { riskLevel, scorePullRequest } from '../scripts/calculate_pr_risk.js';
import { evaluateGithubGovernance } from '../scripts/verify_github_governance.js';

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

const requiredContexts = [
  'Lint, tests, coverage, build, supply chain',
  'Critical mutation gate (queue)',
  'Critical mutation gate (retry)',
  'Critical mutation gate (schema)',
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

const [dependabot, workflow, securityPolicy] = await Promise.all([
  readFile('.github/dependabot.yml', 'utf8'),
  readFile('.github/workflows/quality.yml', 'utf8'),
  readFile('SECURITY.md', 'utf8')
]);
for (const ecosystem of ['npm', 'github-actions', 'docker']) {
  assert.match(dependabot, new RegExp(`package-ecosystem: ${ecosystem}`));
}
assert.match(workflow, /calculate_pr_risk\.js/);
assert.match(workflow, /verify_github_governance\.js/);
assert.match(securityPolicy, /Private Vulnerability Reporting/);

console.log('Repository governance and PR-risk tests passed.');
