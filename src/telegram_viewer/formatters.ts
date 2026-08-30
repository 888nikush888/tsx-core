import type { TelegramViewerSettings, TradingNotificationEvent } from '../viewer_types.js';

const TELEGRAM_MESSAGE_LIMIT = 4096;
const CALLBACK_PATTERN = /^(menu:(summary|accounts|positions|orders|trades|performance|risk|system|events|refresh|help)|page:(accounts|positions|orders|trades|risk|incidents|events):[0-9]{1,4})$/;

function clipped(value: string): string {
  if (value.length <= TELEGRAM_MESSAGE_LIMIT) return value;
  return `${value.slice(0, TELEGRAM_MESSAGE_LIMIT - 1)}…`;
}

function safeDetails(details: Record<string, unknown>): string[] {
  return Object.entries(details)
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .slice(0, 12)
    .map(([key, value]) => `${key}: ${String(value).slice(0, 500)}`);
}

export function formatTelegramViewerEvent(
  event: TradingNotificationEvent,
  settings: TelegramViewerSettings,
): string {
  const occurredAt = new Intl.DateTimeFormat(settings.locale, {
    timeZone: settings.timezone,
    dateStyle: 'medium',
    timeStyle: 'medium',
    hourCycle: 'h23',
  }).format(new Date(event.occurredAt));
  const lines = [
    `TSX Core · ${event.eventType.replaceAll('_', ' ')}`,
    `Zeit: ${occurredAt}`,
    event.exchange ? `Börse: ${event.exchange}${event.mode ? ` (${event.mode})` : ''}` : null,
    event.accountId ? `Konto: ${event.accountId}` : null,
    event.channelId ? `Kanal: ${event.channelId}` : null,
    event.intentId ? `Intent: ${event.intentId}` : null,
    ...safeDetails(event.details),
  ].filter((line): line is string => Boolean(line));
  return clipped(lines.join('\n'));
}

export function formatTelegramViewerProjection(resource: string, payload: Record<string, any>): string {
  if (resource === 'summary') {
    return clipped([
      'TSX Core · Status',
      `Konten: ${payload.accounts?.total ?? 0}`,
      `Aktive Positionen: ${payload.positions?.active ?? 0}`,
      `Offene Incidents: ${payload.incidents?.open ?? 0}`,
    ].join('\n'));
  }
  const singular = resource.endsWith('s') ? resource.slice(0, -1) : resource;
  const values = Array.isArray(payload[resource]) ? payload[resource] : payload[singular] ? [payload[singular]] : [];
  const lines = [`TSX Core · ${resource}`];
  for (const item of values.slice(0, 20)) {
    if (!item || typeof item !== 'object') continue;
    lines.push([
      item.name || item.symbol || item.id || resource,
      item.exchange,
      item.mode,
      item.status,
      item.realizedPnl !== undefined ? `PnL ${item.realizedPnl}` : null,
    ].filter(Boolean).join(' · '));
  }
  if (values.length === 0) lines.push('Keine Einträge.');
  return clipped(lines.join('\n'));
}

export function validTelegramViewerCallback(value: unknown): value is string {
  return typeof value === 'string' && CALLBACK_PATTERN.test(value);
}

export function telegramViewerMenu(): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  return {
    inline_keyboard: [
      [{ text: 'Status', callback_data: 'menu:summary' }, { text: 'Konten', callback_data: 'menu:accounts' }],
      [{ text: 'Positionen', callback_data: 'menu:positions' }, { text: 'Orders', callback_data: 'menu:orders' }],
      [{ text: 'Trades', callback_data: 'menu:trades' }, { text: 'Performance', callback_data: 'menu:performance' }],
      [{ text: 'Risiko', callback_data: 'menu:risk' }, { text: 'System', callback_data: 'menu:system' }],
      [{ text: 'Events', callback_data: 'menu:events' }, { text: 'Aktualisieren', callback_data: 'menu:refresh' }],
    ],
  };
}

export const TELEGRAM_VIEWER_HELP = [
  '🤖 TSX CORE',
  '🟢 System online',
  'Nur lesender Zugriff. Handels- und Konfigurationsaktionen sind nicht möglich.',
  '/status /accounts /positions /orders /trades /performance /risk /system /events /refresh /help',
].join('\n');

export const TELEGRAM_VIEWER_UNKNOWN_COMMAND = [
  'TSX Core Telegram Viewer',
  'Dieser Befehl ist nicht verfügbar. Der Viewer bietet ausschließlich lesenden Zugriff.',
].join('\n');
