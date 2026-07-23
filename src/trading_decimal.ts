const DECIMAL_PATTERN = /^(?:0|[1-9]\d{0,35})(?:\.\d{1,18})?$/;

interface ParsedDecimal {
  coefficient: bigint;
  scale: number;
}

function powerOfTen(exponent: number): bigint {
  if (!Number.isSafeInteger(exponent) || exponent < 0 || exponent > 36) {
    throw new Error('Decimal scale is outside the supported range.');
  }
  return 10n ** BigInt(exponent);
}

function parse(value: string): ParsedDecimal {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) {
    throw new Error(`Invalid unsigned decimal '${String(value)}'.`);
  }
  const [integer, fraction = ''] = value.split('.');
  return { coefficient: BigInt(integer + fraction), scale: fraction.length };
}

function format(coefficient: bigint, scale: number): string {
  if (coefficient < 0n) throw new Error('Unsigned decimal result must not be negative.');
  const digits = coefficient.toString().padStart(scale + 1, '0');
  if (scale === 0) return digits;
  const integer = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/, '');
  return fraction ? `${integer}.${fraction}` : integer;
}

function align(left: ParsedDecimal, right: ParsedDecimal): [bigint, bigint, number] {
  const scale = Math.max(left.scale, right.scale);
  return [
    left.coefficient * powerOfTen(scale - left.scale),
    right.coefficient * powerOfTen(scale - right.scale),
    scale,
  ];
}

export function decimal(value: string, options: { positive?: boolean; max?: string } = {}): string {
  const parsed = parse(value.trim());
  const normalized = format(parsed.coefficient, parsed.scale);
  if (options.positive && parsed.coefficient === 0n) throw new Error('Decimal must be greater than zero.');
  if (options.max && compareDecimal(normalized, options.max) > 0) {
    throw new Error(`Decimal must not exceed ${options.max}.`);
  }
  return normalized;
}

export function compareDecimal(left: string, right: string): number {
  const [leftValue, rightValue] = align(parse(left), parse(right));
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

export function addDecimal(left: string, right: string): string {
  const [leftValue, rightValue, scale] = align(parse(left), parse(right));
  return format(leftValue + rightValue, scale);
}

export function subtractDecimal(left: string, right: string): string {
  const [leftValue, rightValue, scale] = align(parse(left), parse(right));
  if (rightValue > leftValue) throw new Error('Unsigned decimal subtraction would be negative.');
  return format(leftValue - rightValue, scale);
}

export function multiplyDecimal(left: string, right: string): string {
  const a = parse(left);
  const b = parse(right);
  const productScale = a.scale + b.scale;
  const coefficient = a.coefficient * b.coefficient;
  if (productScale <= 18) return format(coefficient, productScale);
  return format(coefficient / powerOfTen(productScale - 18), 18);
}

export function divideDecimal(left: string, right: string, scale = 18): string {
  const a = parse(left);
  const b = parse(right);
  if (b.coefficient === 0n) throw new Error('Division by zero.');
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > 18) throw new Error('Division scale must be between 0 and 18.');
  const numerator = a.coefficient * powerOfTen(scale + b.scale);
  const denominator = b.coefficient * powerOfTen(a.scale);
  return format(numerator / denominator, scale);
}

export function sumDecimals(values: string[]): string {
  return values.reduce((total, value) => addDecimal(total, value), '0');
}

export function midpointDecimal(range: { min: string; max: string }): string {
  if (compareDecimal(range.min, range.max) > 0) throw new Error('Decimal range is inverted.');
  return divideDecimal(addDecimal(range.min, range.max), '2');
}

export function minDecimal(...values: string[]): string {
  if (values.length === 0) throw new Error('At least one decimal is required.');
  return values.slice(1).reduce(
    (minimum, value) => compareDecimal(value, minimum) < 0 ? value : minimum,
    values[0]!,
  );
}

export function quantizeDecimalDown(value: string, increment: string): string {
  decimal(value);
  decimal(increment, { positive: true });
  return multiplyDecimal(divideDecimal(value, increment, 0), increment);
}

export function signedDecimal(value: string): string {
  if (typeof value !== 'string') throw new Error('Invalid signed decimal.');
  const negative = value.startsWith('-');
  const normalized = decimal(negative ? value.slice(1) : value);
  return negative && normalized !== '0' ? `-${normalized}` : normalized;
}

export function addSignedDecimal(left: string, right: string): string {
  const a = signedDecimal(left);
  const b = signedDecimal(right);
  const aNegative = a.startsWith('-');
  const bNegative = b.startsWith('-');
  const aMagnitude = aNegative ? a.slice(1) : a;
  const bMagnitude = bNegative ? b.slice(1) : b;
  if (aNegative === bNegative) {
    const sum = addDecimal(aMagnitude, bMagnitude);
    return aNegative && sum !== '0' ? `-${sum}` : sum;
  }
  const order = compareDecimal(aMagnitude, bMagnitude);
  if (order === 0) return '0';
  const difference = order > 0
    ? subtractDecimal(aMagnitude, bMagnitude)
    : subtractDecimal(bMagnitude, aMagnitude);
  const negative = order > 0 ? aNegative : bNegative;
  return negative ? `-${difference}` : difference;
}

export function signedDifference(left: string, right: string): string {
  const order = compareDecimal(left, right);
  if (order === 0) return '0';
  const greater = order > 0 ? left : right;
  const lesser = order > 0 ? right : left;
  const difference = subtractDecimal(greater, lesser);
  return order > 0 ? difference : `-${difference}`;
}
