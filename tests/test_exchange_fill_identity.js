import assert from 'node:assert/strict';
import { provenFillIdentity, validateFillIdentity } from '../src/trading_fill_identity.js';
import { nativeFillFixture } from './fixtures/native_fill_identity.js';

const account = exchange => ({ id: 'fixture-account', exchange, mode: 'testnet', externalAccountId: 'a'.repeat(64) });
const fill = { exchangeFillId: '123', clientOrderId: 'own', exchangeOrderId: '456', providerSymbol: 'BTC/USDC:USDC', symbol: 'BTCUSDT',
  price: '100', quantity: '1', fee: '0', feeAsset: 'USDC', filledAt: 1000, raw: {} };
for (const exchange of ['bybit', 'hyperliquid', 'krakenfutures']) {
  const original = nativeFillFixture(exchange, fill);
  const proof = provenFillIdentity(account(exchange), original);
  assert.ok(proof, `${exchange} actual native profile is positively identified.`);
  assert.notEqual(proof.key, provenFillIdentity({ ...account(exchange), externalAccountId: 'b'.repeat(64) }, original).key);
  assert.equal(provenFillIdentity(account(exchange), { ...original, identity: undefined }), null, 'Missing original source profile cannot become a canonical fill.');
  assert.equal(provenFillIdentity(account(exchange), { ...original, raw: {} }), null);
  assert.equal(provenFillIdentity(account(exchange), { ...original, exchangeOrderId: 'other' }), null);
  assert.throws(() => validateFillIdentity({ ...original.identity, unknown: true }));
  const later = nativeFillFixture(exchange, { ...fill, filledAt: 2000 });
  if (exchange === 'hyperliquid') assert.notEqual(provenFillIdentity(account(exchange), later).key, proof.key);
  else assert.equal(provenFillIdentity(account(exchange), later).key, proof.key, 'Bybit/Kraken timestamp changes remain payload conflicts on the same native ID.'); // gitleaks:allow
}
const identifierFixture = nativeFillFixture('bybit', fill).identity;
for (const field of ['providerMarketId', 'providerSymbol', 'providerFillId']) {
  for (let unit = 0; unit < 32; unit += 1) {
    assert.throws(() => validateFillIdentity({ ...identifierFixture, [field]: `a${String.fromCodePoint(unit)}b` }),
      /FILL_IDENTITY_UNPROVEN: missing exact provider identifier/u);
  }
  for (const value of ['a b', 'a\u007fb', 'a\u0085b', 'a\u00a0b', 'a😀b', 'a\ud800b']) {
    assert.equal(validateFillIdentity({ ...identifierFixture, [field]: value })[field], value,
      'Only C0 controls are forbidden inside a fill identifier; accepted bytes must not be normalized.');
  }
}
const recent = nativeFillFixture('krakenfutures', fill);
delete recent.raw.info.identitySource;
assert.equal(provenFillIdentity(account('krakenfutures'), recent), null, 'Recent fill_id is not an execution.uid alias.');
const hl = nativeFillFixture('hyperliquid', fill);
assert.throws(() => validateFillIdentity({ ...hl.identity, scopeTimestamp: null }));
assert.equal(provenFillIdentity(account('hyperliquid'), { ...hl, filledAt: 2001 }), null, 'Local time cannot substitute for provider time.');

for (const timestamp of [0, 1000, Number.MAX_SAFE_INTEGER]) {
  for (const nativeTime of [timestamp, String(timestamp)]) {
    const original = nativeFillFixture('bybit', { ...fill, filledAt: timestamp });
    original.raw.info.execTime = nativeTime;
    assert.ok(provenFillIdentity(account('bybit'), original), 'Exact native timestamp strings and safe integers remain supported.');
  }
}

function assertUnprovedNativeScalar(exchange, field, value, normalized = {}) {
  const original = nativeFillFixture(exchange, { ...fill, ...normalized });
  original.raw.info[field] = value;
  const before = { ...original.raw.info };
  assert.equal(provenFillIdentity(account(exchange), original), null, `${exchange}.${field} must prove an original scalar without coercion.`);
  assert.deepEqual(original.raw.info, before, 'Rejected evidence must retain its native originals.');
}

let coercions = 0;
const disguised = expected => ({ toString() { coercions += 1; return expected; } });
for (const value of [[1000], disguised('1000'), Object(1000), true, false, null, undefined,
  1000n, Symbol('1000'), () => 1000, NaN, Infinity, -1, 1000.5, '01000', ' 1000', '1000 ', '1e3', '1000.0']) {
  assertUnprovedNativeScalar('bybit', 'execTime', value);
}
for (const [field, normalizedField, expected] of [['tid', 'exchangeFillId', '123'], ['oid', 'exchangeOrderId', '456']]) {
  for (const value of [[Number(expected)], disguised(expected), Object(expected), null, undefined, Symbol(expected), () => expected, ` ${expected}`, `${expected} `]) {
    assertUnprovedNativeScalar('hyperliquid', field, value);
  }
  for (const value of [true, false, 123n, NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1,
    '+123', '1e3', '123.0', '\u0661\u0662\u0663', '\uff11\uff12\uff13']) {
    assertUnprovedNativeScalar('hyperliquid', field, value, { [normalizedField]: String(value) });
  }
  for (const value of [0, -0, Number.MAX_SAFE_INTEGER, '0', '0001', '9007199254740993', '0'.repeat(256)]) {
    const original = nativeFillFixture('hyperliquid', { ...fill, [normalizedField]: String(value) });
    original.raw.info[field] = value;
    assert.ok(provenFillIdentity(account('hyperliquid'), original), 'Exact digit spelling and safe integers remain supported.');
  }
}
for (const value of ['0'.repeat(257), '123\n']) {
  const original = nativeFillFixture('hyperliquid', { ...fill, exchangeFillId: value });
  original.raw.info.tid = value;
  assert.throws(() => provenFillIdentity(account('hyperliquid'), original),
    /FILL_IDENTITY_UNPROVEN: missing exact provider identifier/u,
    'Malformed canonical fill identifiers must fail before native proof comparison.');
  assertUnprovedNativeScalar('hyperliquid', 'oid', value, { exchangeOrderId: value });
}
assert.equal(coercions, 0, 'Native evidence objects must never execute coercion hooks.');
assertUnprovedNativeScalar('hyperliquid', 'oid', null, { exchangeOrderId: null });
console.log('Fill identity profiles, native originals, account scope and timestamp distinctions passed.');
