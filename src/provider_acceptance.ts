/** A separately signed grant is required for live provider exposure. */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
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
  if (Object.keys(grant).sort((left, right) => left.localeCompare(right)).join(',') !== FIELDS.join(',')) return false;
  if (grant.version !== 1 || grant.mode !== 'live' || account.mode !== 'live') return false;
  if (!grantStringsValid(grant)) return false;
  if (!REVIEW_ID.test(grant.reviewId as string) || !PRODUCTS.has(grant.product as string)) return false;
  return grantAccountMatches(grant, account) && grantTimeValid(grant, now);
}

function grantStringsValid(grant: Record<string, unknown>): boolean {
  return FIELDS.filter(field => !['version', 'validFrom', 'validUntil'].includes(field))
    .every(field => validGrantString(grant[field]));
}

function validGrantString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Array.from(value).length <= 128
    && !/[\u0000-\u001f\ud800-\udfff]/u.test(value);
}

function grantAccountMatches(grant: Record<string, unknown>, account: GrantAccount): boolean {
  if (!account.externalAccountId || !account.credentialGeneration
    || account.externalAccountId.length !== 64 || account.credentialGeneration.length !== 64
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
  // Match Python json.dumps(sort_keys=True, ensure_ascii=True, separators=(',', ':')).
  // Escape UTF-16 code units (including surrogate pairs); never truncate Unicode into ASCII.
  const json = JSON.stringify(Object.fromEntries(FIELDS.map(field => [field, grant[field]])));
  return Buffer.from(json.replace(/[^\u0000-\u007e]/gu, escapeJsonCodeUnits), 'ascii');
}

function escapeJsonCodeUnits(character: string): string {
  let escaped = '';
  for (let index = 0; index < character.length; index += 1) {
    escaped += `\\u${character.charCodeAt(index).toString(16).padStart(4, '0')}`;
  }
  return escaped;
}

export function signedGrantValid(value: unknown, account: GrantAccount, now: number, key: ReturnType<typeof createPublicKey>): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort((left, right) => left.localeCompare(right)).join(',') !== 'grant,signature' || !grantMatches(row.grant, account, now)) return false;
  if (typeof row.signature !== 'string' || row.signature.length !== 88 || !/^(?:[A-Za-z0-9+/]{4}){21}[A-Za-z0-9+/]{2}==$/u.test(row.signature)) return false;
  return verify(null, canonicalProviderGrant(row.grant), key, Buffer.from(row.signature, 'base64'));
}

function pinnedReviewerKey(path: string): ReturnType<typeof createPublicKey> | null {
  const key = createPublicKey(readProviderAcceptanceFile(path, 4096));
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
    const key = pinnedReviewerKey(keyPath);
    if (!key) return false;
    const source = readProviderAcceptanceFile(grantsPath, 131_072);
    const rows: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(source));
    return Array.isArray(rows) && rows.length <= 100
      && rows.some(row => signedGrantValid(row, account, Date.now(), key));
  } catch {
    return false;
  }
}

function assertUnlinkedParents(path: string): void {
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    if (!lstatSync(parent).isDirectory()) throw new Error('Acceptance file parent must be a real directory.');
    if (dirname(parent) === parent) return;
  }
}

function assertAcceptanceFile(stat: BigIntStats, maximum: number): void {
  if (!stat.isFile() || stat.nlink !== 1n || stat.size < 1n || stat.size > BigInt(maximum)) {
    throw new Error('Acceptance evidence must be a bounded regular single-link file.');
  }
}

function assertSameAcceptanceFile(before: BigIntStats, after: BigIntStats): void {
  const fields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'] as const;
  if (!after.isFile() || fields.some(field => before[field] !== after[field])) {
    throw new Error('Acceptance evidence changed during reading.');
  }
}

/** No authority is granted here; caller must still validate the pinned key and signature. */
export function readProviderAcceptanceFile(path: string, maximum: number): Buffer {
  if (!isAbsolute(path) || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 131_072) {
    throw new Error('Invalid acceptance evidence file boundary.');
  }
  const target = resolve(path);
  assertUnlinkedParents(target);
  const before = lstatSync(target, { bigint: true });
  assertAcceptanceFile(before, maximum);
  const descriptor = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    assertSameAcceptanceFile(before, fstatSync(descriptor, { bigint: true }));
    const content = readBoundedDescriptor(descriptor, maximum);
    if (BigInt(content.length) !== before.size) throw new Error('Acceptance evidence size changed during reading.');
    assertSameAcceptanceFile(before, fstatSync(descriptor, { bigint: true }));
    assertSameAcceptanceFile(before, lstatSync(target, { bigint: true }));
    assertUnlinkedParents(target);
    return content;
  } finally {
    closeSync(descriptor);
  }
}

function readBoundedDescriptor(descriptor: number, maximum: number): Buffer {
  const content = Buffer.alloc(maximum + 1);
  let length = 0;
  while (length < content.length) {
    const received = readSync(descriptor, content, length, content.length - length, null);
    if (received === 0) break;
    length += received;
  }
  return content.subarray(0, length);
}
