import { createHash } from 'node:crypto';
import { compareDecimal, decimal } from './trading_decimal.js';
import { validateMoneyValue, type MoneyValue } from './trading_money_value.js';
import { compareRational, multiplyRational, rationalFromDecimal } from './trading_rational.js';
import type { TradingLeverageTier, TradingLeverageTierDecision, TradingLeverageTierEvidence } from './trading_types.js';

export class LeverageTierError extends Error {
  readonly code = 'LEVERAGE_TIERS_UNPROVEN';
  constructor(message: string) { super(message); this.name = 'LeverageTierError'; }
}

function requireTier(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new LeverageTierError(reason);
}

export function validateTierTable(tiers: TradingLeverageTier[]): void {
  requireTier(Array.isArray(tiers) && tiers.length > 0 && tiers.length <= 500, 'Complete leverage tiers are required.');
  let lower = '0';
  let previousLeverage = 50;
  for (const [index, tier] of tiers.entries()) {
    requireTier(tier !== null && typeof tier === 'object', 'Invalid leverage tier.');
    requireTier(decimal(tier.lowerBound) === lower, 'Leverage tiers are gapped, overlapping or unordered.');
    requireTier(Number.isSafeInteger(tier.maxLeverage) && tier.maxLeverage >= 1 && tier.maxLeverage <= previousLeverage,
      'Leverage tier maxima must decrease and must not exceed 50.');
    if (tier.upperBound === null) requireTier(index === tiers.length - 1, 'Only the final tier can be unlimited.');
    else requireTier(compareDecimal(decimal(tier.upperBound, { positive: true }), lower) > 0, 'Invalid leverage tier range.');
    lower = tier.upperBound ?? '';
    previousLeverage = tier.maxLeverage;
  }
}

function quantum(value: string): bigint {
  const [whole, fraction = ''] = decimal(value).split('.');
  return BigInt(whole + fraction.padEnd(18, '0'));
}

/** The product retains all 36 fractional digits: never round a notional down into a cheaper tier. */
function findTierForQuantity(tiers: TradingLeverageTier[], quantity: string, markPrice: string): number {
  const product = quantum(decimal(quantity, { positive: true })) * quantum(decimal(markPrice, { positive: true }));
  return tiers.findIndex(tier => product >= quantum(tier.lowerBound) * 10n ** 18n
    && (tier.upperBound === null || product < quantum(tier.upperBound) * 10n ** 18n));
}

export function tierForQuantity(tiers: TradingLeverageTier[], quantity: string, markPrice: string): number {
  const index = findTierForQuantity(tiers, quantity, markPrice);
  requireTier(index >= 0, 'Quantized notional is outside the proven leverage tiers.');
  return index;
}

export function solveTierQuantity(
  evidence: Pick<TradingLeverageTierEvidence, 'tiers' | 'markPrice' | 'contractSize'>,
  requested: number, quantityForLeverage: (leverage: number) => string,
): { leverage: number; quantity: string; tierIndex: number } {
  validateTierTable(evidence.tiers);
  decimal(evidence.contractSize, { positive: true });
  requireTier(Number.isSafeInteger(requested) && requested > 0, 'Invalid requested tier leverage.');
  let leverage = Math.min(requested, 50, evidence.tiers[0]!.maxLeverage);
  for (let iteration = 0; iteration <= evidence.tiers.length; iteration += 1) {
    const quantity = decimal(quantityForLeverage(leverage), { positive: true });
    const tierIndex = findTierForQuantity(evidence.tiers, quantity, evidence.markPrice);
    const maximum = evidence.tiers[tierIndex < 0 ? evidence.tiers.length - 1 : tierIndex]!.maxLeverage;
    requireTier(tierIndex >= 0 || leverage > maximum, 'Quantized notional is outside the proven leverage tiers.');
    if (leverage <= maximum) return { leverage, quantity, tierIndex };
    leverage = maximum; // Never increase again after crossing into a smaller range.
  }
  throw new LeverageTierError('Leverage tier solver exceeded its monotone bound.');
}

export function tierEvidenceHash(value: TradingLeverageTierEvidence): string {
  return createHash('sha256').update(JSON.stringify([value.exchange, value.symbol, value.providerSymbol,
    value.accountFingerprint, value.credentialGeneration, value.ccxtVersion, value.profileHash, value.source,
    value.currency, value.contractSize, value.tiers.map(tier => [tier.lowerBound, tier.upperBound, tier.maxLeverage])])).digest('hex');
}

export function tierDecision(value: TradingLeverageTierEvidence, result: {
  quantity: string; leverage: number; tierIndex: number;
}, maximumNotional: string | MoneyValue): TradingLeverageTierDecision {
  if (typeof maximumNotional !== 'string') {
    const amount = validateMoneyValue(maximumNotional);
    requireTier(amount.exact !== null && amount.terms > 0
      && compareRational(amount.exact, rationalFromDecimal('0')) > 0, 'Exact positive notional budget is required.');
    return { version: 2, evidenceHash: tierEvidenceHash(value), providerSymbol: value.providerSymbol,
      contractSize: value.contractSize, ...result, maximumNotional: amount.decimal,
      maximumNotionalValue: amount, maximumNotionalCurrency: value.currency };
  }
  return { version: 1, evidenceHash: tierEvidenceHash(value), providerSymbol: value.providerSymbol,
    contractSize: value.contractSize, ...result, maximumNotional };
}

export function assertTierDecisionBudget(decision: TradingLeverageTierDecision, currency: string,
  quantity: string, markPrice: string, entryPrice: string): void {
  if (decision.version === 1) {
    requireTier(typeof decision.maximumNotional === 'string' && decision.maximumNotionalValue === undefined
      && decision.maximumNotionalCurrency === undefined, 'Legacy tier budget contract changed.');
    assertTierNotionalBudget(quantity, markPrice, entryPrice, decision.maximumNotional);
    return;
  }
  requireTier(decision.version === 2 && decision.maximumNotionalCurrency === currency, 'Tier budget currency differs.');
  const amount = validateMoneyValue(decision.maximumNotionalValue);
  requireTier(amount.exact !== null && amount.terms > 0 && decision.maximumNotional === amount.decimal
    && compareRational(amount.exact, rationalFromDecimal('0')) > 0, 'Tier rational budget is not exact or contradicts its decimal alias.');
  const price = compareDecimal(markPrice, entryPrice) > 0 ? markPrice : entryPrice;
  const actual = multiplyRational(rationalFromDecimal(decimal(quantity, { positive: true })), rationalFromDecimal(decimal(price, { positive: true })));
  requireTier(compareRational(actual, amount.exact) <= 0, 'Current valuation exceeds the original margin/notional budget.');
}

export function assertTierNotionalBudget(quantity: string, markPrice: string, entryPrice: string, maximum: string): void {
  const price = compareDecimal(markPrice, entryPrice) > 0 ? markPrice : entryPrice;
  requireTier(quantum(quantity) * quantum(price) <= quantum(maximum) * 10n ** 18n,
    'Current valuation exceeds the original margin/notional budget.');
}
