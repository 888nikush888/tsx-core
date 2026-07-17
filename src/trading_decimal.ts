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
  return format(a.coefficient * b.coefficient, a.scale + b.scale);
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
