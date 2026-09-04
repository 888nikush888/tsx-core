import { compareDecimal, decimal } from './trading_decimal.js';
import { assertFxConversionFresh } from './trading_fx_quotes.js';
import { invalidFx } from './trading_fx_contract.js';
import { persistFxConversion, readFxConversion, type StoredFxConversion } from './trading_fx_repository.js';
import { moneyValueFromRational, type MoneyValue } from './trading_money_value.js';
import { compareRational, divideRational, multiplyRational, quantizeRational, rationalFromDecimal, type ExactRational } from './trading_rational.js';
import type { TradingAccount, TradingAccountSnapshot, TradingFxSizingContext, TradingMarketSnapshot, StrategyConfiguration } from './trading_types.js';

interface FxSizingInput {
  account: TradingAccountSnapshot; market: TradingMarketSnapshot; strategy: StrategyConfiguration;
  fxConversion?: StoredFxConversion;
}
type SizingMode = StrategyConfiguration['sizing']['positionSizingMode'];
interface FxQuantityInput extends FxSizingInput {
  entry: string; distance: string; percent: string; leverage: number;
}
const positive = (value: string) => rationalFromDecimal(decimal(value, { positive: true }));
const nonnegative = (value: string) => rationalFromDecimal(decimal(value));
const minimum = (...values: ExactRational[]) => values.reduce((left, right) => compareRational(left, right) <= 0 ? left : right);

function assertSizingRecipe(fx: StoredFxConversion | undefined, reporting: string, settlement: string): asserts fx is StoredFxConversion {
  if (![reporting, settlement].every(asset => ['USD', 'USDT', 'USDC'].includes(asset))) invalidFx('SIZING_ASSET_UNSUPPORTED');
  if (!fx || !/^[a-f0-9]{64}$/.test(fx.id) || fx.conversion.baseAsset !== settlement || fx.conversion.quoteAsset !== reporting) {
    invalidFx('SIZING_CONVERSION_UNPROVEN');
  }
  assertFxConversionFresh(fx.conversion);
  if (compareRational(fx.conversion.rate, rationalFromDecimal('0')) <= 0) invalidFx('SIZING_RATE_INVALID');
}

/** Pure units/integrity fence, never a substitute for checking the stored originals before dispatch. */
export function fxSizingContext(input: FxSizingInput): TradingFxSizingContext | undefined {
  const reporting = input.account.accounting?.reportingCurrency;
  const settlement = input.market.accounting?.settlementAsset;
  if (!reporting || !settlement) {
    if (input.fxConversion) invalidFx('SIZING_UNITS_UNPROVEN');
    return undefined; // Legacy pure native fixtures; runtime already requires complete accounting contracts.
  }
  if (reporting === settlement) {
    if (input.fxConversion) invalidFx('SIZING_UNEXPECTED_CONVERSION');
    return undefined;
  }
  const fx = input.fxConversion;
  assertSizingRecipe(fx, reporting, settlement);
  return { version: 1, conversionId: fx.id, conversion: structuredClone(fx.conversion), reportingCurrency: reporting,
    notionalCurrency: settlement, strategyMaximumNotionalCurrency: settlement,
    riskAmountCurrency: (input.strategy.sizing.positionSizingMode ?? 'risk_percent') === 'risk_percent' ? reporting : settlement };
}
function sizingBudgets(input: FxQuantityInput) {
  if (!fxSizingContext(input)) return invalidFx('SIZING_CONVERSION_UNPROVEN');
  const rate = input.fxConversion!.conversion.rate;
  const leverage = positive(String(input.leverage));
  const capitalReporting = divideRational(multiplyRational(nonnegative(input.account.equity), positive(input.percent)), positive('100'));
  const capital = divideRational(capitalReporting, rate);
  const available = divideRational(multiplyRational(nonnegative(input.account.availableBalance), leverage), rate);
  const strategyMaximum = positive(input.strategy.sizing.maxPositionNotional);
  return { capital, leverage, available, strategyMaximum };
}
function notionalBudget(budget: ReturnType<typeof sizingBudgets>, mode: SizingMode): ExactRational {
  if (mode === 'equity_percent_margin') return minimum(budget.strategyMaximum, budget.available, multiplyRational(budget.capital, budget.leverage));
  if (mode === 'equity_percent_notional') return minimum(budget.strategyMaximum, budget.available, budget.capital);
  return minimum(budget.strategyMaximum, budget.available);
}
export function fxSizedQuantity(input: FxQuantityInput): string {
  const budget = sizingBudgets(input), mode = input.strategy.sizing.positionSizingMode ?? 'risk_percent';
  let quantity = divideRational(notionalBudget(budget, mode), positive(input.entry));
  if (mode === 'risk_percent') quantity = minimum(quantity, divideRational(budget.capital, positive(input.distance)));
  const result = quantizeRational(quantity, input.market.quantityStep, 'floor');
  if (compareDecimal(result, input.market.minimumQuantity) < 0 || result === '0') invalidFx('SIZING_QUANTITY_BELOW_MINIMUM');
  const actualNotional = multiplyRational(nonnegative(result), positive(input.entry));
  if (compareRational(actualNotional, nonnegative(input.market.minimumNotional)) < 0) invalidFx('SIZING_NOTIONAL_BELOW_MINIMUM');
  return result;
}
/** The strategy maximum and exchange tiers remain explicitly in the market settlement currency. */
export function fxNotionalBudget(input: FxQuantityInput): MoneyValue {
  return moneyValueFromRational(notionalBudget(sizingBudgets(input), input.strategy.sizing.positionSizingMode));
}

/** Read-only local original selection; no extra exchange request or renewed prepared-plan evidence. */
export async function prepareSizingFx(account: TradingAccount, snapshot: TradingAccountSnapshot, market: TradingMarketSnapshot,
  original?: TradingFxSizingContext): Promise<StoredFxConversion | undefined> {
  const reporting = snapshot.accounting?.reportingCurrency, settlement = market.accounting?.settlementAsset;
  if (!reporting || !settlement) return invalidFx('SIZING_UNITS_UNPROVEN');
  if (reporting === settlement) {
    if (original) invalidFx('SIZING_ORIGINAL_UNITS_CHANGED');
    return undefined;
  }
  const fx = original ? await readFxConversion(account, original.conversionId)
    : await persistFxConversion(account, settlement, reporting, Date.now());
  if (fx.conversion.baseAsset !== settlement || fx.conversion.quoteAsset !== reporting) invalidFx('SIZING_UNITS_CHANGED');
  assertFxConversionFresh(fx.conversion);
  return fx;
}
