import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertExactHeadClean, assertSourceMatchesHead, childEnvironment, jobsFor, npmCliPath,
  parseOptions, runFixtureEvidence, runReceiptVerification } from '../scripts/run_receipt_verification.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const temporary = realpathSync.native(os.tmpdir());
const root = mkdtempSync(path.join(temporary, 'tsx-receipt-runner-'));
const lookup = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe') : '/usr/bin/which';
const located = spawnSync(lookup, ['git'], { encoding: 'utf8', shell: false });
assert.equal(located.status, 0, located.stderr);
const gitExecutable = realpathSync.native(located.stdout.trim().split(/\r?\n/)[0]);
const gitTool = { path: gitExecutable, sha256: hash(readFileSync(gitExecutable)) };
function git(args) {
  const result = spawnSync(gitExecutable, ['-C', root, ...args], { encoding: 'utf8', shell: false, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

try {
  const revision = 'a'.repeat(40);
  const python = path.resolve(root, 'python');
  const valid = ['--sha', revision, '--python', python, '--git', gitExecutable,
    '--git-sha256', gitTool.sha256, '--group', 'backend', '--tag', 'freeze-1'];
  const options = { revision, python, git: gitExecutable, gitSha256: gitTool.sha256, group: 'backend', tag: 'freeze-1' };
  assert.deepEqual(parseOptions(valid), options);
  for (const args of [valid.slice(0, 10), [...valid.slice(0, 10), '--group', 'python'],
    [...valid.slice(0, 1), 'not-a-sha', ...valid.slice(2)],
    [...valid.slice(0, 3), 'relative-python', ...valid.slice(4)],
    [...valid.slice(0, 5), 'relative-git', ...valid.slice(6)],
    [...valid.slice(0, 9), 'unknown', ...valid.slice(10)],
    [...valid.slice(0, 11), '../escape']]) {
    assert.throws(() => parseOptions(args), /Receipt verification refused/);
  }
  await assert.rejects(runReceiptVerification({ ...options, tag: '../escape' }), /invalid evidence tag/);
  const shards = jobsFor(python, npmCliPath()).mutations;
  assert.deepEqual(shards.map(item => item.name), ['mutation-schema', 'mutation-queue', 'mutation-retry', 'mutation-trading-risk']);
  assert.deepEqual(shards.map(item => item.timeoutMs / 60_000), [50, 30, 30, 30]);

  git(['init', '-q']);
  git(['config', 'user.email', 'receipt-test@example.invalid']);
  git(['config', 'user.name', 'Receipt Test']);
  git(['config', 'core.autocrlf', 'false']);
  mkdirSync(path.join(root, 'src'));
  const source = path.join(root, 'src', 'sample.ts');
  writeFileSync(source, 'export const value = 1;\n');
  writeFileSync(path.join(root, '.gitignore'), 'src/ignored.ts\n');
  git(['add', '--', '.gitignore', 'src/sample.ts']);
  git(['commit', '-q', '-m', 'Frozen fixture']);
  const head = git(['rev-parse', 'HEAD']);
  const inventory = { files: [{ path: 'src/sample.ts', sha256: hash(readFileSync(source)) }] };
  assert.equal(assertExactHeadClean(root, head, gitTool), head);
  assertSourceMatchesHead(root, head, inventory, gitTool);
  assert.throws(() => assertExactHeadClean(root, revision, gitTool), /HEAD differs/);
  assert.throws(() => assertExactHeadClean(root, head, { ...gitTool, sha256: '0'.repeat(64) }), /trusted Git executable changed/);

  writeFileSync(source, 'export const value = 2;\n');
  assert.throws(() => assertExactHeadClean(root, head, gitTool), /dirty/);
  assert.throws(() => assertSourceMatchesHead(root, head,
    { files: [{ path: 'src/sample.ts', sha256: hash(readFileSync(source)) }] }, gitTool), /differ from Git/);
  writeFileSync(source, 'export const value = 1;\n');
  assert.equal(assertExactHeadClean(root, head, gitTool), head);

  const ignored = path.join(root, 'src', 'ignored.ts');
  writeFileSync(ignored, 'export const ignored = true;\n');
  assert.equal(assertExactHeadClean(root, head, gitTool), head, 'Git status alone cannot catch an ignored source addition');
  assert.throws(() => assertSourceMatchesHead(root, head,
    { files: [...inventory.files, { path: 'src/ignored.ts', sha256: hash(readFileSync(ignored)) }] }, gitTool), /missing Git blob/);

  const shadow = path.join(root, 'shadow');
  mkdirSync(shadow);
  copyFileSync(gitExecutable, path.join(shadow, process.platform === 'win32' ? 'git.exe' : 'git'));
  const priorPath = process.env.PATH;
  try {
    process.env.PATH = `${shadow}${path.delimiter}${priorPath ?? ''}`;
    assert.throws(() => assertExactHeadClean(root, head, gitTool), /PATH shadows/);
  } finally {
    process.env.PATH = priorPath;
  }

  const nodeInjection = path.join(root, 'node-injection.cjs');
  const pythonInjection = path.join(root, 'sitecustomize.py');
  writeFileSync(nodeInjection, "console.log('INJECTED_NODE_OPTIONS');\n");
  writeFileSync(pythonInjection, "print('INJECTED_PYTHONPATH')\n");
  const pythonRuntime = process.env.TSX_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const ambient = { ...process.env, NODE_OPTIONS: `--require=${nodeInjection}`, PYTHONPATH: root,
    npm_config_loglevel: 'silly', npm_execpath: nodeInjection, TSX_FAKE_SECRET: 'must-not-propagate' };
  const clean = childEnvironment(ambient, pythonRuntime, process.execPath, false, gitExecutable);
  for (const forbidden of ['NODE_OPTIONS', 'PYTHONPATH', 'npm_config_loglevel', 'npm_execpath', 'TSX_FAKE_SECRET']) {
    assert.equal(clean[forbidden], undefined, `${forbidden} must not reach child processes`);
  }
  const nodeControl = spawnSync(process.execPath, ['-e', "process.stdout.write('clean')"],
    { encoding: 'utf8', env: ambient, shell: false });
  assert.equal(nodeControl.status, 0, nodeControl.stderr);
  assert.match(nodeControl.stdout, /INJECTED_NODE_OPTIONS/);
  const nodeClean = spawnSync(process.execPath, ['-e', "process.stdout.write('clean')"],
    { encoding: 'utf8', env: clean, shell: false });
  assert.equal(nodeClean.status, 0, nodeClean.stderr);
  assert.equal(nodeClean.stdout, 'clean');
  const pythonControl = spawnSync(pythonRuntime, ['-c', "print('clean')"],
    { encoding: 'utf8', env: ambient, shell: false });
  assert.equal(pythonControl.status, 0, pythonControl.stderr);
  assert.match(pythonControl.stdout, /INJECTED_PYTHONPATH/);
  const pythonClean = spawnSync(pythonRuntime, ['-c', "print('clean')"],
    { encoding: 'utf8', env: clean, shell: false });
  assert.equal(pythonClean.status, 0, pythonClean.stderr);
  assert.equal(pythonClean.stdout.trim(), 'clean');
  const previousNpmExecpath = process.env.npm_execpath;
  try {
    process.env.npm_execpath = nodeInjection;
    assert.notEqual(npmCliPath(), realpathSync.native(nodeInjection), 'npm_execpath cannot replace the adjacent npm CLI');
  } finally {
    if (previousNpmExecpath === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = previousNpmExecpath;
  }

  const fakeInputs = { sourceTreeHash: 'a'.repeat(64), nodeSourcesHash: 'b'.repeat(64),
    testSourcesHash: 'c'.repeat(64), fixturesHash: 'd'.repeat(64), files: [] };
  const fakeRuntime = { node: process.version, ccxt: '4.5.75', sdkTreeHash: 'e'.repeat(64) };
  const fixture = (tag, commands, runtime = () => fakeRuntime) => runFixtureEvidence({
    directory: root, tag, commands, env: clean, snapshot: () => fakeInputs, runtime,
  });
  const readReport = tag => JSON.parse(readFileSync(path.join(root, 'reports', 'receipt-verification', tag, 'fixture.json')));
  await fixture('actual-success', [{ name: 'env-check', command: process.execPath,
    args: ['-e', "console.log(process.env.NODE_OPTIONS || process.env.PYTHONPATH || process.env.TSX_FAKE_SECRET || 'clean')"] }]);
  const successful = readReport('actual-success');
  assert.equal(successful.kind, 'receipt-runner-self-test');
  assert.equal(successful.supplementalChecksPassed, true);
  assert.equal(successful.performedGateExecution, false);
  assert.equal(successful.receiptSufficiency, false);
  assert.equal(successful.dependencyInstallProvenance, 'external-unverified');
  assert.equal(successful.commands[0].sourceVerifiedAfter, true);
  assert.equal(readFileSync(path.join(root, successful.commands[0].log), 'utf8').trim(), 'clean');
  await assert.rejects(fixture('actual-failure', [
    { name: 'fail', command: process.execPath, args: ['-e', 'process.exit(7)'] },
    { name: 'must-not-run', command: process.execPath, args: ['-e', "console.log('unexpected')"] },
  ]), /group failed/);
  const failed = readReport('actual-failure');
  assert.equal(failed.commands.length, 1);
  assert.equal(failed.commands[0].exitCode, 7);
  assert.equal(failed.supplementalChecksPassed, false);
  let runtimeCalls = 0;
  await assert.rejects(fixture('runtime-drift', [{ name: 'pass', command: process.execPath, args: ['-e', "console.log('pass')"] }],
    () => ({ ...fakeRuntime, sdkTreeHash: runtimeCalls++ === 0 ? 'e'.repeat(64) : 'f'.repeat(64) })), /runtime drifted/);
  const drifted = readReport('runtime-drift');
  assert.equal(drifted.allCommandsPassed, true);
  assert.equal(drifted.observedRuntimeUnchanged, false);
  assert.equal(drifted.supplementalChecksPassed, false);
  assert.equal(drifted.performedGateExecution, false);
  let snapshots = 0;
  await assert.rejects(runFixtureEvidence({ directory: root, tag: 'source-drift',
    commands: [{ name: 'pass', command: process.execPath, args: ['-e', "console.log('pass')"] }],
    env: clean, runtime: () => fakeRuntime,
    snapshot: () => snapshots++ === 0 ? fakeInputs : { ...fakeInputs, sourceTreeHash: 'f'.repeat(64) },
  }), /source inventory changed/);
  const sourceDrifted = readReport('source-drift');
  assert.ok(sourceDrifted.completedAt === undefined);
  assert.ok(sourceDrifted.commands[0].sourceVerifiedAfter === undefined);
  console.log('PASS receipt evidence runner: parameters, source fence, environment isolation and actual report outcomes');
} finally {
  assert.equal(path.dirname(realpathSync.native(root)), temporary);
  assert.match(path.basename(root), /^tsx-receipt-runner-[a-zA-Z0-9]+$/);
  rmSync(root, { recursive: true, force: true });
}
