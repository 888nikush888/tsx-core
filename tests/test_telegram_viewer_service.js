import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  formatAccounts,
  formatEvents,
  formatNotification,
  formatOrders,
  formatPerformance,
  formatPositions,
  formatRisk,
  formatSummary,
  formatSystem,
  formatTrades,
  formatTelegramViewerEvent,
  formatTelegramViewerProjection,
  telegramViewerMenu,
  validTelegramViewerCallback,
} from '../src/telegram_viewer/formatters.js';
import { TelegramViewerService } from '../src/telegram_viewer/service.js';
import { TelegramViewerStateRepository } from '../src/telegram_viewer/state_repository.js';

const SETTINGS = {
  enabled: true,
  allowedUserIds: ['1001'],
  timezone: 'Europe/Berlin',
  locale: 'de-DE',
  eventPollingIntervalMs: 1000,
  notifications: {
    positionOpened: true, takeProfitFilled: true, stopLossFilled: true, positionClosed: true,
    executionFailed: true, accountIncidentOpened: true, accountIncidentResolved: true,
    exchangeStreamDegraded: true, exchangeStreamRecovered: true, killSwitchActivated: true,
    signalReceived: true, signalValidated: true, intentCreated: true, exchangeAcknowledged: true,
  },
  display: { detailLevel: 'normal', pnlMode: 'absolute_and_percent', timeFormat: '24h' },
};

function fakeCore() {
  const calls = [];
  const event = {
    seq: 1, id: 'event-1', dedupeKey: 'event:1', eventType: 'position_opened', intentId: 'intent-1',
    channelId: '-100', accountId: 'account-1', exchange: 'futureexchange', mode: 'testnet',
    occurredAt: 1_700_000_000_000, createdAt: 1_700_000_000_001,
    details: { symbol: 'BTC/USDT:USDT', side: 'LONG', quantity: '0.01' },
  };
  return {
    calls,
    config: async () => { calls.push('config'); return { settings: structuredClone(SETTINGS) }; },
    get: async (resource, query = {}) => {
      calls.push(`${resource}:${Number(query.offset || 0)}`);
      if (resource === 'events') return { events: Number(query.afterSeq || 0) < 1 ? [event] : [], nextSeq: 1 };
      if (resource === 'test-events') {
        return Number(query.afterSeq || 0) < 1
          ? { events: [{ seq: 1, id: 'test-1', message: 'Viewer test', createdAt: 1_700_000_009_000 }], nextSeq: 1 }
          : { events: [], nextSeq: 1 };
      }
      if (resource === 'summary') return { accounts: { total: 1 }, positions: { active: 1 }, incidents: { open: 0 } };
      if (resource === 'accounts') {
        const offset = Number(query.offset || 0);
        return {
          accounts: [{ id: offset === 0 ? 'account-1' : 'account-21', name: 'Account', exchange: 'okx' }],
          pagination: { offset, limit: 20, hasMore: offset === 0 },
        };
      }
      return { [resource]: [] };
    },
  };
}

function fakeBot() {
  return {
    updates: [], sent: [], answered: [], failNext: false,
    async getUpdates() { const updates = this.updates; this.updates = []; return updates; },
    async sendMessage(chatId, text, options) {
      if (this.failNext) { this.failNext = false; throw new Error('temporary telegram failure'); }
      this.sent.push({ chatId, text, options }); return { message_id: this.sent.length };
    },
    async answerCallbackQuery(id, text) { this.answered.push({ id, text }); },
  };
}

async function run() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-viewer-service-'));
  try {
    const databasePath = path.join(directory, 'viewer-state.db');
    let state = new TelegramViewerStateRepository(databasePath);
    await state.initialize();
    const core = fakeCore();
    const bot = fakeBot();
    const service = new TelegramViewerService({ core, bot, state, now: () => 1_700_000_010_000 });

    assert.strictEqual(service.pollingInterval(), 2_000);
    await service.refreshSettings();
    assert.strictEqual(service.pollingInterval(), 1_000);
    service.recordFailure('opaque failure');
    assert.strictEqual(service.status().healthy, false);
    assert.strictEqual(service.status().lastError, 'Viewer operation failed.');
    service.recordHealthyPoll();
    bot.updates.push(
      { update_id: 10, message: { chat: { id: 1001, type: 'private' }, from: { id: 1001 }, text: '/status' } },
      { update_id: 11, message: { chat: { id: -1, type: 'group' }, from: { id: 1001 }, text: '/status' } },
      { update_id: 12, message: { chat: { id: 2002, type: 'private' }, from: { id: 2002 }, text: '/status' } },
      { update_id: 13, message: { chat: { id: -2, type: 'supergroup' }, from: { id: 1001 }, text: '/status' } },
      { update_id: 14, message: { chat: { id: -3, type: 'channel' }, from: { id: 1001 }, text: '/status' } },
      { update_id: 15, message: { chat: { id: 1001, type: 'private' }, from: { id: 1001, username: 'changed' }, text: '/accounts' } },
      { update_id: 16, message: { chat: { id: 1001, type: 'private' }, from: { id: 1001 }, text: '/start' } },
      { update_id: 17, message: { chat: { id: 1001, type: 'private' }, from: { id: 1001 }, text: null } },
    );
    await service.pollTelegramOnce();
    assert.strictEqual(bot.sent.length, 4, 'Only an allowed user in a private chat may use the viewer');
    assert.match(bot.sent[0].text, /Konten|accounts/i);
    assert.strictEqual(await state.telegramOffset(), 18, 'Telegram update offset must be persisted');
    assert.ok(
      bot.sent.some(message => message.options.reply_markup.inline_keyboard.flat()
        .some(button => button.callback_data === 'page:accounts:1')),
      'A bounded account page with more rows must expose a next-page callback.',
    );

    bot.updates.push({
      update_id: 18,
      message: { chat: { id: 1001, type: 'private' }, from: { id: 1001 }, text: '/unknown' },
    });
    await service.pollTelegramOnce();
    assert.match(bot.sent.at(-1).text, /nur lesend|viewer/i, 'Unknown commands must receive a neutral viewer hint.');

    bot.updates.push({
      update_id: 19,
      callback_query: { id: 'callback-1', from: { id: 1001 }, data: 'menu:positions', message: { chat: { id: 1001, type: 'private' } } },
    });
    await service.pollTelegramOnce();
    assert.strictEqual(bot.answered.length, 1);
    assert.strictEqual(validTelegramViewerCallback('menu:positions'), true);
    for (const callback of ['menu:system', 'menu:events', 'menu:refresh']) {
      assert.strictEqual(validTelegramViewerCallback(callback), true);
    }
    assert.strictEqual(validTelegramViewerCallback('menu:positions;delete_all'), false);
    assert.ok(telegramViewerMenu().inline_keyboard.flat().every(button => validTelegramViewerCallback(button.callback_data)));

    bot.updates.push({
      update_id: 20,
      callback_query: { id: 'callback-page-1', from: { id: 1001 }, data: 'page:accounts:1', message: { chat: { id: 1001, type: 'private' } } },
    });
    await service.pollTelegramOnce();
    assert.ok(core.calls.includes('accounts:20'), 'The second page must request a real server-side offset.');
    bot.updates.push(
      { update_id: 21, callback_query: { id: 'callback-refresh', from: { id: 1001 }, data: 'menu:refresh', message: { chat: { id: 1001, type: 'private' } } } },
      { update_id: 22, callback_query: { id: 'callback-invalid', from: { id: 1001 }, data: 'delete:everything', message: { chat: { id: 1001, type: 'private' } } } },
    );
    await service.pollTelegramOnce();
    assert.ok(core.calls.includes('summary:0'));

    bot.failNext = true;
    await service.pollEventsOnce();
    assert.strictEqual(await state.eventCursor(), 1, 'Fetched events may advance the cursor after durable delivery creation');
    assert.strictEqual((await state.pendingDeliveries(1_700_000_010_000)).length, 0, 'Failed delivery must use bounded backoff');
    assert.strictEqual((await state.pendingDeliveries(1_700_000_012_000)).length, 1);
    await service.deliverPendingOnce(1_700_000_012_000);
    assert.strictEqual((await state.pendingDeliveries(1_700_000_020_000)).length, 0);

    bot.failNext = true;
    await service.pollTestEventsOnce();
    assert.strictEqual(service.status().lastTest.status, 'retrying');
    await service.deliverPendingOnce(1_700_000_012_000);
    assert.strictEqual(service.status().lastTestEventId, 1);
    assert.strictEqual((await state.lastTest()).status, 'delivered');

    const deliveredCount = bot.sent.length;
    await state.close();
    state = new TelegramViewerStateRepository(databasePath);
    await state.initialize();
    const restarted = new TelegramViewerService({ core, bot, state, now: () => 1_700_000_020_000 });
    await restarted.refreshSettings();
    assert.strictEqual(restarted.status().lastTestEventId, 1, 'Last test delivery status must survive restart.');
    await restarted.pollEventsOnce();
    assert.strictEqual(bot.sent.length, deliveredCount, 'Restart must not redeliver an acknowledged event');
    assert.strictEqual(await state.telegramOffset(), 23, 'Telegram offset must survive restart');

    const longEvent = {
      seq: 2, id: 'event-2', dedupeKey: 'event:2', eventType: 'execution_failed', intentId: null,
      channelId: null, accountId: null, exchange: 'dynamicexchange', mode: 'live',
      occurredAt: 1_700_000_000_000, createdAt: 1_700_000_000_001,
      details: { message: 'x'.repeat(10_000) },
    };
    const formatted = formatTelegramViewerEvent(longEvent, SETTINGS);
    assert.ok(formatted.length <= 4096, 'Telegram messages must respect the platform message limit');
    assert.match(formatted, /dynamicexchange/);
    assert.strictEqual(formatNotification(longEvent, SETTINGS), formatted);
    const formatterOutputs = [
      formatSummary({ accounts: { total: 1 }, positions: { active: 1 }, incidents: { open: 0 } }),
      formatAccounts({ accounts: [{ name: 'OKX Main', exchange: 'okx', mode: 'live', status: 'ready' }] }),
      formatPositions({ positions: [{
        symbol: 'BTC/USDT:USDT', exchange: 'okx', status: 'open',
        leverage: { requested: 12, effective: 7, source: 'signal', cappedBy: 'exchange' },
      }] }),
      formatPositions({ positions: [{ symbol: 'ETH/USDT:USDT', exchange: 'legacyexchange', leverage: 5 }] }),
      formatOrders({ orders: [] }), formatTrades({ trades: [] }), formatPerformance({ groups: [] }),
      formatRisk({ events: [] }), formatSystem({ executionEnabled: true, killSwitchActive: false }),
      formatEvents({ events: [] }),
    ];
    assert.ok(formatterOutputs.every(output => typeof output === 'string' && output.length <= 4096));
    assert.match(formatterOutputs[1], /okx/i, 'Dynamic exchange names must be formatted as opaque strings.');
    assert.match(formatterOutputs[2], /Effective.*7/i);
    assert.match(formatterOutputs[2], /Requested.*12/i);
    assert.match(formatterOutputs[2], /Source.*signal/i);
    assert.match(formatterOutputs[2], /CappedBy.*exchange/i);
    assert.match(formatterOutputs[3], /Leverage.*5/i, 'Legacy leverage must format without a decision object.');
    const projectionOutputs = [
      formatTelegramViewerProjection('summary', {}),
      formatTelegramViewerProjection('accounts', { account: { id: 'single-account', equity: 0, reportingCurrency: 'USD' } }),
      formatTelegramViewerProjection('positions', { position: { id: 'single-position', quantity: 0, leverage: '' } }),
      formatTelegramViewerProjection('orders', { order: { id: 'single-order', filledQuantity: 0 } }),
      formatTelegramViewerProjection('trades', { trade: { id: 'single-trade', realizedPnl: 0, leverage: { legacy: 3 } } }),
      formatTelegramViewerProjection('performance', { group: { accountId: 'account-1', trades: 0, realizedPnl: 0 } }),
      formatTelegramViewerProjection('incidents', { event: { id: 'incident-1', acknowledgedAt: 1 } }),
      formatTelegramViewerProjection('system', { executionEnabled: false, liveTradingEnabled: true, killSwitchActive: true }),
      formatTelegramViewerProjection('events', { event: { id: 'event-3', mode: 'paper' } }),
      formatTelegramViewerProjection('unsupported', {}),
      formatPositions({ positions: [
        { id: 'invalid-leverage', leverage: 'not-a-number' },
        { id: 'array-leverage', leverage: [] },
        { id: 'partial-leverage', leverage: { effective: null, requested: null, source: '', cappedBy: '', legacy: null } },
      ] }),
    ];
    assert.ok(projectionOutputs.every(output => typeof output === 'string'));
    const navigation = telegramViewerMenu('accounts', { offset: 20, limit: 20, hasMore: true }).inline_keyboard.flat();
    assert.ok(navigation.some(button => button.callback_data === 'page:accounts:0'));
    assert.ok(navigation.some(button => button.callback_data === 'page:accounts:2'));
    assert.strictEqual(telegramViewerMenu('summary', { offset: 0, limit: 20, hasMore: true }).inline_keyboard.length, 5);

    const callbackState = new TelegramViewerStateRepository(path.join(directory, 'callback-state.db'));
    await callbackState.initialize();
    const callbackBot = fakeBot();
    const callbackCore = fakeCore();
    callbackCore.get = async () => { throw new Error('projection unavailable'); };
    const callbackService = new TelegramViewerService({ core: callbackCore, bot: callbackBot, state: callbackState });
    await callbackService.refreshSettings();
    callbackBot.updates.push({
      update_id: 1,
      callback_query: { id: 'callback-error', from: { id: 1001 }, data: 'menu:positions', message: { chat: { id: 1001, type: 'private' } } },
    });
    await assert.rejects(callbackService.pollTelegramOnce(), /projection unavailable/);
    assert.deepStrictEqual(callbackBot.answered, [{ id: 'callback-error', text: 'Daten konnten nicht geladen werden.' }]);
    assert.strictEqual(await callbackState.telegramOffset(), 2);
    await callbackState.close();

    const mutedState = new TelegramViewerStateRepository(path.join(directory, 'muted-state.db'));
    await mutedState.initialize();
    const mutedCore = fakeCore();
    mutedCore.config = async () => ({
      settings: {
        ...structuredClone(SETTINGS),
        notifications: { ...structuredClone(SETTINGS.notifications), positionOpened: false },
      },
    });
    const mutedBot = fakeBot();
    const muted = new TelegramViewerService({ core: mutedCore, bot: mutedBot, state: mutedState });
    await muted.refreshSettings();
    await muted.pollEventsOnce();
    assert.strictEqual(mutedBot.sent.length, 0, 'A disabled notification type must not be delivered.');
    await mutedState.close();

    const disabledCore = fakeCore();
    disabledCore.config = async () => ({ settings: { ...structuredClone(SETTINGS), enabled: false } });
    const disabledBot = fakeBot();
    const disabled = new TelegramViewerService({ core: disabledCore, bot: disabledBot, state, now: () => 1_700_000_030_000 });
    await disabled.refreshSettings();
    await disabled.pollTelegramOnce();
    await disabled.pollEventsOnce();
    assert.deepStrictEqual(disabledCore.calls, [], 'Disabled viewer must not request sensitive projections or event data');
    assert.strictEqual(disabledBot.sent.length, 0, 'Disabled viewer must not send notifications');

    const status = restarted.status();
    assert.strictEqual(status.ready, true);
    assert.strictEqual(status.enabled, true);
    assert.strictEqual(JSON.stringify(status).includes('token'), false);
    await state.close();
    console.log('TELEGRAM VIEWER SERVICE TESTS PASSED');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
