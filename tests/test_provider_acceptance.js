import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalProviderGrant, liveProviderAcceptancePinned, signedGrantValid } from '../src/provider_acceptance.js';

const account = {
  id: 'account-1', exchange: 'hyperliquid', mode: 'live',
  externalAccountId: 'a'.repeat(64), credentialGeneration: 'b'.repeat(64),
};

const canonicalVector = {
  accountId: 'account-1', credentialGeneration: 'b'.repeat(64), exchange: 'hyperliquid',
  externalAccountId: 'a'.repeat(64), mode: 'live', product: 'swap:linear', reviewId: 'review-1',
  validFrom: 1_700_000_000_000, validUntil: 1_700_000_060_000, version: 1,
};
assert.equal(createHash('sha256').update(canonicalProviderGrant(canonicalVector)).digest('hex'),
  'ea49c3dc78413a146c70a337c59f6a1f1b0ad8b193aa59a612983a007541e46f');
const fixture = JSON.parse(readFileSync(new URL('./fixtures/provider_acceptance_signature.json', import.meta.url), 'utf8'));
assert.equal(signedGrantValid({ grant: fixture.grant, signature: fixture.signature }, account,
  1_700_000_001_000, createPublicKey(fixture.reviewerPublicKeyPem)), true,
'The signed vector must verify with the same canonical bytes in Node and Python.');

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const at = canonicalVector.validFrom;
const signed = (grant) => ({ grant, signature: sign(null, canonicalProviderGrant(grant), privateKey).toString('base64') });
const valid = signed(canonicalVector);
const rejects = (label, row, targetAccount = account, now = at) => {
  assert.equal(signedGrantValid(row, targetAccount, now, publicKey), false, label);
};
assert.equal(signedGrantValid(valid, account, at, publicKey), true, 'The start of the grant is inclusive.');
rejects('The end of the grant is exclusive.', valid, account, canonicalVector.validUntil);
assert.equal(signedGrantValid(signed({ ...canonicalVector, product: 'future:inverse' }), account, at, publicKey), true,
  'A separately signed supported futures scope verifies.');
assert.equal(signedGrantValid({ grant: Object.fromEntries(Object.entries(canonicalVector).reverse()), signature: valid.signature },
  account, at, publicKey), true, 'Grant serialization is canonical regardless of property insertion order.');

for (const [label, row] of [
  ['null row', null],
  ['array row', []],
  ['missing signature', { grant: canonicalVector }],
  ['extra top-level field', { ...valid, issuer: 'operator' }],
  ['null grant', { ...valid, grant: null }],
  ['array grant', { ...valid, grant: [] }],
  ['extra grant field', signed({ ...canonicalVector, bypass: true })],
  ['missing grant field', signed(Object.fromEntries(Object.entries(canonicalVector).filter(([key]) => key !== 'product')))],
  ['unsupported grant version', signed({ ...canonicalVector, version: 2 })],
  ['non-live grant', signed({ ...canonicalVector, mode: 'testnet' })],
  ['unsupported product', signed({ ...canonicalVector, product: 'spot' })],
  ['invalid review ID', signed({ ...canonicalVector, reviewId: 'review 1' })],
  ['wrong account ID', signed({ ...canonicalVector, accountId: 'account-2' })],
  ['wrong exchange', signed({ ...canonicalVector, exchange: 'binance' })],
  ['wrong external account ID', signed({ ...canonicalVector, externalAccountId: 'c'.repeat(64) })],
  ['wrong credential generation', signed({ ...canonicalVector, credentialGeneration: 'c'.repeat(64) })],
  ['unsafe validity start', signed({ ...canonicalVector, validFrom: Number.MAX_SAFE_INTEGER + 1 })],
  ['fractional validity end', signed({ ...canonicalVector, validUntil: canonicalVector.validUntil + 0.5 })],
  ['validity beyond seven days', signed({ ...canonicalVector, validUntil: at + 8 * 86_400_000 })],
  ['malformed base64 signature', { ...valid, signature: 'invalid' }],
  ['non-string signature', { ...valid, signature: 17 }],
  ['tampered signature', { ...valid, signature: `${valid.signature[0] === 'A' ? 'B' : 'A'}${valid.signature.slice(1)}` }],
]) rejects(label, row);
rejects('A paper account cannot use a live grant.', valid, { ...account, mode: 'paper' });
rejects('An empty external account ID cannot use a signed grant.', valid, { ...account, externalAccountId: '' });
rejects('A malformed external account ID cannot use a signed grant.', valid, { ...account, externalAccountId: 'not-hex' });
rejects('An empty credential generation cannot use a signed grant.', valid, { ...account, credentialGeneration: '' });
rejects('A malformed credential generation cannot use a signed grant.', valid,
  { ...account, credentialGeneration: 'not-hex' });
rejects('A grant cannot be used before its start.', valid, account, at - 1);
assert.equal(signedGrantValid(valid, account, at, createPublicKey(fixture.reviewerPublicKeyPem)), false,
  'A valid signature from another reviewer must not authorize this grant.');

assert.equal(liveProviderAcceptancePinned(account), false, 'No independent reviewer key is pinned.');
assert.equal(liveProviderAcceptancePinned({ ...account, mode: 'testnet' }), true,
  'Testnet remains available for obtaining real provider acceptance evidence.');
assert.equal(liveProviderAcceptancePinned({ ...account, mode: 'paper' }), true);
const beforeKey = process.env.PROVIDER_ACCEPTANCE_REVIEWER_KEY_FILE;
const beforeGrants = process.env.PROVIDER_ACCEPTANCE_GRANTS_FILE;
try {
  process.env.PROVIDER_ACCEPTANCE_REVIEWER_KEY_FILE = '/operator/controlled/key.pem';
  process.env.PROVIDER_ACCEPTANCE_GRANTS_FILE = '/operator/controlled/grants.json';
  assert.equal(liveProviderAcceptancePinned(account), false,
    'Operator file paths cannot replace the independently pinned reviewer key.');
} finally {
  if (beforeKey === undefined) delete process.env.PROVIDER_ACCEPTANCE_REVIEWER_KEY_FILE;
  else process.env.PROVIDER_ACCEPTANCE_REVIEWER_KEY_FILE = beforeKey;
  if (beforeGrants === undefined) delete process.env.PROVIDER_ACCEPTANCE_GRANTS_FILE;
  else process.env.PROVIDER_ACCEPTANCE_GRANTS_FILE = beforeGrants;
}
console.log('Provider acceptance control-plane gate tests passed.');
