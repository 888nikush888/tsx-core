export const REQUIRED_ACCEPTANCE_CASES = Object.freeze([
  'accountIdentity', 'accountMode', 'entryStopCorrelation', 'cancelTerminality',
  'partialFill', 'lateFill', 'feesFunding', 'priceBounds', 'leverageQuantityLimits'
]);

export const TESTNET_ORIGINS = Object.freeze({
  hyperliquid: 'https://api.hyperliquid-testnet.xyz',
  bybit: 'https://api-testnet.bybit.com',
  krakenfutures: 'https://demo-futures.kraken.com'
});

// Format/review obligations, not executable provider assertions or capability grants.
export const PROFILE_PARITY_CHECKS = Object.freeze(Object.fromEntries(Object.entries({
  identitySecrets: ['accountSubaccountBinding', 'credentialGeneration', 'rotation', 'staleRequest', 'permissions', 'secretRedaction'],
  symbolProduct: ['exactResolution', 'ambiguity', 'contractSize', 'decimalPrecision', 'settlement', 'quantityLimits', 'inactiveMissing', 'productSeparation'],
  accountModeAdmission: ['modeReadback', 'leverageTiers', 'entryPriceBound', 'marginReserve', 'accountPositionLimit'],
  entryProtection: ['entryStopCorrelation', 'stableOwnIds', 'batchSemantics', 'partialAcceptance', 'unknownSubmit', 'partialLateFill', 'reduceOnlyTrigger'],
  ownershipReconciliation: ['foreignNullableClientId', 'exchangeId', 'namespaces', 'ambiguousUnknownEvidence', 'foreignExposureUntouched'],
  history: ['completeProductScope', 'pagination', 'retention', 'timeBounds', 'duplicates', 'emptyFullPages', 'durableCursor', 'sharedBudget', 'incompleteRemainsIncomplete'],
  lifecycle: ['stopTakeProfitResize', 'stopOnlyTightens', 'ownedRemainder', 'cancelTerminality', 'entryDrain', 'kill', 'recoveryLateFill', 'sharedReleaseProof'],
  moneyRisk: ['feeRebateSign', 'fundingCompleteness', 'originalCurrency', 'provedConversion', 'replayIdempotency', 'unknownBlocksEntryNotProtection'],
  errorsStreams: ['transientVsContractError', 'noBlindSubmitRetry', 'streamReconnectDuplicates', 'restAuthority'],
  crossLayer: ['originalSignalTtlFallback', 'unknownSubmitNoSecondExecution', 'accountIsolation', 'restartMaintenanceFences'],
}).map(([key, checks]) => [key, Object.freeze(checks)])));
export const REQUIRED_PROFILE_PARITY_CASES = Object.freeze(Object.keys(PROFILE_PARITY_CHECKS));

function dataNode(value, state, depth) {
  requireAcceptance(++state.nodes <= 12000 && depth <= 16, 'implementation JSON budget exceeded');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') { requireAcceptance(Number.isFinite(value), 'invalid implementation number'); return; }
  if (typeof value === 'string') { requireAcceptance(value.length <= 65536 && !value.includes('\0'), 'invalid implementation string'); return; }
  requireAcceptance(typeof value === 'object' && [Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value)), 'invalid implementation data');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors).filter(key => !(Array.isArray(value) && key === 'length'));
  if (Array.isArray(value)) requireAcceptance(keys.length === value.length && keys.every((key, index) => key === String(index)), 'sparse implementation array');
  for (const key of keys) {
    requireAcceptance(typeof key === 'string' && !/[\x00-\x1f\x7f]/u.test(key)
      && !/^(?:__proto__|constructor|prototype|apiKey|secret|password|privateKey|authorization|signature)$/iu.test(key), 'unsafe implementation key');
    const descriptor = descriptors[key];
    requireAcceptance(Object.hasOwn(descriptor, 'value') && descriptor.enumerable, 'implementation accessors are not evidence');
    dataNode(descriptor.value, state, depth + 1);
  }
}

/** Copy data only after rejecting getters, holes and hidden properties; no artifact code is invoked. */
export function copyImplementationData(value) {
  dataNode(value, { nodes: 0 }, 0);
  const encoded = JSON.stringify(value);
  requireAcceptance(Buffer.byteLength(encoded) < 262144, 'implementation JSON byte budget exceeded');
  return JSON.parse(encoded);
}

export function implementationPath(value) {
  requireAcceptance(typeof value === 'string' && value.length <= 240 && /^[a-zA-Z0-9_./-]+$/u.test(value)
    && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..'), 'unsafe implementation path');
  return value;
}

export function validateImplementationBinding(binding) {
  exactKeys(binding, ['sourceSha', 'ccxtVersion', 'exchange', 'profileVersion', 'profileFile', 'profileHash', 'productScope'], 'invalid implementation binding');
  requireAcceptance(/^[a-f0-9]{40}$/u.test(binding.sourceSha) && binding.ccxtVersion === '4.5.75'
    && /^[a-z][a-z0-9_]{1,63}$/u.test(binding.exchange) && Number.isSafeInteger(binding.profileVersion)
    && binding.profileVersion > 0 && isHash(binding.profileHash), 'implementation version or profile differs');
  implementationPath(binding.profileFile);
  const scope = binding.productScope;
  exactKeys(scope, ['marketType', 'linear', 'inverse', 'quanto', 'settlementAsset', 'contractSize', 'expiry',
    'positionMode', 'marginMode', 'environment'], 'invalid product scope');
  requireAcceptance(['perpetual', 'future'].includes(scope.marketType) && ['oneway', 'hedge'].includes(scope.positionMode)
    && ['cross', 'isolated'].includes(scope.marginMode) && ['live', 'testnet'].includes(scope.environment), 'unsupported product scope');
  requireAcceptance(['linear', 'inverse', 'quanto'].every(key => typeof scope[key] === 'boolean')
    && Number(scope.linear) + Number(scope.inverse) + Number(scope.quanto) === 1, 'ambiguous product economics');
  requireAcceptance(/^[A-Z0-9][A-Z0-9._-]{0,31}$/u.test(scope.settlementAsset) && positiveDecimal(scope.contractSize), 'invalid settlement or contract size');
  requireAcceptance(scope.marketType === 'perpetual' ? scope.expiry === null
    : Number.isSafeInteger(scope.expiry) && scope.expiry > 0, 'invalid expiry scope');
}

export function validateParityMatrix(cases) {
  requireAcceptance(Array.isArray(cases) && cases.length === REQUIRED_PROFILE_PARITY_CASES.length, 'incomplete parity matrix');
  const ids = new Set();
  for (const row of cases) {
    exactKeys(row, ['id', 'positive', 'adversarial'], 'invalid parity class');
    requireAcceptance(REQUIRED_PROFILE_PARITY_CASES.includes(row.id) && !ids.has(row.id), 'wrong parity matrix');
    ids.add(row.id);
    for (const polarity of ['positive', 'adversarial']) {
      const references = row[polarity];
      requireAcceptance(Array.isArray(references) && references.length > 0 && references.length <= 100
        && references.every(id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(id))
        && new Set(references).size === references.length, 'missing or duplicate parity fixture');
    }
  }
}

export function validateParityFixture(fixture) {
  exactKeys(fixture, ['schemaVersion', 'evidenceKind', 'id', 'binding', 'category', 'polarity', 'sourceReferences',
    'testReference', 'original', 'assertions', 'expectedOutcome', 'modeReadback'], 'invalid parity fixture schema');
  requireAcceptance(fixture.schemaVersion === 1 && fixture.evidenceKind === 'synthetic-provider-fixture'
    && REQUIRED_PROFILE_PARITY_CASES.includes(fixture.category) && ['positive', 'adversarial'].includes(fixture.polarity), 'invalid parity fixture kind');
  requireAcceptance(fixture.polarity === 'positive' ? fixture.expectedOutcome === 'accepted'
    : ['rejected', 'unresolved'].includes(fixture.expectedOutcome), 'invalid parity outcome');
  exactKeys(fixture.original, ['request', 'response'], 'missing original request/response');
  for (const original of Object.values(fixture.original)) {
    requireAcceptance(original && typeof original === 'object' && !Array.isArray(original) && Object.keys(original).length > 0,
      'empty original request/response');
  }
  validateFixtureAssertions(fixture.assertions, PROFILE_PARITY_CHECKS[fixture.category]);
}

function validateFixtureAssertions(assertions, checks) {
  requireAcceptance(Array.isArray(assertions) && assertions.length > 0 && assertions.length <= checks.length, 'missing parity assertions');
  const seen = new Set();
  for (const assertion of assertions) {
    exactKeys(assertion, ['check', 'expectedBehavior'], 'invalid parity assertion');
    requireAcceptance(checks.includes(assertion.check) && !seen.has(assertion.check)
      && typeof assertion.expectedBehavior === 'string' && assertion.expectedBehavior.trim().length >= 12
      && assertion.expectedBehavior.length <= 2048, 'unproved parity behavior');
    seen.add(assertion.check);
  }
}

export function requireAcceptance(condition, detail) {
  if (!condition) throw new Error(`Exchange acceptance evidence rejected: ${detail}.`);
}

export function exactKeys(object, keys, detail) {
  requireAcceptance(object && typeof object === 'object' && !Array.isArray(object), detail);
  requireAcceptance(Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key)), detail);
}

export function isHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

export function positiveDecimal(value) {
  return typeof value === 'string' && value.length <= 80 && /^\d+(?:\.\d+)?$/u.test(value) && /[1-9]/u.test(value);
}

function decimalAtMost(value, limit) {
  const [whole, fraction = ''] = value.split('.');
  const [limitWhole, limitFraction = ''] = limit.split('.');
  const scale = Math.max(fraction.length, limitFraction.length);
  return BigInt(whole + fraction.padEnd(scale, '0')) <= BigInt(limitWhole + limitFraction.padEnd(scale, '0'));
}

export function validatedTime(value) {
  requireAcceptance(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
    && Number.isFinite(Date.parse(value)), 'invalid UTC timestamp');
  return Date.parse(value);
}

export function validateLimits(evidence) {
  exactKeys(evidence.limits, ['maxNotionalUsd', 'maxOrderCount', 'timeBudgetSeconds'], 'missing or invalid limits');
  exactKeys(evidence.observed, ['maxNotionalUsd', 'submittedOrderCount'], 'missing observed usage');
  const { maxNotionalUsd, maxOrderCount, timeBudgetSeconds } = evidence.limits;
  requireAcceptance(positiveDecimal(maxNotionalUsd), 'notional limit must be a positive decimal');
  requireAcceptance(Number.isSafeInteger(maxOrderCount) && maxOrderCount > 0, 'order limit must be positive');
  requireAcceptance(Number.isSafeInteger(timeBudgetSeconds) && timeBudgetSeconds > 0, 'time limit must be positive');
  requireAcceptance(positiveDecimal(evidence.observed.maxNotionalUsd)
    && decimalAtMost(evidence.observed.maxNotionalUsd, maxNotionalUsd), 'observed notional exceeds limit');
  requireAcceptance(Number.isSafeInteger(evidence.observed.submittedOrderCount)
    && evidence.observed.submittedOrderCount === evidence.ownedOrderIds?.length
    && evidence.observed.submittedOrderCount <= maxOrderCount, 'observed orders exceed limit or ownership journal');
  const elapsed = validatedTime(evidence.finishedAt) - validatedTime(evidence.startedAt);
  requireAcceptance(elapsed >= 0 && elapsed <= timeBudgetSeconds * 1_000, 'capture duration exceeds time limit');
}

function validateCase(test) {
  exactKeys(test, ['id', 'result', 'requestResponseHashes'], 'invalid case schema');
  requireAcceptance(['PASS', 'FAIL', 'NOT_PROVEN'].includes(test.result), 'invalid case result');
  requireAcceptance(Array.isArray(test.requestResponseHashes), 'missing request/response hashes');
  requireAcceptance(test.result !== 'PASS' || test.requestResponseHashes.length > 0, 'passed case lacks evidence hashes');
  for (const hashes of test.requestResponseHashes) {
    exactKeys(hashes, ['requestSha256', 'responseSha256', 'redacted'], 'invalid request/response evidence');
    requireAcceptance(isHash(hashes.requestSha256) && isHash(hashes.responseSha256) && hashes.redacted === true,
      'request/response evidence must be redacted and hashed');
  }
}

export function validateCases(cases) {
  requireAcceptance(Array.isArray(cases) && cases.length === REQUIRED_ACCEPTANCE_CASES.length, 'incomplete required case matrix');
  requireAcceptance(cases.every(test => test && typeof test === 'object'), 'invalid required case schema');
  requireAcceptance(new Set(cases.map(test => test.id)).size === cases.length
    && cases.every(test => REQUIRED_ACCEPTANCE_CASES.includes(test.id)), 'wrong required case matrix');
  for (const test of cases) validateCase(test);
}

export function validateCleanup(evidence) {
  requireAcceptance(Array.isArray(evidence.ownedOrderIds) && evidence.ownedOrderIds.length >= 2
    && evidence.ownedOrderIds.every(id => typeof id === 'string' && /^[\w:.-]{1,200}$/u.test(id)), 'own entry/stop order identities are required');
  const owned = new Set(evidence.ownedOrderIds);
  requireAcceptance(owned.size === evidence.ownedOrderIds.length, 'duplicate own order identities');
  const cleanup = evidence.cleanup;
  exactKeys(cleanup, ['verified', 'journalSha256', 'terminalOrderIds', 'openOrderIds', 'residualExposure',
    'positionResponseSha256', 'completedAt'], 'missing or invalid cleanup proof');
  requireAcceptance(cleanup.verified === true && isHash(cleanup.journalSha256)
    && isHash(cleanup.positionResponseSha256), 'cleanup is not verified');
  requireAcceptance(Array.isArray(cleanup.terminalOrderIds) && cleanup.terminalOrderIds.length === owned.size
    && new Set(cleanup.terminalOrderIds).size === owned.size && cleanup.terminalOrderIds.every(id => owned.has(id)),
  'cleanup ownership or terminality differs');
  requireAcceptance(Array.isArray(cleanup.openOrderIds) && cleanup.openOrderIds.length === 0
    && cleanup.residualExposure === '0', 'unresolved orders or exposure remain');
  const completed = validatedTime(cleanup.completedAt);
  requireAcceptance(completed >= validatedTime(evidence.startedAt) && completed <= validatedTime(evidence.finishedAt),
    'cleanup timestamp is outside the capture window');
}
