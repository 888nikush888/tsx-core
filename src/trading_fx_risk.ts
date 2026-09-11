import { isDeepStrictEqual } from 'node:util';
import { validateFillAccounting } from './trading_accounting_contract.js';
import { persistFxConversion, readFxConversion, snapshotFxAccount, type FxAccount, type StoredFxConversion } from './trading_fx_repository.js';
import { assertFxConversionFresh } from './trading_fx_quotes.js';
import { addMoneyValues, moneyValueFromRational } from './trading_money_value.js';
import { multiplyRational, rationalFromDecimal } from './trading_rational.js';
import { calculateRiskReservation, unresolvedRiskAmounts, type RiskReservationAmounts, type RiskReservationInput } from './trading_risk_reservations.js';
import type { TradingFxSizingContext } from './trading_types.js';

/** Pure conversion is used only after the account-bound stored recipe has been read. */
function convertAmounts(native: RiskReservationAmounts, fx: StoredFxConversion): RiskReservationAmounts {
  const convert = (amount: string | null) => {
    if (amount === null) throw new Error('Native settlement risk is unresolved.');
    return moneyValueFromRational(multiplyRational(rationalFromDecimal(amount), fx.conversion.rate));
  };
  const markToStopRiskValue = convert(native.markToStopRisk), pendingEntryRiskValue = convert(native.pendingEntryRisk);
  const actualFillToStopRiskValue = convert(native.actualFillToStopRisk);
  const additionalRiskValue = addMoneyValues(markToStopRiskValue, pendingEntryRiskValue);
  return { ...native, reportingCurrency: fx.conversion.quoteAsset, markToStopRiskValue, pendingEntryRiskValue,
    actualFillToStopRiskValue, additionalRiskValue, markToStopRisk: markToStopRiskValue.decimal,
    pendingEntryRisk: pendingEntryRiskValue.decimal, actualFillToStopRisk: actualFillToStopRiskValue.decimal,
    additionalRisk: additionalRiskValue.decimal };
}

/** Local originals only: no provider/network read is permitted inside this accounting transaction. */
export async function calculateFxRiskReservation(account: FxAccount, input: RiskReservationInput, at: number)
  : Promise<{ amounts: RiskReservationAmounts; fx: StoredFxConversion | null }> {
  try {
    const market = validateFillAccounting(input.market);
    const native = calculateRiskReservation({ ...input, reportingCurrency: market.settlementAsset });
    if (native.status !== 'complete') return { amounts: { ...native, reportingCurrency: input.reportingCurrency }, fx: null };
    if (market.settlementAsset === input.reportingCurrency) return { amounts: native, fx: null };
    const fx = await persistFxConversion(account, market.settlementAsset, input.reportingCurrency, at);
    assertFxConversionFresh(fx.conversion);
    return { amounts: convertAmounts(native, fx), fx };
  } catch (error) { return { amounts: unresolvedRiskAmounts(input.reportingCurrency, error), fx: null }; }
}

/** Time/hash checks alone do not grant authority: re-read every recipe from its retained originals. */
export async function verifyRiskFxConversions(account: FxAccount, values: StoredFxConversion[]): Promise<void> {
  account = snapshotFxAccount(account);
  for (const expected of values) {
    const actual = await readFxConversion(account, expected.id);
    if (!isDeepStrictEqual(actual, expected)) throw new Error('Risk FX recipe changed.');
    assertFxConversionFresh(actual.conversion);
  }
}

export function assertRiskFxFresh(values: StoredFxConversion[], now = Date.now()): void {
  for (const value of values) assertFxConversionFresh(value.conversion, now);
}

function assertSizingConversionPresent(
  context: TradingFxSizingContext, fx: StoredFxConversion | null,
): asserts fx is StoredFxConversion {
  if (!fx || context.version !== 1 || context.conversionId !== fx.id
    || !isDeepStrictEqual(context.conversion, fx.conversion)) {
    throw new Error('Original risk sizing conversion is missing or changed.');
  }
}

function assertSizingReportingParties(
  context: TradingFxSizingContext, reporting: string, settlement: string,
): void {
  if (settlement === reporting || context.reportingCurrency !== reporting
    || context.notionalCurrency !== settlement) {
    throw new Error('Original risk sizing reporting/settlement units changed.');
  }
}

function assertSizingConversionAssets(
  context: TradingFxSizingContext, fx: StoredFxConversion, reporting: string, settlement: string,
): void {
  if (context.strategyMaximumNotionalCurrency !== settlement
    || ![reporting, settlement].includes(context.riskAmountCurrency)
    || fx.conversion.baseAsset !== settlement || fx.conversion.quoteAsset !== reporting) {
    throw new Error('Original risk sizing reporting/settlement units changed.');
  }
}

/** Every original sizing dependency must be in the same final original-source/time fence. */
export function assertRiskSizingBinding(context: TradingFxSizingContext | undefined, fx: StoredFxConversion | null,
  reporting: string, settlement: string | undefined): void {
  if (!context) {
    if (fx) throw new Error('Unexpected risk sizing conversion without an original plan context.');
    return;
  }
  assertSizingConversionPresent(context, fx);
  assertSizingReportingParties(context, reporting, settlement);
  assertSizingConversionAssets(context, fx, reporting, settlement);
}
