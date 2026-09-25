/** Exact-head, non-provider execution evidence for a later independent receipt review.
 * This runner never creates an implementation receipt, approval pin, provider
 * acceptance, or release authority. Its command inventory is fixed in code.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectBuildInputs } from './verify_exchange_implementation.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const stamp = () => new Date().toISOString();
const shaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const tagPattern = /^[a-z0-9][a-z0-9-]{0,47}$/;
const groups = Object.freeze(['foundation', 'backend', 'python', 'frontend', 'build', 'browser', 'mutations', 'dependencies']);
const systemEnvironment = Object.freeze(['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'HOMEDRIVE', 'HOMEPATH',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']);

function requireEvidence(condition, reason) {
  if (!condition) throw new Error(`Receipt verification refused: ${reason}.`);
}

/** Never forward NODE_OPTIONS, PYTHONPATH, npm_config_*, application secrets,
 * Git overrides or arbitrary tool variables into verifier subprocesses.
 */
export function childEnvironment(ambient, python = null, node = null, browser = false, gitExecutable = null) {
  const normalized = new Map(Object.entries(ambient).map(([key, value]) => [key.toUpperCase(), value]));
  const result = {};
  for (const key of systemEnvironment) {
    const value = normalized.get(key);
    if (typeof value === 'string' && value.length > 0) result[key] = value;
  }
  const parentPath = normalized.get('PATH');
  const prepend = [python && path.dirname(python), node && path.dirname(node),
    gitExecutable && path.dirname(gitExecutable)].filter(Boolean);
  result.PATH = [...prepend, typeof parentPath === 'string' ? parentPath : ''].filter(Boolean).join(path.delimiter);
  if (python) result.TSX_TEST_PYTHON = python;
  if (browser) result.CI = 'true';
  return result;
}

export function parseOptions(args) {
  requireEvidence(Array.isArray(args) && args.length === 12,
    'expected --sha, --python, --git, --git-sha256, --group and --tag');
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    requireEvidence(['--sha', '--python', '--git', '--git-sha256', '--group', '--tag'].includes(key)
      && !Object.hasOwn(values, key), 'unknown or duplicate option');
    values[key] = args[i + 1];
  }
  return validateOptions({ revision: values['--sha'], python: values['--python'], git: values['--git'],
    gitSha256: values['--git-sha256'], group: values['--group'], tag: values['--tag'] });
}

export function validateOptions(options) {
  requireEvidence(options && typeof options === 'object' && !Array.isArray(options)
    && Object.keys(options).sort().join(',') === 'git,gitSha256,group,python,revision,tag', 'invalid options object');
  requireEvidence(shaPattern.test(options.revision), 'invalid frozen SHA');
  requireEvidence(typeof options.python === 'string' && path.isAbsolute(options.python), 'Python path must be absolute');
  requireEvidence(typeof options.git === 'string' && path.isAbsolute(options.git), 'Git path must be absolute');
  requireEvidence(digestPattern.test(options.gitSha256), 'trusted Git digest is invalid');
  requireEvidence(groups.includes(options.group), 'unknown verification group');
  requireEvidence(tagPattern.test(options.tag), 'invalid evidence tag');
  return Object.freeze({ ...options });
}

function trustedGit(tool) {
  requireEvidence(tool && typeof tool.path === 'string' && path.isAbsolute(tool.path)
    && digestPattern.test(tool.sha256), 'trusted Git identity is invalid');
  const canonical = realpathSync.native(tool.path);
  requireEvidence(canonical === tool.path && lstatSync(canonical).isFile()
    && sha256(readFileSync(canonical)) === tool.sha256, 'trusted Git executable changed');
  return canonical;
}

function ambientGitPath() {
  const currentPath = Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
  const executable = process.platform === 'win32' ? 'git.exe' : 'git';
  for (const directory of currentPath.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, executable);
    if (existsSync(candidate)) return realpathSync.native(candidate);
  }
  return null;
}

function git(directory, args, tool, options = {}) {
  const executable = trustedGit(tool);
  const ambient = ambientGitPath();
  requireEvidence(!ambient || ambient === executable, 'PATH shadows the trusted Git executable');
  const result = spawnSync(executable, ['-C', directory, '-c', 'core.fsmonitor=false', ...args], {
    ...options, shell: false, windowsHide: true, timeout: 30_000,
    env: { ...childEnvironment(process.env, null, null, false, executable),
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : devNull,
      GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' },
  });
  requireEvidence(!result.error && result.status === 0, `git ${args[0]} failed`);
  return result.stdout;
}

export function assertExactHeadClean(directory, expectedRevision, gitTool) {
  requireEvidence(shaPattern.test(expectedRevision), 'invalid frozen SHA');
  const actual = git(directory, ['rev-parse', '--verify', 'HEAD'], gitTool,
    { encoding: 'utf8', maxBuffer: 16 * 1024 }).trim();
  requireEvidence(actual === expectedRevision, 'checkout HEAD differs from frozen SHA');
  const status = git(directory, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], gitTool,
    { maxBuffer: 4 * 1024 * 1024 });
  requireEvidence(status.length === 0, 'working tree or index is dirty');
  return actual;
}

/** Compare every discovered source byte against the frozen Git object, including
 * paths that a local ignore rule could otherwise hide from git status.
 */
export function assertSourceMatchesHead(directory, revision, inputs, gitTool) {
  requireEvidence(shaPattern.test(revision) && Array.isArray(inputs?.files) && inputs.files.length > 0, 'source inventory is invalid');
  const paths = inputs.files.map(row => row.path);
  requireEvidence(new Set(paths).size === paths.length && paths.every(name => typeof name === 'string' && name.length > 0
    && !name.includes('\\') && !name.split('/').includes('..') && !name.startsWith('/')), 'source paths are invalid');
  const batch = git(directory, ['cat-file', '--batch'], gitTool, {
    input: paths.map(name => `${revision}:${name}\n`).join(''), maxBuffer: 160 * 1024 * 1024,
  });
  let offset = 0;
  for (const row of inputs.files) {
    const newline = batch.indexOf(10, offset);
    requireEvidence(newline > offset, `missing Git object for ${row.path}`);
    const header = batch.subarray(offset, newline).toString('utf8').split(' ');
    const length = Number(header[2]);
    requireEvidence(header.length === 3 && header[1] === 'blob' && Number.isSafeInteger(length) && length >= 0,
      `missing Git blob for ${row.path}`);
    const end = newline + 1 + length;
    requireEvidence(end < batch.length && batch[end] === 10, `incomplete Git blob for ${row.path}`);
    requireEvidence(sha256(batch.subarray(newline + 1, end)) === row.sha256, `source bytes differ from Git for ${row.path}`);
    offset = end + 1;
  }
  requireEvidence(offset === batch.length, 'unexpected Git blob output');
}

function sourceSnapshot(directory, revision, gitTool) {
  assertExactHeadClean(directory, revision, gitTool);
  const inputs = collectBuildInputs(directory);
  assertSourceMatchesHead(directory, revision, inputs, gitTool);
  return inputs;
}

function runRead(command, args, env, timeout = 30_000) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', shell: false,
    windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 });
  requireEvidence(!result.error && result.status === 0, `runtime probe ${path.basename(command)} failed`);
  return result.stdout.trim();
}

const pythonProbe = String.raw`
import json, sys
from pathlib import Path
if sys.version_info[:2] != (3, 12):
    raise ValueError('Python 3.12 required')
root = Path(sys.argv[1])
sys.path.insert(0, str(root / 'exchange_executor'))
import ccxt
from ccxt_certification_evidence import expected_profile_hash, python_tree_hash
from ccxt_profiles import PROFILES
if ccxt.__version__ != '4.5.75' or 'hyperliquid' not in PROFILES:
    raise ValueError('Pinned CCXT and Hyperliquid profile required')
print(json.dumps({'python': sys.version.split()[0], 'pythonExecutable': str(Path(sys.executable).resolve()),
    'ccxt': ccxt.__version__, 'executorTreeHash': python_tree_hash(root / 'exchange_executor'),
    'sdkTreeHash': python_tree_hash(Path(ccxt.__file__).resolve().parent, sdk=True),
    'profileHash': expected_profile_hash(PROFILES['hyperliquid'])}))
`;

function runtimeSnapshot(python, npmCli, env) {
  const value = JSON.parse(runRead(python, ['-I', '-B', '-c', pythonProbe, root], env));
  requireEvidence(value.python.startsWith('3.12.') && value.ccxt === '4.5.75', 'unpinned Python or CCXT runtime');
  const npmVersion = runRead(process.execPath, [npmCli, '--version'], env);
  requireEvidence(/^10\.9\./.test(npmVersion) && /^v22\./.test(process.version), 'unpinned Node or npm runtime');
  return Object.freeze({ ...value, node: process.version, nodeExecutable: process.execPath, npm: npmVersion,
    npmCliSha256: sha256(readFileSync(npmCli)) });
}

export function npmCliPath() {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [path.join(nodeDir, 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(nodeDir, '../lib/node_modules/npm/bin/npm-cli.js')];
  const found = candidates.find(candidate => candidate && path.isAbsolute(candidate) && existsSync(candidate));
  requireEvidence(Boolean(found), 'npm CLI adjacent to Node was not found');
  return realpathSync.native(found);
}

export function jobsFor(python, npmCli) {
  const npm = (name, args = []) => ({ name, command: process.execPath, args: [npmCli, ...args] });
  const task = name => npm(name.replaceAll(':', '-'), ['run', name]);
  const pythonTask = (name, args) => ({ name, command: python, args });
  return {
    foundation: ['lint', 'lint:frontend', 'lint:python', 'typecheck', 'quality:architecture',
      'quality:complexity', 'quality:frontend', 'quality:release', 'quality:risk-acceptances',
      'quality:monitoring', 'quality:build-context', 'quality:licenses', 'quality:dependencies',
      'quality:duplicates'].map(task).concat([pythonTask('ruff-extra-preflights', ['-m', 'ruff', 'check',
      'scripts/check_internal_tls.py', 'scripts/hyperliquid_bound_preflight.py',
      'scripts/hyperliquid_testnet_preflight.py', 'tests/test_internal_tls_preflight.py',
      'tests/test_hyperliquid_bound_preflight.py', 'tests/fixtures/internal_tls_fixture.py'])]),
    backend: [task('test:coverage'), npm('b2-gateway-test', ['test', '--prefix', 'services/b2-backup-gateway']),
      task('test:coverage:b2-gateway'), npm('b2-audit-test', ['test', '--prefix', 'services/b2-audit-receiver']),
      task('test:coverage:b2-audit'), task('test:coverage:incident-receiver'), task('test:coverage:modules')],
    python: [pythonTask('python-coverage', ['-B', '-m', 'coverage', 'run', '--branch', '--source=exchange_executor',
      '-m', 'unittest', 'discover', '-s', 'exchange_executor/tests', '-v']),
    pythonTask('internal-tls-preflight', ['-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_internal_tls_preflight.py', '-v']),
    pythonTask('hyperliquid-bound-preflight', ['-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_hyperliquid_bound_preflight.py', '-v']),
    pythonTask('python-coverage-report', ['-m', 'coverage', 'report', '--fail-under=60']),
    pythonTask('python-coverage-xml', ['-m', 'coverage', 'xml', '-o', 'exchange_executor/coverage.xml'])],
    frontend: [npm('frontend-coverage', ['--prefix', 'frontend', 'run', 'test:coverage'])],
    build: [task('build')],
    browser: [npm('browser', ['--prefix', 'frontend', 'run', 'test:e2e', '--', '--workers=2'])],
    mutations: ['schema', 'queue', 'retry', 'trading-risk'].map(shard => ({
      ...npm(`mutation-${shard}`, ['run', 'test:mutation', '--', shard, '--force']),
      timeoutMs: (shard === 'schema' ? 50 : 30) * 60_000,
    })),
    dependencies: [npm('npm-audit-backend', ['audit', '--audit-level=moderate']),
      npm('npm-audit-frontend', ['audit', '--prefix', 'frontend', '--audit-level=moderate']),
      npm('npm-audit-b2-gateway', ['audit', '--prefix', 'services/b2-backup-gateway', '--audit-level=moderate']),
      npm('npm-audit-b2-audit', ['audit', '--prefix', 'services/b2-audit-receiver', '--audit-level=moderate']),
      task('quality:sbom')],
  };
}

async function execute(command, args, logPath, env, directory, timeoutMs = 60 * 60 * 1000) {
  const stream = createWriteStream(logPath, { flags: 'wx' });
  const child = spawn(command, args, { cwd: directory, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(stream, { end: false });
  child.stderr.pipe(stream, { end: false });
  let failureReason = null;
  let logBytes = 0;
  const observeBytes = bytes => {
    logBytes += bytes.length;
    if (logBytes > 128 * 1024 * 1024 && !failureReason) {
      failureReason = 'log byte limit exceeded';
      child.kill();
    }
  };
  child.stdout.on('data', observeBytes);
  child.stderr.on('data', observeBytes);
  const timeout = setTimeout(() => {
    failureReason = 'command exceeded its bounded time limit';
    child.kill();
  }, timeoutMs);
  const outcome = await new Promise(resolve => {
    child.once('error', error => { failureReason = error.message; });
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  clearTimeout(timeout);
  await new Promise(resolve => stream.end(resolve));
  return { ...outcome, failureReason, logBytes };
}

function saveReport(filename, value) {
  writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, { flag: existsSync(filename) ? 'w' : 'wx' });
}

function evidenceDirectory(parent, name) {
  const target = path.join(parent, name);
  if (!existsSync(target)) mkdirSync(target);
  const meta = lstatSync(target);
  requireEvidence(meta.isDirectory() && !meta.isSymbolicLink()
    && realpathSync.native(target) === target, 'evidence directory is not canonical');
  return target;
}

async function performEvidenceGroup({ directory, options, commands, env, snapshot, runtime, gitTool, kind }) {
  const before = snapshot();
  const sourceCommitments = Object.fromEntries(['sourceTreeHash', 'nodeSourcesHash', 'testSourcesHash', 'fixturesHash']
    .map(key => [key, before[key]]));
  const runtimeBefore = runtime();
  const out = evidenceDirectory(evidenceDirectory(evidenceDirectory(directory, 'reports'),
    'receipt-verification'), options.tag);
  const reportPath = path.join(out, `${options.group}.json`);
  requireEvidence(!existsSync(reportPath), 'evidence report already exists');
  const report = { schemaVersion: 1, kind, revision: options.revision,
    group: options.group, tag: options.tag, startedAt: stamp(), runnerSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
    gitExecutable: gitTool, dependencyInstallProvenance: 'external-unverified', receiptSufficiency: false,
    inputsBefore: before, runtimeBefore, commands: [], providerAcceptanceVerified: false,
    implementationReceiptApproved: false, containerAcceptanceVerified: false };
  saveReport(reportPath, report);
  for (const item of commands) {
    const logPath = path.join(out, `${options.group}-${item.name}.log`);
    requireEvidence(!existsSync(logPath), `evidence log already exists: ${item.name}`);
    const startedAt = stamp();
    console.log(JSON.stringify({ group: options.group, command: item.name, state: 'started', revision: options.revision }));
    const outcome = await execute(item.command, item.args, logPath, env, directory, item.timeoutMs);
    const result = { ...item, revision: options.revision, sourceCommitments,
      startedAt, completedAt: stamp(), ...outcome,
      log: path.relative(directory, logPath).replaceAll('\\', '/'), logSha256: sha256(readFileSync(logPath)) };
    report.commands.push(result);
    saveReport(reportPath, report);
    console.log(JSON.stringify({ group: options.group, command: item.name, state: 'completed', exitCode: outcome.exitCode,
      failureReason: outcome.failureReason, logSha256: result.logSha256 }));
    if (outcome.exitCode !== 0 || outcome.signal || outcome.failureReason) break;
    const afterCommand = snapshot();
    requireEvidence(JSON.stringify(afterCommand) === JSON.stringify(before), 'source inventory changed during group');
    result.sourceVerifiedAfter = true;
    saveReport(reportPath, report);
  }
  report.completedAt = stamp();
  report.inputsAfter = snapshot();
  report.runtimeAfter = runtime();
  report.observedInputsUnchanged = JSON.stringify(report.inputsBefore) === JSON.stringify(report.inputsAfter);
  report.observedRuntimeUnchanged = JSON.stringify(report.runtimeBefore) === JSON.stringify(report.runtimeAfter);
  report.allCommandsPassed = report.commands.length === commands.length
    && report.commands.every(item => item.exitCode === 0 && !item.signal && !item.failureReason);
  report.supplementalChecksPassed = report.allCommandsPassed && report.observedInputsUnchanged && report.observedRuntimeUnchanged;
  report.performedGateExecution = false;
  saveReport(reportPath, report);
  requireEvidence(report.supplementalChecksPassed, 'group failed, source drifted or runtime drifted');
  return { report: path.relative(directory, reportPath).replaceAll('\\', '/'), reportSha256: sha256(readFileSync(reportPath)),
    group: options.group, sourceTreeHash: before.sourceTreeHash, commands: report.commands.length };
}

export async function runReceiptVerification(rawOptions) {
  const options = validateOptions(rawOptions);
  const python = realpathSync.native(options.python);
  requireEvidence(lstatSync(python).isFile(), 'Python runtime is not a regular file');
  const gitTool = Object.freeze({ path: realpathSync.native(options.git), sha256: options.gitSha256 });
  trustedGit(gitTool);
  const npmCli = npmCliPath();
  const env = childEnvironment(process.env, python, process.execPath, options.group === 'browser', gitTool.path);
  const result = await performEvidenceGroup({ directory: root, options, commands: jobsFor(python, npmCli)[options.group], env,
    snapshot: () => sourceSnapshot(root, options.revision, gitTool), runtime: () => runtimeSnapshot(python, npmCli, env),
    gitTool, kind: 'exact-head-supplemental-verification' });
  return result;
}

/** Test-only execution harness. Its distinct report kind cannot be accepted as
 * production evidence, even when synthetic commands happen to pass.
 */
export async function runFixtureEvidence({ directory, tag, commands, env, snapshot, runtime }) {
  const canonical = realpathSync.native(directory);
  requireEvidence(path.dirname(canonical) === realpathSync.native(tmpdir())
    && /^tsx-receipt-runner-[a-zA-Z0-9]+$/.test(path.basename(canonical)), 'fixture directory is invalid');
  requireEvidence(tagPattern.test(tag) && Array.isArray(commands) && commands.length > 0
    && commands.every(item => item && typeof item.name === 'string' && typeof item.command === 'string'
      && Array.isArray(item.args)), 'fixture plan is invalid');
  const result = await performEvidenceGroup({ directory: canonical,
    options: { revision: '0'.repeat(40), group: 'fixture', tag }, commands, env, snapshot, runtime,
    gitTool: { path: 'TEST-ONLY', sha256: '0'.repeat(64) }, kind: 'receipt-runner-self-test' });
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runReceiptVerification(parseOptions(process.argv.slice(2)));
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Receipt verification failed.');
    process.exitCode = 1;
  }
}
