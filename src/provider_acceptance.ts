/** A separately signed grant is required for live provider exposure. */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { TradingAccount } from './trading_types.js';

type GrantAccount = Pick<TradingAccount, 'id' | 'exchange' | 'mode' | 'externalAccountId' | 'credentialGeneration'>;
const HEX_64 = /^[a-f0-9]{64}$/;
const REVIEW_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const PRODUCTS = new Set(['swap:linear', 'swap:inverse', 'future:linear', 'future:inverse']);
const FIELDS = [
  'accountId', 'credentialGeneration', 'exchange', 'externalAccountId', 'mode',
  'product', 'reviewId', 'validFrom', 'validUntil', 'version',
];

// A future independently reviewed source change must pin the reviewer key.
// Empty is intentionally deny-all. Neither UI nor an implementation receipt
// is an acceptance authority.
const PINNED_REVIEWER_KEY_SHA256 = '';

function liveProvenanceVerified(): boolean {
  // Grant verification must also bind the exact source, CCXT SDK, and profile
  // hashes. A reviewer-key pin alone must never open live trading.
  return false;
}

function grantMatches(value: unknown, account: GrantAccount, now: number): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const grant = value as Record<string, unknown>;
  if (Object.keys(grant).sort().join(',') !== FIELDS.join(',')) return false;
  if (grant.version !== 1 || grant.mode !== 'live' || account.mode !== 'live') return false;
  if (!REVIEW_ID.test(String(grant.reviewId)) || !PRODUCTS.has(String(grant.product))) return false;
  return grantAccountMatches(grant, account) && grantTimeValid(grant, now);
}

function grantAccountMatches(grant: Record<string, unknown>, account: GrantAccount): boolean {
  if (!account.externalAccountId || !account.credentialGeneration
    || !HEX_64.test(account.externalAccountId) || !HEX_64.test(account.credentialGeneration)) return false;
  return grant.accountId === account.id && grant.exchange === account.exchange
    && grant.externalAccountId === account.externalAccountId
    && grant.credentialGeneration === account.credentialGeneration;
}

function grantTimeValid(grant: Record<string, unknown>, now: number): boolean {
  const start = grant.validFrom, end = grant.validUntil;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end)
    && Number(start) <= now && now < Number(end) && Number(end) - Number(start) <= 7 * 86_400_000;
}

export function canonicalProviderGrant(grant: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(Object.fromEntries(FIELDS.map(field => [field, grant[field]]))), 'ascii');
}

export function signedGrantValid(value: unknown, account: GrantAccount, now: number, key: ReturnType<typeof createPublicKey>): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'grant,signature' || !grantMatches(row.grant, account, now)) return false;
  if (typeof row.signature !== 'string' || !/^(?:[A-Za-z0-9+/]{4}){21}[A-Za-z0-9+/]{2}==$/u.test(row.signature)) return false;
  return verify(null, canonicalProviderGrant(row.grant), key, Buffer.from(row.signature, 'base64'));
}

function pinnedReviewerKey(path: string): ReturnType<typeof createPublicKey> | null {
  if (statSync(path).size > 4096) return null;
  const key = createPublicKey(readFileSync(path));
  if (key.asymmetricKeyType !== 'ed25519') return null;
  const der = key.export({ format: 'der', type: 'spki' });
  return createHash('sha256').update(der).digest('hex') === PINNED_REVIEWER_KEY_SHA256 ? key : null;
}

export function liveProviderAcceptancePinned(account: GrantAccount): boolean {
  if (account.mode !== 'live') return true;
  if (!liveProvenanceVerified()) return false;
  if (!HEX_64.test(PINNED_REVIEWER_KEY_SHA256)) return false;
  const keyPath = process.env.PROVIDER_ACCEPTANCE_REVIEWER_KEY_FILE ?? '';
  const grantsPath = process.env.PROVIDER_ACCEPTANCE_GRANTS_FILE ?? '';
  if (!isAbsolute(keyPath) || !isAbsolute(grantsPath)) return false;
  try {
    if (statSync(grantsPath).size > 131_072) return false;
    const key = pinnedReviewerKey(keyPath);
    if (!key) return false;
    const source = readFileSync(grantsPath);
    if (source.length > 131_072) return false;
    const rows: unknown = JSON.parse(source.toString('utf8'));
    return Array.isArray(rows) && rows.length <= 100
      && rows.some(row => signedGrantValid(row, account, Date.now(), key));
  } catch {
    return false;
  }
}
