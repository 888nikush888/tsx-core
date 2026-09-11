import { redactReview } from './ui_change_review.js';
import { decodeUiCursor, encodeUiCursor, filterFingerprint } from './ui_cursor.js';

function protectedKey(key: string) { return redactReview({ [key]: null })[key] !== null; }
function reviewNode(root: unknown, path: unknown): { node: unknown; path: string[] } {
  if (!Array.isArray(path) || path.length > 40 || path.some(key => typeof key !== 'string' || key.length > 256)) throw new Error('Invalid review path.');
  let node: unknown = root;
  for (const key of path) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error('Review path is unavailable.');
    if (protectedKey(key) || !node || typeof node !== 'object' || !Object.hasOwn(node, key)) throw new Error('Review path is unavailable.');
    node = (node as Record<string, unknown>)[key];
  }
  return { node, path };
}
function nodeEntry(key: string, value: any, path: string[]) {
  if (protectedKey(key)) return { key, type: 'redacted', value: '[redigiert]', expandable: false };
  const container = value !== null && typeof value === 'object'; const text = typeof value === 'string';
  const scalarType = Array.isArray(value) ? 'array' : typeof value;
  let displayValue = value;
  if (container) displayValue = null;
  else if (text) displayValue = redactReview(value.slice(0, 1000));
  return { key, type: value === null ? 'null' : scalarType,
    value: displayValue,
    childCount: container ? Object.keys(value).length : null, expandable: container || (text && value.length > 1000), path: [...path, key] };
}
function textSection(node: string, offset: number) {
  let end = Math.min(node.length, offset + 10000);
  if (end < node.length && /[\uD800-\uDBFF]/u.test(node[end - 1])) end--;
  return { end, text: redactReview(node.slice(offset, end)) };
}
/** Bounded content navigation; path selects only keys inside an already authorized review object. */
export function uiReviewTree(root: unknown, query: URLSearchParams, scope: unknown) {
  const { node, path } = reviewNode(root, JSON.parse(query.get('path') || '[]'));
  const filter = filterFingerprint({ scope, path }); const cursor = decodeUiCursor(query.get('cursor'), filter);
  const offset = cursor ? Number(cursor.id) : 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid review cursor.');
  const observedAt = cursor?.observedAt ?? Date.now();
  const next = (position: number) => encodeUiCursor({ version: 1, filter, observedAt, createdAt: 0, id: String(position) });
  if (typeof node === 'string') {
    const { end, text } = textSection(node, offset);
    return { path, type: 'string', text, observedAt, hasMore: end < node.length, nextCursor: end < node.length ? next(end) : null, entries: [] };
  }
  const keys = node !== null && typeof node === 'object' ? Object.keys(node) : [];
  const hasMore = offset + 30 < keys.length;
  return { path, type: Array.isArray(node) ? 'array' : typeof node, value: keys.length ? undefined : node, observedAt, total: keys.length,
    entries: keys.slice(offset, offset + 30).map(key => nodeEntry(key, node[key], path)), hasMore, nextCursor: hasMore ? next(offset + 30) : null };
}
