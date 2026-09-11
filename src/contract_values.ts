/** Validate raw scalar contracts before comparing them; objects must never supply identity through coercion. */
export function isStringMember(value: unknown, allowed: readonly string[]): value is string {
  return typeof value === 'string' && allowed.includes(value);
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string.`);
  return value;
}

/** Do not invoke arbitrary object coercion or serialize possibly secret-bearing objects in diagnostics. */
export function unknownErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error === null) return 'null';
  return primitiveErrorMessage(error)
    ?? 'A non-Error value was thrown; inspect the operation receipt for context.';
}

const STRINGIFIABLE_PRIMITIVE_TYPES: ReadonlySet<string> = new Set([
  'string', 'number', 'boolean', 'bigint', 'symbol', 'undefined',
]);

function primitiveErrorMessage(error: unknown): string | null {
  if (typeof error === 'string') return error;
  if (!STRINGIFIABLE_PRIMITIVE_TYPES.has(typeof error)) return null;
  return String(error);
}
