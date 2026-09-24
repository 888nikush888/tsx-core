import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPublicKey } from 'node:crypto';
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
