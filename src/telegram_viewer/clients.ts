import { viewerRecord, viewerUpdates, type TelegramViewerUpdate } from './contracts.js';
import { validateTelegramViewerSettings } from '../telegram_viewer_settings.js';
import type { TelegramViewerSettings } from '../viewer_types.js';
import type { TelegramViewerBotClient, TelegramViewerCoreClient } from './service.js';

const CORE_RESOURCES = new Set([
  'summary', 'system', 'accounts', 'positions', 'orders', 'trades', 'performance', 'risk', 'incidents', 'events', 'test-events',
]);
type TokenProvider = string | (() => string | Promise<string>);

async function tokenValue(provider: TokenProvider): Promise<string> {
  const value = typeof provider === 'function' ? await provider() : provider;
  if (typeof value !== 'string' || value.length < 20 || /[\0\r\n]/.test(value)) throw new Error('Viewer service credential is unavailable.');
  return value;
}

async function responseJson(response: Response, label: string): Promise<unknown> {
  const text = await response.text();
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { throw new Error(`${label} returned malformed JSON.`); }
  if (!response.ok) throw new Error(`${label} request failed with status ${response.status}.`);
  return payload;
}

export class TelegramViewerCoreApiClient implements TelegramViewerCoreClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string, private readonly serviceToken: TokenProvider) {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Viewer core API URL is invalid.');
    this.baseUrl = parsed.toString().replace(/\/$/, '');
  }

  private async request(resource: string, query: Record<string, string | number> = {}): Promise<Record<string, unknown>> {
    const endpoint = new URL(`${this.baseUrl}/internal/viewer/v1/${resource}`);
    for (const [key, value] of Object.entries(query)) endpoint.searchParams.set(key, String(value));
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${await tokenValue(this.serviceToken)}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    return viewerRecord(await responseJson(response, 'TSX Core viewer API'));
  }

  async config(): Promise<{ settings: TelegramViewerSettings }> {
    const response = await this.request('config');
    return { settings: validateTelegramViewerSettings(response.settings) };
  }

  async get(resource: string, query: Record<string, string | number> = {}): Promise<Record<string, unknown>> {
    if (!CORE_RESOURCES.has(resource)) throw new Error('Viewer core resource is not allowed.');
    return this.request(resource, query);
  }
}

export class TelegramBotApiClient implements TelegramViewerBotClient {
  private readonly baseUrl: string;

  constructor(private readonly botToken: TokenProvider, apiBase = 'https://api.telegram.org/bot') {
    if (typeof botToken === 'string' && !/^[1-9]\d{4,19}:[A-Za-z0-9_-]{20,128}$/.test(botToken)) {
      throw new Error('Telegram bot token is invalid.');
    }
    const parsed = new URL(apiBase);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Telegram Bot API URL is invalid.');
    this.baseUrl = parsed.toString().replace(/\/$/, '');
  }

  private async call(method: string, body: Record<string, unknown>, timeoutMs = 10_000): Promise<unknown> {
    if (!/^(getUpdates|sendMessage|answerCallbackQuery)$/.test(method)) throw new Error('Telegram Bot API method is not allowed.');
    const botToken = await tokenValue(this.botToken);
    if (!/^[1-9]\d{4,19}:[A-Za-z0-9_-]{20,128}$/.test(botToken)) throw new Error('Telegram bot token is invalid.');
    const response = await fetch(`${this.baseUrl}${botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = viewerRecord(await responseJson(response, 'Telegram Bot API'));
    if (payload?.ok !== true) throw new Error('Telegram Bot API rejected the request.');
    return payload.result;
  }

  async getUpdates(offset: number): Promise<TelegramViewerUpdate[]> {
    const result = await this.call('getUpdates', {
      offset, timeout: 25, limit: 100, allowed_updates: ['message', 'callback_query'],
    }, 35_000);
    return viewerUpdates(result);
  }

  sendMessage(chatId: string | number, text: string, options: Record<string, unknown> = {}): Promise<unknown> {
    return this.call('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true, ...options });
  }

  answerCallbackQuery(id: string, text?: string): Promise<unknown> {
    return this.call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) });
  }
}
