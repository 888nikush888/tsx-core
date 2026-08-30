import { randomUUID } from 'node:crypto';

import { getDatabase } from './db.js';
import { tradingExchangeId } from './trading_types.js';
import {
  TRADING_NOTIFICATION_EVENT_TYPES,
  type TelegramViewerTestEvent,
  type TradingNotificationEvent,
  type TradingNotificationEventType,
} from './viewer_types.js';

export { TRADING_NOTIFICATION_EVENT_TYPES } from './viewer_types.js';

const EVENT_TYPE_SET = new Set<string>(TRADING_NOTIFICATION_EVENT_TYPES);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/;
const SENSITIVE_KEY = /(secret|token|password|private.?key|api.?key|api.?hash|authorization|credential)/i;
const MAXIMUM_DETAILS_BYTES = 32 * 1024;

function identifier(value: unknown, label: string, nullable = false): string | null {
  if ((value === null || value === undefined) && nullable) return null;
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function channelIdentifier(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^-?[A-Za-z0-9][A-Za-z0-9:._/-]{0,254}$/.test(value)) {
    throw new Error('Notification channel identifier is invalid.');
  }
  return value;
}

function timestamp(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} is invalid.`);
  return number;
}

function assertNoSecrets(value: unknown, depth = 0): void {
  if (depth > 8) throw new Error('Notification event details exceed the safe nesting depth.');
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecrets(item, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) throw new Error('Notification event details must not contain secrets.');
    assertNoSecrets(item, depth + 1);
  }
}

function detailsJson(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Notification event details must be an object.');
  }
  assertNoSecrets(value);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > MAXIMUM_DETAILS_BYTES) {
    throw new Error('Notification event details exceed the maximum size.');
  }
  return serialized;
}

function eventType(value: unknown): TradingNotificationEventType {
  if (typeof value !== 'string' || !EVENT_TYPE_SET.has(value)) {
    throw new Error('Notification event type is invalid.');
  }
  return value as TradingNotificationEventType;
}

function eventFromRow(row: any): TradingNotificationEvent {
  return {
    seq: Number(row.seq),
    id: String(row.id),
    dedupeKey: String(row.dedupe_key),
    eventType: eventType(row.event_type),
    intentId: row.intent_id === null ? null : String(row.intent_id),
    channelId: row.channel_id === null ? null : String(row.channel_id),
    accountId: row.account_id === null ? null : String(row.account_id),
    exchange: row.exchange === null ? null : tradingExchangeId(row.exchange),
    mode: row.mode,
    occurredAt: Number(row.occurred_at),
    createdAt: Number(row.created_at),
    details: JSON.parse(String(row.details_json)),
  };
}

export async function recordTradingNotificationEvent(input: {
  id?: unknown;
  dedupeKey: unknown;
  eventType: unknown;
  intentId?: unknown;
  channelId?: unknown;
  accountId?: unknown;
  exchange?: unknown;
  mode?: unknown;
  occurredAt: unknown;
  details: unknown;
  now?: unknown;
}): Promise<{ inserted: boolean; event: TradingNotificationEvent }> {
  const id = input.id === undefined ? randomUUID() : identifier(input.id, 'Notification event identifier')!;
  const dedupeKey = identifier(input.dedupeKey, 'Notification event dedupe key')!;
  const type = eventType(input.eventType);
  const intentId = identifier(input.intentId, 'Notification intent identifier', true);
  const channelId = channelIdentifier(input.channelId);
  const accountId = identifier(input.accountId, 'Notification account identifier', true);
  const exchange = input.exchange === null || input.exchange === undefined ? null : tradingExchangeId(input.exchange);
  const mode = input.mode === null || input.mode === undefined ? null : String(input.mode);
  if (mode !== null && !['paper', 'testnet', 'live'].includes(mode)) throw new Error('Notification account mode is invalid.');
  const occurredAt = timestamp(input.occurredAt, 'Notification event timestamp');
  const createdAt = input.now === undefined ? Date.now() : timestamp(input.now, 'Notification creation timestamp');
  const serializedDetails = detailsJson(input.details);
  const result = await getDatabase().run(
    `INSERT OR IGNORE INTO trading_notification_events (
       id, dedupe_key, event_type, intent_id, channel_id, account_id, exchange, mode,
       occurred_at, created_at, details_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, dedupeKey, type, intentId, channelId, accountId, exchange, mode, occurredAt, createdAt, serializedDetails],
  );
  const row = await getDatabase().get<any>(
    'SELECT * FROM trading_notification_events WHERE dedupe_key = ?',
    [dedupeKey],
  );
  if (!row) throw new Error('Notification event could not be read after persistence.');
  return { inserted: Number(result.changes || 0) === 1, event: eventFromRow(row) };
}

function cursorInput(value: unknown, label: string): number {
  const number = Number(value ?? 0);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} is invalid.`);
  return number;
}

function boundedLimit(value: unknown): number {
  const number = Number(value ?? 100);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Viewer event limit is invalid.');
  return Math.min(number, 100);
}

export async function listTradingNotificationEvents(input: {
  afterSeq?: unknown;
  limit?: unknown;
} = {}): Promise<{ events: TradingNotificationEvent[]; nextSeq: number }> {
  const afterSeq = cursorInput(input.afterSeq, 'Notification event cursor');
  const rows = await getDatabase().all<any[]>(
    'SELECT * FROM trading_notification_events WHERE seq > ? ORDER BY seq LIMIT ?',
    [afterSeq, boundedLimit(input.limit)],
  );
  const events = rows.map(eventFromRow);
  return { events, nextSeq: events.at(-1)?.seq ?? afterSeq };
}

function testEventFromRow(row: any): TelegramViewerTestEvent {
  return {
    seq: Number(row.seq),
    id: String(row.id),
    createdAt: Number(row.created_at),
    createdBy: String(row.created_by),
    message: String(row.message),
  };
}

export async function createTelegramViewerTestEvent(input: {
  createdBy: unknown;
  message: unknown;
  now?: unknown;
}): Promise<TelegramViewerTestEvent> {
  const createdBy = identifier(input.createdBy, 'Telegram viewer test-event actor')!;
  if (typeof input.message !== 'string' || input.message.trim().length < 1 || input.message.trim().length > 1_000
    || /\0/.test(input.message)) {
    throw new Error('Telegram viewer test-event message is invalid.');
  }
  const event = {
    id: randomUUID(),
    createdAt: input.now === undefined ? Date.now() : timestamp(input.now, 'Telegram viewer test-event timestamp'),
    createdBy,
    message: input.message.trim(),
  };
  const result = await getDatabase().run(
    `INSERT INTO telegram_viewer_test_events (id, created_at, created_by, message)
     VALUES (?, ?, ?, ?)`,
    [event.id, event.createdAt, event.createdBy, event.message],
  );
  return { seq: Number(result.lastID), ...event };
}

export async function listTelegramViewerTestEvents(input: {
  afterSeq?: unknown;
  limit?: unknown;
} = {}): Promise<{ events: TelegramViewerTestEvent[]; nextSeq: number }> {
  const afterSeq = cursorInput(input.afterSeq, 'Telegram viewer test-event cursor');
  const rows = await getDatabase().all<any[]>(
    'SELECT * FROM telegram_viewer_test_events WHERE seq > ? ORDER BY seq LIMIT ?',
    [afterSeq, boundedLimit(input.limit)],
  );
  const events = rows.map(testEventFromRow);
  return { events, nextSeq: events.at(-1)?.seq ?? afterSeq };
}
