import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const cursorKey = randomBytes(32);
export interface UiCursor {
  version: 1;
  filter: string;
  observedAt: number;
  createdAt: number;
  id: string;
}
export function filterFingerprint(filters: unknown): string {
  return createHash('sha256').update(JSON.stringify(filters)).digest('hex');
}
export function encodeUiCursor(value: UiCursor): string {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${payload}.${createHmac('sha256', cursorKey).update(payload).digest('base64url')}`;
}
function validCursorSelection(parsed: UiCursor, filter: string): boolean {
  return parsed?.version === 1 && parsed.filter === filter && typeof parsed.id === 'string' && parsed.id.length > 0 && parsed.id.length <= 512;
}
function validCursorTimes(parsed: UiCursor): boolean {
  return Number.isSafeInteger(parsed.observedAt) && parsed.observedAt >= 0 && Number.isSafeInteger(parsed.createdAt) && parsed.createdAt >= 0 && parsed.createdAt <= parsed.observedAt;
}
export function decodeUiCursor(value: unknown, filter: string): UiCursor | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid page cursor. Reload the first page.');
  const [payload, signature, extra] = value.split('.');
  const expected = createHmac('sha256', cursorKey).update(payload).digest();
  const actual = Buffer.from(signature ?? '', 'base64url');
  if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Page cursor expired or invalid. Reload the first page.');
  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString()) as UiCursor;
  if (!validCursorSelection(parsed, filter) || !validCursorTimes(parsed)) throw new Error('Page cursor does not match this selection. Reload the first page.');
  return parsed;
}
