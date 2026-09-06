import { createHash } from 'node:crypto';
import { maskPII } from './logger.js';

export function reviewHash(value: unknown): string {
  const canonical = (item: any): any => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

const SECRET = /password|passphrase|secret|credential|authorization|cookie|(?:^token$|Token$|tokenSha|tokenPrefix)|api[_-]?key|api[_-]?hash|sourceText|raw(Response|Request|Payload)/i;
/** Review-only copy: never passed back into a command or used as an authoritative configuration. */
export function redactReview(value: unknown, depth = 0, personalData = true): any {
  if (depth > 45) return '[Tiefe überschritten]';
  if (typeof value === 'string') return (personalData ? maskPII(value) : value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redigiert]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redigiert]@');
  if (Array.isArray(value)) return value.map(item => redactReview(item, depth + 1, personalData));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, SECRET.test(key) ? '[redigiert]' : redactReview(item, depth + 1, personalData)]));
  return value;
}
