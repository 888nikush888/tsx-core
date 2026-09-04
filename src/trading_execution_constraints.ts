import { TradingRiskError } from './trading_risk.js';
import type { ExchangeEntryConstraints, TradingAccount, TradingExchangeAdapter, TradingPlan } from './trading_types.js';

const MAX_MODE_AGE_MS = 10_000;
const MODE_PROFILES: Record<string, { api: string; origin: string; leverage: string }> = {
  bybit: { api: 'bybit-v5', origin: 'authenticated', leverage: 'configured' },
  hyperliquid: { api: 'hyperliquid-info-exchange-v1', origin: 'public_bound_account', leverage: 'configured' },
  krakenfutures: { api: 'kraken-derivatives-v3', origin: 'authenticated', leverage: 'effective_collateral_ratio' },
};
const SAFE_MODE_REASONS = new Set([
  'READBACK_SCHEMA_INVALID', 'READBACK_LIST_MISSING_OR_UNBOUNDED', 'READBACK_LIST_INVALID',
  'LEVERAGE_READBACK_MISSING', 'LEVERAGE_READBACK_INVALID', 'LEVERAGE_READBACK_CONTRADICTORY',
  'MODE_READBACK_UNSUPPORTED', 'ACCOUNT_MODE_READ_FAILED', 'ACCOUNT_MODE_UNSUPPORTED',
  'MARGIN_MODE_READBACK_MISSING', 'POSITION_MODE_READ_FAILED', 'POSITION_MODE_SCOPE_INCOMPLETE',
  'POSITION_MODE_SYMBOL_UNPROVEN', 'POSITION_MODE_READBACK_MISSING', 'HEDGE_MODE_UNSUPPORTED',
  'WALLET_BINDING_UNPROVEN', 'WALLET_BINDING_CHANGED', 'PERP_DEX_SCOPE_UNPROVEN', 'ACTIVE_ASSET_BINDING_MISMATCH',
  'KRAKEN_MODE_READ_FAILED', 'MODE_SYMBOL_MISSING', 'POSITION_MODE_CONTRADICTORY', 'KRAKEN_CROSS_MARKET_SCOPE_UNPROVEN',
  'EXECUTION_PROFILE_UNSUPPORTED', 'CCXT_VERSION_UNREVIEWED', 'POSITION_MODE_UNSUPPORTED', 'MARGIN_MODE_UNSUPPORTED',
  'MODE_READBACK_EXPIRED', 'MODE_READBACK_TIMEOUT', 'MODE_READBACK_FAILED', 'ACCOUNT_MODE_READBACK_FAILED',
]);

function modeFailure(reason: string): never {
  throw new TradingRiskError('EXECUTION_MODE_UNPROVEN', `Entry mode evidence is not proven: ${reason}`);
}

export function rejectModeReadback(reason: unknown): never {
  modeFailure(typeof reason === 'string' && SAFE_MODE_REASONS.has(reason) ? reason : 'mode not allowed.');
}

/** A declaration only rejects unsupported forms; fresh mode evidence remains independently mandatory. */
export function assertBoundedEntryProfile(account: TradingAccount, plan: Pick<TradingPlan, 'entryPriceBoundary'>): void {
  if (!plan.entryPriceBoundary || account.exchange === 'paper') return;
  const declared = account.capabilities?.executionCapabilities as Record<string, unknown> | undefined;
  if (!['bybit', 'hyperliquid'].includes(account.exchange) || declared?.protected_bounded_entry !== 'limit_ioc_batch_v1') {
    throw new TradingRiskError('ENTRY_PRICE_BOUND_UNPROVEN', 'Protected limit IOC plus stop-market is not proven for this account profile.');
  }
}

function assertProfile(account: TradingAccount, evidence: ExchangeEntryConstraints): void {
  const expected = MODE_PROFILES[account.exchange];
  if (!expected || evidence.ccxtVersion !== '4.5.75' || evidence.profileVersion !== 1
    || evidence.providerApiVersion !== expected.api || evidence.origin !== expected.origin
    || evidence.leverageSemantics !== expected.leverage) modeFailure('unreviewed mode profile.');
  if (account.exchange === 'hyperliquid' && evidence.accountAbstraction !== 'disabled') modeFailure('account abstraction is unreviewed.');
  if (!/^[a-f0-9]{64}$/.test(evidence.profileHash)
    || evidence.profileHash !== account.capabilities?.executionProfileHash) modeFailure('mode profile changed; account verification is required.');
  assertModeLeverage(expected.leverage, evidence);
}

function assertModeLeverage(semantics: string, evidence: ExchangeEntryConstraints): void {
  if (semantics === 'configured') {
    if (!Number.isSafeInteger(evidence.leverage) || Number(evidence.leverage) <= 0) modeFailure('leverage readback missing.');
  } else if (evidence.leverage !== null) modeFailure('cross effective leverage is not a configured integer.');
}

function assertModeBinding(account: TradingAccount, symbol: string, value: ExchangeEntryConstraints): void {
  if (value.exchange !== account.exchange || value.symbol !== symbol
    || typeof value.providerSymbol !== 'string' || value.providerSymbol.length < 1 || value.providerSymbol.length > 100
    || value.accountFingerprint !== account.externalAccountId
    || value.credentialGeneration !== account.credentialGeneration) modeFailure('account/symbol binding changed.');
}

function assertObservationProfile(capabilities: Record<string, unknown> | undefined, observation: Record<string, unknown>, api: string): void {
  const declared = capabilities?.executionCapabilities as Record<string, unknown> | undefined;
  if (observation.ccxtVersion !== '4.5.75' || capabilities?.profileVersion !== 1 || typeof capabilities.executionProfileHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(capabilities.executionProfileHash) || declared?.provider_api_version !== api) {
    modeFailure('account mode observation has an unreviewed profile.');
  }
  const observedAt = observation.observedAt;
  if (!Number.isSafeInteger(observedAt) || Number(observedAt) > Date.now()
    || Date.now() - Number(observedAt) >= MAX_MODE_AGE_MS) modeFailure('account mode observation is stale.');
}

export function assertAccountModeObservation(account: TradingAccount, result: Record<string, unknown>): void {
  const capabilities = result.capabilities as Record<string, unknown> | undefined;
  const observation = capabilities?.executionModeObservation as Record<string, unknown> | undefined;
  const profile = MODE_PROFILES[account.exchange];
  if (!profile || result.entryAllowed !== false || result.reason !== null || !observation
    || observation.verified !== true || observation.entryAllowed !== false || observation.requiresSymbolRead !== true
    || observation.reason !== null || observation.scope !== 'account_observation' || observation.origin !== profile.origin) {
    modeFailure('account mode observation is missing or invalid.');
  }
  assertObservationProfile(capabilities, observation, profile.api);
}

function assertModeFresh(value: ExchangeEntryConstraints, now: number): void {
  if (!Number.isSafeInteger(value.observedAt) || !Number.isSafeInteger(value.expiresAt)
    || now < value.observedAt || now >= value.expiresAt
    || value.expiresAt - value.observedAt !== MAX_MODE_AGE_MS) modeFailure('stale mode readback.');
}

function assertModeSources(value: ExchangeEntryConstraints): void {
  if (!Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > 8
    || value.sources.some(source => typeof source !== 'string' || source.length < 1 || source.length > 100)) modeFailure('readback sources missing.');
}

/** Synchronous final fence: no I/O and no provider writes. */
export function assertEntryModeEvidence(
  account: TradingAccount, symbol: string, value: ExchangeEntryConstraints | null, now = Date.now(),
): void {
  if (account.exchange === 'paper' && value === null) return;
  if (!value || typeof value !== 'object') modeFailure('mode readback missing.');
  if (value.version !== 1 || value.entryAllowed !== true || value.reason !== null
    || value.positionMode !== 'oneway' || value.marginMode !== 'cross') rejectModeReadback(value.reason);
  assertModeBinding(account, symbol, value);
  assertProfile(account, value);
  assertModeFresh(value, now);
  assertModeSources(value);
}

export async function readEntryModeEvidence(
  adapter: TradingExchangeAdapter, account: TradingAccount, symbol: string,
): Promise<ExchangeEntryConstraints | null> {
  if (account.exchange === 'paper') return null;
  if (!adapter.entryConstraints) modeFailure('adapter has no mode readback.');
  const evidence = await adapter.entryConstraints(account, symbol);
  assertEntryModeEvidence(account, symbol, evidence);
  return evidence;
}
