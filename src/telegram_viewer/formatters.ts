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

function values(payload: Record<string, any>, key: string): any[] {
  const value = payload[key];
  if (Array.isArray(value)) return value;
  const singular = key.endsWith('s') ? key.slice(0, -1) : key;
  return payload[singular] && typeof payload[singular] === 'object' ? [payload[singular]] : [];
}

function line(parts: unknown[]): string {
  return parts.filter(value => value !== null && value !== undefined && value !== '').join(' · ');
}

function listMessage(title: string, items: string[]): string {
  return clipped([`TSX Core · ${title}`, ...(items.length > 0 ? items : ['Keine Einträge.'])].join('\n'));
}

function leverageLines(value: unknown): string[] {
  if (typeof value === 'number' || typeof value === 'string') {
    return value === '' || !Number.isFinite(Number(value)) ? [] : [`Leverage: ${value}`];
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const leverage = value as Record<string, unknown>;
  return [
    leverage.effective !== null && leverage.effective !== undefined ? `Effective: ${leverage.effective}` : null,
    leverage.requested !== null && leverage.requested !== undefined ? `Requested: ${leverage.requested}` : null,
    leverage.source ? `Source: ${leverage.source}` : null,
    leverage.cappedBy ? `CappedBy: ${leverage.cappedBy}` : null,
    leverage.effective === undefined && leverage.legacy !== null && leverage.legacy !== undefined
      ? `Leverage: ${leverage.legacy}` : null,
  ].filter((item): item is string => item !== null);
}

export function formatSummary(payload: Record<string, any>): string {
  return clipped([
    'TSX Core · Übersicht',
    `Konten: ${payload.accounts?.total ?? 0}`,
    `Aktive Positionen: ${payload.positions?.active ?? 0}`,
    `Offene Intents: ${payload.intents?.active ?? 0}`,
    `Offene Incidents: ${payload.incidents?.open ?? 0}`,
  ].join('\n'));
}

export function formatAccounts(payload: Record<string, any>): string {
  return listMessage('Accounts', values(payload, 'accounts').map(item => line([
    item.name || item.id || 'Konto', item.exchange, item.mode, item.status,
    item.equity !== null && item.equity !== undefined
      ? `Equity ${item.equity}${item.reportingCurrency ? ` ${item.reportingCurrency}` : ''}` : null,
  ])));
}

export function formatPositions(payload: Record<string, any>): string {
  const items = values(payload, 'positions').map(item => [
    line([item.symbol || item.id || 'Position', item.exchange, item.mode, item.side, item.status]),
    ...leverageLines(item.leverage),
    item.quantity !== undefined ? `Menge: ${item.quantity}` : null,
    item.averageEntryPrice !== null && item.averageEntryPrice !== undefined ? `Entry: ${item.averageEntryPrice}` : null,
    item.stopPrice !== null && item.stopPrice !== undefined ? `Stop: ${item.stopPrice}` : null,
  ].filter((value): value is string => Boolean(value)).join('\n'));
  return listMessage('Positionen', items);
}

export function formatOrders(payload: Record<string, any>): string {
  return listMessage('Orders', values(payload, 'orders').map(item => line([
    item.symbol || item.id || 'Order', item.exchange, item.role, item.side, item.status,
    item.filledQuantity !== undefined ? `${item.filledQuantity}/${item.quantity ?? '?'}` : null,
  ])));
}

export function formatTrades(payload: Record<string, any>): string {
  return listMessage('Trades', values(payload, 'trades').map(item => {
    const summary = line([
      item.symbol || item.id || 'Trade', item.exchange, item.mode, item.side, item.status,
      item.realizedPnl !== null && item.realizedPnl !== undefined ? `PnL ${item.realizedPnl}` : null,
    ]);
    return [summary, ...leverageLines(item.leverage)].join('\n');
  }));
}

export function formatPerformance(payload: Record<string, any>): string {
  return listMessage('Performance', values(payload, 'groups').map(item => line([
    item.channelId || item.accountId || 'Gruppe', item.exchange, item.mode,
    item.trades !== undefined ? `${item.trades} Trades` : null,
    item.realizedPnl !== undefined ? `PnL ${item.realizedPnl}` : null,
  ])));
}

export function formatRisk(payload: Record<string, any>): string {
  return listMessage('Risk', values(payload, 'events').map(item => line([
    item.severity, item.code || item.eventType || item.id, item.accountId, item.acknowledgedAt ? 'quittiert' : null,
  ])));
}

export function formatSystem(payload: Record<string, any>): string {
  return clipped([
    'TSX Core · System',
    `Execution: ${payload.executionEnabled ? 'aktiv' : 'inaktiv'}`,
    `Live: ${payload.liveTradingEnabled ? 'aktiv' : 'inaktiv'}`,
    `Kill-Switch: ${payload.killSwitchActive ? 'aktiv' : 'inaktiv'}`,
    `Offene Incidents: ${payload.openIncidents ?? 0}`,
  ].join('\n'));
}

export function formatEvents(payload: Record<string, any>): string {
  return listMessage('Events', values(payload, 'events').map(item => line([
    item.eventType || item.code || item.id || 'Event', item.exchange, item.mode, item.accountId, item.intentId,
  ])));
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

export function formatNotification(
  event: TradingNotificationEvent,
  settings: TelegramViewerSettings,
): string {
  return formatTelegramViewerEvent(event, settings);
}

export function formatTelegramViewerProjection(resource: string, payload: Record<string, any>): string {
  if (resource === 'summary') return formatSummary(payload);
  if (resource === 'accounts') return formatAccounts(payload);
  if (resource === 'positions') return formatPositions(payload);
  if (resource === 'orders') return formatOrders(payload);
  if (resource === 'trades') return formatTrades(payload);
  if (resource === 'performance') return formatPerformance(payload);
  if (resource === 'risk' || resource === 'incidents') return formatRisk(payload);
  if (resource === 'system') return formatSystem(payload);
  if (resource === 'events') return formatEvents(payload);
  return listMessage(resource, []);
}

export function validTelegramViewerCallback(value: unknown): value is string {
  return typeof value === 'string' && CALLBACK_PATTERN.test(value);
}

export function telegramViewerMenu(
  resource?: string,
  pagination?: { offset: number; limit: number; hasMore: boolean },
): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  const inlineKeyboard = [
      [{ text: 'Status', callback_data: 'menu:summary' }, { text: 'Konten', callback_data: 'menu:accounts' }],
      [{ text: 'Positionen', callback_data: 'menu:positions' }, { text: 'Orders', callback_data: 'menu:orders' }],
      [{ text: 'Trades', callback_data: 'menu:trades' }, { text: 'Performance', callback_data: 'menu:performance' }],
      [{ text: 'Risiko', callback_data: 'menu:risk' }, { text: 'System', callback_data: 'menu:system' }],
      [{ text: 'Events', callback_data: 'menu:events' }, { text: 'Aktualisieren', callback_data: 'menu:refresh' }],
  ];
  if (resource && pagination && ['accounts', 'positions', 'orders', 'trades', 'risk', 'incidents'].includes(resource)) {
    const page = Math.floor(pagination.offset / pagination.limit);
    const navigation: Array<{ text: string; callback_data: string }> = [];
    if (page > 0) navigation.push({ text: '← Zurück', callback_data: `page:${resource}:${page - 1}` });
    if (pagination.hasMore) navigation.push({ text: 'Weiter →', callback_data: `page:${resource}:${page + 1}` });
    if (navigation.length > 0) inlineKeyboard.push(navigation);
  }
  return { inline_keyboard: inlineKeyboard };
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
