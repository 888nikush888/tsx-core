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
const recent = nativeFillFixture('krakenfutures', fill);
delete recent.raw.info.identitySource;
assert.equal(provenFillIdentity(account('krakenfutures'), recent), null, 'Recent fill_id is not an execution.uid alias.');
const hl = nativeFillFixture('hyperliquid', fill);
assert.throws(() => validateFillIdentity({ ...hl.identity, scopeTimestamp: null }));
assert.equal(provenFillIdentity(account('hyperliquid'), { ...hl, filledAt: 2001 }), null, 'Local time cannot substitute for provider time.');
console.log('Fill identity profiles, native originals, account scope and timestamp distinctions passed.');
