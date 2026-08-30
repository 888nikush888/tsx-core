import { addLog } from './logger.js';
import { recordTradingNotificationEvent } from './viewer_repository.js';
import type { TradingNotificationEventType } from './viewer_types.js';

export interface TradingNotificationInput {
  dedupeKey: unknown;
  eventType: unknown;
  intentId?: unknown;
  channelId?: unknown;
  accountId?: unknown;
  exchange?: unknown;
  mode?: unknown;
  occurredAt: unknown;
  details: unknown;
}

export async function recordTradingNotificationBestEffort(input: TradingNotificationInput): Promise<boolean> {
  try {
    const result = await recordTradingNotificationEvent(input);
    return result.inserted;
  } catch (error) {
    addLog(`[WARN] Trading notification event could not be persisted; trading state remains authoritative: ${
      error instanceof Error ? error.message : 'unknown persistence error'
    }`, { event: 'trading_notification_persistence_failed' });
    return false;
  }
}

function executionDedupe(input: {
  eventType: string;
  occurredAt: number;
  intentId?: string | null;
  channelId?: string | null;
  accountId?: string | null;
  correlationId?: string | null;
}): string {
  if (input.intentId) return `${input.eventType}:${input.intentId}`;
  if (input.correlationId) return `${input.eventType}:${input.correlationId}`;
  return `${input.eventType}:${input.accountId || input.channelId || 'global'}:${input.occurredAt}`;
}

const EXECUTION_NOTIFICATION_TYPES: Partial<Record<string, TradingNotificationEventType>> = {
  signal_received: 'signal_received',
  signal_validated: 'signal_validated',
  intent_created: 'intent_created',
  exchange_ack: 'exchange_ack',
  first_fill: 'partial_fill',
  fully_filled: 'position_opened',
  position_closed: 'position_closed',
  kill_switch_activated: 'kill_switch_activated',
};

export async function recordExecutionNotificationBestEffort(input: {
  eventType: string;
  occurredAt: number;
  intentId?: string | null;
  channelId?: string | null;
  accountId?: string | null;
  exchange?: string | null;
  mode?: string | null;
  details?: Record<string, unknown>;
  correlationId?: string | null;
}): Promise<void> {
  const notificationType = EXECUTION_NOTIFICATION_TYPES[input.eventType];
  if (!notificationType) return;
  await recordTradingNotificationBestEffort({
    dedupeKey: executionDedupe(input),
    eventType: notificationType,
    intentId: input.intentId,
    channelId: input.channelId,
    accountId: input.accountId,
    exchange: input.exchange,
    mode: input.mode,
    occurredAt: input.occurredAt,
    details: input.details || {},
  });
  if (input.eventType === 'intent_created' && input.details?.status === 'blocked') {
    await recordTradingNotificationBestEffort({
      dedupeKey: `intent-blocked:${input.intentId || input.correlationId || input.occurredAt}`,
      eventType: 'intent_blocked',
      intentId: input.intentId,
      channelId: input.channelId,
      accountId: input.accountId,
      exchange: input.exchange,
      mode: input.mode,
      occurredAt: input.occurredAt,
      details: input.details,
    });
  }
}
