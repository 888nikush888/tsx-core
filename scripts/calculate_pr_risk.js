import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TRUSTED_GIT_LOCATIONS = Object.freeze({
  win32: Object.freeze([
    String.raw`C:\Program Files\Git\cmd\git.exe`,
    String.raw`C:\Program Files\Git\bin\git.exe`,
    String.raw`C:\Program Files (x86)\Git\cmd\git.exe`,
  ]),
  unix: Object.freeze([
    '/usr/bin/git',
  ]),
});

const GOVERNANCE_FILES = new Set([
  '.dockerignore',
  '.editorconfig',
  '.gitattributes',
  '.gitleaks.toml',
  '.sonarcloud.properties',
  '.github/CODEOWNERS',
  '.github/dependabot.yml',
  'Dockerfile',
  'c8.critical.json',
  'c8.modules.json',
  'coverage-baseline.json',
  'config/runtime-settings.json',
  'docker-compose.yml',
  'eslint.config.js',
  'frontend/.oxlintrc.json',
  'frontend/index.html',
  'frontend/package-lock.json',
  'frontend/package.json',
  'frontend/playwright.config.ts',
  'frontend/postcss.config.js',
  'frontend/tailwind.config.js',
  'frontend/vite.config.ts',
  'exchange_executor/requirements.lock',
  'monitoring/alertmanager.Dockerfile',
  'monitoring/rules.yml',
  'package-lock.json',
  'package.json',
  'quality-baseline.json',
  'stryker.config.mjs',
  'tests/run_all.js',
  'tests/test_supply_chain.js',
  'tsconfig.json',
]);

const FACTORS = [
  {
    id: 'governance-control',
    points: 10,
    matches: changes => changes.some(change => isGovernancePath(change.path)
      || (isRiskRecord(change.path) && change.status !== 'D')),
  },
  {
    id: 'risk-record-cleanup',
    points: 5,
    matches: changes => changes.some(change => isRiskRecord(change.path) && change.status === 'D'),
  },
  {
    id: 'critical-domain',
    points: 5,
    matches: changes => changes.some(change => isCriticalPath(change.path)),
  },
  {
    id: 'operator-safety',
    points: 3,
    matches: changes => changes.some(change => isCriticalPath(change.path)),
  },
  {
    id: 'auth-secrets',
    points: 5,
    matches: changes => changes.some(change => /(?:auth|secret|credential|token|oidc|session)/i.test(change.path)),
  },
  {
    id: 'ai-side-effect',
    points: 5,
    matches: changes => changes.some(change => /(?:signal_parser|openrouter|prompt|schema|trading_engine|exchange_executor)/i.test(change.path)),
  },
  {
    id: 'persistence',
    points: 4,
    matches: changes => changes.some(change => /(?:db|migration|repository|backup|retention|journal)/i.test(change.path)),
  },
  {
    id: 'concurrency',
    points: 4,
    matches: changes => changes.some(change => /(?:queue|retry|scheduler|outbox|stream|shutdown|worker)/i.test(change.path)),
  },
  {
    id: 'public-contract',
    points: 3,
    matches: changes => changes.some(change => /(?:web_server|web_control|mcp_server|signal_contract|config\.ts|types\.ts)/i.test(change.path)),
  },
  {
    id: 'production-verification',
    points: 3,
    matches: changes => changes.some(change => isProductionPath(change.path)),
  },
  {
    id: 'dependency',
    points: 2,
    matches: changes => changes.some(change => /(?:package(?:-lock)?\.json|requirements\.(?:in|lock)|Dockerfile|docker-compose)/i.test(change.path)),
  },
  {
    id: 'large-change',
    points: 2,
    matches: changes => changes.reduce((sum, change) => sum + change.additions + change.deletions, 0) > 500,
  },
];

function normalizePath(filePath) {
  return String(filePath || '').replaceAll('\\', '/');
}

function isRiskRecord(filePath) {
  return /^docs\/risk-acceptances\/RA-[^/]+\.md$/.test(normalizePath(filePath));
}

function isGovernancePath(filePath) {
  const normalized = normalizePath(filePath);
  return GOVERNANCE_FILES.has(normalized)
    || normalized.startsWith('.github/workflows/')
    || normalized.startsWith('monitoring/vex/')
    || normalized.startsWith('scripts/check_')
    || normalized.startsWith('scripts/verify_');
}

function isCriticalPath(filePath) {
  const normalized = normalizePath(filePath);
  return /^(?:src\/(?:dashboard_auth|secret_store|runtime_settings|trading_|mcp_|factory_reset_paths|exchange_stream_repository|trade_journal|signal_contract|db|backup)|frontend\/src\/(?:lib\/api|components\/dashboard-auth-gate)|exchange_executor\/)/.test(normalized);
}

function isProductionPath(filePath) {
  const normalized = normalizePath(filePath);
  return /^(?:src|frontend\/src|exchange_executor|monitoring)\//.test(normalized)
    || /^(?:Dockerfile|docker-compose[^/]*\.yml)$/.test(normalized);
}

export function riskLevel(score) {
  if (score >= 15) return 'critical-staging-and-explicit-approval';
  if (score >= 10) return 'security-architecture-review-and-rollback';
  if (score >= 5) return 'senior-review';
  return 'standard-review';
}

export function scorePullRequest(changes) {
  const normalized = changes.map(change => ({
    path: normalizePath(change.path),
    status: String(change.status || 'M'),
    additions: Number.isSafeInteger(change.additions) ? Math.max(0, change.additions) : 0,
    deletions: Number.isSafeInteger(change.deletions) ? Math.max(0, change.deletions) : 0,
  }));
  const factors = FACTORS
    .filter(factor => factor.matches(normalized))
    .map(({ id, points }) => ({ id, points }));
  const score = factors.reduce((sum, factor) => sum + factor.points, 0);
  return { score, level: riskLevel(score), factors };
}

function parseNumstat(value) {
  return value.split(/\r?\n/).filter(Boolean).map(line => {
    const [rawAdditions, rawDeletions, ...pathParts] = line.split('\t');
    return {
      path: pathParts.join('\t'),
      additions: /^\d+$/.test(rawAdditions) ? Number(rawAdditions) : 0,
      deletions: /^\d+$/.test(rawDeletions) ? Number(rawDeletions) : 0,
    };
  });
}

function parseNameStatus(value) {
  return new Map(value.split(/\r?\n/).filter(Boolean).map(line => {
    const [status, ...pathParts] = line.split('\t');
    return [pathParts.at(-1), status.charAt(0)];
  }));
}

export function resolveGitExecutable({
  platform = process.platform,
  fileExists = existsSync,
} = {}) {
  const pathImplementation = platform === 'win32' ? path.win32 : path.posix;
  const trustedCandidates = platform === 'win32'
    ? TRUSTED_GIT_LOCATIONS.win32
    : TRUSTED_GIT_LOCATIONS.unix;
  const executable = trustedCandidates.find(candidate =>
    pathImplementation.isAbsolute(candidate) && fileExists(candidate)
  );
  if (!executable) {
    throw new Error('Git was not found in a trusted absolute installation location.');
  }
  return executable;
}

function gitChanges(base, head) {
  const range = `${base}...${head}`;
  const options = { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 };
  const gitExecutable = resolveGitExecutable();
  const numstat = execFileSync(
    gitExecutable,
    ['diff', '--no-renames', '--numstat', range],
    options
  );
  const statuses = parseNameStatus(execFileSync(
    gitExecutable,
    ['diff', '--no-renames', '--name-status', range],
    options
  ));
  return parseNumstat(numstat).map(change => ({
    ...change,
    status: statuses.get(change.path) || 'M',
  }));
}

async function main() {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) throw new Error('Usage: calculate_pr_risk.js <base> <head>');
  const changes = gitChanges(base, head);
  const evaluation = scorePullRequest(changes);
  const evidence = {
    schemaVersion: 1,
    base,
    head,
    evaluatedAt: new Date().toISOString(),
    changes,
    ...evaluation,
  };
  await mkdir(path.resolve('reports', 'pr-risk'), { recursive: true });
  await writeFile(
    path.resolve('reports', 'pr-risk', 'evaluation.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
  console.log(JSON.stringify(evidence, null, 2));
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'PR risk calculation failed.');
    process.exitCode = 1;
  }
}
