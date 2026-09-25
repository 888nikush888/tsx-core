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
const NON_STRING_FIELDS = new Set(['version', 'validFrom', 'validUntil']);
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
  return FIELDS.every(field => NON_STRING_FIELDS.has(field) || validGrantString(ownField(grant, field)));
}

function validGrantString(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  const characters = Array.from(value);
  return characters.length <= 128 && characters.every(validGrantCharacter);
}

function validGrantCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return codePoint !== undefined && codePoint > 0x1f && (codePoint < 0xd800 || codePoint > 0xdfff);
}

function ownField(record: Record<string, unknown>, field: string): unknown {
  if (!Object.hasOwn(record, field)) return undefined;
  return Object.getOwnPropertyDescriptor(record, field)?.value;
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
  const json = JSON.stringify(Object.fromEntries(FIELDS.map(field => [field, ownField(grant, field)])));
  return asciiJsonBytes(json);
}

function asciiJsonBytes(json: string): Buffer {
  let ascii = '';
  for (let index = 0; index < json.length; index++) {
    const codePoint = json.codePointAt(index) ?? 0;
    if (codePoint > 0xffff) {
      const offset = codePoint - 0x10000;
      const high = 0xd800 + (offset >> 10);
      const low = 0xdc00 + (offset & 0x3ff);
      ascii += `\\u${high.toString(16).padStart(4, '0')}\\u${low.toString(16).padStart(4, '0')}`;
      index += 1;
    } else {
      ascii += codePoint >= 0x20 && codePoint <= 0x7e
        ? String.fromCodePoint(codePoint)
        : `\\u${codePoint.toString(16).padStart(4, '0')}`;
    }
  }
  return Buffer.from(ascii, 'ascii');
}

function validGrantSignature(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 88 || !value.endsWith('==')) return false;
  for (let index = 0; index < 86; index++) {
    if (!isBase64Code(value.charCodeAt(index))) return false;
  }
  return true;
}

function isBase64Code(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)
    || (code >= 0x30 && code <= 0x39) || code === 0x2b || code === 0x2f;
}

export function signedGrantValid(value: unknown, account: GrantAccount, now: number, key: ReturnType<typeof createPublicKey>): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort((left, right) => left.localeCompare(right)).join(',') !== 'grant,signature' || !grantMatches(row.grant, account, now)) return false;
  if (!validGrantSignature(row.signature)) return false;
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
    if (!lstatAcceptancePath(parent).isDirectory()) throw new Error('Acceptance file parent must be a real directory.');
    if (dirname(parent) === parent) return;
  }
}

function lstatAcceptancePath(path: string): BigIntStats {
  // Callers require canonical absolute paths and validate every ancestor as a real directory.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- validated canonical path is the security boundary.
  return lstatSync(path, { bigint: true });
}

function openAcceptancePath(path: string): number {
  // O_NOFOLLOW prevents a symlink swap after the lstat validation.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- validated canonical path is the security boundary.
  return openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW | 0) | (constants.O_NONBLOCK | 0));
}

function assertAcceptanceFile(stat: BigIntStats, maximum: number): void {
  if (!stat.isFile() || stat.nlink !== 1n || stat.size < 1n || stat.size > BigInt(maximum)) {
    throw new Error('Acceptance evidence must be a bounded regular single-link file.');
  }
}

function assertSameAcceptanceFile(before: BigIntStats, after: BigIntStats): void {
  if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.nlink !== after.nlink) {
    throw new Error('Acceptance evidence changed during reading.');
  }
}

/** No authority is granted here; caller must still validate the pinned key and signature. */
export function readProviderAcceptanceFile(path: string, maximum: number): Buffer {
  if (!isAbsolute(path) || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 131_072) {
    throw new Error('Invalid acceptance evidence file boundary.');
  }
  const target = resolve(path);
  if (target !== path) throw new Error('Acceptance evidence path must already be canonical.');
  assertUnlinkedParents(target);
  const before = lstatAcceptancePath(target);
  assertAcceptanceFile(before, maximum);
  const descriptor = openAcceptancePath(target);
  try {
    assertSameAcceptanceFile(before, fstatSync(descriptor, { bigint: true }));
    const content = readBoundedDescriptor(descriptor, maximum);
    if (BigInt(content.length) !== before.size) throw new Error('Acceptance evidence size changed during reading.');
    assertSameAcceptanceFile(before, fstatSync(descriptor, { bigint: true }));
    assertSameAcceptanceFile(before, lstatAcceptancePath(target));
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
