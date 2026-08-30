import type { TradingAccountMode, TradingExchange } from './trading_types.js';

export const TRADING_NOTIFICATION_EVENT_TYPES = [
  'position_opened',
  'partial_fill',
  'take_profit_filled',
  'stop_loss_filled',
  'stop_moved',
  'position_closed',
  'intent_blocked',
  'execution_failed',
  'reconciliation_failed',
  'account_incident_opened',
  'account_incident_resolved',
  'exchange_stream_degraded',
  'exchange_stream_recovered',
  'kill_switch_activated',
  'signal_received',
  'signal_validated',
  'intent_created',
  'exchange_ack',
  'workflow_fallback_candidate_skipped',
] as const;

export type TradingNotificationEventType = typeof TRADING_NOTIFICATION_EVENT_TYPES[number];

export interface TradingNotificationEvent {
  seq: number;
  id: string;
  dedupeKey: string;
  eventType: TradingNotificationEventType;
  intentId: string | null;
  channelId: string | null;
  accountId: string | null;
  exchange: TradingExchange | null;
  mode: TradingAccountMode | null;
  occurredAt: number;
  createdAt: number;
  details: Record<string, unknown>;
}

export interface TelegramViewerTestEvent {
  seq: number;
  id: string;
  createdAt: number;
  createdBy: string;
  message: string;
}

export interface TelegramViewerSettings {
  enabled: boolean;
  allowedUserIds: string[];
  timezone: string;
  locale: string;
  eventPollingIntervalMs: number;
  notifications: {
    positionOpened: boolean;
    takeProfitFilled: boolean;
    stopLossFilled: boolean;
    positionClosed: boolean;
    executionFailed: boolean;
    accountIncidentOpened: boolean;
    accountIncidentResolved: boolean;
    exchangeStreamDegraded: boolean;
    exchangeStreamRecovered: boolean;
    killSwitchActivated: boolean;
    signalReceived: boolean;
    signalValidated: boolean;
    intentCreated: boolean;
    exchangeAcknowledged: boolean;
  };
  display: {
    detailLevel: 'compact' | 'normal' | 'detailed';
    pnlMode: 'absolute' | 'absolute_and_percent';
    timeFormat: '24h';
  };
}
