import assert from 'node:assert/strict';
import { assertCompleteFillCoverage, fillCoverageReason } from '../src/exchange_history_coverage.js';
import { assertHistoryResponse, validateHistoryProgress } from '../src/exchange_history_contract.js';
import { evaluateTradingSafety } from '../src/trading_safety_proof.js';

const now = Date.now();
const initial = { source: 'fills', providerSymbol: null, revision: 0, baselineSince: now - 1000,
  windowSince: now - 1000, windowUntil: null, cursor: null, scannedThrough: null, nextReadAt: 0,
  completeness: 'unknown', reason: 'history_pending', coverage: null };
function covered(profile = 'kraken_v3_executions_v1') {
  return { baseRevision: 0, pages: 1, checkpoint: { ...initial, revision: 1, windowSince: now - 1000, scannedThrough: now,
    providerAccountUid: profile === 'kraken_v3_executions_v1' ? 'kraken-account' : null,
    completeness: 'complete', reason: null, coverage: { version: 1, profile, since: initial.baselineSince, through: now } } };
}
function acquisition(update = covered()) {
  return { version: 1, startedAt: now - 10, completedAt: now, checkedOrders: [], history: [update],
    sources: ['positions', 'orders', 'fills', 'targeted_orders'].map(source => ({ source, startedAt: now - 10, completedAt: now,
      completeness: 'complete', reason: null, since: source === 'fills' ? initial.baselineSince : null })) };
}
for (const [exchange, profile] of [['krakenfutures', 'kraken_v3_executions_v1'], ['hyperliquid', 'hyperliquid_retained_fills_v1']]) {
  const evidence = acquisition(covered(profile));
  assertHistoryResponse([initial], validateHistoryProgress(evidence.history));
  assert.equal(fillCoverageReason(exchange, evidence, initial.baselineSince), null);
  assertCompleteFillCoverage(exchange, evidence, initial.baselineSince);
}
assert.equal(fillCoverageReason('bybit', acquisition(covered('bybit_v5_linear_endpoint_v1')), initial.baselineSince), 'FILL_OPTION_SCOPE_UNPROVED');
const missing = acquisition();
delete missing.history;
assert.throws(() => assertCompleteFillCoverage('krakenfutures', missing, initial.baselineSince), /FILL_COVERAGE_MISSING/);
assert.throws(() => assertCompleteFillCoverage('krakenfutures', acquisition(covered('hyperliquid_retained_fills_v1')), initial.baselineSince), /UNPROVED/);
const partial = acquisition();
const noUid = acquisition();
delete noUid.history[0].checkpoint.providerAccountUid;
assert.throws(() => assertCompleteFillCoverage('krakenfutures', noUid, initial.baselineSince), /IDENTITY_UNPROVED/);
partial.history[0].checkpoint.cursor = 'still-pending';
assert.throws(() => assertCompleteFillCoverage('krakenfutures', partial, initial.baselineSince), /UNPROVED/);
for (const patch of [{ pages: 0 }, { checkpoint: { ...covered().checkpoint, coverage: { ...covered().checkpoint.coverage, through: now - 11 } } }]) {
  assert.equal(fillCoverageReason('krakenfutures', acquisition({ ...covered(), ...patch }), initial.baselineSince), 'FILL_COVERAGE_NOT_FRESH');
}
assert.equal(fillCoverageReason('krakenfutures', acquisition(), initial.baselineSince - 1), 'FILL_BASELINE_UNPROVED');
const previous = covered().checkpoint;
const keep = { baseRevision: 1, pages: 0, checkpoint: { ...previous, revision: 2 } };
assertHistoryResponse([previous], validateHistoryProgress([keep]));
for (const change of [null, { ...previous.coverage, through: now - 1 }, { ...previous.coverage, profile: 'hyperliquid_retained_fills_v1' }]) {
  assert.throws(() => assertHistoryResponse([previous], validateHistoryProgress([{ ...keep,
    checkpoint: { ...keep.checkpoint, coverage: change } }])), /coverage/i);
}
assert.throws(() => assertHistoryResponse([initial], validateHistoryProgress([{ ...covered(), pages: 0 }])), /unread/);
const hole = { ...initial, windowSince: initial.baselineSince + 1 };
assert.throws(() => assertHistoryResponse([hole], validateHistoryProgress([covered()])), /unread/);
const legacy = { ...initial, windowSince: initial.baselineSince + 1, scannedThrough: initial.baselineSince + 1 };
delete legacy.coverage;
assert.throws(() => assertHistoryResponse([legacy], validateHistoryProgress([covered()])), /unread/);
const input = { binding: { accountId: 'a', accountVersion: 1, runtimeEpoch: '0:0', accountFingerprint: 'a', credentialGeneration: 'c' },
  identityVerified: true, stateCurrent: true, accountReady: true, entryAllowed: true, acquisition: acquisition(),
  minimumAcquisitionStart: now - 100, requiredSince: initial.baselineSince, now, historyExchange: 'krakenfutures',
  orders: [], positions: [], operations: [], unresolvedEvidence: 0, fillIdentityUnresolved: 0, foreignOrders: 0, foreignPositions: 0,
  blockingIncidents: [], reviewRequiredIntents: [], balanceVerified: true };
assert.equal(evaluateTradingSafety(input, 'accountRelease').safe, true);
assert.equal(evaluateTradingSafety({ ...input, acquisition: missing }, 'accountRelease').safe, false);
assert.equal(evaluateTradingSafety({ ...input, unresolvedEvidence: 1 }, 'accountRelease').safe, false,
  'Complete history is not ownership and cannot release unresolved execution evidence.');
console.log('Historical coverage: range continuity, provider binding, fresh acquisition and fail-closed release passed.');
