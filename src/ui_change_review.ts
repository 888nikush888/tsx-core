import { createHash } from 'node:crypto';
import { maskPII } from './logger.js';

export function reviewHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalReviewValue(value))).digest('hex');
}

function canonicalReviewValue(item: unknown): unknown {
  if (Array.isArray(item)) return item.map(canonicalReviewValue);
  if (item && typeof item === 'object') {
    const record = item as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort(compareReviewKeys).map(key => [key, canonicalReviewValue(record[key])]));
  }
  return item;
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
export function redactReview<T>(value: T, depth = 0, personalData = true): T {
  if (depth > 45) return '[Tiefe überschritten]' as T;
  return redactReviewContent(value, depth, personalData);
}

function redactReviewContent<T>(value: T, depth: number, personalData: boolean): T {
  if (typeof value === 'string') return redactReviewString(value, personalData) as T;
  if (Array.isArray(value)) return redactReviewArray(value as unknown[], depth, personalData) as T;
  if (value && typeof value === 'object') return redactReviewObject(value as Record<string, unknown>, depth, personalData) as T;
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
