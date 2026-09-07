import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SONAR_PROJECT = '888nikush888_telegram-tdlib-forwarder-private';
export const REVIEW_MANIFEST = 'docs/testing/sonar-reviewed-decisions.json';
export const REVIEW_LEDGER = 'reports/sonar-reviewed-decisions/ledger.json';
const ORIGIN = 'https://sonarcloud.io';
const REPOSITORY = '888nikush888/tsx-core';
const OWNER = '888nikush888';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA256 = /^[a-f0-9]{64}$/u;
const MESSAGES = {
  AUTHORIZATION: 'Sonar decisions require an explicitly enabled, owner-started Quality OS workflow dispatch.',
  CHECKOUT: 'Sonar decisions require a clean checkout of the exact workflow revision.',
  MANIFEST: 'The reviewed Sonar decision manifest is invalid.',
  SOURCE: 'A reviewed source or regression test does not match its pinned file and SHA256.',
  IDENTITY: 'Sonar did not prove the exact reviewed main issue identity.',
  CLASSIFICATION: 'The issue classification is unsafe or unsupported for the reviewed disposition.',
  STATE: 'The issue status or prior review comment does not match the reviewed decision.',
  PERMISSION: 'Sonar credentials lack permission for the reviewed decision. Browse and Administer Issues are required.',
  READ: 'The Sonar decision preflight or readback failed; no response body was retained.',
  REJECTED: 'Sonar rejected the transition; remaining decisions were not submitted.',
  UNCONFIRMED: 'The attempted transition is unconfirmed. Do not retry blindly; inspect the ledger and live issue first.',
  LEDGER: 'The Sonar decision ledger could not be persisted; remaining decisions were not submitted.'
};

class DecisionError extends Error {
  constructor(code) {
    super(MESSAGES[code]);
    this.code = code;
  }
}

function requireCondition(condition, code) {
  if (!condition) throw new DecisionError(code);
}

const digest = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function exactKeys(value, required, optional = []) {
  return object(value) && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => [...required, ...optional].includes(key));
}

function validPath(value) {
  return typeof value === 'string' && /^(?:exchange_executor|src|frontend|tests)\/[A-Za-z0-9_./-]+\.(?:py|js|mjs|ts|tsx|jsx)$/u.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..');
}

function validBinding(binding) {
  return exactKeys(binding, ['path', 'sha256']) && validPath(binding.path) && SHA256.test(binding.sha256);
}

function validRationale(value) {
  return typeof value === 'string' && value.trim() === value && value.length >= 80 && value.length <= 4000
    && !/[\x00-\x1f\x7f]/u.test(value);
}

function validateDecision(decision) {
  requireCondition(exactKeys(decision, ['issueKey', 'rule', 'component', 'source', 'tests', 'rationale', 'disposition'], ['acceptanceRationale']), 'MANIFEST');
  requireCondition(typeof decision.issueKey === 'string' && /^[A-Za-z0-9_-]{10,100}$/u.test(decision.issueKey), 'MANIFEST');
  requireCondition(typeof decision.rule === 'string' && /^(?:python|typescript|javascript|Web):S\d+$/u.test(decision.rule), 'MANIFEST');
  requireCondition(validBinding(decision.source) && decision.component === `${SONAR_PROJECT}:${decision.source.path}`, 'MANIFEST');
  requireCondition(Array.isArray(decision.tests) && decision.tests.length > 0 && decision.tests.every(validBinding), 'MANIFEST');
  const testPaths = decision.tests.map(test => test.path);
  requireCondition(new Set(testPaths).size === testPaths.length
    && testPaths.every(name => name !== decision.source.path && /(?:^|\/)(?:tests|__tests__)\/|\.(?:test|spec)\./u.test(name)), 'MANIFEST');
  requireCondition(validRationale(decision.rationale) && ['falsepositive', 'accept'].includes(decision.disposition), 'MANIFEST');
  requireCondition(decision.disposition === 'accept' ? validRationale(decision.acceptanceRationale)
    : !Object.hasOwn(decision, 'acceptanceRationale'), 'MANIFEST');
}

async function boundFile(root, name) {
  // Reject links at every path segment, including intermediate directory links.
  let target = root;
  for (const part of name.split('/')) {
    target = path.join(target, part);
    requireCondition(!(await lstat(target)).isSymbolicLink(), 'SOURCE');
  }
  const resolved = await realpath(target);
  requireCondition(resolved.startsWith(`${root}${path.sep}`) && (await lstat(resolved)).isFile(), 'SOURCE');
  return readFile(resolved);
}

export async function loadReviewedDecisions(root = ROOT) {
  let bytes;
  let manifest;
  const resolvedRoot = await realpath(root);
  try {
    bytes = await boundFile(resolvedRoot, REVIEW_MANIFEST);
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new DecisionError('MANIFEST');
  }
  requireCondition(exactKeys(manifest, ['schemaVersion', 'projectKey', 'branch', 'decisions'])
    && manifest.schemaVersion === 1 && manifest.projectKey === SONAR_PROJECT && manifest.branch === 'main'
    && Array.isArray(manifest.decisions) && manifest.decisions.length > 0 && manifest.decisions.length <= 100, 'MANIFEST');
  manifest.decisions.forEach(validateDecision);
  requireCondition(new Set(manifest.decisions.map(decision => decision.issueKey)).size === manifest.decisions.length, 'MANIFEST');
  try {
    for (const decision of manifest.decisions) {
      for (const binding of [decision.source, ...decision.tests]) {
        requireCondition(digest(await boundFile(resolvedRoot, binding.path)) === binding.sha256, 'SOURCE');
      }
    }
  } catch {
    throw new DecisionError('SOURCE');
  }
  return { manifest, manifestSha256: digest(bytes) };
}

function authorizeRunner(environment) {
  requireCondition(environment.GITHUB_ACTIONS === 'true' && environment.GITHUB_EVENT_NAME === 'workflow_dispatch'
    && environment.GITHUB_REPOSITORY === REPOSITORY && environment.GITHUB_ACTOR === OWNER
    && environment.GITHUB_TRIGGERING_ACTOR === OWNER && environment.SONAR_APPLY_REVIEWED_DECISIONS === 'true', 'AUTHORIZATION');
  requireCondition(environment.GITHUB_REF_TYPE === 'branch' && /^refs\/heads\/[^\s\x00-\x1f\x7f]+$/u.test(environment.GITHUB_REF ?? '')
    && environment.GITHUB_WORKFLOW_REF === `${REPOSITORY}/.github/workflows/quality.yml@${environment.GITHUB_REF}`, 'AUTHORIZATION');
}

export function authorizeWorkflow(environment, event, revision, clean) {
  authorizeRunner(environment);
  requireCondition(event?.repository?.full_name === REPOSITORY && event.repository.owner?.login === OWNER
    && event.sender?.login === OWNER && [true, 'true'].includes(event.inputs?.apply_reviewed_sonar_decisions), 'AUTHORIZATION');
  requireCondition(/^[a-f0-9]{40}$/u.test(revision) && revision === environment.GITHUB_SHA
    && revision === environment.SONAR_EXPECTED_REVISION && clean === true, 'CHECKOUT');
  requireCondition(typeof environment.SONAR_TOKEN === 'string' && environment.SONAR_TOKEN.trim().length > 0, 'PERMISSION');
}

function reviewComment(decision) {
  // The decision hash is stable across unrelated manifest additions and workflow reruns.
  const binding = [decision.source, ...decision.tests].map(file => `${file.path} SHA256 ${file.sha256}`).join('\n');
  return `TSX Core reviewed decision v1: ${digest(JSON.stringify(decision))}\nDisposition: ${decision.disposition}\n${decision.rationale}`
    + `${decision.acceptanceRationale ? `\nExplicit risk acceptance: ${decision.acceptanceRationale}` : ''}\n${binding}`;
}

async function requestIssue(decision, { fetchImpl, token }) {
  const url = new URL('/api/issues/search', ORIGIN);
  url.search = new URLSearchParams({ issues: decision.issueKey, componentKeys: SONAR_PROJECT, branch: 'main',
    additionalFields: 'comments,transitions', p: '1', ps: '2' }).toString();
  let response;
  let body;
  try {
    response = await fetchImpl(url, { method: 'GET', redirect: 'error', headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000) });
    requireCondition(![401, 403].includes(response.status), 'PERMISSION');
    requireCondition(response.ok, 'READ');
    body = await response.json();
  } catch (error) {
    throw error instanceof DecisionError ? error : new DecisionError('READ');
  }
  return validateIssueIdentity(body, decision);
}

function validateIssueIdentity(body, decision) {
  requireCondition(body?.paging?.total === 1 && body.paging.pageIndex === 1 && (!Object.hasOwn(body, 'total') || body.total === 1)
    && Array.isArray(body.issues) && body.issues.length === 1, 'IDENTITY');
  const issue = body.issues[0];
  requireCondition(issue?.key === decision.issueKey && issue.rule === decision.rule && issue.component === decision.component
    && issue.project === SONAR_PROJECT && !Object.hasOwn(issue, 'pullRequest')
    && (!Object.hasOwn(issue, 'branch') || issue.branch === 'main'), 'IDENTITY');
  return issue;
}

function validateClassification(issue, decision) {
  // Unknown classification is never interpreted as non-security. These reviewed exceptions are code smells only.
  requireCondition(issue.type === 'CODE_SMELL' && ['INFO', 'MINOR', 'MAJOR', 'CRITICAL', 'BLOCKER'].includes(issue.severity)
    && Array.isArray(issue.impacts) && issue.impacts.length > 0, 'CLASSIFICATION');
  requireCondition(issue.impacts.every(impact => ['MAINTAINABILITY', 'RELIABILITY'].includes(impact?.softwareQuality)
    && ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'BLOCKER'].includes(impact.severity)), 'CLASSIFICATION');
  if (decision.disposition === 'accept') {
    requireCondition(!['CRITICAL', 'BLOCKER'].includes(issue.severity)
      && issue.impacts.every(impact => !['HIGH', 'BLOCKER'].includes(impact.severity)), 'CLASSIFICATION');
  }
}

function decisionState(issue, decision) {
  validateClassification(issue, decision);
  requireCondition(Array.isArray(issue.comments) && issue.comments.every(comment => typeof comment?.markdown === 'string'), 'STATE');
  const desired = decision.disposition === 'falsepositive' ? 'FALSE_POSITIVE' : 'ACCEPTED';
  if (issue.issueStatus === desired) {
    const resolution = decision.disposition === 'falsepositive' ? 'FALSE-POSITIVE' : 'WONTFIX';
    requireCondition(['RESOLVED', 'CLOSED'].includes(issue.status) && issue.resolution === resolution
      && issue.comments.some(comment => comment.markdown === reviewComment(decision)), 'STATE');
    return 'already-confirmed';
  }
  const open = (issue.issueStatus === 'OPEN' && ['OPEN', 'REOPENED'].includes(issue.status))
    || (issue.issueStatus === 'CONFIRMED' && issue.status === 'CONFIRMED');
  requireCondition(open && !issue.resolution && !issue.comments.some(comment => comment.markdown === reviewComment(decision)), 'STATE');
  requireCondition(Array.isArray(issue.transitions) && issue.transitions.includes(decision.disposition), 'PERMISSION');
  return 'ready';
}

async function transitionOnce(decision, { fetchImpl, token }) {
  let response;
  try {
    response = await fetchImpl(new URL('/api/issues/do_transition', ORIGIN), { method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ issue: decision.issueKey, transition: decision.disposition, comment: reviewComment(decision) }),
      signal: AbortSignal.timeout(15_000) });
  } catch {
    return 'uncertain';
  }
  // Never print, persist or use an untrusted response body to decide whether to retry a mutation.
  await response.body?.cancel().catch(() => undefined);
  requireCondition(![401, 403].includes(response.status), 'PERMISSION');
  if (response.status >= 400 && response.status < 500) throw new DecisionError('REJECTED');
  return response.ok ? 'responded' : 'uncertain';
}

async function persistLedger(ledger, writeLedger) {
  try {
    await writeLedger(structuredClone(ledger));
  } catch {
    throw new DecisionError('LEDGER');
  }
}

export async function applyReviewedDecisions({ root = ROOT, environment = process.env, event, revision, clean,
  fetchImpl = fetch, writeLedger, dryRun = false }) {
  requireCondition(typeof writeLedger === 'function', 'LEDGER');
  if (!dryRun) authorizeWorkflow(environment, event, revision, clean);
  const { manifest, manifestSha256 } = await loadReviewedDecisions(root);
  const ledger = { schemaVersion: 1, projectKey: SONAR_PROJECT, branch: 'main', manifestSha256,
    revision: dryRun ? null : revision, dryRun, result: 'preflight', entries: manifest.decisions.map(decision => ({
      issueKey: decision.issueKey, rule: decision.rule, disposition: decision.disposition, status: 'not-submitted'
    })) };
  const dependencies = { fetchImpl, token: environment.SONAR_TOKEN };
  try {
    await persistLedger(ledger, writeLedger);
    if (!dryRun) {
      // Complete every local and live preflight before the first mutation, including authorization for every issue.
      for (const [index, decision] of manifest.decisions.entries()) {
        ledger.entries[index].status = decisionState(await requestIssue(decision, dependencies), decision);
      }
      ledger.result = 'preflight-passed';
      await persistLedger(ledger, writeLedger);
      for (const [index, decision] of manifest.decisions.entries()) {
        const entry = ledger.entries[index];
        if (entry.status === 'already-confirmed') continue;
        // Recheck immediately before each POST as well: do not overwrite another review made during preflight.
        entry.status = decisionState(await requestIssue(decision, dependencies), decision);
        if (entry.status === 'already-confirmed') continue;
        // Persist intent before POST. Cancellation or an unconfirmed readback leaves an explicit ambiguous entry.
        entry.status = 'attempted-unconfirmed';
        await persistLedger(ledger, writeLedger);
        entry.response = await transitionOnce(decision, dependencies);
        const readback = await requestIssue(decision, dependencies);
        requireCondition(decisionState(readback, decision) === 'already-confirmed', 'UNCONFIRMED');
        entry.status = 'confirmed';
        await persistLedger(ledger, writeLedger);
      }
    }
    ledger.result = dryRun ? 'local-bindings-verified' : 'confirmed';
    await persistLedger(ledger, writeLedger);
    return ledger;
  } catch (error) {
    const code = error instanceof DecisionError ? error.code : 'READ';
    ledger.result = 'failed';
    ledger.failureCode = code;
    await persistLedger(ledger, writeLedger);
    throw new DecisionError(code);
  }
}

async function main() {
  const args = process.argv.slice(2);
  requireCondition(args.length === 0 || (args.length === 1 && args[0] === '--dry-run'), 'AUTHORIZATION');
  const dryRun = args[0] === '--dry-run';
  let event;
  let revision;
  let clean;
  if (!dryRun) {
    try {
      event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
      revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      clean = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() === '';
    } catch {
      throw new DecisionError('AUTHORIZATION');
    }
  }
  const ledger = await applyReviewedDecisions({ event, revision, clean, dryRun, writeLedger: async value => {
    const filename = path.join(ROOT, REVIEW_LEDGER);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(`${filename}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
    await rename(`${filename}.tmp`, filename);
  } });
  console.log(`Reviewed Sonar decisions: ${ledger.result}; ${ledger.entries.length} entries. Ledger: ${REVIEW_LEDGER}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof DecisionError ? error.message : 'The reviewed Sonar decision runner failed safely.');
    process.exitCode = 1;
  });
}
