import assert from 'node:assert/strict';
const risk = await import('../src/trading_risk_reservations.js');

const market = { version: 1, source: 'paper-contract-v1', providerSymbol: 'BTCUSDT', settlementAsset: 'USDT', linear: true, quantityUnit: 'base' };
const base = { side: 'LONG', ownedQuantity: '2', averageEntryPrice: '100', markPrice: '95', stopPrice: '90',
  reportingCurrency: 'USDT', market, entries: [], protectionProven: true };
const entry = { id: 'entry-1', generation: 0, status: 'partially_filled', quantity: '5', filledQuantity: '2',
  price: '101', operationUnresolved: false };
const cases = [
  ['open loss', {}, '0', '10', '0', '20'],
  ['filled plus pending', { entries: [entry] }, '3', '10', '33', '20'],
  ['cancel pending is still risk', { entries: [{ ...entry, status: 'cancel_pending' }] }, '3', '10', '33', '20'],
  ['terminal cancel releases only residual', { entries: [{ ...entry, status: 'cancelled' }] }, '0', '10', '0', '20'],
  ['stop tightened', { stopPrice: '94' }, '0', '2', '0', '12'],
  ['stop in profit still protects current gains', { markPrice: '120', stopPrice: '110' }, '0', '20', '0', '0'],
  ['short adverse move', { side: 'SHORT', markPrice: '105', stopPrice: '110' }, '0', '10', '0', '20'],
  ['short pending worst allowed price', { side: 'SHORT', markPrice: '105', stopPrice: '110', entries: [{ ...entry, price: '99' }] }, '3', '10', '33', '20'],
  ['new bounded candidate', { ownedQuantity: '0', markPrice: null, averageEntryPrice: null,
    entries: [{ ...entry, quantity: '10', filledQuantity: '0', status: 'created' }] }, '10', '0', '110', '0'],
];
for (const [label, override, pendingQuantity, ownedRisk, pendingRisk, actualFillRisk] of cases) {
  const result = risk.calculateRiskReservation({ ...base, ...override });
  assert.equal(result.status, 'complete', label);
  assert.equal(result.pendingQuantity, pendingQuantity, label);
  assert.equal(result.markToStopRisk, ownedRisk, label);
  assert.equal(result.pendingEntryRisk, pendingRisk, label);
  assert.equal(result.actualFillToStopRisk, actualFillRisk, label);
}
for (const override of [
  { market: null }, { market: { ...market, settlementAsset: 'USDC' } }, { markPrice: null }, { protectionProven: false },
  { entries: [{ ...entry, status: 'cancelled', operationUnresolved: true }] }, { entries: [{ ...entry, filledQuantity: null }] },
  { entries: [{ ...entry, price: null }] },
  { entries: [{ ...entry, status: 'filled' }] },
]) {
  const result = risk.calculateRiskReservation({ ...base, ...override });
  assert.equal(result.status, 'unresolved');
  assert.equal(result.additionalRisk, null, 'Unproven risk must not become zero.');
}
assert.deepEqual(risk.calculateDailyRisk({ budget: '30', ledgerPnl: '-1', unrealizedPnl: '-10', existingCommitment: '10', candidateCommitment: '9' }),
  { dayPnl: '-11', consumedLoss: '11', existingCommitment: '10', candidateCommitment: '9', totalCommitment: '30', budget: '30', allowed: true });
assert.equal(risk.calculateDailyRisk({ budget: '30', ledgerPnl: '-1', unrealizedPnl: '-10', existingCommitment: '10', candidateCommitment: '9.000000000000000001' }).allowed, false);
assert.equal(risk.calculateDailyRisk({ budget: '100', ledgerPnl: '19.25', unrealizedPnl: '-10', existingCommitment: '20', candidateCommitment: '80' }).allowed, true);
assert.equal(risk.calculateDailyRisk({ budget: '100', ledgerPnl: '-50', unrealizedPnl: '0', existingCommitment: '0', candidateCommitment: '49.05' }).allowed, true);
assert.equal(risk.calculateDailyRisk({ budget: '100', ledgerPnl: '-51', unrealizedPnl: '0', existingCommitment: '0', candidateCommitment: '49.05' }).allowed, false);
const now = Date.UTC(2026, 8, 2, 23, 59, 59);
const proof = { observedAt: now, expiresAt: now + 60000, utcDay: new Date(now).setUTCHours(0, 0, 0, 0) };
assert.doesNotThrow(() => risk.assertRiskFresh(proof, now));
assert.throws(() => risk.assertRiskFresh(proof, now + 1000), /UTC|stale/i);
assert.throws(() => risk.assertRiskFresh(proof, now - 1001), /future|stale/i);
console.log('Exact dynamic reserve table, non-double-counted loss, uncertain residuals and UTC expiry passed.');
