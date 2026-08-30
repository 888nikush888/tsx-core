import type { TelegramViewerSettings, TradingNotificationEvent } from '../viewer_types.js';
import {
  formatTelegramViewerEvent,
  formatTelegramViewerProjection,
  TELEGRAM_VIEWER_HELP,
  TELEGRAM_VIEWER_UNKNOWN_COMMAND,
  telegramViewerMenu,
  validTelegramViewerCallback,
} from './formatters.js';
import type { TelegramViewerStateRepository } from './state_repository.js';

export interface TelegramViewerCoreClient {
  config(): Promise<{ settings: TelegramViewerSettings }>;
  get(resource: string, query?: Record<string, string | number>): Promise<Record<string, any>>;
}

export interface TelegramViewerBotClient {
  getUpdates(offset: number): Promise<any[]>;
  sendMessage(chatId: string | number, text: string, options?: Record<string, unknown>): Promise<unknown>;
  answerCallbackQuery(id: string, text?: string): Promise<unknown>;
}

const NOTIFICATION_SETTING: Partial<Record<TradingNotificationEvent['eventType'], keyof TelegramViewerSettings['notifications']>> = {
  position_opened: 'positionOpened', take_profit_filled: 'takeProfitFilled', stop_loss_filled: 'stopLossFilled',
  position_closed: 'positionClosed', execution_failed: 'executionFailed', account_incident_opened: 'accountIncidentOpened',
  account_incident_resolved: 'accountIncidentResolved', exchange_stream_degraded: 'exchangeStreamDegraded',
  exchange_stream_recovered: 'exchangeStreamRecovered', kill_switch_activated: 'killSwitchActivated',
  signal_received: 'signalReceived', signal_validated: 'signalValidated', intent_created: 'intentCreated',
  exchange_ack: 'exchangeAcknowledged',
};

const COMMAND_RESOURCES: Record<string, string> = {
  '/status': 'summary', '/accounts': 'accounts', '/positions': 'positions', '/orders': 'orders',
  '/trades': 'trades', '/performance': 'performance', '/risk': 'risk', '/incidents': 'incidents',
  '/system': 'system', '/events': 'events', '/refresh': 'summary',
};

export class TelegramViewerService {
  private settings: TelegramViewerSettings | null = null;
  private initializedAt = Date.now();
  private lastPollAt: number | null = null;
  private lastError: string | null = null;
  private lastTest: Record<string, unknown> | null = null;

  constructor(private readonly dependencies: {
    core: TelegramViewerCoreClient;
    bot: TelegramViewerBotClient;
    state: TelegramViewerStateRepository;
    now?: () => number;
  }) {}

  private now(): number { return this.dependencies.now?.() ?? Date.now(); }

  async refreshSettings(): Promise<TelegramViewerSettings> {
    const response = await this.dependencies.core.config();
    this.settings = response.settings;
    this.lastTest = await this.dependencies.state.lastTest();
    this.lastError = null;
    return this.settings;
  }

  recordFailure(error: unknown): void {
    this.lastError = error instanceof Error ? error.message.slice(0, 500) : 'Viewer operation failed.';
  }

  recordHealthyPoll(): void {
    this.lastError = null;
    this.lastPollAt = this.now();
  }

  pollingInterval(): number {
    return this.settings?.eventPollingIntervalMs ?? 2_000;
  }

  private authorized(chat: any, from: any): boolean {
    return Boolean(
      this.settings?.enabled
      && chat?.type === 'private'
      && from?.id !== undefined
      && String(chat.id) === String(from.id)
      && this.settings.allowedUserIds.includes(String(from.id)),
    );
  }

  private async sendProjection(chatId: string | number, resource: string, page = 0): Promise<void> {
    const payload = await this.dependencies.core.get(resource, { limit: 20, offset: page * 20 });
    await this.dependencies.bot.sendMessage(chatId, formatTelegramViewerProjection(resource, payload), {
      reply_markup: telegramViewerMenu(resource, payload.pagination),
    });
  }

  private async processMessage(message: any): Promise<void> {
    if (!this.authorized(message?.chat, message?.from)) return;
    const command = typeof message.text === 'string' ? message.text.trim().split(/\s/, 1)[0].toLowerCase() : '';
    if (command === '/start' || command === '/help') {
      await this.dependencies.bot.sendMessage(message.chat.id, TELEGRAM_VIEWER_HELP, { reply_markup: telegramViewerMenu() });
      return;
    }
    const resource = COMMAND_RESOURCES[command];
    if (resource) {
      await this.sendProjection(message.chat.id, resource);
      return;
    }
    await this.dependencies.bot.sendMessage(message.chat.id, TELEGRAM_VIEWER_UNKNOWN_COMMAND, {
      reply_markup: telegramViewerMenu(),
    });
  }

  private async processCallback(callback: any): Promise<void> {
    const chat = callback?.message?.chat;
    if (!this.authorized(chat, callback?.from) || !validTelegramViewerCallback(callback?.data)) return;
    const [kind, requestedResource, page] = callback.data.split(':');
    const resource = requestedResource === 'refresh' ? 'summary' : requestedResource;
    try {
      await this.sendProjection(chat.id, resource, page ? Number(page) : 0);
      await this.dependencies.bot.answerCallbackQuery(String(callback.id));
    } catch (error) {
      await this.dependencies.bot.answerCallbackQuery(String(callback.id), 'Daten konnten nicht geladen werden.');
      throw error;
    }
    void kind;
  }

  async pollTelegramOnce(): Promise<void> {
    if (!this.settings?.enabled) return;
    const offset = await this.dependencies.state.telegramOffset();
    const updates = await this.dependencies.bot.getUpdates(offset);
    for (const update of updates.sort((left, right) => Number(left.update_id) - Number(right.update_id))) {
      try {
        if (update.message) await this.processMessage(update.message);
        else if (update.callback_query) await this.processCallback(update.callback_query);
      } finally {
        const updateId = Number(update.update_id);
        if (Number.isSafeInteger(updateId) && updateId >= offset) {
          await this.dependencies.state.setTelegramOffset(updateId + 1);
        }
      }
    }
    this.recordHealthyPoll();
  }

  private notificationEnabled(event: TradingNotificationEvent): boolean {
    const setting = NOTIFICATION_SETTING[event.eventType];
    return setting ? Boolean(this.settings?.notifications[setting]) : true;
  }

  async pollEventsOnce(): Promise<void> {
    if (!this.settings?.enabled || this.settings.allowedUserIds.length === 0) return;
    const afterSeq = await this.dependencies.state.eventCursor();
    const response = await this.dependencies.core.get('events', { afterSeq, limit: 100 });
    for (const event of (response.events || []) as TradingNotificationEvent[]) {
      if (this.notificationEnabled(event)) {
        await this.dependencies.state.queueDeliveries({
          kind: 'notification', sourceSeq: event.seq, sourceId: event.id,
          userIds: this.settings.allowedUserIds, payload: { event }, now: this.now(),
        });
      }
    }
    await this.dependencies.state.setEventCursor(Number(response.nextSeq ?? afterSeq));
    await this.deliverPendingOnce(this.now());
  }

  async pollTestEventsOnce(): Promise<void> {
    if (!this.settings?.enabled || this.settings.allowedUserIds.length === 0) return;
    const afterSeq = await this.dependencies.state.testCursor();
    const response = await this.dependencies.core.get('test-events', { afterSeq, limit: 100 });
    for (const event of response.events || []) {
      await this.dependencies.state.queueDeliveries({
        kind: 'test', sourceSeq: Number(event.seq), sourceId: String(event.id),
        userIds: this.settings.allowedUserIds, payload: { test: event }, now: this.now(),
      });
    }
    await this.dependencies.state.setTestCursor(Number(response.nextSeq ?? afterSeq));
    await this.deliverPendingOnce(this.now());
  }

  async deliverPendingOnce(now = this.now()): Promise<void> {
    if (!this.settings?.enabled) return;
    for (const delivery of await this.dependencies.state.pendingDeliveries(now)) {
      try {
        const text = delivery.kind === 'notification'
          ? formatTelegramViewerEvent(delivery.payload.event as TradingNotificationEvent, this.settings)
          : `TSX Core · Test\n${String((delivery.payload.test as any)?.message ?? 'Testnachricht')}`.slice(0, 4096);
        await this.dependencies.bot.sendMessage(delivery.userId, text, { reply_markup: telegramViewerMenu() });
        await this.dependencies.state.markDelivered(delivery.id, now);
        if (delivery.kind === 'test') {
          this.lastTest = { sourceSeq: delivery.sourceSeq, status: 'delivered', attemptedAt: now, deliveredAt: now, error: null };
          await this.dependencies.state.setLastTest(this.lastTest as {
            sourceSeq: number; status: string; attemptedAt: number; deliveredAt: number;
          });
        }
      } catch (error) {
        await this.dependencies.state.markFailed(delivery.id, delivery.attempts, error, now);
        if (delivery.kind === 'test') {
          this.lastTest = {
            sourceSeq: delivery.sourceSeq, status: 'retrying', attemptedAt: now,
            error: error instanceof Error ? error.message : 'Telegram delivery failed.',
          };
          await this.dependencies.state.setLastTest(this.lastTest as {
            sourceSeq: number; status: string; attemptedAt: number; error: string;
          });
        }
      }
    }
  }

  status(): Record<string, unknown> {
    return {
      healthy: this.lastError === null,
      ready: this.settings !== null,
      enabled: Boolean(this.settings?.enabled),
      allowedUsers: this.settings?.allowedUserIds.length ?? 0,
      initializedAt: this.initializedAt,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      lastTestEventId: this.lastTest?.sourceSeq ?? null,
      lastTest: this.lastTest,
    };
  }
}
