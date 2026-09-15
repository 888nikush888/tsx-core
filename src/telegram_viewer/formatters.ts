import type { TelegramViewerSettings, TradingNotificationEvent } from '../viewer_types.js';
import { moneyValueFromDecimal, validateMoneyValue, type MoneyValue } from '../trading_money_value.js';

const TELEGRAM_MESSAGE_LIMIT = 4096;
const CALLBACK_PATTERNS = [
  /^menu:(summary|accounts|positions|orders|trades|performance|risk|system|events|refresh|help)$/,
  /^page:(accounts|positions|orders|trades|risk|incidents|events):\d{1,4}$/,
];

function clipped(value: string): string {
  if (value.length <= TELEGRAM_MESSAGE_LIMIT) return value;
  const suffix = '\n… Weitere Einträge im Viewer.';
  const prefix = value.slice(0, TELEGRAM_MESSAGE_LIMIT - suffix.length);
  // Do not truncate a fraction/bound and leave it looking like a complete numeric claim.
  return `${prefix.slice(0, Math.max(0, prefix.lastIndexOf('\n')))}${suffix}`;
}

function safeDetails(details: Record<string, unknown>): string[] {
  const hasMoney = 'realizedPnl' in details || 'realizedPnlValue' in details;
  return Object.entries(details)
    .filter((entry): entry is [string, string | number | boolean] => !(hasMoney && ['realizedPnl', 'reportingCurrency', 'accountingStatus'].includes(entry[0]))
      && scalarText(entry[1]) !== null)
    .slice(0, 12)
    .map(([key, value]) => `${key}: ${String(value).slice(0, 500)}`);
}

// These compiler views permit only the original JavaScript property operations.
// They do not validate a record or its fields: values remain unknown, primitives
// retain native boxing, and null/property-membership errors remain native.
function legacyField(value: unknown, key: string): unknown {
  return (value as Record<string, unknown>)[key];
}

function legacyOptionalField(value: unknown, key: string): unknown {
  return (value as Record<string, unknown> | null | undefined)?.[key];
}

function legacyHasField(value: unknown, key: string): boolean {
  return key in (value as object);
}

function values(payload: Record<string, unknown>, key: string): unknown[] {
  const value = payload[key];
  if (Array.isArray(value)) return value;
  const singular = key.endsWith('s') ? key.slice(0, -1) : key;
  return payload[singular] && typeof payload[singular] === 'object' ? [payload[singular]] : [];
}

function line(parts: unknown[]): string {
  return parts.map(scalarText).filter(value => value !== null && value !== '').join(' · ');
}

function scalarText(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

// Untrusted display values must not run object coercion or imply an object is a numeric value.
function displayScalarText(value: unknown): string {
  return scalarText(value) ?? 'ungeklärt';
}

function currencyUnit(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Z][A-Z0-9]{1,15}$/.test(value) ? value : null;
}

function exactMoneyText(value: MoneyValue): string {
  if (value.decimal !== null) return `${value.decimal} (exakt)`;
  if (value.exact) return `${value.exact.numerator}/${value.exact.denominator}`;
  return `[${value.lower}, ${value.upper}] (konservative Grenzen)`;
}

function moneyText(summary: unknown): string | null {
  if (legacyField(summary, 'accountingStatus') !== undefined && legacyField(summary, 'accountingStatus') !== 'complete') return null;
  const currency = currencyUnit(legacyField(summary, 'reportingCurrency'));
  try {
    if (legacyField(summary, 'realizedPnlValue') === undefined) {
      if (typeof legacyField(summary, 'realizedPnl') !== 'string') return null;
      // Preserve the second legacy getter read; the decimal parser validates it at runtime.
      const parseLegacyDecimal = moneyValueFromDecimal as (input: unknown) => MoneyValue;
      const value = parseLegacyDecimal(legacyField(summary, 'realizedPnl'));
      const suffix = legacyField(summary, 'accountingStatus') === 'complete' && currency ? ' (vollständig; exakt)' : '';
      const currencyLabel = currency ? ` ${currency}` : ' (Währung ungeklärt)';
      return `${value.decimal}${currencyLabel}${suffix}`;
    }
    if (!currency || legacyField(summary, 'realizedPnlValue') === null || legacyField(summary, 'accountingStatus') !== 'complete') return null;
    const value = validateMoneyValue(legacyField(summary, 'realizedPnlValue'));
    if (value.decimal !== legacyField(summary, 'realizedPnl')) return null;
    return `${exactMoneyText(value)} ${currency} (vollständig)`;
  } catch { return null; }
}

function subtotalLines(label: string, summary: unknown): string[] {
  const values = legacyField(summary, 'valuedSubtotalValuesByCurrency');
  if (!values || typeof values !== 'object' || Array.isArray(values)) return [];
  return Object.entries(values).flatMap(([currency, input]) => {
    if (!currencyUnit(currency)) return [];
    try { return [`${label} bewertete Teilsumme: ${exactMoneyText(validateMoneyValue(input))} ${currency}`]; }
    catch { return []; }
  });
}

function moneyLines(label: string, summary: unknown): string[] {
  if (!(legacyHasField(summary, 'realizedPnl')) && !(legacyHasField(summary, 'realizedPnlValue'))) return [];
  const text = moneyText(summary);
  return text ? [`${label} ${text}`] : [`${label} ungeklärt`, ...subtotalLines(label, summary)];
}

function accountingLines(item: unknown): string[] {
  const components: Array<[string, string]> = [['pricePnl', 'Preis-PnL'], ['signedFees', 'Gebühren (signiert)'], ['funding', 'Funding']];
  return [...moneyLines('PnL', item), ...components.flatMap(([key, label]) => {
    const value = legacyField(item, key);
    return value && typeof value === 'object' && !Array.isArray(value) ? moneyLines(label, value) : [];
  })];
}

function listMessage(title: string, items: string[]): string {
  return clipped([`TSX Core · ${title}`, ...(items.length > 0 ? items : ['Keine Einträge.'])].join('\n'));
}

function optionalLeverageLine(label: string, value: unknown): string | null {
  const text = scalarText(value);
  if (text === null || text === '') return null;
  return `${label}: ${text}`;
}

function leverageLines(value: unknown): string[] {
  if (typeof value === 'number' || typeof value === 'string') {
    return value === '' || !Number.isFinite(Number(value)) ? [] : [`Leverage: ${value}`];
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const leverage = value as Record<string, unknown>;
  const lines = [
    optionalLeverageLine('Effective', leverage.effective),
    optionalLeverageLine('Requested', leverage.requested),
    optionalLeverageLine('Source', leverage.source),
    optionalLeverageLine('CappedBy', leverage.cappedBy),
  ];
  if (leverage.effective === undefined) lines.push(optionalLeverageLine('Leverage', leverage.legacy));
  return lines.filter((item): item is string => item !== null);
}

export function formatSummary(payload: Record<string, unknown>): string {
  return clipped([
    'TSX Core · Übersicht',
    `Konten: ${displayScalarText(legacyOptionalField(payload.accounts, 'total') ?? 0)}`,
    `Aktive Positionen: ${displayScalarText(legacyOptionalField(payload.positions, 'active') ?? 0)}`,
    `Offene Intents: ${displayScalarText(legacyOptionalField(payload.intents, 'active') ?? 0)}`,
    `Offene Incidents: ${displayScalarText(legacyOptionalField(payload.incidents, 'open') ?? 0)}`,
  ].join('\n'));
}

export function formatAccounts(payload: Record<string, unknown>): string {
  return listMessage('Accounts', values(payload, 'accounts').map(item => line([
    legacyField(item, 'name') || legacyField(item, 'id') || 'Konto', legacyField(item, 'exchange'), legacyField(item, 'mode'), legacyField(item, 'status'),
    accountEquityLine(item),
  ])));
}

export function formatPositions(payload: Record<string, unknown>): string {
  const items = values(payload, 'positions').map(item => [
    line([legacyField(item, 'symbol') || legacyField(item, 'id') || 'Position', legacyField(item, 'exchange'), legacyField(item, 'mode'), legacyField(item, 'side'), legacyField(item, 'status')]),
    ...leverageLines(legacyField(item, 'leverage')),
    legacyField(item, 'quantity') !== undefined ? `Menge: ${displayScalarText(legacyField(item, 'quantity'))}` : null,
    legacyField(item, 'averageEntryPrice') !== null && legacyField(item, 'averageEntryPrice') !== undefined ? `Entry: ${displayScalarText(legacyField(item, 'averageEntryPrice'))}` : null,
    legacyField(item, 'stopPrice') !== null && legacyField(item, 'stopPrice') !== undefined ? `Stop: ${displayScalarText(legacyField(item, 'stopPrice'))}` : null,
    ...accountingLines(item),
  ].filter((value): value is string => Boolean(value)).join('\n'));
  return listMessage('Positionen', items);
}

export function formatOrders(payload: Record<string, unknown>): string {
  return listMessage('Orders', values(payload, 'orders').map(item => line([
    legacyField(item, 'symbol') || legacyField(item, 'id') || 'Order', legacyField(item, 'exchange'), legacyField(item, 'role'), legacyField(item, 'side'), legacyField(item, 'status'),
    legacyField(item, 'filledQuantity') !== undefined ? `${displayScalarText(legacyField(item, 'filledQuantity'))}/${displayScalarText(legacyField(item, 'quantity') ?? '?')}` : null,
  ])));
}

export function formatTrades(payload: Record<string, unknown>): string {
  return listMessage('Trades', values(payload, 'trades').map(item => {
    const summary = line([
      legacyField(item, 'symbol') || legacyField(item, 'id') || 'Trade', legacyField(item, 'exchange'), legacyField(item, 'mode'), legacyField(item, 'side'), legacyField(item, 'status'),
    ]);
    return [summary, ...leverageLines(legacyField(item, 'leverage')), ...accountingLines(item)].join('\n');
  }));
}

export function formatPerformance(payload: Record<string, unknown>): string {
  return listMessage('Performance', values(payload, 'groups').map(item => [line([
    legacyField(item, 'channelId') || legacyField(item, 'accountId') || 'Gruppe', legacyField(item, 'exchange'), legacyField(item, 'mode'),
    legacyField(item, 'trades') !== undefined ? `${displayScalarText(legacyField(item, 'trades'))} Trades` : null,
  ]), ...accountingLines(item)].join('\n')));
}

export function formatRisk(payload: Record<string, unknown>): string {
  return listMessage('Risk', values(payload, 'events').map(item => line([
    legacyField(item, 'severity'), legacyField(item, 'code') || legacyField(item, 'eventType') || legacyField(item, 'id'), legacyField(item, 'accountId'), legacyField(item, 'acknowledgedAt') ? 'quittiert' : null,
  ])));
}

export function formatSystem(payload: Record<string, unknown>): string {
  return clipped([
    'TSX Core · System',
    `Execution: ${payload.executionEnabled ? 'aktiv' : 'inaktiv'}`,
    `Live: ${payload.liveTradingEnabled ? 'aktiv' : 'inaktiv'}`,
    `Kill-Switch: ${payload.killSwitchActive ? 'aktiv' : 'inaktiv'}`,
    `Offene Incidents: ${displayScalarText(payload.openIncidents ?? 0)}`,
  ].join('\n'));
}

export function formatEvents(payload: Record<string, unknown>): string {
  return listMessage('Events', values(payload, 'events').map(item => line([
    legacyField(item, 'eventType') || legacyField(item, 'code') || legacyField(item, 'id') || 'Event', legacyField(item, 'exchange'), legacyField(item, 'mode'), legacyField(item, 'accountId'), legacyField(item, 'intentId'),
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
  const title = event.eventType === 'workflow_fallback_candidate_skipped'
    ? '↪️ Fallback-Kandidat übersprungen'
    : event.eventType.replaceAll('_', ' ');
  const lines = [
    `TSX Core · ${title}`,
    `Zeit: ${occurredAt}`,
    exchangeLine(event),
    event.accountId ? `Konto: ${event.accountId}` : null,
    event.channelId ? `Kanal: ${event.channelId}` : null,
    event.intentId ? `Intent: ${event.intentId}` : null,
    ...safeDetails(event.details),
    ...accountingLines(event.details),
  ].filter((line): line is string => Boolean(line));
  return clipped(lines.join('\n'));
}

export function formatNotification(
  event: TradingNotificationEvent,
  settings: TelegramViewerSettings,
): string {
  return formatTelegramViewerEvent(event, settings);
}

export function formatTelegramViewerProjection(resource: string, payload: Record<string, unknown>): string {
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
  return typeof value === 'string' && CALLBACK_PATTERNS.some(pattern => pattern.test(value));
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

function accountEquityLine(item: unknown): string | null {
  if (legacyField(item, 'equity') === null || legacyField(item, 'equity') === undefined) return null;
  const currency = legacyField(item, 'reportingCurrency') ? ` ${displayScalarText(legacyField(item, 'reportingCurrency'))}` : '';
  return `Equity ${displayScalarText(legacyField(item, 'equity'))}${currency}`;
}
function exchangeLine(event: TradingNotificationEvent): string | null {
  if (!event.exchange) return null;
  const mode = event.mode ? ` (${event.mode})` : '';
  return `Börse: ${event.exchange}${mode}`;
}
