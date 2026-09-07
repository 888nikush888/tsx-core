import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyReviewedDecisions, authorizeWorkflow, loadReviewedDecisions, REVIEW_MANIFEST, SONAR_PROJECT } from '../scripts/sonar_review_decisions.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await mkdtemp(path.join(os.tmpdir(), 'tsx-sonar-decisions-'));
const revision = 'a'.repeat(40);
const secret = 'FAKE-TOKEN-NEVER-PRINT';
const environment = {
  GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: '888nikush888/tsx-core',
  GITHUB_ACTOR: '888nikush888', GITHUB_TRIGGERING_ACTOR: '888nikush888', GITHUB_REF_TYPE: 'branch',
  GITHUB_REF: 'refs/heads/branch-reviewed',
  GITHUB_WORKFLOW_REF: '888nikush888/tsx-core/.github/workflows/quality.yml@refs/heads/branch-reviewed',
  GITHUB_SHA: revision, SONAR_EXPECTED_REVISION: revision, SONAR_APPLY_REVIEWED_DECISIONS: 'true', SONAR_TOKEN: secret,
  // These general scanner settings may exist in the job but must never select decision targets.
  SONAR_HOST_URL: 'https://attacker.invalid', SONAR_PROJECT_KEY: 'wrong-project', SONAR_BRANCH: 'branch-reviewed'
};
const event = { repository: { full_name: '888nikush888/tsx-core', owner: { login: '888nikush888' } },
  sender: { login: '888nikush888' }, inputs: { apply_reviewed_sonar_decisions: 'true' } };
const original = JSON.parse(await readFile(path.join(repository, REVIEW_MANIFEST), 'utf8'));
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

async function resetManifest(manifest = original) {
  await mkdir(path.dirname(path.join(root, REVIEW_MANIFEST)), { recursive: true });
  await writeFile(path.join(root, REVIEW_MANIFEST), JSON.stringify(manifest));
  for (const decision of original.decisions) {
    for (const file of [decision.source, ...decision.tests]) {
      await mkdir(path.dirname(path.join(root, file.path)), { recursive: true });
      await writeFile(path.join(root, file.path), await readFile(path.join(repository, file.path)));
    }
  }
}

function openIssue(decision) {
  // Actual SonarCloud main response shape: no branch field; both modern and legacy status, impacts, comments and transitions.
  return { key: decision.issueKey, rule: decision.rule, component: decision.component, project: SONAR_PROJECT,
    status: 'OPEN', issueStatus: 'OPEN', type: 'CODE_SMELL', severity: 'MINOR',
    impacts: [{ softwareQuality: 'MAINTAINABILITY', severity: 'LOW' }], comments: [], transitions: ['falsepositive', 'accept'] };
}

function transport(manifest = original) {
  const issues = new Map(manifest.decisions.map(decision => [decision.issueKey, openIssue(decision)]));
  const calls = [];
  const ledgers = [];
  const state = { issues, calls, ledgers, postMode: 'ok', getOverride: null, postCount: 0 };
  state.writeLedger = ledger => ledgers.push(ledger);
  state.fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://sonarcloud.io');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, `Bearer ${secret}`);
    assert.ok(options.signal instanceof AbortSignal);
    if (options.method === 'GET') {
      assert.equal(parsed.pathname, '/api/issues/search');
      assert.equal(parsed.searchParams.get('componentKeys'), SONAR_PROJECT);
      assert.equal(parsed.searchParams.get('branch'), 'main');
      assert.equal(parsed.searchParams.get('additionalFields'), 'comments,transitions');
      assert.equal(parsed.searchParams.has('pullRequest'), false);
      const key = parsed.searchParams.get('issues');
      calls.push({ method: 'GET', key });
      const payload = { total: 1, paging: { pageIndex: 1, total: 1 }, issues: [issues.get(key)] };
      return state.getOverride?.(payload, key) ?? json(payload);
    }
    assert.equal(options.method, 'POST');
    assert.equal(parsed.pathname, '/api/issues/do_transition');
    assert.equal(parsed.search, '');
    assert.equal(options.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.ok(options.body instanceof URLSearchParams);
    assert.deepEqual([...options.body.keys()], ['issue', 'transition', 'comment']);
    const key = options.body.get('issue');
    const transition = options.body.get('transition');
    const comment = options.body.get('comment');
    assert.match(comment, /^TSX Core reviewed decision v1: [a-f0-9]{64}\n/u);
    assert.ok(comment.includes(manifest.decisions.find(decision => decision.issueKey === key).rationale));
    const latestLedger = ledgers.at(-1);
    assert.equal(latestLedger.entries.find(entry => entry.issueKey === key).status, 'attempted-unconfirmed');
    calls.push({ method: 'POST', key });
    state.postCount += 1;
    if (state.postMode === '403') return json({ error: secret }, 403);
    if (state.postMode === '400') return json({ error: secret }, 400);
    if (state.postMode === 'timeout') throw new TypeError(secret);
    if (state.postMode === '500') return json({ error: secret }, 500);
    const issue = issues.get(key);
    issue.status = 'RESOLVED';
    issue.issueStatus = transition === 'falsepositive' ? 'FALSE_POSITIVE' : 'ACCEPTED';
    issue.resolution = transition === 'falsepositive' ? 'FALSE-POSITIVE' : 'WONTFIX';
    issue.comments.push({ markdown: comment });
    if (state.postMode === 'timeout-applied') throw new TypeError(secret);
    if (state.postMode === 'missing-comment') issue.comments = [];
    return json({ untrusted: secret });
  };
  return state;
}

const run = (state, changes = {}) => applyReviewedDecisions({ root, environment, event, revision, clean: true,
  fetchImpl: state.fetchImpl, writeLedger: state.writeLedger, ...changes });

async function expectFailure(state, expression, changes = {}) {
  await assert.rejects(run(state, changes), expression);
  assert.doesNotMatch(JSON.stringify(state.ledgers), new RegExp(secret, 'u'));
}

function testAuthorization() {
  authorizeWorkflow(environment, event, revision, true);
  authorizeWorkflow(environment, { ...event, inputs: { apply_reviewed_sonar_decisions: true } }, revision, true);
  for (const changed of [
    { GITHUB_ACTIONS: 'false' }, { GITHUB_EVENT_NAME: 'push' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_REPOSITORY: 'fork/tsx-core' }, { GITHUB_ACTOR: 'collaborator' }, { GITHUB_TRIGGERING_ACTOR: 'collaborator' },
    { SONAR_APPLY_REVIEWED_DECISIONS: undefined }, { SONAR_APPLY_REVIEWED_DECISIONS: 'false' },
    { GITHUB_REF_TYPE: 'tag' }, { GITHUB_REF: 'refs/tags/v1' }, { GITHUB_REF: 'refs/heads/a\nsecret' },
    { GITHUB_WORKFLOW_REF: '888nikush888/tsx-core/.github/workflows/other.yml@refs/heads/branch-reviewed' }
  ]) assert.throws(() => authorizeWorkflow({ ...environment, ...changed }, event, revision, true), /owner-started/u);
  for (const changed of [
    { repository: { full_name: 'fork/tsx-core', owner: { login: '888nikush888' } } },
    { repository: { full_name: '888nikush888/tsx-core', owner: { login: 'collaborator' } } },
    { sender: { login: 'collaborator' } }, { inputs: {} }, { inputs: { apply_reviewed_sonar_decisions: false } }
  ]) assert.throws(() => authorizeWorkflow(environment, { ...event, ...changed }, revision, true), /owner-started/u);
  assert.throws(() => authorizeWorkflow(environment, event, revision, false), /exact workflow revision/u);
  assert.throws(() => authorizeWorkflow(environment, event, 'b'.repeat(40), true), /exact workflow revision/u);
  assert.throws(() => authorizeWorkflow({ ...environment, SONAR_EXPECTED_REVISION: 'b'.repeat(40) }, event, revision, true), /exact workflow revision/u);
  assert.throws(() => authorizeWorkflow({ ...environment, SONAR_TOKEN: '' }, event, revision, true), /Administer Issues/u);
}

async function testBindingsAndManifest() {
  const manifestChanges = [
    value => { value.projectKey = 'other'; }, value => { value.branch = 'other'; }, value => { value.url = 'https://attacker.invalid'; },
    value => { value.decisions.push(value.decisions[0]); }, value => { value.decisions.at(-1).disposition = 'resolve'; },
    value => { value.decisions.at(-1).source.path = '../../outside.py'; }, value => { value.decisions.at(-1).source.path = 'src//a.ts'; },
    value => { value.decisions.at(-1).tests = []; }, value => { value.decisions.at(-1).rationale = 'silence warning'; },
    value => { value.decisions.at(-1).component = 'other'; },
    value => { value.decisions.at(-1).disposition = 'accept'; delete value.decisions.at(-1).acceptanceRationale; },
    value => { value.decisions.at(-1).source.sha256 = 'b'.repeat(64); },
    value => { value.decisions.at(-1).tests[0].sha256 = 'b'.repeat(64); }
  ];
  for (const change of manifestChanges) {
    const manifest = structuredClone(original);
    change(manifest);
    await resetManifest(manifest);
    const state = transport();
    await expectFailure(state, /manifest|pinned file/u);
    assert.equal(state.calls.length, 0, 'Every local binding must pass before even reading live issues.');
  }
  await resetManifest();
  await writeFile(path.join(root, original.decisions.at(-1).tests[0].path), 'changed regression');
  await assert.rejects(loadReviewedDecisions(root), /pinned file/u);
  await resetManifest();
  const target = path.join(root, 'linked-tests');
  await symlink(path.join(repository, 'exchange_executor/tests'), target, 'junction');
  const manifest = structuredClone(original);
  manifest.decisions[0].tests[0].path = 'tests/linked/test_stream_health.py';
  await mkdir(path.join(root, 'tests'), { recursive: true });
  await symlink(target, path.join(root, 'tests/linked'), 'junction');
  await writeFile(path.join(root, REVIEW_MANIFEST), JSON.stringify(manifest));
  await assert.rejects(loadReviewedDecisions(root), /pinned file/u);
  await resetManifest();
}

async function testIdentityAndPermissionPreflight() {
  const last = original.decisions.at(-1).issueKey;
  for (const change of [
    { key: 'other-issue' }, { rule: 'python:S1234' }, { project: 'other' }, { component: 'other' },
    { branch: 'other' }, { pullRequest: '28' }, { pullRequest: null }
  ]) {
    const state = transport();
    Object.assign(state.issues.get(last), change);
    await expectFailure(state, /exact reviewed main issue identity/u);
    assert.equal(state.postCount, 0);
  }
  for (const change of [
    { type: 'VULNERABILITY' }, { type: undefined }, { type: 'BUG' }, { impacts: [] },
    { impacts: [{ softwareQuality: 'SECURITY', severity: 'LOW' }] },
    { impacts: [{ softwareQuality: 'UNKNOWN', severity: 'LOW' }] }, { impacts: [{ softwareQuality: 'MAINTAINABILITY', severity: 'UNKNOWN' }] }
  ]) {
    const state = transport();
    Object.assign(state.issues.get(last), change);
    await expectFailure(state, /classification/u);
    assert.equal(state.postCount, 0);
  }
  for (const change of [{ transitions: [] }, { transitions: undefined }, { transitions: ['resolve'] }]) {
    const state = transport();
    Object.assign(state.issues.get(last), change);
    await expectFailure(state, /Administer Issues/u);
    assert.equal(state.postCount, 0);
  }
  for (const change of [{ comments: undefined }, { comments: [{}] }, { issueStatus: undefined },
    { issueStatus: 'FIXED' }, { status: 'RESOLVED', resolution: 'FIXED' }]) {
    const inconsistent = transport();
    Object.assign(inconsistent.issues.get(last), change);
    await expectFailure(inconsistent, /prior review comment/u);
    assert.equal(inconsistent.postCount, 0);
  }
  const state = transport();
  state.getOverride = (_, key) => key === last ? json({ errors: [{ msg: secret }] }, 403) : undefined;
  await expectFailure(state, /Administer Issues/u);
  assert.equal(state.postCount, 0);
  for (const body of [{}, { issues: [], paging: { total: 0, pageIndex: 1 } },
    { issues: [openIssue(original.decisions[0])], paging: { total: 1, pageIndex: 2 } },
    { issues: [openIssue(original.decisions[0])], paging: { total: 1, pageIndex: 1 }, total: 2 }]) {
    const malformed = transport();
    malformed.getOverride = () => json(body);
    await expectFailure(malformed, /identity/u);
    assert.equal(malformed.postCount, 0);
  }
}

async function testConfirmedTransitionsAndReplay() {
  const state = transport();
  const result = await run(state);
  assert.equal(result.result, 'confirmed');
  assert.equal(state.postCount, original.decisions.length);
  assert.deepEqual(state.calls.slice(0, original.decisions.length), original.decisions.map(decision => ({ method: 'GET', key: decision.issueKey })));
  assert.ok(result.entries.every(entry => entry.status === 'confirmed'));
  assert.doesNotMatch(JSON.stringify(result), /FAKE-TOKEN|untrusted|markdown|authorization/u);
  const replay = await run(state);
  assert.equal(state.postCount, original.decisions.length, 'Rerunning an already confirmed decision must never repeat the POST.');
  assert.ok(replay.entries.every(entry => entry.status === 'already-confirmed'));
  const issue = state.issues.get(original.decisions[0].issueKey);
  issue.comments = [{ markdown: 'A different manual decision' }];
  await expectFailure(state, /prior review comment/u);
  assert.equal(state.postCount, original.decisions.length);
}

async function testUncertaintyAndReadback() {
  for (const mode of ['timeout', '500', 'missing-comment', '400', '403']) {
    const state = transport();
    state.postMode = mode;
    await expectFailure(state, /unconfirmed|prior review comment|rejected|Administer Issues/u);
    assert.equal(state.postCount, 1, 'A rejected or unconfirmed transition must not be retried or followed by another POST.');
    assert.equal(state.ledgers.at(-1).result, 'failed');
    assert.equal(state.ledgers.at(-1).entries[0].status, 'attempted-unconfirmed');
  }
  const applied = transport();
  applied.postMode = 'timeout-applied';
  const result = await run(applied);
  assert.equal(applied.postCount, original.decisions.length, 'A lost POST response is confirmed only by the independently read exact status and comment.');
  assert.ok(result.entries.every(entry => entry.response === 'uncertain' && entry.status === 'confirmed'));
  const invalid = transport();
  invalid.getOverride = payload => invalid.postCount > 0 ? json({ ...payload, issues: [{ ...payload.issues[0], project: 'other' }] }) : undefined;
  await expectFailure(invalid, /identity/u);
  assert.equal(invalid.postCount, 1);
  const failedReadback = transport();
  failedReadback.getOverride = () => {
    if (failedReadback.postCount > 0) throw new TypeError(secret);
    return undefined;
  };
  await expectFailure(failedReadback, /readback failed/u);
  assert.equal(failedReadback.postCount, 1);
  const changed = transport();
  let reads = 0;
  changed.getOverride = payload => {
    reads += 1;
    if (reads > original.decisions.length) payload.issues[0].issueStatus = 'FIXED';
    return json(payload);
  };
  await expectFailure(changed, /prior review comment/u);
  assert.equal(changed.postCount, 0, 'Changes after complete preflight must be caught by the immediate pre-POST recheck.');
  const noLedger = transport();
  await expectFailure(noLedger, /ledger could not be persisted/u, { writeLedger: () => { throw new Error(secret); } });
  assert.equal(noLedger.postCount, 0);
}

async function testExplicitAcceptance() {
  const manifest = structuredClone(original);
  manifest.decisions = [manifest.decisions[0]];
  manifest.decisions[0].disposition = 'accept';
  manifest.decisions[0].acceptanceRationale = 'This synthetic fixture explicitly accepts a non-security maintainability tradeoff with regression evidence. Production acceptances require their own independently reviewed rationale and pinned source files.';
  await resetManifest(manifest);
  const state = transport(manifest);
  assert.equal((await run(state)).result, 'confirmed');
  assert.equal(state.issues.get(manifest.decisions[0].issueKey).issueStatus, 'ACCEPTED');
  for (const change of [{ severity: 'CRITICAL' }, { severity: 'BLOCKER' },
    { impacts: [{ softwareQuality: 'MAINTAINABILITY', severity: 'HIGH' }] },
    { impacts: [{ softwareQuality: 'SECURITY', severity: 'LOW' }] }]) {
    const rejected = transport(manifest);
    Object.assign(rejected.issues.get(manifest.decisions[0].issueKey), change);
    await expectFailure(rejected, /classification/u);
    assert.equal(rejected.postCount, 0);
  }
  await resetManifest();
}

async function testWorkflowAndCli() {
  const workflow = await readFile(path.join(repository, '.github/workflows/quality.yml'), 'utf8');
  assert.match(workflow, /workflow_dispatch:\s+inputs:\s+apply_reviewed_sonar_decisions:[\s\S]*?type: boolean\s+required: false\s+default: false/u);
  const step = workflow.slice(workflow.indexOf('      - name: Apply pinned reviewed main Sonar decisions'), workflow.indexOf('      - name: Prepare explicit Sonar revision'));
  assert.match(step, /if: github\.event_name == 'workflow_dispatch' && inputs\.apply_reviewed_sonar_decisions && github\.actor == github\.repository_owner && github\.triggering_actor == github\.repository_owner/u);
  assert.match(step, /run: node scripts\/sonar_review_decisions\.js\s*$/u);
  assert.match(workflow, /reports\/sonar-reviewed-decisions\//u);
  assert.ok(workflow.indexOf('      - name: Checkout exact analyzed revision') < workflow.indexOf('      - name: Apply pinned reviewed main Sonar decisions'));
  assert.ok(workflow.indexOf('      - name: Produce Python coverage') < workflow.indexOf('      - name: Apply pinned reviewed main Sonar decisions'));
  const result = spawnSync(process.execPath, ['scripts/sonar_review_decisions.js', '--issue=arbitrary'], {
    cwd: repository, encoding: 'utf8', env: { ...process.env, SONAR_TOKEN: secret, GITHUB_ACTIONS: 'false' }
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /explicitly enabled/u);
  assert.doesNotMatch(`${result.stderr}${result.stdout}`, new RegExp(secret, 'u'));
  const state = transport();
  const dryRun = await run(state, { dryRun: true, environment: {} });
  assert.equal(dryRun.result, 'local-bindings-verified');
  assert.equal(state.calls.length, 0, 'Dry run checks bindings without sending any credentials or HTTP requests.');
}

try {
  testAuthorization();
  await resetManifest();
  await testBindingsAndManifest();
  await testIdentityAndPermissionPreflight();
  await testConfirmedTransitionsAndReplay();
  await testUncertaintyAndReadback();
  await testExplicitAcceptance();
  await testWorkflowAndCli();
} finally {
  assert.ok(root.startsWith(path.join(os.tmpdir(), 'tsx-sonar-decisions-')));
  await rm(root, { recursive: true, force: true });
}
console.log('Reviewed Sonar decisions: exact bindings, owner-only manual authorization, atomic comments, readback, no blind retries, and security refusal passed.');
