import { isDeepStrictEqual } from 'node:util';
import type { ExchangeFill, ExchangeFillIdentity, TradingAccount } from './trading_types.js';

const PROFILES = { bybit_execution_v1: ['linear', 'inverse', 'spot', 'option'], hyperliquid_user_fill_v1: ['perpetual'],
  kraken_history_execution_v3: ['futures'], paper_fill_v1: ['paper'] };
function codeUnitOrder(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
function object(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > 256 || /[\x00-\x1f]/.test(value)) {
    throw new Error('FILL_IDENTITY_UNPROVEN: missing exact provider identifier.');
  }
}
export function validateFillIdentity(value: unknown): ExchangeFillIdentity {
  const row = object(value);
  if (!isDeepStrictEqual(Object.keys(row).sort(codeUnitOrder),
    ['marketNamespace', 'profile', 'providerFillId', 'providerMarketId', 'providerSymbol', 'scopeTimestamp', 'version'])
    || row.version !== 1 || !Object.hasOwn(PROFILES, row.profile)
    || !PROFILES[row.profile as keyof typeof PROFILES].includes(row.marketNamespace)) throw new Error('Invalid fill identity profile.');
  for (const key of ['providerMarketId', 'providerSymbol', 'providerFillId']) identifier(row[key]);
  if (row.profile === 'hyperliquid_user_fill_v1') {
    if (!Number.isSafeInteger(row.scopeTimestamp) || row.scopeTimestamp < 0) throw new Error('Invalid Hyperliquid fill time identity.');
  } else if (row.scopeTimestamp !== null) throw new Error('Only the Hyperliquid native identity includes its timestamp.');
  return row as ExchangeFillIdentity;
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
function matchesBybit(info: Record<string, any>, fill: ExchangeFill, identity: ExchangeFillIdentity): boolean {
  return info.execId === fill.exchangeFillId && info.orderId === fill.exchangeOrderId
    && info.symbol === identity.providerMarketId && String(info.execTime) === String(fill.filledAt)
    && (!Object.hasOwn(info, 'category') || info.category === identity.marketNamespace);
}
function matchesHyperliquid(info: Record<string, any>, fill: ExchangeFill, identity: ExchangeFillIdentity): boolean {
  return String(info.tid) === fill.exchangeFillId && String(info.oid) === fill.exchangeOrderId
    && info.coin === identity.providerMarketId && info.time === fill.filledAt && identity.scopeTimestamp === fill.filledAt;
}
function matchesKraken(info: Record<string, any>, fill: ExchangeFill, identity: ExchangeFillIdentity): boolean {
  return info.identitySource === 'kraken_history_execution_v3' && info.executionUid === fill.exchangeFillId
    && info.orderUid === fill.exchangeOrderId && info.tradeable === identity.providerMarketId
    && typeof info.accountUid === 'string' && !!info.accountUid && info.executionTimestamp === fill.filledAt;
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
