import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import fs, { readFileSync, mkdtempSync, writeFileSync, rmSync, linkSync, symlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonicalProviderGrant, liveProviderAcceptancePinned, signedGrantValid, readProviderAcceptanceFile } from '../src/provider_acceptance.js';

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

const unicodeFixture = JSON.parse(readFileSync(new URL('./fixtures/provider_acceptance_unicode.json', import.meta.url), 'utf8'));
for (const vector of unicodeFixture.vectors) {
  const unicodeAccount = { ...account, id: vector.grant.accountId };
  assert.equal(canonicalProviderGrant(vector.grant).toString('ascii'), vector.canonical);
  assert.equal(signedGrantValid(vector, unicodeAccount, at, createPublicKey(unicodeFixture.reviewerPublicKeyPem)), false,
    'Vector metadata must not become an extra signed document field.');
  assert.equal(signedGrantValid({ grant: vector.grant, signature: vector.signature }, unicodeAccount,
    at, createPublicKey(unicodeFixture.reviewerPublicKeyPem)), true);
}
const astralGrant = { ...canonicalVector, accountId: 'account-\u{1f600}-\u{10ffff}' };
assert.ok(canonicalProviderGrant(astralGrant).toString('ascii').includes('account-\\ud83d\\ude00-\\udbff\\udfff'),
  'Each astral code point must encode both UTF-16 units in Python-compatible ASCII JSON.');
const collisionGrant = { ...canonicalVector, accountId: '\u0161ccount-1' };
assert.notDeepEqual(canonicalProviderGrant(collisionGrant), canonicalProviderGrant(canonicalVector));
rejects('A Unicode account alias cannot reuse the original signature.',
  { ...valid, grant: collisionGrant }, { ...account, id: collisionGrant.accountId });
for (const field of ['accountId', 'exchange', 'externalAccountId', 'credentialGeneration', 'mode', 'product', 'reviewId']) {
  for (const value of [1, [canonicalVector[field]], null, '\ud800', 'trailing\n']) {
    rejects(`Strict string field: ${field}`, signed({ ...canonicalVector, [field]: value }));
  }
}

const evidenceDirectory = mkdtempSync(path.join(os.tmpdir(), 'provider-file-boundary-'));
const evidenceFile = path.join(evidenceDirectory, 'grant.json');
const restoreFilesystem = (name, replacement, operation) => {
  const original = fs[name];
  fs[name] = replacement(original);
  syncBuiltinESMExports();
  try { operation(); } finally { fs[name] = original; syncBuiltinESMExports(); }
};
try {
  writeFileSync(evidenceFile, 'valid');
  assert.equal(readProviderAcceptanceFile(evidenceFile, 5).toString(), 'valid');
  assert.throws(() => readProviderAcceptanceFile(evidenceFile, 4));
  assert.throws(() => readProviderAcceptanceFile('relative', 5));
  assert.throws(() => readProviderAcceptanceFile(evidenceDirectory, 5));
  const linked = path.join(evidenceDirectory, 'hardlink');
  linkSync(evidenceFile, linked);
  assert.throws(() => readProviderAcceptanceFile(evidenceFile, 5));
  rmSync(linked);
  const directoryLink = path.join(evidenceDirectory, 'parent-link');
  symlinkSync(evidenceDirectory, directoryLink, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => readProviderAcceptanceFile(path.join(directoryLink, 'grant.json'), 5));
  rmSync(directoryLink);
  if (process.platform !== 'win32') {
    const symbolic = path.join(evidenceDirectory, 'symlink');
    symlinkSync(evidenceFile, symbolic);
    assert.throws(() => readProviderAcceptanceFile(symbolic, 5));
    const fifo = path.join(evidenceDirectory, 'fifo');
    assert.equal(spawnSync('mkfifo', [fifo], { timeout: 5000 }).status, 0);
    restoreFilesystem('openSync', () => () => { throw new Error('Special file must be rejected before open'); }, () => {
      assert.throws(() => readProviderAcceptanceFile(fifo, 5), /bounded regular single-link/);
    });
  }
  restoreFilesystem('lstatSync', original => (target, options) => {
    const stat = original(target, options);
    if (target === evidenceFile) stat.isFile = () => false;
    return stat;
  }, () => restoreFilesystem('openSync', () => () => { assert.fail('A nonregular file must not be opened.'); }, () => {
    assert.throws(() => readProviderAcceptanceFile(evidenceFile, 5), /bounded regular single-link/);
  }));
  let descriptor = null;
  restoreFilesystem('openSync', original => (...args) => { descriptor = original(...args); return descriptor; }, () => {
    restoreFilesystem('readSync', original => (...args) => {
      writeFileSync(evidenceFile, 'longer-than-the-bound');
      return original(...args);
    }, () => assert.throws(() => readProviderAcceptanceFile(evidenceFile, 5), /size changed/));
    assert.equal(typeof descriptor, 'number', 'The failed read must have opened a descriptor.');
    assert.throws(() => fs.fstatSync(descriptor), /bad file descriptor|EBADF/i, 'Failure closes the opened descriptor.');
  });
  writeFileSync(evidenceFile, 'valid');
  let replaced = false;
  restoreFilesystem('readSync', original => (...args) => {
    const count = original(...args);
    if (!replaced) {
      replaced = true;
      const replacement = path.join(evidenceDirectory, 'replacement-after-read');
      writeFileSync(replacement, 'valid');
      fs.renameSync(replacement, evidenceFile);
    }
    return count;
  }, () => assert.throws(() => readProviderAcceptanceFile(evidenceFile, 5), error =>
    process.platform === 'win32' ? error.code === 'EPERM' : /changed during/.test(error.message)));
  restoreFilesystem('fstatSync', original => (...args) => {
    const stat = original(...args);
    return Object.assign(stat, { ino: stat.ino + 1n });
  }, () => assert.throws(() => readProviderAcceptanceFile(evidenceFile, 5), /changed during/));
  restoreFilesystem('lstatSync', original => (target, options) => {
    const stat = original(target, options);
    if (target === evidenceFile && options?.bigint) {
      // Replace the directory entry after the pre-open snapshot; the open sees a different inode.
      const replacement = path.join(evidenceDirectory, 'replacement');
      writeFileSync(replacement, 'valid');
      fs.renameSync(replacement, evidenceFile);
    }
    return stat;
  }, () => assert.throws(() => readProviderAcceptanceFile(evidenceFile, 5), /changed during/));
} finally {
  rmSync(evidenceDirectory, { recursive: true, force: true });
}
console.log('Provider grant Unicode signatures and bounded descriptor file boundaries passed.');
