import { addSignedDecimal, negateSignedDecimal, signedDecimal } from './trading_decimal.js';
import {
  addRational, rational, rationalDecimalBounds, rationalFromDecimal, type ExactRational,
} from './trading_rational.js';

/** Precision is a mathematical property, not evidence of currency, ownership or valuation authority. */
export interface MoneyValue {
  lower: string;
  upper: string;
  exact: ExactRational | null;
  decimal: string | null;
  precision: 'exact_decimal' | 'exact_rational' | 'bounded';
  terms: number;
}

const MONEY_KEYS = ['lower', 'upper', 'exact', 'decimal', 'precision', 'terms'];
const RATIONAL_KEYS = ['numerator', 'denominator'];
const DECIMAL_SCALE = 18;
const RATIONAL_DIGITS = 256;

function dataRecord(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid money value structure.');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) throw new Error('Invalid money value prototype.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length) throw new Error('Invalid money value fields.');
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw new Error('Money value fields must be enumerable data properties.');
    }
  }
  return value as Record<string, unknown>;
}

function canonicalDecimal(value: unknown): string {
  if (typeof value !== 'string' || signedDecimal(value) !== value) throw new Error('Invalid canonical money decimal.');
  return value;
}

function exactFraction(value: unknown, requireCanonical: boolean): ExactRational {
  const source = dataRecord(value, RATIONAL_KEYS);
  if (typeof source.numerator !== 'string' || typeof source.denominator !== 'string') {
    throw new Error('Invalid money rational components.');
  }
  const normalized = rational({ numerator: source.numerator, denominator: source.denominator });
  if (requireCanonical && (normalized.numerator !== source.numerator || normalized.denominator !== source.denominator)) {
    throw new Error('Money rational must be reduced and canonical.');
  }
  return normalized;
}

function decimalUnits(value: string): bigint {
  const [integer, tail = ''] = value.split('.');
  return BigInt(integer + tail.padEnd(DECIMAL_SCALE, '0'));
}

function checkedTerms(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new Error('Money terms must be a nonnegative safe integer.');
  }
  return value;
}

function exactValue(exact: ExactRational, terms: number): MoneyValue {
  const bounds = rationalDecimalBounds(exact);
  return {
    lower: bounds.lower, upper: bounds.upper, exact,
    decimal: bounds.exact ? bounds.lower : null,
    precision: bounds.exact ? 'exact_decimal' : 'exact_rational', terms,
  };
}

function validateExact(source: Record<string, unknown>, terms: number, lower: string, upper: string): MoneyValue {
  const exact = exactFraction(source.exact, true);
  const result = exactValue(exact, terms);
  if (lower !== result.lower || upper !== result.upper || source.decimal !== result.decimal
    || source.precision !== result.precision) throw new Error('Money exact value, bounds and precision disagree.');
  if (terms === 0 && exact.numerator !== '0') throw new Error('Zero money terms require an exact zero identity.');
  return result;
}

/** Validate a serialized value and return an independent canonical copy, without inferring provenance. */
export function validateMoneyValue(value: unknown): MoneyValue {
  const source = dataRecord(value, MONEY_KEYS);
  const lower = canonicalDecimal(source.lower), upper = canonicalDecimal(source.upper);
  const terms = checkedTerms(source.terms);
  if (source.exact !== null) return validateExact(source, terms, lower, upper);
  const width = decimalUnits(upper) - decimalUnits(lower);
  if (source.precision !== 'bounded' || source.decimal !== null || terms < 2 || width <= 0n || width > BigInt(terms)) {
    throw new Error('Money bounded interval, precision and terms disagree.');
  }
  return { lower, upper, exact: null, decimal: null, precision: 'bounded', terms };
}

/** A single event always retains its exact original value, including amounts below one decimal quantum. */
export function moneyValueFromRational(value: ExactRational): MoneyValue {
  return exactValue(exactFraction(value, false), 1);
}

export function moneyValueFromDecimal(value: string): MoneyValue {
  return exactValue(rationalFromDecimal(value), 1);
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function exceedsRationalLimit(left: ExactRational, right: ExactRational): boolean {
  const a = BigInt(left.numerator), b = BigInt(left.denominator);
  const c = BigInt(right.numerator), d = BigInt(right.denominator);
  const common = gcd(b, d);
  const numerator = a * (d / common) + c * (b / common);
  const denominator = b * (d / common);
  const divisor = gcd(numerator, denominator);
  const magnitude = numerator < 0n ? -numerator : numerator;
  // Prove the normalized result limit, not an oversized intermediate or an unrelated thrown error.
  return String(magnitude / divisor).length > RATIONAL_DIGITS
    || String(denominator / divisor).length > RATIONAL_DIGITS;
}

/** Exact addition first; only proven rational-result overflow loses correlation into outward bounds. */
export function addMoneyValues(left: MoneyValue, right: MoneyValue): MoneyValue {
  const a = validateMoneyValue(left), b = validateMoneyValue(right);
  const terms = checkedTerms(a.terms + b.terms);
  if (a.exact && b.exact && !exceedsRationalLimit(a.exact, b.exact)) {
    return exactValue(addRational(a.exact, b.exact), terms);
  }
  return validateMoneyValue({
    lower: addSignedDecimal(a.lower, b.lower), upper: addSignedDecimal(a.upper, b.upper),
    exact: null, decimal: null, precision: 'bounded', terms,
  });
}

export function negateMoneyValue(value: MoneyValue): MoneyValue {
  const source = validateMoneyValue(value);
  if (source.exact) {
    return exactValue({ numerator: String(-BigInt(source.exact.numerator)), denominator: source.exact.denominator }, source.terms);
  }
  return validateMoneyValue({
    lower: negateSignedDecimal(source.upper), upper: negateSignedDecimal(source.lower),
    exact: null, decimal: null, precision: 'bounded', terms: source.terms,
  });
}
