import type { FilterMessage } from './filters.js';
import type { Config } from './config.js';
import type { TradingSignalSchema, SignalContractVersion, WorkflowRevision } from './trading_types.js';
import type { RouteRow } from './trading_repository_rows.js';

/** Only consumed identity fields are projected; persistence retains the complete Telegram payload. */
export interface TelegramMessageIdentity extends FilterMessage {
  id: number; chat_id: number; is_outgoing?: boolean; media_group_id?: string;
}
export interface DurableIngressSnapshot {
  id: string; chatId: string; receivedAt: number; workflowRevisionId: string | null;
  targetChatId: string | number | null; workflow?: WorkflowRevision | null;
  deliveryMode?: 'telegram_xml' | 'telegram_original'; parsedXml?: string;
  albumMessages?: TelegramMessageIdentity[]; planKey?: string;
  schemas?: TradingSignalSchema[]; contracts?: Record<string, SignalContractVersion>; prompts?: Record<string, string>;
  legacySchema?: TradingSignalSchema | null; legacyPrompt?: string; legacyRoute?: RouteRow | null;
}
export interface IngressConfiguration extends Config {
  durableIngress?: DurableIngressSnapshot;
  resolvedTargetChatId?: number | string | null;
}

function objectValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function formattedText(value: unknown): boolean {
  return value === undefined || (objectValue(value) && (value.text === undefined || typeof value.text === 'string'));
}
function messageContent(value: unknown): boolean {
  return value === undefined || (objectValue(value) && (value._ === undefined || typeof value._ === 'string')
    && formattedText(value.text) && formattedText(value.caption));
}

/** Check fields used by routing without rebuilding or truncating the full source payload. */
export function assertIngressMessage(value: unknown): asserts value is TelegramMessageIdentity {
  if (!objectValue(value) || !Number.isSafeInteger(value.id) || !Number.isSafeInteger(value.chat_id)) {
    throw new Error('Incoming message requires safe Telegram message and chat IDs.');
  }
  if ((value.media_group_id !== undefined && typeof value.media_group_id !== 'string')
    || (value.is_outgoing !== undefined && typeof value.is_outgoing !== 'boolean') || !messageContent(value.content)) {
    throw new Error('Incoming message content or album identity is invalid.');
  }
}

export function readIngressMessage(encoded: string): TelegramMessageIdentity {
  const value: unknown = JSON.parse(encoded);
  assertIngressMessage(value);
  return value;
}
