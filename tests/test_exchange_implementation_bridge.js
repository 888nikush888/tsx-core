import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD_INPUT_POLICY, collectBuildInputs, compareBuildReceipt } from '../scripts/verify_exchange_implementation.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let revision;
const root = mkdtempSync(path.join(os.tmpdir(), 'tsx-implementation-build-'));
const script = fileURLToPath(new URL('../scripts/verify_exchange_implementation.js', import.meta.url));

function put(relative, contents = '// independently selected synthetic input\n') {
  const destination = path.join(root, relative);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
}

function git(args) {
  // Every Git write is confined to this disposable tree. No inherited GIT_DIR,
  // hooks, user/system configuration, signing or remote setup can redirect it.
  const result = spawnSync('git', ['-C', root, '-c', 'user.name=Bridge Fixture',
    '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', `core.hooksPath=${path.join(root, '.no-hooks')}`, ...args], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true, shell: false,
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, '.no-git-config') },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture() {
  for (const directory of BUILD_INPUT_POLICY.recursiveRoots) mkdirSync(path.join(root, directory), { recursive: true });
  for (const file of BUILD_INPUT_POLICY.requiredFiles) put(file);
  for (const file of ['src/trading_engine.ts', 'scripts/test_registry.js', 'tests/test_engine.js',
    'tests/fixtures/order.json', 'exchange_executor/ccxt_profiles.py', 'exchange_executor/ccxt_adapter.py',
    'exchange_executor/tests/test_contract.py', 'exchange_executor/tests/fixtures/original.json',
    'frontend/src/App.tsx', 'frontend/src/Order.test.tsx', 'frontend/tests/view.test.ts',
    'frontend/e2e/mobile.spec.ts', 'frontend/public/icon.svg']) put(file);
  put('tests/test_engine.js', 'throw new Error("MUST NOT EXECUTE");\n');
  git(['init', '--quiet', '--template=']);
  git(['add', '--', '.']);
  git(['commit', '--quiet', '-m', 'Independent original input fixture']);
  revision = git(['rev-parse', 'HEAD']);
  const actual = collectBuildInputs(root);
  const receipt = {
    schemaVersion: 2, kind: 'reviewed_implementation_receipt', exchange: 'bybit', ccxtVersion: '4.5.75',
    profileVersion: 1, profileHash: 'b'.repeat(64), sourceRevision: revision,
    sourceTreeHash: actual.sourceTreeHash, nodeSourcesHash: actual.nodeSourcesHash,
    testSourcesHash: actual.testSourcesHash, fixturesHash: actual.fixturesHash,
    executorTreeHash: 'c'.repeat(64), sdkTreeHash: 'd'.repeat(64), parityEvidenceHash: 'e'.repeat(64),
    executionReportHash: 'f'.repeat(64), reviewedAt: '2026-01-01T00:00:00Z', providerAcceptanceVerified: false,
    scope: { product: 'linear_perpetual', positionMode: 'oneway', marginMode: 'cross',
      settlementAssets: ['USDT'], modes: ['testnet'], contractSizeRule: 'positive_native_base_multiplier' },
  };
  const bytes = Buffer.from(JSON.stringify(receipt));
  return { receipt, bytes, expected: { root, exchange: 'bybit', profileVersion: 1,
    approvedReceiptHashes: [hash(bytes)] } };
}

function verify(context, bytes = context.bytes, expected = context.expected) {
  return compareBuildReceipt(bytes, expected);
}

function testBoundPositiveIsComparisonOnly(context) {
  const actual = collectBuildInputs(root);
  assert.equal(actual.sourceTreeHash, hash(JSON.stringify(actual.files.map(({ path: name, sha256 }) => [name, sha256]))));
  const result = verify(context);
  assert.equal(result.buildInputsMatch, true);
  assert.equal(result.implementationVerified, false);
  assert.equal(result.providerAcceptanceVerified, false);
  assert.equal(result.runtimeReceiptVerified, false);
  assert.equal(result.performedGateExecution, false);
  assert.equal(result.receiptSha256, hash(context.bytes));
  assert.ok(actual.files.some(file => file.path === 'scripts/verify_exchange_implementation.js'));
  assert.ok(actual.files.some(file => file.path === 'tests/test_exchange_implementation_bridge.js'));
  assert.ok(actual.files.some(file => file.path === 'exchange_executor/ccxt_certification_evidence.py'));
  assert.ok(actual.files.some(file => file.path === 'frontend/src/Order.test.tsx' && file.category === 'test'));
  assert.ok(actual.files.some(file => file.path === 'exchange_executor/tests/fixtures/original.json' && file.category === 'fixture'));
}

function testAllInputClassesDrift(context) {
  for (const file of ['src/trading_engine.ts', 'frontend/src/App.tsx', 'tests/test_engine.js',
    'frontend/tests/view.test.ts', 'frontend/e2e/mobile.spec.ts', 'frontend/src/Order.test.tsx',
    'exchange_executor/tests/test_contract.py', 'tests/fixtures/order.json',
    'exchange_executor/tests/fixtures/original.json', 'package-lock.json', 'frontend/package-lock.json',
    'exchange_executor/requirements.lock', 'scripts/test_registry.js', '.github/workflows/quality.yml',
    'exchange_executor/ccxt_adapter.py', 'exchange_executor/ccxt_profiles.py']) {
    const original = readFileSync(path.join(root, file));
    put(file, Buffer.concat([original, Buffer.from('changed bytes')]));
    assert.throws(() => verify(context), /drift|commitment/i, file);
    put(file, original);
  }
  assert.equal(verify(context).buildInputsMatch, true);
}

function testAddedRemovedAndUntrackedFiles(context) {
  for (const file of ['src/untracked_helper.ts', 'tests/new_test.js', 'frontend/src/New.test.tsx',
    'exchange_executor/tests/new_case.py', 'tests/fixtures/new_original.json',
    'scripts/new_gate.js', 'additional.config.json', 'exchange_executor/new_shared.py']) {
    put(file);
    assert.throws(() => verify(context), /drift|commitment/i, file);
    rmSync(path.join(root, file));
  }
  const selected = path.join(root, 'tests/test_engine.js');
  const original = readFileSync(selected);
  rmSync(selected);
  assert.throws(() => verify(context), /drift|commitment/i);
  put('tests/test_engine.js', original);
  const required = path.join(root, 'package-lock.json');
  const lock = readFileSync(required);
  rmSync(required);
  assert.throws(() => verify(context), /missing|required/i);
  put('package-lock.json', lock);
}

function testSelfUpdatedArtifactCannotBecomeApproval(context) {
  const original = readFileSync(path.join(root, 'src/trading_engine.ts'));
  put('src/trading_engine.ts', '// hostile source plus freshly matching artifact\n');
  const current = collectBuildInputs(root);
  const updated = { ...context.receipt, ...Object.fromEntries(
    ['sourceTreeHash', 'nodeSourcesHash', 'testSourcesHash', 'fixturesHash'].map(key => [key, current[key]])) };
  assert.throws(() => verify(context, Buffer.from(JSON.stringify(updated))), /independent|pin/i);
  put('src/trading_engine.ts', original);
  for (const update of [{ implementationVerified: true }, { providerAcceptanceVerified: true },
    { status: 'PASS' }, { commands: ['touch MUST_NOT_EXIST'] }, { approvedReceiptHashes: [hash(context.bytes)] }]) {
    const bytes = Buffer.from(JSON.stringify({ ...context.receipt, ...update }));
    assert.throws(() => verify(context, bytes), /independent|pin/i);
    assert.throws(() => verify(context, bytes, { ...context.expected, approvedReceiptHashes: [hash(bytes)] }), /schema|provider/i);
  }
  assert.equal(existsSync(path.join(root, 'MUST_NOT_EXIST')), false);
  assert.throws(() => verify(context, context.bytes, { ...context.expected, approvedReceiptHashes: [] }), /pin/i);
  assert.throws(() => verify(context, context.bytes, { ...context.expected, exchange: 'okx' }), /binding/i);
}

function testHistoricalOriginAllowsProofOnlyCommitButNotDrift(context) {
  git(['add', '--', 'exchange_executor/ccxt_implementation_reviews.py', 'exchange_executor/certifications/bybit.json']);
  git(['commit', '--quiet', '-m', 'Independent proof-only fixture commit']);
  const checkout = git(['rev-parse', 'HEAD']);
  assert.notEqual(checkout, revision);
  const result = verify(context);
  assert.equal(result.reviewedSourceRevision, revision, 'Historical origin must not be relabeled as current HEAD.');
  assert.equal(result.checkoutRevision, checkout);
  assert.equal(result.sourceTreeHash, context.receipt.sourceTreeHash);
  const unrelated = git(['commit-tree', git(['rev-parse', 'HEAD^{tree}']), '-m', 'Unrelated fixture origin']);
  for (const origin of ['0'.repeat(40), unrelated]) {
    const bytes = Buffer.from(JSON.stringify({ ...context.receipt, sourceRevision: origin }));
    assert.throws(() => verify(context, bytes, { ...context.expected, approvedReceiptHashes: [hash(bytes)] }), /origin/i);
  }
  const original = readFileSync(path.join(root, 'src/trading_engine.ts'));
  put('src/trading_engine.ts', '// changed economic source\n');
  git(['add', '--', 'src/trading_engine.ts']);
  git(['commit', '--quiet', '-m', 'Changed source cannot inherit old approval']);
  assert.throws(() => verify(context), /drift|commitment/i);
  put('src/trading_engine.ts', original);
}

function testAmbientGitCannotRedirectTrustedCheckout(context) {
  const keys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_COUNT'];
  const prior = keys.map(key => process.env[key]);
  try {
    process.env.GIT_DIR = path.join(root, 'not-the-checked-repository');
    process.env.GIT_WORK_TREE = path.dirname(root);
    process.env.GIT_CONFIG_COUNT = '999';
    assert.equal(verify(context).buildInputsMatch, true, 'Ambient Git overrides cannot change the fixed source/provenance root.');
  } finally {
    keys.forEach((key, index) => {
      if (prior[index] === undefined) delete process.env[key];
      else process.env[key] = prior[index];
    });
  }
}

function testExcludedArtifactsAndAuthorityAreNotCircular(context) {
  for (const file of ['reports/fake-pass.json', 'coverage/lcov.info', 'frontend/playwright-report/index.html',
    'exchange_executor/certifications/bybit.json', 'exchange_executor/ccxt_implementation_reviews.py',
    'exchange_executor/tests/__pycache__/ignored.pyc']) put(file, '{"status":"PASS"}');
  const actual = collectBuildInputs(root);
  assert.equal(actual.sourceTreeHash, context.receipt.sourceTreeHash);
  assert.equal(verify(context).buildInputsMatch, true);
  assert.ok(!actual.files.some(file => file.path.endsWith('ccxt_implementation_reviews.py')));
  put('exchange_executor/ccxt_certification_evidence.py', '# changed validator\n');
  assert.throws(() => verify(context), /drift|commitment/i);
  put('exchange_executor/ccxt_certification_evidence.py');
}

function testUnsafeFilesystemCannotEnterInventory(context) {
  const external = mkdtempSync(path.join(os.tmpdir(), 'tsx-bridge-outside-'));
  const target = path.join(root, 'tests/fixtures/linked');
  try {
    writeFileSync(path.join(external, 'original.json'), 'do not read outside');
    symlinkSync(external, target, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => verify(context), /canonical|symlink|ordinary/i);
    rmSync(target);
    linkSync(path.join(root, 'src/trading_engine.ts'), path.join(root, 'src/hardlink.ts'));
    assert.throws(() => verify(context), /ordinary|link/i);
    rmSync(path.join(root, 'src/hardlink.ts'));
    put('tests/fixtures/too-large.bin', Buffer.alloc(BUILD_INPUT_POLICY.maxFileBytes + 1));
    assert.throws(() => verify(context), /budget/i);
    rmSync(path.join(root, 'tests/fixtures/too-large.bin'));
  } finally {
    if (existsSync(target)) rmSync(target);
    rmSync(external, { recursive: true, force: true });
  }
  assert.equal(verify(context).buildInputsMatch, true);
}

function testProductionCliHasNoApprovalOrRootBypass() {
  for (const argument of ['--root', '--receipt', '--approval', '--allow-unreviewed', '--generate', '--run-gates']) {
    const processResult = spawnSync(process.execPath, [script, argument, root], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true, shell: false,
    });
    assert.notEqual(processResult.status, 0);
    assert.match(processResult.stderr, /arguments|python/i);
  }
  const noRuntime = spawnSync(process.execPath, [script], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true, shell: false,
  });
  assert.notEqual(noRuntime.status, 0);
  assert.match(noRuntime.stderr, /python/i);
  const source = readFileSync(script, 'utf8');
  assert.match(source, /APPROVED_IMPLEMENTATION_RECEIPTS/);
  assert.match(source, /certification_result/);
  assert.match(source, /file_bytes/);
  assert.doesNotMatch(source, /writeFile|appendFile|execSync|shell:\s*true/);
}

function testActualPythonCliWithFixedEmptyFixtureRegistry() {
  const python = process.env.TSX_TEST_PYTHON || (process.env.pythonLocation
    ? path.join(process.env.pythonLocation, process.platform === 'win32' ? 'python.exe' : 'bin/python') : null);
  assert.ok(python && path.isAbsolute(python), 'This interop test requires an explicit TSX_TEST_PYTHON or setup-python pythonLocation.');
  const runtime = spawnSync(python, ['-I', '-B', '-c',
    'import sys,ccxt; assert sys.version_info[:2] == (3,12); assert ccxt.__version__ == "4.5.75"'], {
    encoding: 'utf8', shell: false, windowsHide: true, timeout: 10_000,
  });
  assert.ifError(runtime.error);
  assert.equal(runtime.status, 0, runtime.stderr);
  put('scripts/verify_exchange_implementation.js', readFileSync(script));
  put('package.json', '{"type":"module"}');
  for (const file of ['ccxt_profiles.py', 'ccxt_certification_evidence.py']) {
    put(`exchange_executor/${file}`, readFileSync(new URL(`../exchange_executor/${file}`, import.meta.url)));
  }
  // This is a fixed trusted TEST policy, not an artifact-supplied approval path.
  put('exchange_executor/ccxt_implementation_reviews.py',
    'from types import MappingProxyType\nAPPROVED_IMPLEMENTATION_RECEIPTS = MappingProxyType({})\n');
  const receiptBefore = readFileSync(path.join(root, 'exchange_executor/certifications/bybit.json'));
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/verify_exchange_implementation.js'), '--python', python], {
    encoding: 'utf8', shell: false, windowsHide: true, timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, 'Fake PASS receipt plus an empty independent registry must remain No-Go.');
  assert.match(result.stderr, /No-Go/);
  assert.equal(result.stdout, '');
  assert.deepEqual(readFileSync(path.join(root, 'exchange_executor/certifications/bybit.json')), receiptBefore);
  assert.equal(existsSync(path.join(root, 'exchange_executor/__pycache__')), false, 'The read-only bridge must not generate bytecode.');
  return python;
}

function pythonFixtureRead(python, code) {
  const result = spawnSync(python, ['-I', '-B', '-c', code, root], {
    encoding: 'utf8', shell: false, windowsHide: true, timeout: 30_000, maxBuffer: 256 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function actualFixtureRuntimeContext(python) {
  return pythonFixtureRead(python, String.raw`
import json, sys
from pathlib import Path
assert sys.version_info[:2] == (3, 12)
executor = Path(sys.argv[1]) / 'exchange_executor'
sys.path.insert(0, str(executor))
import ccxt
from ccxt_profiles import PROFILES
from ccxt_certification_evidence import expected_profile_hash, python_tree_hash
assert ccxt.__version__ == '4.5.75'
profiles = [{'exchange': key, 'profileVersion': value.profile_version, 'profileHash': expected_profile_hash(value),
             'scope': {'product': 'linear_perpetual', 'positionMode': value.position_mode, 'marginMode': value.margin_mode,
                       'settlementAssets': list(value.settlement_preference), 'modes': list(value.modes),
                       'contractSizeRule': 'positive_native_base_multiplier'}} for key, value in sorted(PROFILES.items())]
print(json.dumps({'profiles': profiles, 'loadedSdkRoot': str(Path(ccxt.__file__).resolve().parent),
                  'executorTreeHash': python_tree_hash(executor),
                  'sdkTreeHash': python_tree_hash(Path(ccxt.__file__).resolve().parent, sdk=True)}))
`);
}

function copyExactInstalledSdkIntoFixture(python) {
  // Development package managers can hardlink SDK installations. The production
  // validator correctly rejects those files. Only this TEST makes an independent
  // byte-identical regular-file copy; no validator rule or installation changes.
  const inventory = pythonFixtureRead(python, String.raw`
import hashlib, json, stat, sys
from pathlib import Path
import ccxt
assert sys.version_info[:2] == (3, 12) and ccxt.__version__ == '4.5.75'
sdk = Path(ccxt.__file__).resolve().parent
files = []
for file in sorted(sdk.rglob('*')):
    relative = file.relative_to(sdk)
    if '__pycache__' in relative.parts or file.suffix in ('.pyc', '.pyo'):
        continue
    assert not file.is_symlink()
    if file.is_dir():
        continue
    assert stat.S_ISREG(file.stat().st_mode)
    files.append([relative.as_posix(), hashlib.sha256(file.read_bytes()).hexdigest()])
rows = sorted([row for row in files if row[0].endswith('.py')])
tree_hash = hashlib.sha256(json.dumps(rows, ensure_ascii=True, separators=(',', ':')).encode()).hexdigest()
print(json.dumps({'root': str(sdk), 'files': files, 'pythonTreeHash': tree_hash}))
`);
  assert.ok(inventory.files.length > 0 && inventory.files.length <= 2000);
  let total = 0;
  for (const [relative, digest] of inventory.files) {
    assert.ok(!path.posix.isAbsolute(relative) && !relative.split('/').includes('..') && !/[\\:]/.test(relative));
    const bytes = readFileSync(path.join(inventory.root, relative));
    total += bytes.length;
    assert.ok(bytes.length <= 2 * 1024 * 1024 && total <= 64 * 1024 * 1024);
    assert.equal(hash(bytes), digest, 'Installed original must not drift between inventory and copy.');
    const copied = `exchange_executor/ccxt/${relative}`;
    put(copied, bytes);
    const target = path.join(root, copied);
    const meta = lstatSync(target);
    assert.ok(meta.isFile() && !meta.isSymbolicLink());
    assert.equal(meta.nlink, 1, 'SDK test files must be independent copies, never hardlinks.');
    assert.equal(hash(readFileSync(target)), digest, 'Every copied SDK source/asset byte matches its installed original.');
  }
  return inventory.pythonTreeHash;
}

function fixtureRuntimeResults(python) {
  return pythonFixtureRead(python, String.raw`
import json, sys
from pathlib import Path
executor = Path(sys.argv[1]) / 'exchange_executor'
sys.path.insert(0, str(executor))
from ccxt_profiles import PROFILES
from ccxt_certification import certification_result
rows = []
for exchange, profile in sorted(PROFILES.items()):
    result = certification_result(executor / 'certifications', exchange, '4.5.75', profile)
    rows.append({'exchange': exchange, 'valid': result.valid, 'reason': result.reason})
print(json.dumps(rows))
`);
}

function pinTestReceipts(receipts) {
  // TEST-ONLY authority: these synthetic receipts are explicitly trusted only
  // inside this disposable Git tree. This function never touches production pins.
  const pins = receipts.map(receipt => {
    const bytes = Buffer.from(JSON.stringify(receipt));
    put(`exchange_executor/certifications/${receipt.exchange}.json`, bytes);
    return { exchange: receipt.exchange, version: receipt.profileVersion, digest: hash(bytes) };
  });
  put('exchange_executor/ccxt_implementation_reviews.py',
    '# TRUSTED SYNTHETIC TEST CONTEXT ONLY; no gate or provider acceptance.\nfrom types import MappingProxyType\n'
    + 'APPROVED_IMPLEMENTATION_RECEIPTS = MappingProxyType({\n'
    + pins.map(pin => `    (${JSON.stringify(pin.exchange)}, ${pin.version}): (${JSON.stringify(pin.digest)},),\n`).join('') + '})\n');
  return pins;
}

function prepareBoundCliReceipts(python) {
  const executor = new URL('../exchange_executor/', import.meta.url);
  for (const file of readdirSync(executor).filter(file => file.endsWith('.py') && file !== 'ccxt_implementation_reviews.py')) {
    put(`exchange_executor/${file}`, readFileSync(new URL(file, executor)));
  }
  const installedSdkHash = copyExactInstalledSdkIntoFixture(python);
  put('tests/test_exchange_implementation_bridge.js', readFileSync(fileURLToPath(import.meta.url)));
  // These are honest synthetic references, not invented execution/PASS records.
  put('reports/fixture-parity.json', JSON.stringify({ kind: 'synthetic-comparison-reference', providerAcceptanceVerified: false }));
  put('reports/fixture-execution.json', JSON.stringify({ kind: 'synthetic-comparison-reference', performedGateExecution: false }));
  git(['add', '--', '.']);
  git(['commit', '--quiet', '-m', 'Complete synthetic comparison inputs']);
  const origin = git(['rev-parse', 'HEAD']);
  const actual = collectBuildInputs(root);
  const runtime = actualFixtureRuntimeContext(python);
  assert.deepEqual(runtime.profiles.map(profile => profile.exchange), ['bybit', 'hyperliquid', 'krakenfutures']);
  assert.match(runtime.executorTreeHash, /^[a-f0-9]{64}$/);
  assert.equal(runtime.sdkTreeHash, installedSdkHash, 'Real validator must hash the complete byte-identical SDK copy.');
  assert.equal(path.resolve(runtime.loadedSdkRoot), path.join(root, 'exchange_executor', 'ccxt'));
  const receipts = runtime.profiles.map(profile => ({
    schemaVersion: 2, kind: 'reviewed_implementation_receipt', ...profile, ccxtVersion: '4.5.75', sourceRevision: origin,
    sourceTreeHash: actual.sourceTreeHash, nodeSourcesHash: actual.nodeSourcesHash,
    testSourcesHash: actual.testSourcesHash, fixturesHash: actual.fixturesHash,
    executorTreeHash: runtime.executorTreeHash, sdkTreeHash: runtime.sdkTreeHash,
    parityEvidenceHash: hash(readFileSync(path.join(root, 'reports/fixture-parity.json'))),
    executionReportHash: hash(readFileSync(path.join(root, 'reports/fixture-execution.json'))),
    reviewedAt: '2026-01-01T00:00:00Z', providerAcceptanceVerified: false,
  }));
  const pins = pinTestReceipts(receipts);
  git(['add', '--', 'exchange_executor/certifications', 'exchange_executor/ccxt_implementation_reviews.py']);
  git(['commit', '--quiet', '-m', 'Explicit trusted fixture receipt pins only']);
  assert.notEqual(git(['rev-parse', 'HEAD']), origin);
  assert.equal(collectBuildInputs(root).sourceTreeHash, actual.sourceTreeHash);
  return { actual, origin, receipts, pins };
}

function actualFixtureCli(python) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/verify_exchange_implementation.js'), '--python', python], {
    encoding: 'utf8', shell: false, windowsHide: true, timeout: 30_000,
  });
  assert.ifError(result.error);
  return result;
}

function assertPositiveCliComparison(python, context) {
  const result = actualFixtureCli(python);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const value = JSON.parse(result.stdout);
  assert.equal(value.buildInputsMatch, true);
  assert.equal(value.runtimeReceiptsVerified, true);
  assert.equal(value.performedGateExecution, false);
  assert.equal(value.providerAcceptanceVerified, false);
  assert.equal(value.sourceTreeHash, context.actual.sourceTreeHash);
  assert.equal(value.checkoutRevision, git(['rev-parse', 'HEAD']));
  assert.deepEqual(value.receipts, context.pins.map(pin => ({
    exchange: pin.exchange, receiptSha256: pin.digest, reviewedSourceRevision: context.origin,
  })));
  assert.equal(collectBuildInputs(root).sourceTreeHash, context.actual.sourceTreeHash);
  return value;
}

function testActualPositiveCliAndIndependentRuntimeNegatives(python) {
  const context = prepareBoundCliReceipts(python);
  const expectedPins = readFileSync(path.join(root, 'exchange_executor/ccxt_implementation_reviews.py'));
  const first = assertPositiveCliComparison(python, context);
  const original = readFileSync(path.join(root, 'src/trading_engine.ts'));
  put('src/trading_engine.ts', Buffer.concat([original, Buffer.from('\n// Node-only economic drift\n')]));
  assert.ok(fixtureRuntimeResults(python).every(row => row.valid === true),
    'All three real Python receipt checks must still be valid when only Node changes.');
  const nodeDrift = actualFixtureCli(python);
  assert.equal(nodeDrift.status, 1);
  assert.match(nodeDrift.stderr, /No-Go/);
  assert.equal(nodeDrift.stdout, '');
  put('src/trading_engine.ts', original);
  const wrongSdk = structuredClone(context.receipts);
  wrongSdk[0].sdkTreeHash = '0'.repeat(64);
  pinTestReceipts(wrongSdk);
  const runtime = fixtureRuntimeResults(python);
  assert.deepEqual(runtime.map(row => row.valid), [false, true, true]);
  assert.match(runtime[0].reason, /SDK source drifted/);
  const invalidSdk = actualFixtureCli(python);
  assert.equal(invalidSdk.status, 1);
  assert.match(invalidSdk.stderr, /No-Go/);
  assert.equal(invalidSdk.stdout, '');
  pinTestReceipts(context.receipts);
  assert.deepEqual(assertPositiveCliComparison(python, context), first, 'Fresh CLI restart retains the exact original binding.');
  assert.deepEqual(readFileSync(path.join(root, 'exchange_executor/ccxt_implementation_reviews.py')), expectedPins);
  assert.equal(existsSync(path.join(root, 'exchange_executor/__pycache__')), false);
}

try {
  const context = fixture();
  testBoundPositiveIsComparisonOnly(context);
  testAllInputClassesDrift(context);
  testAddedRemovedAndUntrackedFiles(context);
  testSelfUpdatedArtifactCannotBecomeApproval(context);
  testExcludedArtifactsAndAuthorityAreNotCircular(context);
  testHistoricalOriginAllowsProofOnlyCommitButNotDrift(context);
  testAmbientGitCannotRedirectTrustedCheckout(context);
  testUnsafeFilesystemCannotEnterInventory(context);
  testProductionCliHasNoApprovalOrRootBypass();
  const python = testActualPythonCliWithFixedEmptyFixtureRegistry();
  testActualPositiveCliAndIndependentRuntimeNegatives(python);
  console.log('PASS implementation build bridge: bound inputs, drift, independent pins, safe filesystem and CLI boundaries');
} finally {
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.match(path.basename(root), /^tsx-implementation-build-[a-zA-Z0-9]+$/);
  rmSync(root, { recursive: true, force: true });
}
