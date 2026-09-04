import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyExchangeImplementation, validateExchangeAcceptance, REQUIRED_ACCEPTANCE_CASES, TESTNET_ORIGINS } from '../scripts/verify_exchange_acceptance.js';
import { REQUIRED_PROFILE_PARITY_CASES, PROFILE_PARITY_CHECKS } from '../scripts/exchange_acceptance_contract.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const jsonHash = value => hash(JSON.stringify(value));
const sha = 'a'.repeat(40);
assert.deepEqual(REQUIRED_PROFILE_PARITY_CASES, ['identitySecrets', 'symbolProduct', 'accountModeAdmission', 'entryProtection',
  'ownershipReconciliation', 'history', 'lifecycle', 'moneyRisk', 'errorsStreams', 'crossLayer']);
const scope = { marketType: 'perpetual', linear: true, inverse: false, quanto: false, settlementAsset: 'USDT',
  contractSize: '1', expiry: null, positionMode: 'oneway', marginMode: 'cross', environment: 'testnet' };

function providerFixture(binding, category, polarity) {
  const original = { request: { operation: 'privateRead', accountReferenceHash: 'a'.repeat(64), credentialGeneration: 'b'.repeat(64) },
    response: { result: { positionMode: 'oneway', marginMode: 'cross', account: 'redacted-fixture-account' } } };
  return { schemaVersion: 1, evidenceKind: 'synthetic-provider-fixture', id: `${category}-${polarity}`, binding,
    category, polarity, sourceReferences: [{ path: 'adapter.js', symbol: 'readMode' }],
    testReference: { path: 'cases.js', name: 'testBoundContracts' }, original,
    assertions: PROFILE_PARITY_CHECKS[category].map(check => ({ check, expectedBehavior: `${check}: ${polarity} boundary is enforced` })),
    expectedOutcome: polarity === 'positive' ? 'accepted' : 'rejected',
    modeReadback: category === 'accountModeAdmission' && polarity === 'positive' ? {
      origin: 'authenticated', accountReferenceHash: 'a'.repeat(64), credentialGeneration: 'b'.repeat(64),
      positionMode: 'oneway', marginMode: 'cross', responseSha256: jsonHash(original.response),
    } : null };
}

async function reference(root, file) { return { path: file, sha256: hash(await readFile(path.join(root, file))) }; }
async function writeFixture(context, fixture) {
  const file = `fixtures/${fixture.id}.json`;
  await writeFile(path.join(context.root, file), JSON.stringify(fixture));
  const ref = await reference(context.root, file);
  const index = context.evidence.fixtures.findIndex(item => item.path === file);
  if (index >= 0) context.evidence.fixtures[index] = ref;
  else { context.evidence.fixtures.push(ref); context.expected.fixtureFiles.push(file); }
}

async function contextFixture(root, exchange = 'additionalfixture') {
  await mkdir(path.join(root, 'fixtures'));
  await writeFile(path.join(root, 'profile.py'), 'PROFILE_VERSION = 1\n');
  await writeFile(path.join(root, 'adapter.js'), 'export function readMode() { throw new Error("fixture only"); }\n');
  await writeFile(path.join(root, 'cases.js'), 'throw new Error("MUST NOT EXECUTE");\nfunction testBoundContracts() {}\n');
  const binding = { sourceSha: sha, ccxtVersion: '4.5.75', exchange, profileVersion: 1,
    profileFile: 'profile.py', profileHash: hash(await readFile(path.join(root, 'profile.py'))), productScope: scope };
  const expected = { root, binding: structuredClone(binding), sourceFiles: ['profile.py', 'adapter.js'],
    testFiles: ['cases.js'], fixtureFiles: [] };
  const evidence = { schemaVersion: 1, evidenceKind: 'implementation-fixture-review', binding,
    sources: await Promise.all(expected.sourceFiles.map(file => reference(root, file))),
    tests: await Promise.all(expected.testFiles.map(file => reference(root, file))), fixtures: [], cases: [] };
  const context = { root, expected, evidence };
  for (const category of REQUIRED_PROFILE_PARITY_CASES) {
    for (const polarity of ['positive', 'adversarial']) await writeFixture(context, providerFixture(binding, category, polarity));
    evidence.cases.push({ id: category, positive: [`${category}-positive`], adversarial: [`${category}-adversarial`] });
  }
  return context;
}

async function incompleteThenComplete(context) {
  const missing = structuredClone(context.evidence);
  missing.cases.pop();
  await assert.rejects(verifyExchangeImplementation(missing, context.expected), /parity|matrix/i);
  const result = await verifyExchangeImplementation(context.evidence, context.expected);
  assert.equal(result.implementationEvidenceComplete, true);
  assert.equal(result.fixtureCount, 20);
  assert.equal(result.implementationVerified, false);
  assert.equal(result.providerAcceptanceVerified, false);
  assert.equal(result.requiresIndependentReview, true);
  assert.equal(result.reviewBindingValid, false);
  assert.equal(result.evidenceSha256, jsonHash(context.evidence));
}

async function invalidArtifacts(context) {
  const mutations = [
    value => { value.cases[0].adversarial = []; },
    value => { value.cases[0].positive = ['not-a-fixture']; },
    value => { value.cases[0].positive = [value.cases[1].positive[0]]; },
    value => { value.cases[0].positive.push(value.cases[0].positive[0]); },
    value => { value.cases[0].positive = [true]; },
    value => { value.cases[0].has = { createOrders: true }; },
    value => { value.cases[0].notApplicable = 'no testnet'; },
    value => { value.sources.pop(); }, value => { value.tests = []; }, value => { value.fixtures.pop(); },
    value => { value.sources[0].sha256 = 'f'.repeat(64); },
    value => { value.sources[0].path = '../outside.py'; },
    value => { value.sources[0].path = path.resolve(context.root, 'profile.py'); },
    value => { value.sources[0].path = 'profile.py:secret'; },
    value => { value.sources[0].path = 'a/../profile.py'; },
    value => { value.sources[0].path = 'PROFILE.py'; },
    value => { value.binding.sourceSha = 'b'.repeat(40); },
    value => { value.binding.ccxtVersion = '4.5.76'; },
    value => { value.binding.profileVersion = 2; },
    value => { value.binding.productScope.marketType = 'spot'; },
    value => { value.binding.productScope.settlementAsset = 'USDC'; },
    value => { value.binding.productScope.environment = 'live'; },
    value => { value.binding.productScope.contractSize = '100'; },
    value => { value.binding.productScope.linear = false; },
    value => { value.binding.productScope.expiry = 2000000000000; },
    value => { value.binding.exchange = 'otherprofile'; },
    value => { value.attestation = { status: 'certified', implementationVerified: true }; },
    value => { value.providerAcceptanceVerified = true; },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(context.evidence);
    mutate(invalid);
    await assert.rejects(verifyExchangeImplementation(invalid, context.expected), /evidence rejected/i);
  }
  await assert.rejects(verifyExchangeImplementation(context.evidence, { ...context.expected,
    sourceFiles: ['profile.py'] }), /evidence rejected/i, 'The independently selected complete source inventory is mandatory.');
}

async function invalidOriginals(context) {
  const category = 'accountModeAdmission';
  const original = providerFixture(context.evidence.binding, category, 'positive');
  for (const mutate of [
    value => { value.original = { request: { has: true }, response: { createOrders: true } }; value.modeReadback = null; },
    value => { value.modeReadback.origin = 'capability_flag'; },
    value => { value.modeReadback.positionMode = 'hedge'; },
    value => { value.modeReadback.responseSha256 = 'c'.repeat(64); },
    value => { value.modeReadback.accountReferenceHash = ''; },
    value => { value.modeReadback.credentialGeneration = 'f'.repeat(64); },
    value => { value.original.request = {}; },
    value => { value.original.response = {}; },
    value => { value.assertions.pop(); },
    value => { value.assertions[0].expectedBehavior = true; },
    value => { value.testReference.name = 'missingTest'; },
    value => { value.sourceReferences[0].symbol = 'missingReadback'; },
    value => { value.binding.productScope.inverse = true; },
  ]) {
    const invalid = structuredClone(original);
    mutate(invalid);
    await writeFixture(context, invalid);
    await assert.rejects(verifyExchangeImplementation(context.evidence, context.expected), /evidence rejected/i);
  }
  await writeFixture(context, original);
  const publicBound = structuredClone(original);
  publicBound.modeReadback.origin = 'public_bound_account';
  await writeFixture(context, publicBound);
  assert.equal((await verifyExchangeImplementation(context.evidence, context.expected)).implementationEvidenceComplete, true);
  await writeFixture(context, original);
}

async function everyClassRequiresBothContracts(context) {
  for (const category of REQUIRED_PROFILE_PARITY_CASES) for (const polarity of ['positive', 'adversarial']) {
    const original = providerFixture(context.evidence.binding, category, polarity);
    const incomplete = structuredClone(original);
    incomplete.assertions.pop();
    await writeFixture(context, incomplete);
    await assert.rejects(verifyExchangeImplementation(context.evidence, context.expected), /mandatory contract|assertions/);
    await writeFixture(context, original);
  }
}

async function diskAndReview(context) {
  const adapter = await readFile(path.join(context.root, 'adapter.js'));
  await writeFile(path.join(context.root, 'adapter.js'), `${adapter}\n// shared adapter changed\n`);
  await assert.rejects(verifyExchangeImplementation(context.evidence, context.expected), /hash/i);
  await writeFile(path.join(context.root, 'adapter.js'), adapter);
  const missing = context.evidence.fixtures[0];
  const bytes = await readFile(path.join(context.root, missing.path));
  await rm(path.join(context.root, missing.path));
  await assert.rejects(verifyExchangeImplementation(context.evidence, context.expected), /evidence rejected/i);
  await writeFile(path.join(context.root, missing.path), bytes);
  const result = await verifyExchangeImplementation(context.evidence, context.expected);
  const review = { schemaVersion: 1, kind: 'independent-review-reference', evidenceSha256: result.evidenceSha256,
    binding: context.evidence.binding, sources: context.evidence.sources, tests: context.evidence.tests, fixtures: context.evidence.fixtures };
  await writeFile(path.join(context.root, 'review.json'), JSON.stringify(review));
  const expected = { ...context.expected, reviewFile: await reference(context.root, 'review.json') };
  const reviewed = await verifyExchangeImplementation(context.evidence, expected);
  assert.equal(reviewed.reviewBindingValid, true);
  assert.equal(reviewed.implementationVerified, false, 'A review hash is not authority to certify an implementation.');
  assert.equal(reviewed.providerAcceptanceVerified, false);
  for (const mutate of [
    value => { value.evidenceSha256 = 'a'.repeat(64); },
    value => { value.binding.profileVersion = 2; },
    value => { value.tests[0].sha256 = 'c'.repeat(64); },
    value => { value.fixtures.pop(); },
  ]) {
    const forged = structuredClone(review);
    mutate(forged);
    await writeFile(path.join(context.root, 'review.json'), JSON.stringify(forged));
    expected.reviewFile = await reference(context.root, 'review.json');
    await assert.rejects(verifyExchangeImplementation(context.evidence, expected), /review/);
  }
  await writeFile(path.join(context.root, 'review.json'), JSON.stringify(review));
  expected.reviewFile = await reference(context.root, 'review.json');
  await writeFile(path.join(context.root, 'review.json'), JSON.stringify({ ...review, implementationVerified: true }));
  await assert.rejects(verifyExchangeImplementation(context.evidence, expected), /hash/i);
  expected.reviewFile = await reference(context.root, 'review.json');
  await assert.rejects(verifyExchangeImplementation(context.evidence, expected), /review/i);
}

async function symlinkBoundary(context, directory) {
  const target = path.join(directory, 'outside');
  await mkdir(target);
  await writeFile(path.join(target, 'foreign.json'), '{}');
  await symlink(target, path.join(context.root, 'linked'), 'junction');
  const evidence = structuredClone(context.evidence), expected = structuredClone(context.expected);
  const ref = { path: 'linked/foreign.json', sha256: hash('{}') };
  evidence.fixtures.push(ref); expected.fixtureFiles.push(ref.path);
  await assert.rejects(verifyExchangeImplementation(evidence, expected), /symlink|path|regular/i);
  await assert.rejects(verifyExchangeImplementation(context.evidence, { ...context.expected, root: path.join(context.root, 'linked') }), /root path/);
  const folder = 'not-a-regular-fixture.json';
  await mkdir(path.join(context.root, folder));
  const nonregular = structuredClone(context.evidence), nonregularExpected = structuredClone(context.expected);
  nonregular.fixtures.push({ path: folder, sha256: hash('{}') }); nonregularExpected.fixtureFiles.push(folder);
  await assert.rejects(verifyExchangeImplementation(nonregular, nonregularExpected), /regular/);
  const large = 'oversized.js';
  await writeFile(path.join(context.root, large), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
  const oversized = structuredClone(context.evidence), oversizedExpected = structuredClone(context.expected);
  oversized.sources.push(await reference(context.root, large)); oversizedExpected.sourceFiles.push(large);
  await assert.rejects(verifyExchangeImplementation(oversized, oversizedExpected), /bounded/);
}

async function malformedData(context) {
  const sparse = structuredClone(context.evidence);
  delete sparse.cases[0];
  await assert.rejects(verifyExchangeImplementation(sparse, context.expected), /sparse/);
  let getterCalls = 0;
  const accessor = structuredClone(context.evidence);
  Object.defineProperty(accessor, 'schemaVersion', { get() { getterCalls += 1; return 1; }, enumerable: true });
  await assert.rejects(verifyExchangeImplementation(accessor, context.expected), /accessors/);
  assert.equal(getterCalls, 0);
  const hidden = structuredClone(context.evidence);
  Object.defineProperty(hidden, 'secret', { value: 'must-not-leak' });
  await assert.rejects(verifyExchangeImplementation(hidden, context.expected), error => {
    assert.doesNotMatch(error.message, /must-not-leak/);
    return /evidence rejected/.test(error.message);
  });
  const invalidRoot = { ...context.expected, root: '.' };
  await assert.rejects(verifyExchangeImplementation(context.evidence, invalidRoot), /root path/);
  const excessive = structuredClone(context.evidence);
  excessive.cases[0].positive = Array(12001).fill('fake');
  await assert.rejects(verifyExchangeImplementation(excessive, context.expected), /budget|fixture/);
}

async function existingAndAdditionalProfiles(directory) {
  for (const exchange of ['hyperliquid', 'bybit', 'krakenfutures']) {
    const root = path.join(directory, exchange);
    await mkdir(root);
    const context = await contextFixture(root, exchange);
    const result = await verifyExchangeImplementation(context.evidence, context.expected);
    assert.equal(result.implementationEvidenceComplete, true);
    assert.equal(result.implementationVerified, false);
    assert.equal(result.providerAcceptanceVerified, false);
  }
}

function providerBooleanCannotApprove() {
  const hashValue = 'b'.repeat(64), exchange = 'bybit';
  const evidence = { schemaVersion: 1, evidenceKind: 'synthetic', sourceSha: sha, ccxtVersion: '4.5.75', profileHash: hashValue,
    exchange, environment: 'testnet', host: TESTNET_ORIGINS[exchange], accountReferenceHash: hashValue,
    accountMode: { position: 'oneway', margin: 'cross', verified: true, responseSha256: hashValue },
    startedAt: '2026-09-02T10:00:00Z', finishedAt: '2026-09-02T10:00:10Z',
    limits: { maxNotionalUsd: '5', maxOrderCount: 2, timeBudgetSeconds: 30 },
    observed: { maxNotionalUsd: '4', submittedOrderCount: 2 }, ownedOrderIds: ['entry', 'stop'],
    cases: REQUIRED_ACCEPTANCE_CASES.map(id => ({ id, result: 'PASS', requestResponseHashes: [
      { requestSha256: hashValue, responseSha256: hashValue, redacted: true }] })),
    cleanup: { verified: true, journalSha256: hashValue, terminalOrderIds: ['entry', 'stop'], openOrderIds: [],
      residualExposure: '0', positionResponseSha256: hashValue, completedAt: '2026-09-02T10:00:09Z' } };
  assert.equal(validateExchangeAcceptance(evidence, { sourceSha: sha, ccxtVersion: '4.5.75', profileHash: hashValue,
    exchange, allowedTestnetOrigins: [TESTNET_ORIGINS[exchange]], implementationVerified: true }).implementationVerified, false);
}

const directory = await mkdtemp(path.join(os.tmpdir(), 'profile-parity-'));
try {
  const root = path.join(directory, 'workspace');
  await mkdir(root);
  const context = await contextFixture(root);
  await incompleteThenComplete(context);
  await invalidArtifacts(context);
  await invalidOriginals(context);
  await everyClassRequiresBothContracts(context);
  await diskAndReview(context);
  await symlinkBoundary(context, directory);
  await malformedData(context);
  await existingAndAdditionalProfiles(directory);
  providerBooleanCannotApprove();
} finally { await rm(directory, { recursive: true, force: true }); }
console.log('Profile parity evidence tests passed (offline format/review bindings only; no profile or provider approval).');
