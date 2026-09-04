/** Read-only root-build comparison, not a gate runner or approval generator.
 *
 * Hash contract v2: UTF-8 JSON of sorted [repo-relative POSIX path, SHA256(bytes)]
 * rows, ordered by JS code-unit comparison (not locale). sourceTreeHash covers
 * their complete union, including executor root Python and gate/build inputs.
 * nodeSourcesHash covers Node/frontend source plus gate/build configuration;
 * testSourcesHash covers tests; fixturesHash covers fixture/data/snapshot files.
 * No receipt chooses paths. Untracked additions count. Generated reports, caches
 * and certifications are not inputs. Exactly ccxt_implementation_reviews.py is
 * excluded as the separately trusted approval root, avoiding circular hashing.
 * Python profileHash is canonical asdict(profile), NOT the profile file hash:
 * those file bytes are bound by executorTreeHash and this full sourceTreeHash.
 * sourceRevision is the pinned historical origin, not today's HEAD (committing
 * a receipt and its approval necessarily changes HEAD). Ancestry establishes
 * provenance only; every current byte commitment still has to match exactly.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { devNull } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const authorityFile = 'exchange_executor/ccxt_implementation_reviews.py';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;
const revisionPattern = /^[a-f0-9]{40}$/;
const receiptKeys = ['schemaVersion', 'kind', 'exchange', 'ccxtVersion', 'profileVersion', 'profileHash',
  'sourceRevision', 'sourceTreeHash', 'parityEvidenceHash', 'executionReportHash', 'nodeSourcesHash',
  'testSourcesHash', 'fixturesHash', 'executorTreeHash', 'sdkTreeHash', 'reviewedAt', 'scope', 'providerAcceptanceVerified'];
const commitmentKeys = ['sourceTreeHash', 'nodeSourcesHash', 'testSourcesHash', 'fixturesHash'];

export const BUILD_INPUT_POLICY = Object.freeze({
  recursiveRoots: Object.freeze(['src', 'scripts', 'tests', 'exchange_executor/tests', 'exchange_executor/tools',
    'frontend/src', 'frontend/public', 'frontend/tests', 'frontend/e2e', '.github', 'config', 'security', 'monitoring', 'docs']),
  requiredFiles: Object.freeze(['package.json', 'package-lock.json', 'tsconfig.json', 'eslint.config.js',
    'stryker.config.mjs', 'c8.critical.json', 'c8.modules.json', 'coverage-baseline.json', 'quality-baseline.json',
    'ruff.toml', 'sonar-project.properties', '.npmrc', '.nvmrc', '.python-version', '.dockerignore',
    'Dockerfile', 'docker-compose.yml', 'docker-compose.monitoring.yml', '.github/workflows/quality.yml',
    'frontend/package.json', 'frontend/package-lock.json', 'frontend/tsconfig.json', 'frontend/playwright.config.ts',
    'frontend/vite.config.ts', 'exchange_executor/requirements.lock', 'exchange_executor/requirements-dev.lock',
    'exchange_executor/requirements.in', 'exchange_executor/Dockerfile', 'exchange_executor/.dockerignore',
    'exchange_executor/ccxt_certification.py', 'exchange_executor/ccxt_certification_evidence.py',
    'exchange_executor/ccxt_profiles.py', 'scripts/verify_exchange_implementation.js',
    'tests/test_exchange_implementation_bridge.js', 'tests/run_all.js']),
  maxFileBytes: 8 * 1024 * 1024,
  maxTreeBytes: 128 * 1024 * 1024,
  maxEntries: 20_000,
  maxFiles: 10_000,
});

function requireBuild(condition, reason) {
  if (!condition) throw new Error(`Implementation build rejected: ${reason}.`);
}

function canonicalDirectory(directory) {
  const absolute = path.resolve(directory);
  const meta = lstatSync(absolute, { bigint: true });
  requireBuild(meta.isDirectory() && !meta.isSymbolicLink() && realpathSync.native(absolute) === absolute,
    'source directory is not canonical');
  return absolute;
}

function safeRelative(relative) {
  requireBuild(typeof relative === 'string' && relative.length > 0 && relative.length <= 512
    && !/[\\:\x00-\x1f\x7f]/.test(relative) && !path.posix.isAbsolute(relative)
    && relative.split('/').every(part => part && part !== '.' && part !== '..'), 'invalid source path');
}

function ordinaryFile(file) {
  const meta = lstatSync(file, { bigint: true });
  requireBuild(meta.isFile() && !meta.isSymbolicLink() && meta.nlink === 1n, 'source must be an ordinary unlinked file');
  return meta;
}

function sameFile(left, right) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(field => left[field] === right[field]);
}

function stableBytes(file, limit = BUILD_INPUT_POLICY.maxFileBytes) {
  canonicalDirectory(path.dirname(file));
  const before = ordinaryFile(file);
  requireBuild(before.size >= 0n && before.size <= BigInt(limit), 'source file exceeds byte budget');
  const handle = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    const opened = fstatSync(handle, { bigint: true });
    requireBuild(opened.isFile() && opened.nlink === 1n && sameFile(before, opened), 'source changed before opening');
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(handle, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    requireBuild(BigInt(length) === before.size && sameFile(before, fstatSync(handle, { bigint: true })),
      'source changed during verification');
    bytes = buffer.subarray(0, length);
  } finally {
    closeSync(handle);
  }
  requireBuild(sameFile(before, ordinaryFile(file)), 'source changed after reading');
  canonicalDirectory(path.dirname(file));
  return bytes;
}

function fixturePath(relative) {
  return /(?:^|\/)(?:fixtures?|__fixtures__|__snapshots__|data)(?:\/|$)/.test(relative)
    || /(?:^|\/)[^/]*fixtures?\.[^/]+$/.test(relative);
}

function category(relative) {
  if (fixturePath(relative)) return 'fixture';
  if (/^(?:tests|exchange_executor\/tests|frontend\/(?:tests|e2e))\//.test(relative)
    || /^frontend\/src\/.*\.(?:test|spec)\.[^/]+$/.test(relative)) return 'test';
  if (/^exchange_executor\/[^/]+\.py$/.test(relative)) return 'executor';
  return 'node';
}

function ignoredCache(name) {
  return ['__pycache__', '.pytest_cache', '.ruff_cache'].includes(name) || /\.py[co]$/.test(name);
}

function selectedFlatFile(relative) {
  if (relative === authorityFile) return false;
  const name = path.posix.basename(relative);
  return /\.(?:[cm]?js|tsx?|json(?:\.example)?|ya?ml|toml|lock|in|properties|html|py)$/.test(name)
    || /^Dockerfile(?:\.|$)/.test(name) || /^\.(?:dockerignore|npmrc|nvmrc|python-version|gitleaks\.toml|env\.example)$/.test(name);
}

function discoverFiles(root) {
  const selected = new Set();
  let visited = 0;
  function visit(relative, recursive) {
    const directory = path.join(root, relative);
    canonicalDirectory(directory);
    for (const name of readdirSync(directory)) {
      if (ignoredCache(name)) continue;
      requireBuild(++visited <= BUILD_INPUT_POLICY.maxEntries, 'source entry budget exceeded');
      const file = relative ? `${relative}/${name}` : name;
      safeRelative(file);
      const meta = lstatSync(path.join(root, file), { bigint: true });
      if (meta.isDirectory()) {
        if (recursive) visit(file, true);
      } else if (recursive || selectedFlatFile(file)) {
        requireBuild(file !== authorityFile, 'approval code entered recursive input scope');
        selected.add(file);
      }
    }
  }
  for (const directory of BUILD_INPUT_POLICY.recursiveRoots) visit(directory, true);
  for (const directory of ['', 'frontend', 'exchange_executor']) visit(directory, false);
  requireBuild(selected.size > 0 && selected.size <= BUILD_INPUT_POLICY.maxFiles, 'source file budget exceeded');
  for (const required of BUILD_INPUT_POLICY.requiredFiles) requireBuild(selected.has(required), 'required source file is missing');
  return [...selected].sort();
}

function rowsHash(files) {
  return hash(JSON.stringify(files.map(file => [file.path, file.sha256])));
}

export function collectBuildInputs(directory) {
  const root = canonicalDirectory(directory);
  const paths = discoverFiles(root);
  let total = 0;
  const files = paths.map(relative => {
    const bytes = stableBytes(path.join(root, relative));
    total += bytes.length;
    requireBuild(total <= BUILD_INPUT_POLICY.maxTreeBytes, 'source tree exceeds byte budget');
    return { path: relative, sha256: hash(bytes), category: category(relative) };
  });
  requireBuild(JSON.stringify(discoverFiles(root)) === JSON.stringify(paths), 'source inventory drifted during verification');
  return Object.freeze({ sourceTreeHash: rowsHash(files),
    nodeSourcesHash: rowsHash(files.filter(file => file.category === 'node')),
    testSourcesHash: rowsHash(files.filter(file => file.category === 'test')),
    fixturesHash: rowsHash(files.filter(file => file.category === 'fixture')), files, totalBytes: total });
}

function pinnedReceipt(bytes, expected) {
  requireBuild(Buffer.isBuffer(bytes) && bytes.length <= 64 * 1024, 'receipt byte budget or type is invalid');
  const pins = expected.approvedReceiptHashes;
  requireBuild(Array.isArray(pins) && pins.length > 0 && pins.length <= 16
    && pins.every(pin => typeof pin === 'string' && hashPattern.test(pin))
    && new Set(pins).size === pins.length, 'independent pin policy is invalid');
  requireBuild(pins.includes(hash(bytes)), 'receipt has no independent review pin');
  const receipt = JSON.parse(bytes.toString('utf8'));
  requireBuild(receipt && Object.keys(receipt).length === receiptKeys.length
    && receiptKeys.every(key => Object.hasOwn(receipt, key)), 'receipt schema is invalid');
  requireBuild(receipt.providerAcceptanceVerified === false, 'receipt cannot grant provider acceptance');
  requireBuild(receipt.schemaVersion === 2 && receipt.kind === 'reviewed_implementation_receipt'
    && receipt.ccxtVersion === '4.5.75' && Number.isSafeInteger(receipt.profileVersion)
    && receipt.exchange === expected.exchange && receipt.profileVersion === expected.profileVersion, 'receipt binding differs');
  requireBuild(typeof receipt.sourceRevision === 'string' && revisionPattern.test(receipt.sourceRevision), 'source revision is invalid');
  requireBuild(receiptKeys.filter(key => key.endsWith('Hash')).every(key =>
    typeof receipt[key] === 'string' && hashPattern.test(receipt[key])), 'receipt commitment is invalid');
  return receipt;
}

function compareCommitments(bytes, expected, actual, checkoutRevision) {
  const receipt = pinnedReceipt(bytes, expected);
  requireBuild(commitmentKeys.every(key => receipt[key] === actual[key]), 'current source commitment drifted');
  assertOriginAncestor(expected.root, receipt.sourceRevision, checkoutRevision);
  return Object.freeze({ buildInputsMatch: true, receiptSha256: hash(bytes), sourceTreeHash: actual.sourceTreeHash,
    reviewedSourceRevision: receipt.sourceRevision, checkoutRevision,
    runtimeReceiptVerified: false, implementationVerified: false, providerAcceptanceVerified: false, performedGateExecution: false });
}

/** Explicit test/review API: approval context is trusted caller code, never CLI
 * input. This is ONLY a build-byte comparison. Python alone validates profile,
 * complete receipt schema (including duplicate JSON keys), SDK and runtime.
 */
export function compareBuildReceipt(bytes, expected) {
  pinnedReceipt(bytes, expected);
  const revision = currentRevision(expected.root);
  const result = compareCommitments(bytes, expected, collectBuildInputs(expected.root), revision);
  requireBuild(currentRevision(expected.root) === revision, 'checkout revision drifted during comparison');
  return result;
}

// Fixed code, never receipt-selected imports or commands. -I ignores PYTHONPATH
// and user site packages; -B prevents repository bytecode/cache writes.
const pythonBridge = String.raw`
import base64, json, sys
from pathlib import Path
try:
    if sys.version_info[:2] != (3, 12):
        raise ValueError('Pinned Python 3.12 is required.')
    executor = Path(sys.argv[1]) / 'exchange_executor'
    sys.path.insert(0, str(executor))
    import ccxt
    from ccxt_profiles import PROFILES
    from ccxt_certification import certification_result
    from ccxt_implementation_reviews import APPROVED_IMPLEMENTATION_RECEIPTS
    from ccxt_certification_evidence import file_bytes
    if ccxt.__version__ != '4.5.75' or not PROFILES:
        raise ValueError('Pinned CCXT 4.5.75 and known profiles are required.')
    rows, quarantined = [], []
    pending = 'Independent implementation review is pending; legacy certification flags are insufficient.'
    for exchange, profile in sorted(PROFILES.items()):
        result = certification_result(executor / 'certifications', exchange, ccxt.__version__, profile)
        if result.valid is True and result.reason is None:
            pins = APPROVED_IMPLEMENTATION_RECEIPTS[(exchange, profile.profile_version)]
            receipt_path = executor / 'certifications' / (exchange + '.json')
            original = file_bytes(receipt_path, 64 * 1024)
            if original != file_bytes(receipt_path, 64 * 1024):
                raise ValueError('Implementation receipt changed during verification.')
            rows.append({'exchange': exchange, 'profileVersion': profile.profile_version,
                         'approvedReceiptHashes': list(pins), 'receipt': base64.b64encode(original).decode('ascii')})
        elif result.valid is False and result.reason == pending:
            quarantined.append(exchange)
        else:
            raise ValueError('Installed implementation receipt is invalid.')
    if not rows:
        raise ValueError('No implementation receipt is independently approved.')
    print(json.dumps({'schemaVersion': 1, 'pythonVersion': '3.12', 'ccxtVersion': ccxt.__version__,
                      'receipts': rows, 'quarantinedProfiles': quarantined}))
except Exception:
    print(json.dumps({'error': 'Runtime implementation evidence is missing or invalid.'}))
    sys.exit(2)
`;

function gitRead(root, args) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  return spawnSync('git', ['-C', root, '-c', 'core.fsmonitor=false', ...args], {
    encoding: 'utf8', shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024,
    env: { ...environment, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : devNull,
      GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' },
  });
}

function currentRevision(root) {
  const result = gitRead(root, ['rev-parse', '--verify', 'HEAD']);
  requireBuild(!result.error && result.status === 0 && revisionPattern.test(result.stdout.trim()), 'Git source revision is unavailable');
  return result.stdout.trim();
}

function assertOriginAncestor(root, origin, checkoutRevision) {
  requireBuild(revisionPattern.test(origin) && revisionPattern.test(checkoutRevision), 'source origin revision is invalid');
  const result = gitRead(root, ['merge-base', '--is-ancestor', origin, checkoutRevision]);
  requireBuild(!result.error && result.status === 0, 'reviewed source origin is unknown or unrelated to the checkout');
}

function runtimeReceipts(python, root) {
  requireBuild(path.isAbsolute(python), 'explicit absolute Python 3.12 runtime is required');
  // The explicitly selected tool may use the usual bin/python symlink. Resolve
  // its executable first; this never relaxes source/receipt path restrictions.
  const executable = realpathSync.native(python);
  ordinaryFile(executable);
  canonicalDirectory(path.dirname(executable));
  const result = spawnSync(executable, ['-I', '-B', '-c', pythonBridge, root], {
    cwd: root, encoding: 'utf8', shell: false, windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
  });
  requireBuild(!result.error && result.status === 0, 'independent runtime review is pending or invalid');
  const value = JSON.parse(result.stdout);
  requireBuild(value.schemaVersion === 1 && value.pythonVersion === '3.12' && value.ccxtVersion === '4.5.75'
    && Array.isArray(value.receipts) && value.receipts.length > 0 && value.receipts.length <= 128,
  'fixed Python validator returned invalid evidence');
  requireBuild(Array.isArray(value.quarantinedProfiles)
    && value.quarantinedProfiles.every(exchange => typeof exchange === 'string'),
  'fixed Python validator returned invalid quarantine inventory');
  return Object.freeze({ receipts: value.receipts, quarantinedProfiles: value.quarantinedProfiles });
}

/** Production entry has fixed repository, receipt directory and Python policy.
 * It grants no new review and runs no tests. Its success is an instant snapshot,
 * not a guarantee that a later unguarded packaging process uses identical bytes.
 */
export function verifyImplementationBuild(python) {
  const root = canonicalDirectory(repositoryRoot);
  const revision = currentRevision(root);
  const before = collectBuildInputs(root);
  const authority = stableBytes(path.join(root, authorityFile));
  const runtime = runtimeReceipts(python, root);
  const after = collectBuildInputs(root);
  requireBuild(before.sourceTreeHash === after.sourceTreeHash && currentRevision(root) === revision
    && authority.equals(stableBytes(path.join(root, authorityFile))), 'source or independent policy drifted across runtime check');
  const seen = new Set();
  const matched = runtime.receipts.map(row => {
    requireBuild(row && typeof row.exchange === 'string' && !seen.has(row.exchange)
      && typeof row.receipt === 'string', 'fixed Python receipt identities are invalid');
    seen.add(row.exchange);
    const bytes = Buffer.from(row.receipt, 'base64');
    requireBuild(bytes.toString('base64') === row.receipt, 'fixed Python receipt encoding is invalid');
    const result = compareCommitments(bytes, { ...row, root }, after, revision);
    const current = stableBytes(path.join(root, 'exchange_executor/certifications', `${row.exchange}.json`), 64 * 1024);
    requireBuild(current.equals(bytes), 'reviewed receipt drifted after runtime check');
    return { exchange: row.exchange, receiptSha256: result.receiptSha256, reviewedSourceRevision: result.reviewedSourceRevision };
  });
  requireBuild(currentRevision(root) === revision, 'checkout revision drifted after receipt comparison');
  return Object.freeze({ buildInputsMatch: true, runtimeReceiptsVerified: true, checkoutRevision: revision,
    sourceTreeHash: after.sourceTreeHash, receipts: matched, quarantinedProfiles: runtime.quarantinedProfiles,
    providerAcceptanceVerified: false, performedGateExecution: false });
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    requireBuild(args.length === 2 && args[0] === '--python', 'arguments require only --python and an explicit pinned runtime');
    console.log(JSON.stringify(verifyImplementationBuild(args[1])));
  } catch {
    console.error('Implementation build No-Go: pinned Python, independent review and unchanged complete inputs are required; invalid arguments are refused.');
    process.exitCode = 1;
  }
}
