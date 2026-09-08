import { TRADING_NOTIFICATION_EVENT_TYPES, type TradingNotificationEvent } from '../viewer_types.js';

export function optionalViewerRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function viewerRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Viewer API returned an invalid object.');
  return value as Record<string, unknown>;
}
export interface TelegramViewerUpdate { update_id: number; message?: unknown; callback_query?: unknown }
export function viewerUpdates(value: unknown): TelegramViewerUpdate[] {
  if (!Array.isArray(value)) return [];
  return value.map((input: unknown) => {
    const update = viewerRecord(input);
    if (typeof update.update_id !== 'number' || !Number.isSafeInteger(update.update_id) || update.update_id < 0) {
      throw new Error('Telegram Bot API returned an invalid update identity.');
    }
    return { update_id: update.update_id, message: update.message, callback_query: update.callback_query };
  });
}
export function viewerPagination(value: unknown): { offset: number; limit: number; hasMore: boolean } | undefined {
  if (value === undefined) return undefined;
  const page = viewerRecord(value);
  if (typeof page.offset !== 'number' || !Number.isSafeInteger(page.offset) || page.offset < 0
    || typeof page.limit !== 'number' || !Number.isSafeInteger(page.limit) || page.limit <= 0 || typeof page.hasMore !== 'boolean') {
    throw new Error('Viewer API returned invalid pagination.');
  }
  return { offset: page.offset, limit: page.limit, hasMore: page.hasMore };
}
export function viewerEventCursor(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < fallback) throw new Error('Viewer API returned an invalid event cursor.');
  return value;
}
export function viewerEventRecords(value: unknown): Array<Record<string, unknown> & { seq: number; id: string }> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('Viewer API returned invalid events.');
  return value.map((input: unknown) => {
    const event = viewerRecord(input);
    if (typeof event.seq !== 'number' || !Number.isSafeInteger(event.seq) || event.seq < 0 || typeof event.id !== 'string' || !event.id) {
      throw new Error('Viewer API returned invalid event identity.');
    }
    return { ...event, seq: event.seq, id: event.id };
  });
}
function nullableContext(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  throw new Error('Viewer API returned invalid notification context.');
}
function notificationMode(value: unknown): TradingNotificationEvent['mode'] {
  if (value === null) return null;
  if (value === 'paper' || value === 'testnet' || value === 'live') return value;
  throw new Error('Viewer API returned invalid notification mode.');
}
export function viewerNotification(value: unknown): TradingNotificationEvent {
  const event = viewerRecord(value);
  const identity = viewerEventRecords([event])[0];
  const eventType = TRADING_NOTIFICATION_EVENT_TYPES.find(type => type === event.eventType);
  if (!eventType || typeof event.dedupeKey !== 'string' || typeof event.occurredAt !== 'number' || typeof event.createdAt !== 'number') {
    throw new Error('Viewer API returned invalid notification metadata.');
  }
  return { seq: identity.seq, id: identity.id, eventType, dedupeKey: event.dedupeKey,
    occurredAt: event.occurredAt, createdAt: event.createdAt,
    intentId: nullableContext(event.intentId), channelId: nullableContext(event.channelId),
    accountId: nullableContext(event.accountId), exchange: nullableContext(event.exchange), mode: notificationMode(event.mode),
    details: viewerRecord(event.details) };
}
