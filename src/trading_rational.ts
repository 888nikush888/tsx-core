import { decimal, signedDecimal } from './trading_decimal.js';

/** Exact bounded fractions for FX provenance. Decimal bounds are never an exact rate claim. */
export interface ExactRational { numerator: string; denominator: string }
export interface RationalDecimalBounds { lower: string; upper: string; exact: boolean }
const INTEGER = /^(?:0|-?[1-9]\d{0,255})$/;
const POSITIVE_INTEGER = /^[1-9]\d{0,255}$/;

function integers(value: ExactRational): [bigint, bigint] {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'denominator,numerator'
    || typeof value.numerator !== 'string' || !INTEGER.test(value.numerator)
    || typeof value.denominator !== 'string' || !POSITIVE_INTEGER.test(value.denominator)) {
    throw new Error('Invalid bounded rational value.');
  }
  return [BigInt(value.numerator), BigInt(value.denominator)];
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function fraction(numerator: bigint, denominator: bigint): ExactRational {
  if (denominator === 0n) throw new Error('Rational division by zero.');
  if (denominator < 0n) { numerator = -numerator; denominator = -denominator; }
  const divisor = gcd(numerator, denominator);
  const result = { numerator: String(numerator / divisor), denominator: String(denominator / divisor) };
  integers(result);
  return result;
}

export function rational(value: ExactRational): ExactRational {
  return fraction(...integers(value));
}

export function rationalFromDecimal(value: string): ExactRational {
  if (typeof value !== 'string' || /\s/.test(value)) throw new Error('Invalid rational source decimal.');
  const normalized = signedDecimal(value);
  const [integer, tail = ''] = normalized.split('.');
  return fraction(BigInt(integer + tail), 10n ** BigInt(tail.length));
}

export function addRational(left: ExactRational, right: ExactRational): ExactRational {
  const [a, b] = integers(left), [c, d] = integers(right);
  const divisor = gcd(b, d);
  return fraction(a * (d / divisor) + c * (b / divisor), b * (d / divisor));
}

export function multiplyRational(left: ExactRational, right: ExactRational): ExactRational {
  const [a, b] = integers(left), [c, d] = integers(right);
  const first = gcd(a, d), second = gcd(c, b);
  return fraction((a / first) * (c / second), (b / second) * (d / first));
}

export function divideRational(left: ExactRational, right: ExactRational): ExactRational {
  const [a, b] = integers(left), [c, d] = integers(right);
  if (c === 0n) throw new Error('Rational division by zero.');
  return fraction(a * d, b * c);
}

export function compareRational(left: ExactRational, right: ExactRational): number {
  const [a, b] = integers(left), [c, d] = integers(right);
  const difference = a * d - c * b;
  if (difference < 0n) return -1;
  return difference > 0n ? 1 : 0;
}

function integerBounds(numerator: bigint, denominator: bigint): [bigint, bigint] {
  const quotient = numerator / denominator, remainder = numerator % denominator;
  return [quotient - (remainder < 0n ? 1n : 0n), quotient + (remainder > 0n ? 1n : 0n)];
}

function format(coefficient: bigint, scale: number): string {
  const magnitude = coefficient < 0n ? -coefficient : coefficient;
  const digits = String(magnitude).padStart(scale + 1, '0');
  const unsigned = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return signedDecimal(`${coefficient < 0n ? '-' : ''}${unsigned}`);
}

/** Lower <= exact value <= upper, including negative costs below the decimal quantum. */
export function rationalDecimalBounds(value: ExactRational, scale = 18): RationalDecimalBounds {
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > 18) throw new Error('Rational decimal scale must be 0 through 18.');
  const [numerator, denominator] = integers(value);
  const [lower, upper] = integerBounds(numerator * 10n ** BigInt(scale), denominator);
  return { lower: format(lower, scale), upper: format(upper, scale), exact: lower === upper };
}

/** Round only to the final exchange increment, never via an intermediate decimal FX rate. */
export function quantizeRational(value: ExactRational, increment: string, direction: 'floor' | 'ceil'): string {
  if (direction !== 'floor' && direction !== 'ceil') throw new Error('Invalid rational quantization direction.');
  if (typeof increment !== 'string' || increment.trim() !== increment) throw new Error('Invalid rational increment.');
  const step = rationalFromDecimal(decimal(increment, { positive: true }));
  const [numerator, denominator] = integers(value), [stepNumerator, stepDenominator] = integers(step);
  const [lower, upper] = integerBounds(numerator * stepDenominator, denominator * stepNumerator);
  const count = direction === 'floor' ? lower : upper;
  const result = multiplyRational(fraction(count, 1n), step);
  const bounds = rationalDecimalBounds(result);
  if (!bounds.exact) throw new Error('Rational increment cannot be represented exactly.');
  return bounds.lower;
}
