import { decimal } from './trading_decimal.js';
import { moneyValueFromRational, validateMoneyValue, type MoneyValue } from './trading_money_value.js';
import { compareRational, divideRational, multiplyRational, rationalFromDecimal } from './trading_rational.js';

export type ChannelThreshold = 'reached' | 'not_reached' | 'uncertain';

/** Compare actual PnL units; never truncate the percentage or reinterpret a loss's rounded sign. */
export function channelReturnThreshold(value: MoneyValue, equity: string, threshold: string, loss = false): ChannelThreshold {
  const pnl = validateMoneyValue(value);
  const boundary = divideRational(multiplyRational(rationalFromDecimal(decimal(equity, { positive: true })),
    rationalFromDecimal(decimal(threshold, { positive: true, max: '100' }))), rationalFromDecimal('100'));
  if (loss) boundary.numerator = String(-BigInt(boundary.numerator));
  const lower = compareRational(pnl.exact ?? rationalFromDecimal(pnl.lower), boundary);
  const upper = compareRational(pnl.exact ?? rationalFromDecimal(pnl.upper), boundary);
  if (loss ? upper <= 0 : lower >= 0) return 'reached';
  if (loss ? lower > 0 : upper < 0) return 'not_reached';
  return 'uncertain';
}

/** Percentage is a derived presentation value; a failed representation never drives the decision. */
export function channelReturnValue(value: MoneyValue, equity: string): { value: MoneyValue | null; reason: string | null } {
  const pnl = validateMoneyValue(value), capital = rationalFromDecimal(decimal(equity, { positive: true }));
  if (!pnl.exact) return { value: null, reason: 'Return percentage has only bounded PnL inputs.' };
  try {
    return { value: moneyValueFromRational(multiplyRational(pnl.exact, divideRational(rationalFromDecimal('100'), capital))), reason: null };
  } catch {
    // Inputs have already been validated; the bounded rational/decimal output budget can still be exceeded.
    return { value: null, reason: 'Exact return percentage exceeds the supported representation budget.' };
  }
}
