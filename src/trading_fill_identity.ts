import { isDeepStrictEqual } from 'node:util';
import type { ExchangeFill, ExchangeFillIdentity, TradingAccount } from './trading_types.js';

const PROFILES = { bybit_execution_v1: ['linear', 'inverse', 'spot', 'option'], hyperliquid_user_fill_v1: ['perpetual'],
  kraken_history_execution_v3: ['futures'], paper_fill_v1: ['paper'] };
function codeUnitOrder(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.length > 256 || [...value].some(character => character < ' ')) {
    throw new Error('FILL_IDENTITY_UNPROVEN: missing exact provider identifier.');
  }
}
export function validateFillIdentity(value: unknown): ExchangeFillIdentity {
  const row = object(value);
  if (!isDeepStrictEqual(Object.keys(row).sort(codeUnitOrder),
    ['marketNamespace', 'profile', 'providerFillId', 'providerMarketId', 'providerSymbol', 'scopeTimestamp', 'version'])
    || row.version !== 1 || !Object.hasOwn(PROFILES, row.profile as PropertyKey)
    || !PROFILES[row.profile as keyof typeof PROFILES].includes(row.marketNamespace as string)) throw new Error('Invalid fill identity profile.');
  for (const key of ['providerMarketId', 'providerSymbol', 'providerFillId']) identifier(row[key]);
  if (row.profile === 'hyperliquid_user_fill_v1') {
    if (!Number.isSafeInteger(row.scopeTimestamp) || (row.scopeTimestamp as number) < 0) throw new Error('Invalid Hyperliquid fill time identity.');
  } else if (row.scopeTimestamp !== null) throw new Error('Only the Hyperliquid native identity includes its timestamp.');
  return row as unknown as ExchangeFillIdentity;
}

function nativeMatches(fill: ExchangeFill, identity: ExchangeFillIdentity): boolean {
  const raw = object(fill.raw), info = object(raw.info);
  if (raw.id !== fill.exchangeFillId || raw.order !== fill.exchangeOrderId || raw.symbol !== identity.providerSymbol) return false;
  switch (identity.profile) {
    case 'bybit_execution_v1': return matchesBybit(info, fill, identity);
    case 'hyperliquid_user_fill_v1': return matchesHyperliquid(info, fill, identity);
    case 'kraken_history_execution_v3': return matchesKraken(info, fill, identity);
    default: return false;
  }
}
function matchesBybit(info: Record<string, unknown>, fill: ExchangeFill, identity: ExchangeFillIdentity): boolean {
  return info.execId === fill.exchangeFillId && info.orderId === fill.exchangeOrderId
    && info.symbol === identity.providerMarketId && nativeIntegerText(info.execTime) === String(fill.filledAt)
    && (!Object.hasOwn(info, 'category') || info.category === identity.marketNamespace);
}
function matchesHyperliquid(info: Record<string, unknown>, fill: ExchangeFill, identity: ExchangeFillIdentity): boolean {
  const tradeId = nativeIntegerText(info.tid), orderId = nativeIntegerText(info.oid);
  return tradeId !== null && orderId !== null && tradeId === fill.exchangeFillId && orderId === fill.exchangeOrderId
    && info.coin === identity.providerMarketId && info.time === fill.filledAt && identity.scopeTimestamp === fill.filledAt;
}

/** Native numeric evidence preserves its spelling; structured or rounded originals cannot prove identity. */
function nativeIntegerText(value: unknown): string | null {
  if (typeof value === 'string') return /^[0-9]{1,256}$/u.test(value) && value.trim() === value ? value : null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function matchesKraken(info: Record<string, unknown>, fill: ExchangeFill, identity: ExchangeFillIdentity): boolean {
  return info.identitySource === 'kraken_history_execution_v3' && info.executionUid === fill.exchangeFillId
    && info.orderUid === fill.exchangeOrderId && info.tradeable === identity.providerMarketId
    && typeof info.accountUid === 'string' && Boolean(info.accountUid) && info.executionTimestamp === fill.filledAt;
}

export function fillAccountFingerprint(account: Pick<TradingAccount, 'exchange' | 'mode' | 'id' | 'externalAccountId'>): string | null {
  return account.exchange === 'paper' && account.mode === 'paper' ? `paper:${account.id}` : account.externalAccountId;
}

/** Missing profile/native originals stay observations; no timestamp/economics alias is invented. */
export function provenFillIdentity(account: TradingAccount, fill: ExchangeFill): { key: string; identity: ExchangeFillIdentity } | null {
  let identity: ExchangeFillIdentity;
  if (account.exchange === 'paper' && account.mode === 'paper') {
    const symbol = fill.providerSymbol ?? fill.symbol;
    if (!symbol) return null;
    identity = { version: 1, profile: 'paper_fill_v1', marketNamespace: 'paper', providerMarketId: symbol,
      providerSymbol: symbol, providerFillId: fill.exchangeFillId, scopeTimestamp: null };
  } else {
    if (!fill.identity) return null;
    identity = validateFillIdentity(fill.identity);
    const provider = { bybit_execution_v1: 'bybit', hyperliquid_user_fill_v1: 'hyperliquid', kraken_history_execution_v3: 'krakenfutures', paper_fill_v1: 'paper' }[identity.profile];
    if (provider !== account.exchange || !nativeMatches(fill, identity)) return null;
  }
  const fingerprint = fillAccountFingerprint(account);
  if (!fingerprint || identity.providerFillId !== fill.exchangeFillId || identity.providerSymbol !== (fill.providerSymbol ?? fill.symbol)) return null;
  return { identity, key: JSON.stringify(['fill-v1', account.exchange, fingerprint, identity.profile, identity.marketNamespace,
    identity.providerMarketId, identity.providerFillId, identity.scopeTimestamp]) };
}

export function fillDigestIdentity(account: TradingAccount, fill: ExchangeFill): unknown {
  const proven = provenFillIdentity(account, fill);
  return proven ? ['native', proven.key] : ['unproved', fill.providerSymbol ?? fill.symbol ?? null, fill.exchangeFillId, fill.exchangeOrderId, fill.filledAt];
}
