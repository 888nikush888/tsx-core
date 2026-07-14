import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RISK_FACTORS = [
  { id: 'critical-domain', points: 5, label: 'Critical delivery, data, AI or control-plane domain', matches: file => /^src\/(forwarder|db|signal_parser|signal_schema|delivery_tracker|backup|backup_replication|web_server|audit_trail|dashboard_auth)\.ts$/.test(file) },
  { id: 'auth-secrets', points: 5, label: 'Authentication, authorization or secret boundary', matches: file => /^src\/(dashboard_auth|web_server|env|audit_trail)\.ts$/.test(file) || /^\.github\/workflows\//.test(file) },
  { id: 'ai-side-effect', points: 5, label: 'AI prompt, schema or automatic side effect', matches: file => /^src\/(signal_parser|signal_schema|forwarder)\.ts$/.test(file) || /^templates\//.test(file) },
  { id: 'database', points: 4, label: 'Database, migration or persistent recovery', matches: file => /^src\/(db|migration_cli|backup)\.ts$/.test(file) },
  { id: 'concurrency', points: 4, label: 'Concurrency, retry, timeout, idempotency or shutdown', matches: file => /^src\/(queue|forwarder|delivery_tracker|tdlib_retry)\.ts$/.test(file) },
  { id: 'contract', points: 3, label: 'HTTP, configuration or metrics contract', matches: file => /^src\/(web_server|metrics|config)\.ts$/.test(file) },
  { id: 'dependency', points: 2, label: 'Production dependency, workflow or base image', matches: file => /^(package(-lock)?\.json|frontend\/package(-lock)?\.json|Dockerfile|\.github\/workflows\/)/.test(file) }
];

export function riskLevel(score) {
  if (score >= 15) return 'critical-staging-and-explicit-approval';
  if (score >= 10) return 'security-architecture-review-and-rollback';
  if (score >= 5) return 'senior-review';
  return 'standard-review';
}

export function scorePullRequest(changes) {
  const files = changes.map(change => change.path.replaceAll('\\', '/'));
  const factors = RISK_FACTORS
    .filter(factor => files.some(factor.matches))
    .map(({ id, points, label }) => ({ id, points, label }));
  const productionChanged = files.some(file => /^(src\/|frontend\/src\/|Dockerfile|docker-compose|monitoring\/|package)/.test(file));
  const testsChanged = files.some(file => /^(tests\/|frontend\/.*(?:test|spec)|monitoring\/rules\.test\.yml)/.test(file));
  if (productionChanged && !testsChanged) factors.push({ id: 'test-gap', points: 3, label: 'Production change without a changed regression test' });
  const changedLines = changes.reduce((sum, change) => sum + change.additions + change.deletions, 0);
  if (changedLines > 500) factors.push({ id: 'large-change', points: 2, label: 'More than 500 changed lines' });
  const score = factors.reduce((sum, factor) => sum + factor.points, 0);
  return { score, level: riskLevel(score), changedLines, factors };
}

function gitChanges(base, head) {
  const output = execFileSync('git', ['diff', '--numstat', `${base}...${head}`], { encoding: 'utf8' });
  return output.trim().split('\n').filter(Boolean).map(line => {
    const [added, deleted, ...nameParts] = line.split('\t');
    return {
      path: nameParts.join('\t'),
      additions: added === '-' ? 0 : Number(added),
      deletions: deleted === '-' ? 0 : Number(deleted)
    };
  });
}

async function main() {
  const [base, head] = process.argv.slice(2);
  if (!/^[a-f0-9]{40}$/i.test(base || '') || !/^[a-f0-9]{40}$/i.test(head || '')) {
    throw new Error('Usage: node scripts/calculate_pr_risk.js <40-char-base-sha> <40-char-head-sha>');
  }
  const changes = gitChanges(base, head);
  const evaluation = scorePullRequest(changes);
  const evidence = { schemaVersion: 1, base, head, evaluatedAt: new Date().toISOString(), changes, ...evaluation };
  const directory = path.resolve('reports', 'pr-risk');
  await mkdir(directory, { recursive: true });
  const output = path.join(directory, `pr-risk-${head}.json`);
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  console.log(`PR RISK SCORE ${evaluation.score} level=${evaluation.level} evidence=${output}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(process.env.GITHUB_STEP_SUMMARY, `## PR risk: ${evaluation.score}\n\nRequired procedure: \`${evaluation.level}\`\n`, { flag: 'a' });
  }
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
