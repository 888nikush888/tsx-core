import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateOpenState } from '../src/exchange_contract_validation.js';
import { fillQuantityDigest } from '../src/trading_fill_quantity_contract.js';
import { quantityFill, quantityHash } from './fixtures/fill_quantity.js';

function checked(fill) { return validateOpenState({ orders: [], positions: [], fills: [fill], observedAt: Date.now(), accountFingerprint: 'a'.repeat(64) }).fills[0]; }
const original = quantityFill();
const hashDomain = 'kraken-normalization-original-v1';
assert.equal(fillQuantityDigest(hashDomain, { '2': 2, '10': 10, '\u{1F600}': 'supplementary', '\uE000': 'bmp' }),
  createHash('sha256').update(`${hashDomain}\n{"10":10,"2":2,"\uE000":"bmp","\u{1F600}":"supplementary"}`).digest('hex'),
  'Canonical JSON must not use JavaScript integer-key enumeration or UTF16 ordering.');
for (const unsafe of [undefined, 0.25, Number.MAX_SAFE_INTEGER + 1, '\ud800', { bad: '\udfff' }]) {
  assert.throws(() => fillQuantityDigest(hashDomain, unsafe));
}
assert.deepEqual(checked(original).quantityNormalization, original.quantityNormalization);
const invalid = [
  value => { value.quantityNormalization = null; },
  value => { value.quantityNormalization.version = 2; },
  value => { value.quantityNormalization.source = 'guessed'; },
  value => { value.quantityNormalization.inputUnit = 'base'; },
  value => { value.quantityNormalization.outputUnit = 'contracts'; },
  value => { value.quantityNormalization.inputField = 'positionSize'; },
  value => { value.quantityNormalization.inputQuantity = '5'; },
  value => { value.quantityNormalization.outputQuantity = '2'; },
  value => { value.quantityNormalization.originalExecutionHash = 'a'.repeat(64); },
  value => { value.quantityNormalization.market.sourceHash = 'a'.repeat(64); },
  value => { value.quantityNormalization.nativeIdentity.providerFillId = 'foreign'; },
  value => { value.quantityNormalization.nativeIdentity.providerMarketId = 'PF_ETHUSD'; },
  value => { value.quantityNormalization.market.providerMarketId = 'PF_ETHUSD'; },
  value => { value.quantityNormalization.market.settlementAsset = 'USDT'; },
  value => { value.quantityNormalization.market.contract = false; },
  value => { value.quantityNormalization.market.inverse = true; },
  value => { value.quantityNormalization.market.observedAt = Date.now(); },
  value => { value.quantityNormalization.market.providerOriginalStatus = 'exact-token-bound'; },
  value => { value.quantityNormalization.market.providerContractSize = '0.25'; },
  value => { value.quantityNormalization.arithmetic.exactProduct = false; },
  value => { value.quantityNormalization.arithmetic.decimalPrecision = 0; },
  value => { value.quantityNormalization.arithmetic.decimalRounding = 'probably'; },
  value => { value.quantityNormalization.normalizedAt = Date.now() + 120000; },
  value => { value.quantityNormalization.secret = 'MUST_NOT_PERSIST'; },
  value => { value.raw.info.accountUid = 'different-original'; },
  value => { delete value.identity; },
  ...[null, true, '-1', '0', '1e2', '0.25 ', '1'.repeat(100)].map(factor => value => { value.quantityNormalization.appliedFactor = factor; }),
];
for (const change of invalid) {
  const fill = structuredClone(original); change(fill);
  assert.throws(() => checked(fill), `Contradictory normalization must be rejected: ${String(change)}`);
}
for (const [input, factor, output] of [['4', '1', '4'], ['4', '2.5', '10'], ['0.2', '0.25', '0.05']]) {
  assert.equal(checked(quantityFill(input, factor, output)).quantity, output);
}
const rounded = quantityFill('12345678901234567890.12345679', '0.25', '3086419725308641972.530864198');
rounded.quantityNormalization.arithmetic.exactProduct = false;
assert.equal(checked(rounded).quantityNormalization.arithmetic.exactProduct, false, 'Observed rounding is retained, not changed into an exact provider proof.');
rounded.quantityNormalization.arithmetic.exactProduct = true;
assert.throws(() => checked(rounded));
const floatOriginal = quantityFill(); floatOriginal.raw.amount = 4.1;
floatOriginal.quantityNormalization.originalExecutionHash = quantityHash('kraken-normalization-original-v1', floatOriginal.raw);
assert.throws(() => checked(floatOriginal), 'Already rounded JSON floats cannot be authenticated as exact native decimal strings.');
const legacy = structuredClone(original); delete legacy.quantityNormalization;
assert.equal(checked(legacy).quantityNormalization, undefined, 'An absent historical observation is not invented.');
console.log('Fill quantity normalization contracts: original/hash/identity binding, exact versus rounded arithmetic, invalid fields and legacy absence passed.');
