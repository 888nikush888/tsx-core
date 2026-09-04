import { getDatabase } from './db.js';
import { decimal } from './trading_decimal.js';
import { TradingRiskError } from './trading_risk.js';
import { assertTierDecisionBudget, tierEvidenceHash, tierForQuantity, validateTierTable } from './trading_leverage_tiers.js';
import type { TradingAccount, TradingLeverageTierEvidence, TradingMarketSnapshot, TradingPlan } from './trading_types.js';

const SOURCES: Record<string, string> = {
  bybit: 'bybit_v5_risk_limit_mark_authenticated_scope_v1',
  hyperliquid: 'hyperliquid_meta_asset_context_bound_scope_v1',
  krakenfutures: 'kraken_authenticated_trading_instruments_mark_scope_v1',
  paper: 'paper_simulated_complete_tiers_v1',
};

function requireEvidence(condition: boolean, message: string): asserts condition {
  if (!condition) throw new TradingRiskError('LEVERAGE_TIERS_UNPROVEN', message);
}

function assertTierBinding(account: TradingAccount, value: TradingLeverageTierEvidence): void {
  const paper = account.exchange === 'paper';
  requireEvidence(value.accountFingerprint === (paper ? account.id : account.externalAccountId)
    && value.credentialGeneration === (paper ? 'paper' : account.credentialGeneration), 'Tier account/credential binding changed.');
  requireEvidence(value.source === SOURCES[account.exchange] && value.ccxtVersion === (paper ? 'paper' : '4.5.75')
    && value.profileHash === (paper ? 'paper-v1' : account.capabilities?.executionProfileHash), 'Tier implementation profile changed.');
  if (!paper) requireEvidence([value.profileHash, value.accountFingerprint, value.credentialGeneration]
    .every(binding => typeof binding === 'string' && /^[a-f0-9]{64}$/.test(binding)), 'Tier binding is incomplete.');
}

function assertTierFresh(value: TradingLeverageTierEvidence, now: number): void {
  requireEvidence(Number.isSafeInteger(value.observedAt) && Number.isSafeInteger(value.expiresAt)
    && now >= value.observedAt && now < value.expiresAt && value.expiresAt - value.observedAt === 10_000, 'Tier evidence expired.');
}

function assertTierUnits(market: TradingMarketSnapshot, value: TradingLeverageTierEvidence): void {
  requireEvidence(typeof value.providerSymbol === 'string' && value.providerSymbol.length > 0 && value.providerSymbol.length <= 100
    && ['USD', 'USDT', 'USDC'].includes(value.currency), 'Tier units are not proven.');
  if (market.accounting) requireEvidence(market.accounting.providerSymbol === value.providerSymbol
    && market.accounting.settlementAsset === value.currency, 'Tier and accounting contracts disagree.');
  requireEvidence(value.markPrice === market.markPrice && decimal(value.contractSize, { positive: true }) === value.contractSize,
    'Tier mark or contract size is invalid.');
}

export function assertTierEvidence(
  account: TradingAccount, symbol: string, market: TradingMarketSnapshot, now = Date.now(),
): TradingLeverageTierEvidence {
  const value = market.leverageTiers;
  requireEvidence(value?.version === 1 && value.exchange === account.exchange && value.symbol === symbol, 'Tier account/symbol evidence is missing.');
  assertTierBinding(account, value);
  assertTierFresh(value, now);
  assertTierUnits(market, value);
  requireEvidence(value.scope?.complete === true && value.scope.positionQuantity === '0' && value.scope.openOrderCount === 0,
    'Existing or unknown actual tier scope blocks scale-in.');
  try { validateTierTable(value.tiers); } catch { throw new TradingRiskError('LEVERAGE_TIERS_UNPROVEN', 'Complete consistent leverage tiers are required.'); }
  requireEvidence(value.tiers[0]!.maxLeverage === market.maxLeverage, 'Display maximum conflicts with actual tiers.');
  return value;
}

export function assertPlanTierDecision(account: TradingAccount, plan: TradingPlan, market: TradingMarketSnapshot): void {
  const value = assertTierEvidence(account, plan.symbol, market);
  const decision = plan.leverageTierDecision;
  requireEvidence((decision?.version === 1 || decision?.version === 2) && decision.evidenceHash === tierEvidenceHash(value)
    && decision.contractSize === value.contractSize && decision.providerSymbol === value.providerSymbol,
  'Original tier table or contract changed.');
  requireEvidence(decision.quantity === plan.quantity && decision.leverage === plan.leverage, 'Original tier sizing changed.');
  let index: number;
  try { index = tierForQuantity(value.tiers, plan.quantity, value.markPrice); }
  catch { throw new TradingRiskError('LEVERAGE_TIERS_UNPROVEN', 'Current notional is outside proven tiers.'); }
  requireEvidence(index === decision.tierIndex && plan.leverage <= value.tiers[index]!.maxLeverage,
    'Current mark changed the original leverage tier.');
  const entry = plan.orders.find(order => order.role === 'entry');
  requireEvidence(entry?.quantity === plan.quantity, 'Entry quantity changed after tier planning.');
  if (decision.version === 2) requireEvidence(plan.fxSizing?.notionalCurrency === value.currency, 'Tier FX budget lacks the original sizing context.');
  try { assertTierDecisionBudget(decision, value.currency, plan.quantity, value.markPrice, entry.price!); }
  catch { throw new TradingRiskError('LEVERAGE_TIERS_UNPROVEN', 'Current valuation exceeds the original margin/notional budget.'); }
}

/** Current candidate is excluded; all other local entry commitments count even after a trade closes. */
export async function assertLocalTierScope(accountId: string, intentId: string, symbol: string, providerSymbol: string): Promise<void> {
  const rows = await getDatabase().all<Array<{ quantity: string; status: string }>>(
    `SELECT positions.quantity, positions.status FROM trading_positions positions
       WHERE positions.account_id = ? AND positions.intent_id <> ? AND positions.symbol = ? AND positions.status <> 'closed'
     UNION ALL
     SELECT orders.quantity, orders.status FROM trading_orders orders JOIN trading_trade_intents intents ON intents.id = orders.intent_id
       WHERE orders.account_id = ? AND orders.intent_id <> ? AND orders.role = 'entry' AND orders.reduce_only = 0
         AND (intents.symbol = ? OR orders.provider_symbol = ?) AND orders.status IN ('created','submitting','open','partially_filled','cancel_pending','unknown')`,
    [accountId, intentId, symbol, accountId, intentId, symbol, providerSymbol]);
  requireEvidence(rows.length === 0,
    'Existing local position or entry reservation blocks tier scope.');
}
