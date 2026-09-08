import { createHash } from 'node:crypto';
import { maskPII } from './logger.js';

export function reviewHash(value: unknown): string {
  const canonical = (item: any): any => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object') return Object.fromEntries(Object.keys(item).sort(compareReviewKeys).map(key => [key, canonical(item[key])]));
    return item;
  };
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
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
export function redactReview(value: unknown, depth = 0, personalData = true): any {
  if (depth > 45) return '[Tiefe überschritten]';
  if (typeof value === 'string') return (personalData ? maskPII(value) : value)
    .replace(/\bBearer\s+[a-z0-9._~+/=-]+/gi, 'Bearer [redigiert]')
    .replace(/(https?:\/\/)([^\s/@]+)@/gi, (match, scheme: string, userinfo: string) =>
      userinfo.slice(1, -1).includes(':') ? `${scheme}[redigiert]@` : match);
  if (Array.isArray(value)) return value.map(item => redactReview(item, depth + 1, personalData));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, SECRET_PATTERNS.some(pattern => pattern.test(key)) ? '[redigiert]' : redactReview(item, depth + 1, personalData)]));
  return value;
}
