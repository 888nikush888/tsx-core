import { createHash } from 'node:crypto';
import { maskPII } from './logger.js';

export function reviewHash(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (isReviewObject(item)) return Object.fromEntries(Object.keys(item).sort(compareReviewKeys).map(key => [key, canonical(item[key])]));
    return item;
  };
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function isReviewObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/** Match the original UTF-16 key order exactly; hashes must never depend on host locale. */
function compareReviewKeys(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

const SECRET_PATTERNS = [
  /password|passphrase|secret|credential|authorization|cookie/i,
  /(?:^token$|Token$|tokenSha|tokenPrefix)/i,
  /api[_-]?key|api[_-]?hash|sourceText|raw(Response|Request|Payload)/i,
];
/** Review-only copy: never passed back into a command or used as an authoritative configuration. */
export function redactReview(value: unknown, depth = 0, personalData = true): unknown {
  if (depth > 45) return '[Tiefe überschritten]';
  return redactReviewContent(value, depth, personalData);
}

/** Root object projection; redacted field values have no original-value type guarantee. */
export function redactReviewRecord(value: Record<string, unknown>, personalData = true): Record<string, unknown> {
  return redactReviewObject(value, 0, personalData);
}

function redactReviewContent(value: unknown, depth: number, personalData: boolean): unknown {
  if (typeof value === 'string') return redactReviewString(value, personalData);
  if (Array.isArray(value)) return redactReviewArray(value as unknown[], depth, personalData);
  if (value && typeof value === 'object') return redactReviewObject(value as Record<string, unknown>, depth, personalData);
  return value;
}

function redactReviewString(value: string, personalData: boolean): string {
  return (personalData ? maskPII(value) : value)
    .replace(/\bBearer\s+[a-z0-9._~+/=-]+/gi, 'Bearer [redigiert]')
    .replace(/(https?:\/\/)([^\s/@]+)@/gi, (match, scheme: string, userinfo: string) =>
      userinfo.includes(':') ? `${scheme}[redigiert]@` : match);
}

function redactReviewArray(items: unknown[], depth: number, personalData: boolean): unknown[] {
  return items.map(item => redactReview(item, depth + 1, personalData));
}

function isSecretKey(key: string): boolean {
  return SECRET_PATTERNS.some(pattern => pattern.test(key));
}

function redactReviewObject(record: Record<string, unknown>, depth: number, personalData: boolean): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).map(([key, item]) =>
    [key, isSecretKey(key) ? '[redigiert]' : redactReview(item, depth + 1, personalData)]));
}
