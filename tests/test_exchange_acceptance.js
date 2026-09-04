import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateExchangeAcceptance, REQUIRED_ACCEPTANCE_CASES, TESTNET_ORIGINS } from '../scripts/verify_exchange_acceptance.js';

const sha = 'a'.repeat(40);
const hash = 'b'.repeat(64);
const evidenceHash = evidence => createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
function fixture(exchange) {
  return {
    schemaVersion: 1, evidenceKind: 'synthetic', sourceSha: sha, ccxtVersion: '4.5.75', profileHash: hash, exchange,
    environment: 'testnet', host: TESTNET_ORIGINS[exchange], accountReferenceHash: hash,
    accountMode: { position: 'oneway', margin: 'cross', verified: true, responseSha256: hash },
    startedAt: '2026-09-02T10:00:00Z', finishedAt: '2026-09-02T10:00:10Z',
    limits: { maxNotionalUsd: '5', maxOrderCount: 2, timeBudgetSeconds: 30 },
    observed: { maxNotionalUsd: '4', submittedOrderCount: 2 }, ownedOrderIds: ['entry-owned', 'stop-owned'],
    cases: REQUIRED_ACCEPTANCE_CASES.map(id => ({
      id, result: 'PASS', requestResponseHashes: [{ requestSha256: hash, responseSha256: hash, redacted: true }]
    })),
    cleanup: {
      verified: true, journalSha256: hash, terminalOrderIds: ['entry-owned', 'stop-owned'], openOrderIds: [],
      residualExposure: '0', positionResponseSha256: hash, completedAt: '2026-09-02T10:00:09Z'
    }
  };
}
function expected(exchange) {
  return { sourceSha: sha, ccxtVersion: '4.5.75', profileHash: hash, exchange, allowedTestnetOrigins: [TESTNET_ORIGINS[exchange]] };
}

for (const exchange of Object.keys(TESTNET_ORIGINS)) {
  const evidence = fixture(exchange);
  const result = validateExchangeAcceptance(evidence, expected(exchange));
  assert.equal(result.formatValid, true);
  assert.equal(result.providerAcceptanceVerified, false, 'Synthetic data must never become real provider acceptance.');
  assert.equal(result.requiresIndependentReview, true);
  assert.throws(() => validateExchangeAcceptance(evidence, { ...expected(exchange), requireProviderAcceptance: true }), /provider acceptance/);
  for (const mutate of [
    value => { delete value.limits; }, value => { value.limits.maxOrderCount = 0; },
    value => { value.limits.maxNotionalUsd = 'NaN'; }, value => { value.limits.timeBudgetSeconds = 1; },
    value => { value.host = 'https://api.bybit.com'; }, value => { value.host += '.attacker.invalid'; },
    value => { value.environment = 'mainnet'; }, value => { value.sourceSha = 'c'.repeat(40); },
    value => { value.profileHash = 'c'.repeat(64); }, value => { value.ccxtVersion = '4.5.76'; },
    value => { delete value.cleanup; }, value => { value.cleanup.terminalOrderIds = ['foreign']; },
    value => { value.cleanup.openOrderIds = ['entry-owned']; }, value => { value.cleanup.residualExposure = '1'; },
    value => { value.cases.pop(); }, value => { value.cases[0].requestResponseHashes = []; },
    value => { value.cases[0] = null; },
    value => { value.accountMode.verified = false; }, value => { value.observed.submittedOrderCount = 3; },
    value => { value.observed.maxNotionalUsd = '5.000000000000000001'; },
    value => { value.apiKey = 'must-not-be-in-evidence'; }
  ]) {
    const invalid = structuredClone(evidence);
    mutate(invalid);
    assert.throws(() => validateExchangeAcceptance(invalid, expected(exchange)), /acceptance evidence/);
  }
  const unproven = structuredClone(evidence);
  unproven.cases[0].result = 'NOT_PROVEN';
  unproven.cases[0].requestResponseHashes = [];
  const pending = validateExchangeAcceptance(unproven, expected(exchange));
  assert.equal(pending.providerEvidenceComplete, false);
  const provider = { ...evidence, evidenceKind: 'provider' };
  assert.equal(validateExchangeAcceptance(provider, expected(exchange)).providerAcceptanceVerified, false);
  const reviewed = { ...expected(exchange), approvedEvidenceSha256: evidenceHash(provider), requireProviderAcceptance: true };
  assert.equal(validateExchangeAcceptance(provider, reviewed).providerAcceptanceVerified, true);
  assert.throws(() => validateExchangeAcceptance(evidence, { ...reviewed, approvedEvidenceSha256: evidenceHash(evidence) }), /provider acceptance/);
  assert.throws(() => validateExchangeAcceptance(provider, { ...reviewed, approvedEvidenceSha256: 'f'.repeat(64) }), /provider acceptance/);
}

const directory = await mkdtemp(path.join(os.tmpdir(), 'exchange-acceptance-'));
try {
  const file = path.join(directory, 'synthetic.json');
  const evidence = fixture('bybit');
  evidence.profileHash = createHash('sha256').update(await readFile('exchange_executor/ccxt_profiles.py')).digest('hex');
  await writeFile(file, JSON.stringify(evidence));
  const args = ['scripts/verify_exchange_acceptance.js', '--evidence', file, '--source-sha', sha,
    '--exchange', 'bybit', '--allow-testnet-origin', TESTNET_ORIGINS.bybit];
  const runCli = extra => spawnSync(process.execPath, [...args, ...extra], {
    cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', windowsHide: true
  });
  const validCli = runCli([]);
  assert.equal(validCli.status, 0);
  assert.equal(JSON.parse(validCli.stdout).providerAcceptanceVerified, false);
  assert.equal(JSON.parse(validCli.stdout).implementationVerified, false);
  const rejectedCli = runCli(['--require-provider']);
  assert.equal(rejectedCli.status, 1);
  assert.match(rejectedCli.stderr, /Exchange acceptance evidence rejected/);
  await writeFile(file, JSON.stringify({ apiKey: 'secret-must-not-be-logged' }));
  assert.doesNotMatch(runCli([]).stderr, /secret-must-not-be-logged/);
} finally {
  await rm(directory, { recursive: true, force: true });
}
console.log('Exchange acceptance evidence tests passed (synthetic fixtures only).');
