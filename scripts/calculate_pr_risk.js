import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRiskAcceptance } from './check_risk_acceptances.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const acceptanceDirectory = path.join(root, 'docs', 'risk-acceptances');
const gitExecutable = process.platform === 'win32'
  ? 'C:\\Program Files\\Git\\cmd\\git.exe'
  : '/usr/bin/git';

const RISK_FACTORS = [
  { id: 'critical-domain', points: 5, label: 'Critical delivery, data, AI, trading or control-plane domain', matches: file => /^src\/(forwarder|db|signal_parser|signal_schema|delivery_tracker|backup|backup_replication|web_server|audit_trail|dashboard_auth|secret_store|telegram_login|trading_.+|paper_exchange|official_exchange)\.ts$/.test(file) || /^exchange_executor\/(?!tests\/)/.test(file) },
  { id: 'auth-secrets', points: 5, label: 'Authentication, authorization or secret boundary', matches: file => /^src\/(dashboard_auth|web_server|env|audit_trail|runtime_profile|runtime_settings|secret_store|telegram_login|trading_credentials|official_exchange)\.ts$/.test(file) || /^exchange_executor\/(credentials|server)\.py$/.test(file) || file.startsWith('.github/workflows/') },
  { id: 'ai-side-effect', points: 5, label: 'AI prompt, schema or automatic side effect', matches: file => /^src\/(signal_parser|signal_schema|forwarder|trading_engine|trading_runtime|trading_risk)\.ts$/.test(file) || file.startsWith('templates/') || /^exchange_executor\/(hyperliquid_adapter|bybit_adapter)\.py$/.test(file) },
  { id: 'database', points: 4, label: 'Database, migration or persistent recovery', matches: file => /^src\/(db|migration_cli|backup|trading_repository|trading_engine)\.ts$/.test(file) },
  { id: 'concurrency', points: 4, label: 'Concurrency, retry, timeout, idempotency or shutdown', matches: file => /^src\/(queue|forwarder|delivery_tracker|tdlib_retry|trading_engine|trading_runtime|official_exchange)\.ts$/.test(file) },
  { id: 'contract', points: 3, label: 'HTTP, configuration or metrics contract', matches: file => /^src\/(web_server|metrics|config)\.ts$/.test(file) },
  { id: 'dependency', points: 2, label: 'Production dependency, workflow or base image', matches: file => /^(package(-lock)?\.json|frontend\/package(-lock)?\.json|Dockerfile|exchange_executor\/(Dockerfile|requirements\.(in|lock))|\.github\/workflows\/)/.test(file) }
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
  const productionChanged = files.some(file => /^(src\/|frontend\/src\/|exchange_executor\/(?!tests\/)|Dockerfile|docker-compose|monitoring\/|package)/.test(file));
  const testsChanged = files.some(file => /^(tests\/|exchange_executor\/tests\/|frontend\/.*(?:test|spec)|monitoring\/rules\.test\.yml)/.test(file));
  if (productionChanged && !testsChanged) factors.push({ id: 'test-gap', points: 3, label: 'Production change without a changed regression test' });
  const changedLines = changes.reduce((sum, change) => sum + change.additions + change.deletions, 0);
  if (changedLines > 500) factors.push({ id: 'large-change', points: 2, label: 'More than 500 changed lines' });
  const score = factors.reduce((sum, factor) => sum + factor.points, 0);
  return { score, level: riskLevel(score), changedLines, factors };
}

function frontMatterFields(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return {};
  return Object.fromEntries(match[1]
    .split(/\r?\n/)
    .map(line => line.match(/^([a-z-]+):\s*(.+?)\s*$/))
    .filter(Boolean)
    .map(item => [item[1], item[2]]));
}

export function evaluatePrRiskGate(evaluation, head, acceptances = []) {
  if (evaluation.score < 10) {
    return { passed: true, required: false, accepted: false, reason: 'risk score is below the high-risk threshold' };
  }
  const gateName = `pr-risk:${head}`;
  const matching = acceptances.find(item => item.errors.length === 0
    && item.fields.gate === gateName
    && item.fields.owner !== item.fields.approver
    && item.fields.scope?.includes(head));
  if (!matching) {
    return {
      passed: false,
      required: true,
      accepted: false,
      reason: `score ${evaluation.score} requires a valid, unexpired ${gateName} record with independent approver and commit-bound scope`,
    };
  }
  return { passed: true, required: true, accepted: true, acceptance: matching.file, reason: `time-bounded exception ${matching.file}` };
}

async function loadRiskAcceptances(now = new Date()) {
  const files = await readdir(acceptanceDirectory).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return Promise.all(files.filter(file => /^RA-.+\.md$/.test(file)).sort().map(async file => {
    const content = await readFile(path.join(acceptanceDirectory, file), 'utf8');
    return { file, fields: frontMatterFields(content), errors: validateRiskAcceptance(content, now) };
  }));
}

function gitChanges(base, head) {
  const output = execFileSync(gitExecutable, ['diff', '--numstat', `${base}...${head}`], { encoding: 'utf8' });
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
  const gate = evaluatePrRiskGate(evaluation, head, await loadRiskAcceptances());
  const evidence = { schemaVersion: 2, base, head, evaluatedAt: new Date().toISOString(), changes, ...evaluation, gate };
  const directory = path.resolve('reports', 'pr-risk');
  await mkdir(directory, { recursive: true });
  const output = path.join(directory, `pr-risk-${head}.json`);
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  console.log(`PR RISK SCORE ${evaluation.score} level=${evaluation.level} gate=${gate.passed ? 'PASS' : 'FAIL'} evidence=${output}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(process.env.GITHUB_STEP_SUMMARY, `## PR risk: ${evaluation.score}\n\nRequired procedure: \`${evaluation.level}\`\n\nGate: **${gate.passed ? 'PASS' : 'FAIL'}** - ${gate.reason}\n`, { flag: 'a' });
  }
  if (!gate.passed) throw new Error(`PR risk gate failed: ${gate.reason}.`);
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
