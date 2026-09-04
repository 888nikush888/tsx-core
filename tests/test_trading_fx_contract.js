import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFxLegReceipt, fxEvidenceDigest } from '../src/trading_fx_contract.ts';
import { deriveFxConversion, assertFxConversionFresh } from '../src/trading_fx_quotes.ts';
import { fxReceipt, sealFxReceipt, FX_CONTEXT } from './fixtures/fx_receipts.js';

const at = Date.now() - 100;
const receipts = [fxReceipt('usd', at - 50), fxReceipt('usdt', at), fxReceipt('usdc', at - 20)];
for (const receipt of receipts) assert.deepEqual(validateFxLegReceipt(receipt, FX_CONTEXT), receipt);
const conversion = (base, quote = 'USD', time = at, rows = receipts) => deriveFxConversion(rows, base, quote, time, FX_CONTEXT);
const usdt = conversion('USDT');
assert.deepEqual(usdt.rate, { numerator: '400', denominator: '401' });
assert.equal(usdt.earliestAt, at - 50);
assert.equal(usdt.latestAt, at);
assert.equal(usdt.expiresAt, at - 50 + 10000);
assert.deepEqual(usdt.receiptHashes, receipts.slice(0, 2).map(row => row.receiptHash));
assert.equal(usdt.valuationBasis, 'provider_snapshot_index_asof');
assert.deepEqual(conversion('USDC').rate, { numerator: '501', denominator: '500' });
assert.deepEqual(conversion('USD', 'USDT').rate, { numerator: '401', denominator: '400' });
assert.deepEqual(conversion('USDT', 'USDC').rate, { numerator: '200000', denominator: '200901' });
assert.equal(assertFxConversionFresh(usdt, at), undefined);
assert.equal(assertFxConversionFresh(usdt, usdt.expiresAt), undefined);
assert.throws(() => assertFxConversionFresh(usdt, usdt.expiresAt + 1), /FX/);
assert.throws(() => assertFxConversionFresh(usdt, usdt.latestAt - 1), /FX/);
assert.throws(() => assertFxConversionFresh({ ...usdt, rate: { numerator: '1', denominator: '1' } }, at), /FX/);
for (const pair of [['BNB', 'USD'], ['USD', 'EUR'], ['USDT', 'USDT']]) assert.throws(() => conversion(...pair), /FX/);
assert.throws(() => conversion('USDT', 'USD', at - 1), /FX/);
assert.throws(() => conversion('USDT', 'USD', at + 10001), /FX/);
assert.throws(() => conversion('USDT', 'USD', at, receipts.slice(0, 1)), /FX/);
assert.throws(() => conversion('USDT', 'USD', at, [fxReceipt('usd', at - 1001), receipts[1]]), /FX/);
assert.deepEqual(conversion('USDT', 'USD', at, [fxReceipt('usd', at - 1000), receipts[1]]).rate, usdt.rate);
// Pick the newest coherent original pair, not merely the newest independent legs.
const earlier = [fxReceipt('usd', at - 2000), fxReceipt('usdt', at - 1990), fxReceipt('usd', at)];
assert.equal(conversion('USDT', 'USD', at, earlier).latestAt, at - 1990);
assert.deepEqual(conversion('USDT', 'USD', at, [...receipts, receipts[0]]), usdt);
assert.deepEqual(conversion('USDT', 'USD', at, [...receipts].reverse()), usdt);

const different = structuredClone(receipts[0]);
different.value = '59000'; different.envelope.result.list[0].indexPrice = different.value;
assert.throws(() => conversion('USDT', 'USD', at, [...receipts, sealFxReceipt(different)]), /FX.*CONFLICT/);
for (const delta of [
  { provider: 'krakenfutures' }, { origin: 'https://api.bybit.com' }, { origin: 'https://api-testnet.bybit.com.evil.invalid' },
  { mode: 'paper' }, { source: 'last-price' }, { endpoint: '/v5/market/kline' }, { version: 2 }, { profileVersion: 0 },
  { ccxtVersion: '4.5.76' }, { profileHash: 'b'.repeat(64) }, { providerQuoteAt: at }, { timeBasis: 'local_received' },
  { category: 'spot' }, { symbol: 'ETHUSD' }, { field: 'markPrice' }, { value: '1' }, { value: ' 60000' },
  { routeId: 'dynamic' }, { legId: 'unknown' }, { startedAt: at + 11 }, { completedAt: at + 10000 },
  { providerResponseAt: at - 1001 }, { startedAt: at - 20000 }, { completedAt: Date.now() + 5000 },
  { extra: true }, { receiptHash: '0'.repeat(64) }, { envelopeHash: '0'.repeat(64) },
]) assert.throws(() => validateFxLegReceipt({ ...receipts[0], ...delta }, FX_CONTEXT), /FX/);

// Rehash manipulated originals: rejection must not rely solely on a stale hash.
for (const delta of [{ symbol: 'ETHUSD' }, { category: 'spot' }, { mode: 'live' }, { profileHash: 'b'.repeat(64) },
  { providerQuoteAt: at }, { value: '0' }, { value: '-1' }, { value: '1e0' }, { startedAt: at + 100 },
  { completedAt: at + 20000 }, { providerResponseAt: at - 10000 }, { endpoint: '/v5/market/kline' }]) {
  assert.throws(() => validateFxLegReceipt(sealFxReceipt({ ...receipts[0], ...delta }), FX_CONTEXT), /FX/);
}

for (const mutate of [
  row => { row.envelope.retCode = 10001; },
  row => { row.envelope.result.category = 'spot'; },
  row => { row.envelope.result.list = []; },
  row => { row.envelope.result.list.push({ ...row.envelope.result.list[0] }); },
  row => { row.envelope.result.list[0].symbol = 'ETHUSD'; },
  row => { row.envelope.result.list[0].indexPrice = 60000; },
  row => { row.envelope.time = String(at); },
]) {
  const row = structuredClone(receipts[0]); mutate(row);
  assert.throws(() => validateFxLegReceipt(sealFxReceipt(row), FX_CONTEXT), /FX/);
}
for (const original of [undefined, NaN, 0.1, Infinity, '\ud800', 'x'.repeat(32768), { long: 'x'.repeat(65536) }]) {
  assert.throws(() => fxEvidenceDigest('bybit-fx-envelope-v1', original), /FX/);
}
// Only dense retained JSON arrays are accepted; holes must not collide with an empty array.
for (const data of [Array(1), Array(300), Object.assign(Array(3), { 0: 1, 2: 3 }), Object.assign([1], { extra: true })]) {
  assert.throws(() => fxEvidenceDigest('bybit-fx-envelope-v1', { data }), /FX/);
}
for (const key of ['\u0080', '\u009f', '🟢'.repeat(257)]) {
  assert.throws(() => fxEvidenceDigest('bybit-fx-envelope-v1', { [key]: true }), /FX/);
}
assert.match(fxEvidenceDigest('bybit-fx-envelope-v1', { ['🟢'.repeat(256)]: true }), /^[a-f0-9]{64}$/);
assert.match(fxEvidenceDigest('bybit-fx-envelope-v1', { '': true }), /^[a-f0-9]{64}$/, 'Retained JSON permits an empty metadata key.');
// The envelope has its own 64-KiB limit; bounded receipt metadata may add to it.
const largeEnvelope = { first: 'x'.repeat(32000), second: 'y'.repeat(32000) };
assert.match(fxEvidenceDigest('bybit-fx-envelope-v1', largeEnvelope), /^[a-f0-9]{64}$/);
assert.match(fxEvidenceDigest('bybit-fx-receipt-v1', { envelope: largeEnvelope, metadata: 'z'.repeat(2000) }), /^[a-f0-9]{64}$/);
assert.throws(() => fxEvidenceDigest('bybit-fx-envelope-v1', { ...largeEnvelope, metadata: 'z'.repeat(2000) }), /FX/);
assert.throws(() => deriveFxConversion(Array(257).fill(receipts[0]), 'USDT', 'USD', at, FX_CONTEXT), /FX/);
assert.throws(() => conversion('USDT', 'USD', Infinity), /FX/);

// The real Python producer uses pinned CCXT with its entire HTTP transport replaced by fixtures.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const emitted = spawnSync(process.env.TSX_TEST_PYTHON || 'python', ['-B', path.join(root, 'exchange_executor/tests/fx_evidence_fixture.py')], {
  cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 512000, windowsHide: true,
  env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP,
    PYTHONNOUSERSITE: '1', PYTHONIOENCODING: 'utf-8' },
});
assert.ifError(emitted.error); assert.equal(emitted.status, 0, emitted.stderr);
const progress = JSON.parse(emitted.stdout);
assert.equal(progress.receipts.length, 3);
const sdkContext = { mode: 'live', profileHash: '8d05406f0f117f751a4b664eb81f7c464f8f8598bd97550c3daaf52f6f285f9a' };
for (const row of progress.receipts) assert.deepEqual(validateFxLegReceipt(row, sdkContext), row);
const sdkAt = Math.max(...progress.receipts.map(row => row.providerResponseAt));
assert.deepEqual(deriveFxConversion(progress.receipts, 'USDT', 'USD', sdkAt, sdkContext).rate, usdt.rate);
assert.deepEqual(deriveFxConversion(progress.receipts, 'USDC', 'USD', sdkAt, sdkContext).rate, { numerator: '10003', denominator: '10000' });
console.log('Fixed stablecoin FX legs, source/time/origin binding and exact bounded-as-of conversion passed.');
