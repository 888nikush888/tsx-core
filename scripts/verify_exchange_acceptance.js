import { createHash } from 'node:crypto';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  exactKeys, isHash, requireAcceptance, TESTNET_ORIGINS, validateCases, validateCleanup, validateLimits,
  copyImplementationData, implementationPath, validateImplementationBinding, validateParityMatrix, validateParityFixture,
  PROFILE_PARITY_CHECKS,
} from './exchange_acceptance_contract.js';
export { REQUIRED_ACCEPTANCE_CASES, TESTNET_ORIGINS } from './exchange_acceptance_contract.js';

function validateBinding(evidence, expected) {
  exactKeys(evidence, ['schemaVersion', 'evidenceKind', 'sourceSha', 'ccxtVersion', 'profileHash', 'exchange',
    'environment', 'host', 'accountReferenceHash', 'accountMode', 'startedAt', 'finishedAt', 'limits', 'observed',
    'ownedOrderIds', 'cases', 'cleanup'], 'invalid root schema (no secrets or raw responses allowed)');
  requireAcceptance(evidence.schemaVersion === 1 && ['synthetic', 'provider'].includes(evidence.evidenceKind), 'invalid evidence type');
  requireAcceptance(/^[a-f0-9]{40}$/u.test(expected.sourceSha ?? '') && evidence.sourceSha === expected.sourceSha, 'source SHA differs');
  requireAcceptance(isHash(expected.profileHash) && evidence.profileHash === expected.profileHash, 'profile hash differs');
  requireAcceptance(expected.ccxtVersion === '4.5.75' && evidence.ccxtVersion === expected.ccxtVersion, 'CCXT version differs');
  requireAcceptance(Object.hasOwn(TESTNET_ORIGINS, expected.exchange) && evidence.exchange === expected.exchange, 'exchange differs');
  requireAcceptance(evidence.environment === 'testnet' && evidence.host === TESTNET_ORIGINS[evidence.exchange]
    && expected.allowedTestnetOrigins?.includes(evidence.host), 'unapproved or non-testnet host');
}

function validateAccount(evidence) {
  requireAcceptance(isHash(evidence.accountReferenceHash), 'nonsecret account reference hash is required');
  exactKeys(evidence.accountMode, ['position', 'margin', 'verified', 'responseSha256'], 'invalid account mode proof');
  requireAcceptance(evidence.accountMode.position === 'oneway' && evidence.accountMode.margin === 'cross'
    && evidence.accountMode.verified === true && isHash(evidence.accountMode.responseSha256), 'account mode is unproven');
}

export function validateExchangeAcceptance(evidence, expected = {}) {
  validateBinding(evidence, expected);
  validateAccount(evidence);
  validateLimits(evidence);
  validateCases(evidence.cases);
  validateCleanup(evidence);
  const evidenceSha256 = createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
  const providerEvidenceComplete = evidence.evidenceKind === 'provider' && evidence.cases.every(test => test.result === 'PASS');
  // Approval is an independent, explicitly supplied input. The artifact cannot approve itself.
  const providerAcceptanceVerified = providerEvidenceComplete && isHash(expected.approvedEvidenceSha256)
    && expected.approvedEvidenceSha256 === evidenceSha256;
  requireAcceptance(!expected.requireProviderAcceptance || providerAcceptanceVerified, 'provider acceptance is still pending');
  return {
    formatValid: true,
    implementationVerified: false,
    providerEvidenceComplete, providerAcceptanceVerified, evidenceSha256,
    requiresIndependentReview: !providerAcceptanceVerified,
    unprovenCases: evidence.cases.filter(test => test.result !== 'PASS').map(test => test.id)
  };
}

const implementationHash = value => createHash('sha256').update(value).digest('hex');
const jsonHash = value => implementationHash(JSON.stringify(value));
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_INVENTORY_BYTES = 16 * 1024 * 1024;

async function realDirectory(directory) {
  const absolute = path.resolve(directory);
  requireAcceptance(path.isAbsolute(directory) && await realpath(absolute) === absolute, 'implementation root path is not canonical');
  let current = path.parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await lstat(current);
    requireAcceptance(stat.isDirectory() && !stat.isSymbolicLink(), 'implementation directory symlink is forbidden');
  }
  return absolute;
}

async function readBoundFile(root, file) {
  implementationPath(file);
  let current = root;
  const segments = file.split('/');
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = await lstat(current);
    requireAcceptance(!stat.isSymbolicLink(), 'implementation symlink is forbidden');
    requireAcceptance(index < segments.length - 1 ? stat.isDirectory() : stat.isFile() && stat.nlink === 1 && stat.size <= MAX_FILE_BYTES,
      'implementation path must be bounded and regular');
  }
  requireAcceptance(await realpath(current) === current, 'implementation file path changed');
  const handle = await open(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    requireAcceptance(before.isFile() && before.nlink === 1 && before.size <= MAX_FILE_BYTES, 'implementation file must be bounded and regular');
    const bytes = await handle.readFile();
    const after = await handle.stat(), currentStat = await lstat(current);
    requireAcceptance(bytes.length === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs
      && after.ctimeMs === before.ctimeMs && currentStat.ino === before.ino && currentStat.dev === before.dev
      && !currentStat.isSymbolicLink() && await realpath(current) === current, 'implementation file changed during read');
    return bytes;
  } finally { await handle.close(); }
}

async function verifiedFiles(root, references, expectedPaths, allPaths) {
  requireAcceptance(Array.isArray(references) && Array.isArray(expectedPaths) && references.length > 0
    && references.length <= 400 && references.length === expectedPaths.length, 'incomplete implementation file inventory');
  const expected = expectedPaths.map(implementationPath);
  requireAcceptance(new Set(expected).size === expected.length, 'duplicate implementation inventory');
  const result = new Map();
  let totalBytes = 0;
  for (const reference of references) {
    exactKeys(reference, ['path', 'sha256'], 'invalid implementation file reference');
    const file = implementationPath(reference.path);
    requireAcceptance(expected.includes(file) && !allPaths.has(file) && isHash(reference.sha256), 'unexpected or duplicate implementation file');
    allPaths.add(file);
    const bytes = await readBoundFile(root, file);
    totalBytes += bytes.length;
    requireAcceptance(totalBytes <= MAX_INVENTORY_BYTES, 'implementation inventory byte budget exceeded');
    requireAcceptance(implementationHash(bytes) === reference.sha256, 'implementation byte hash differs');
    result.set(file, bytes.toString('utf8'));
  }
  return result;
}

function validateFixtureReferences(fixture, sources, tests) {
  requireAcceptance(Array.isArray(fixture.sourceReferences) && fixture.sourceReferences.length > 0
    && fixture.sourceReferences.length <= 100, 'missing fixture source references');
  for (const source of fixture.sourceReferences) {
    exactKeys(source, ['path', 'symbol'], 'invalid fixture source reference');
    requireAcceptance(typeof source.symbol === 'string' && /^[a-zA-Z_][a-zA-Z0-9_.]{1,127}$/u.test(source.symbol)
      && sources.get(source.path)?.includes(source.symbol), 'fixture source symbol is missing');
  }
  const test = fixture.testReference;
  exactKeys(test, ['path', 'name'], 'invalid fixture test reference');
  requireAcceptance(typeof test.name === 'string' && /^[a-zA-Z_][a-zA-Z0-9_.]{1,127}$/u.test(test.name)
    && tests.get(test.path)?.includes(test.name), 'fixture test is missing');
}

function validateModeReadback(fixture, scope) {
  const readback = fixture.modeReadback;
  if (fixture.category !== 'accountModeAdmission' || fixture.polarity !== 'positive') {
    requireAcceptance(readback === null, 'unexpected mode readback');
    return;
  }
  exactKeys(readback, ['origin', 'accountReferenceHash', 'credentialGeneration', 'positionMode', 'marginMode', 'responseSha256'], 'missing actual mode readback');
  requireAcceptance(['authenticated', 'public_bound_account'].includes(readback.origin) && isHash(readback.accountReferenceHash)
    && isHash(readback.credentialGeneration), 'mode account binding is unproven');
  requireAcceptance(readback.accountReferenceHash === fixture.original.request.accountReferenceHash
    && readback.credentialGeneration === fixture.original.request.credentialGeneration, 'mode request binding differs');
  requireAcceptance(readback.positionMode === scope.positionMode && readback.marginMode === scope.marginMode
    && readback.responseSha256 === jsonHash(fixture.original.response), 'mode response is unproven');
}

function loadFixtures(files, sources, tests, binding) {
  const fixtures = new Map();
  for (const content of files.values()) {
    const fixture = copyImplementationData(JSON.parse(content));
    validateParityFixture(fixture);
    requireAcceptance(typeof fixture.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(fixture.id)
      && !fixtures.has(fixture.id), 'duplicate or invalid fixture identity');
    requireAcceptance(isDeepStrictEqual(fixture.binding, binding), 'fixture binding or product scope differs');
    validateFixtureReferences(fixture, sources, tests);
    validateModeReadback(fixture, binding.productScope);
    fixtures.set(fixture.id, fixture);
  }
  return fixtures;
}

function assertFixtureCoverage(cases, fixtures) {
  const used = new Set();
  for (const row of cases) for (const polarity of ['positive', 'adversarial']) {
    const checks = new Set();
    for (const id of row[polarity]) {
      const fixture = fixtures.get(id);
      requireAcceptance(fixture?.category === row.id && fixture?.polarity === polarity && !used.has(id), 'missing or misclassified parity fixture');
      used.add(id);
      for (const assertion of fixture.assertions) checks.add(assertion.check);
    }
    requireAcceptance(PROFILE_PARITY_CHECKS[row.id].every(check => checks.has(check)), 'parity fixture omits a mandatory contract');
  }
  requireAcceptance(used.size === fixtures.size, 'unreferenced parity fixture');
}

async function reviewBinding(root, reference, evidence, evidenceSha256) {
  if (reference === undefined) return false;
  exactKeys(reference, ['path', 'sha256'], 'invalid independent review reference');
  const bytes = await readBoundFile(root, reference.path);
  requireAcceptance(isHash(reference.sha256) && implementationHash(bytes) === reference.sha256, 'independent review byte hash differs');
  const review = copyImplementationData(JSON.parse(bytes.toString('utf8')));
  exactKeys(review, ['schemaVersion', 'kind', 'evidenceSha256', 'binding', 'sources', 'tests', 'fixtures'], 'invalid independent review schema');
  requireAcceptance(review.schemaVersion === 1 && review.kind === 'independent-review-reference'
    && review.evidenceSha256 === evidenceSha256, 'independent review evidence differs');
  for (const field of ['binding', 'sources', 'tests', 'fixtures']) {
    requireAcceptance(isDeepStrictEqual(review[field], evidence[field]), 'independent review source binding differs');
  }
  return true;
}

/** Read-only bound format/review check. expected is selected independently of the artifact.
 * No fixture or test module is executed/imported. Hash matches are NOT authentication,
 * observed test success, provider acceptance, or permission to change the profile allowlist. */
export async function verifyExchangeImplementation(evidence, expected) {
  try { return await verifyImplementationFiles(copyImplementationData(evidence), copyImplementationData(expected)); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith('Exchange acceptance evidence rejected:')) throw error;
    throw new Error('Exchange acceptance evidence rejected: implementation file or JSON unavailable.', { cause: error });
  }
}

async function verifyImplementationFiles(evidence, expected) {
  exactKeys(evidence, ['schemaVersion', 'evidenceKind', 'binding', 'sources', 'tests', 'fixtures', 'cases'], 'invalid implementation artifact');
  exactKeys(expected, ['root', 'binding', 'sourceFiles', 'testFiles', 'fixtureFiles',
    ...(Object.hasOwn(expected, 'reviewFile') ? ['reviewFile'] : [])], 'invalid independent implementation context');
  requireAcceptance(evidence.schemaVersion === 1 && evidence.evidenceKind === 'implementation-fixture-review', 'invalid implementation evidence kind');
  validateImplementationBinding(expected.binding);
  requireAcceptance(isDeepStrictEqual(evidence.binding, expected.binding), 'implementation binding differs');
  validateParityMatrix(evidence.cases);
  const root = await realDirectory(expected.root), allPaths = new Set();
  const sources = await verifiedFiles(root, evidence.sources, expected.sourceFiles, allPaths);
  const tests = await verifiedFiles(root, evidence.tests, expected.testFiles, allPaths);
  const originals = await verifiedFiles(root, evidence.fixtures, expected.fixtureFiles, allPaths);
  requireAcceptance(sources.has(evidence.binding.profileFile)
    && evidence.sources.find(source => source.path === evidence.binding.profileFile).sha256 === evidence.binding.profileHash,
  'actual profile byte hash differs');
  const fixtures = loadFixtures(originals, sources, tests, evidence.binding);
  assertFixtureCoverage(evidence.cases, fixtures);
  const evidenceSha256 = jsonHash(evidence);
  return { formatValid: true, implementationEvidenceComplete: true, fixtureCount: fixtures.size,
    evidenceSha256, reviewBindingValid: await reviewBinding(root, expected.reviewFile, evidence, evidenceSha256),
    implementationVerified: false, providerAcceptanceVerified: false, requiresIndependentReview: true };
}

async function main() {
  const { values } = parseArgs({ options: {
    evidence: { type: 'string' }, 'source-sha': { type: 'string' }, exchange: { type: 'string' },
    'allow-testnet-origin': { type: 'string', multiple: true }, 'approved-evidence-sha256': { type: 'string' },
    'require-provider': { type: 'boolean', default: false }
  } });
  const profileFile = new URL('../exchange_executor/ccxt_profiles.py', import.meta.url);
  const profileHash = createHash('sha256').update(await readFile(profileFile)).digest('hex');
  const result = validateExchangeAcceptance(JSON.parse(await readFile(values.evidence, 'utf8')), {
    sourceSha: values['source-sha'], exchange: values.exchange, ccxtVersion: '4.5.75', profileHash,
    allowedTestnetOrigins: values['allow-testnet-origin'], approvedEvidenceSha256: values['approved-evidence-sha256'],
    requireProviderAcceptance: values['require-provider']
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch {
    console.error('Exchange acceptance evidence rejected; check schema, binding, limits, cleanup and independent approval.');
    process.exitCode = 1;
  }
}
