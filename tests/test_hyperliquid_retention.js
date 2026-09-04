import assert from 'node:assert/strict';
import { assertHistoryResponse, validateHistoryCheckpoint, validateHistoryProgress } from '../src/exchange_history_contract.js';
import { fillCoverageReason } from '../src/exchange_history_coverage.js';

const now = Date.now();
const probe = { version: 1, phase: 'scan', originalSince: now - 1000, originalUntil: now - 100,
  startedAt: now - 90, fixedUntil: now - 50, cursor: now - 500, count: 2000, validatedAt: null,
  anchor: { coin: 'BTC', tid: '123', time: now - 900, payloadHash: 'a'.repeat(64) } };
const initial = { source: 'fills', providerSymbol: null, revision: 1, baselineSince: now - 1000,
  windowSince: now - 1000, windowUntil: now - 100, cursor: String(now - 200), scannedThrough: null,
  nextReadAt: 0, completeness: 'unknown', reason: 'retention_probe_pending', coverage: null, retention: probe };
assert.deepEqual(validateHistoryCheckpoint(initial).retention, probe, 'The restart checkpoint must retain the exact bounded probe.');
const update = (retention, pages = 1) => ({ baseRevision: 1, pages, checkpoint: { ...initial, revision: 2, retention } });
assertHistoryResponse([initial], validateHistoryProgress([update(probe, 0)]));
for (const change of [{ count: 2001 }, { phase: 'verify' }, { fixedUntil: now }, { anchor: { ...probe.anchor, tid: '456' } }]) {
  assert.throws(() => assertHistoryResponse([initial], validateHistoryProgress([update({ ...probe, ...change }, 0)])), /retention|unread/i);
}
for (const change of [{ version: 2 }, { secret: 'not-allowlisted' }, { count: 10000 }, { cursor: now + 1 },
  { fixedUntil: probe.originalUntil - 1 }, { validatedAt: now }, { anchor: { ...probe.anchor, payloadHash: 'x' } }]) {
  assert.throws(() => validateHistoryCheckpoint({ ...initial, retention: { ...probe, ...change } }), /retention/i);
}
for (const change of [{ count: 1999 }, { cursor: probe.cursor - 1 }, { fixedUntil: now },
  { startedAt: probe.startedAt + 1 }, { anchor: { ...probe.anchor, tid: '456' } },
  { phase: 'proved', validatedAt: now - 5 }]) {
  assert.throws(() => assertHistoryResponse([initial], validateHistoryProgress([update({ ...probe, ...change })])), /retention/i);
}
assert.throws(() => validateHistoryCheckpoint({ ...initial, source: 'orders' }), /retention/i);
assert.throws(() => validateHistoryCheckpoint({ ...initial, cursor: '界'.repeat(4096) }), /Oversized/);
assertHistoryResponse([initial], validateHistoryProgress([update(null)])); // A failed anchor discards, never certifies.
assertHistoryResponse([initial], validateHistoryProgress([update({ ...probe, phase: 'verify' })]));
const proved = { ...probe, phase: 'proved', validatedAt: now - 5 };
const final = { ...initial, revision: 2, windowUntil: null, windowSince: now - 1000, cursor: null,
  scannedThrough: now - 100, completeness: 'complete', reason: null, retention: proved,
  coverage: { version: 1, profile: 'hyperliquid_retained_fills_v1', since: initial.baselineSince, through: now - 100 } };
const evidence = { version: 1, startedAt: now - 110, completedAt: now, sources: [], checkedOrders: [],
  history: [{ baseRevision: 1, pages: 1, checkpoint: final }] };
const verify = { ...initial, retention: { ...probe, phase: 'verify' } };
assertHistoryResponse([verify], validateHistoryProgress(evidence.history));
assert.throws(() => assertHistoryResponse([verify], validateHistoryProgress([{ ...evidence.history[0],
  checkpoint: { ...final, scannedThrough: now, coverage: { ...final.coverage, through: now } } }])), /retention/i);
assert.equal(fillCoverageReason('hyperliquid', evidence, initial.baselineSince), null);
assert.equal(fillCoverageReason('hyperliquid', { ...evidence, startedAt: now - 1 }, initial.baselineSince), 'FILL_COVERAGE_NOT_FRESH');
assert.equal(fillCoverageReason('hyperliquid', { ...evidence, history: [{ ...evidence.history[0],
  checkpoint: { ...final, retention: { ...proved, validatedAt: now - 200 } } }] }, initial.baselineSince), 'FILL_COVERAGE_NOT_FRESH');
console.log('Hyperliquid retention: bounded persistence, restart continuity and horizon/validation freshness passed.');
