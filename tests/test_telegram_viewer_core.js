import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  closeDb,
  DATABASE_FEATURE_SET,
  expectedDatabaseMigrations,
  getDatabase,
  initDb,
  LATEST_SCHEMA_VERSION,
  REQUIRED_DATABASE_TABLES,
} from '../src/db.js';
import {
  DEFAULT_TELEGRAM_VIEWER_SETTINGS,
  ManagedTelegramViewerSettingsStore,
  telegramViewerSettingsFromEnvironment,
  validateTelegramViewerSettings,
} from '../src/telegram_viewer_settings.js';
import {
  TelegramViewerSecretStore,
  telegramViewerSecretStoreFromEnvironment,
} from '../src/telegram_viewer_secrets.js';
import {
  createTelegramViewerTestEvent,
  listTelegramViewerTestEvents,
  listTradingNotificationEvents,
  recordTradingNotificationEvent,
  TRADING_NOTIFICATION_EVENT_TYPES,
} from '../src/viewer_repository.js';
import { recordTradingExecutionEvent } from '../src/trading_telemetry.js';
import { recordTradingAccountIncident, resolveTradingAccountIncidents } from '../src/trading_incidents.js';
import { recordTradingNotificationBestEffort } from '../src/trading_notifications.js';
import { updateTradingAccountConfiguration } from '../src/trading_repository.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-telegram-viewer-core-'));
const databasePath = path.join(directory, 'forwarder.db');
const settingsPath = path.join(directory, 'config', 'telegram-viewer-settings.json');
const secretDirectory = path.join(directory, 'viewer-secrets');

try {
  await initDb(databasePath);

  assert.equal(LATEST_SCHEMA_VERSION, 22);
  assert.deepEqual(expectedDatabaseMigrations().at(-1), {
    version: 22,
    name: 'configurable_account_fallback_policy',
    checksum: expectedDatabaseMigrations().at(-1).checksum,
  });
  assert.ok(DATABASE_FEATURE_SET.includes('telegram-viewer-notification-delivery'));
  for (const table of ['trading_notification_events', 'telegram_viewer_test_events']) {
    assert.ok(REQUIRED_DATABASE_TABLES.includes(table));
    assert.ok(await getDatabase().get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      [table],
    ));
  }

  assert.deepEqual(TRADING_NOTIFICATION_EVENT_TYPES, [
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
  ]);

  const inserted = await recordTradingNotificationEvent({
    id: 'event-position-opened',
    dedupeKey: 'position-open:intent-1',
    eventType: 'position_opened',
    intentId: 'intent-1',
    channelId: '-100123',
    accountId: null,
    exchange: 'okx',
    mode: 'testnet',
    occurredAt: 1_700_000_000_000,
    details: { symbol: 'BTCUSDT', quantity: '0.01' },
    now: 1_700_000_000_010,
  });
  assert.equal(inserted.inserted, true);
  assert.equal(inserted.event.exchange, 'okx', 'Dynamic exchanges must remain opaque strings.');
  const duplicate = await recordTradingNotificationEvent({
    ...inserted.event,
    id: 'event-position-opened-duplicate',
    dedupeKey: 'position-open:intent-1',
    details: { symbol: 'BTCUSDT', quantity: '0.01' },
    now: 1_700_000_000_020,
  });
  assert.equal(duplicate.inserted, false, 'A legitimate duplicate must not throw or create a second row.');

  await recordTradingNotificationEvent({
    id: 'fill-a', dedupeKey: 'fill:account-1:fill-a', eventType: 'partial_fill',
    accountId: null, occurredAt: 1_700_000_000_030, details: { exchangeFillId: 'fill-a' },
  });
  await recordTradingNotificationEvent({
    id: 'fill-b', dedupeKey: 'fill:account-1:fill-b', eventType: 'partial_fill',
    accountId: null, occurredAt: 1_700_000_000_040, details: { exchangeFillId: 'fill-b' },
  });
  const firstPage = await listTradingNotificationEvents({ afterSeq: 0, limit: 2 });
  assert.equal(firstPage.events.length, 2);
  assert.equal(firstPage.nextSeq, firstPage.events.at(-1).seq);
  const secondPage = await listTradingNotificationEvents({ afterSeq: firstPage.nextSeq, limit: 1000 });
  assert.equal(secondPage.events.length, 1);
  assert.equal(secondPage.events[0].id, 'fill-b');
  assert.equal(secondPage.nextSeq, secondPage.events[0].seq);
  const emptyPage = await listTradingNotificationEvents({ afterSeq: secondPage.nextSeq, limit: 10 });
  assert.deepEqual(emptyPage, { events: [], nextSeq: secondPage.nextSeq });

  await assert.rejects(
    recordTradingNotificationEvent({
      id: 'bad-type', dedupeKey: 'bad:type', eventType: 'made_up', occurredAt: Date.now(), details: {},
    }),
    /event type/i,
  );
  await assert.rejects(
    recordTradingNotificationEvent({
      id: 'secret-details', dedupeKey: 'secret:details', eventType: 'execution_failed',
      occurredAt: Date.now(), details: { apiKey: 'must-not-be-stored' },
    }),
    /secret/i,
  );
  await assert.rejects(
    recordTradingNotificationEvent({
      id: 'huge-details', dedupeKey: 'huge:details', eventType: 'execution_failed',
      occurredAt: Date.now(), details: { text: 'x'.repeat(40_000) },
    }),
    /details/i,
  );

  const tradingStateBeforeTest = await getDatabase().get(
    `SELECT execution_enabled, live_trading_enabled, kill_switch_active
     FROM trading_runtime_state WHERE singleton_id = 1`,
  );
  const tradingRowsBeforeTest = await getDatabase().get(
    `SELECT
       (SELECT COUNT(*) FROM trading_trade_intents) AS intents,
       (SELECT COUNT(*) FROM trading_positions) AS positions,
       (SELECT COUNT(*) FROM trading_orders) AS orders`,
  );
  const testEvent = await createTelegramViewerTestEvent({
    createdBy: 'dashboard:admin', message: 'TSX Viewer Test', now: 1_700_000_001_000,
  });
  assert.equal(testEvent.message, 'TSX Viewer Test');
  assert.deepEqual(await listTelegramViewerTestEvents({ afterSeq: 0, limit: 10 }), {
    events: [testEvent],
    nextSeq: testEvent.seq,
  });
  assert.equal(
    Number((await getDatabase().get('SELECT COUNT(*) AS count FROM trading_execution_events')).count),
    0,
    'The test-event path must not insert a trading execution event.',
  );
  assert.deepEqual(await getDatabase().get(
    `SELECT execution_enabled, live_trading_enabled, kill_switch_active
     FROM trading_runtime_state WHERE singleton_id = 1`,
  ), tradingStateBeforeTest, 'A viewer test event must not mutate trading runtime state.');
  assert.deepEqual(await getDatabase().get(
    `SELECT
       (SELECT COUNT(*) FROM trading_trade_intents) AS intents,
       (SELECT COUNT(*) FROM trading_positions) AS positions,
       (SELECT COUNT(*) FROM trading_orders) AS orders`,
  ), tradingRowsBeforeTest, 'A viewer test event must not create or mutate trading entities.');

  assert.equal(await recordTradingNotificationBestEffort({
    dedupeKey: 'invalid-best-effort', eventType: 'not-a-real-event', occurredAt: Date.now(), details: {},
  }), false, 'Notification persistence failures must never escape into a trading call site.');
  await recordTradingExecutionEvent({
    eventType: 'signal_received', occurredAt: 1_700_000_002_000, channelId: '-100123',
    correlationId: 'telegram-message-77', details: { telegramMessageId: '77' },
  });
  await recordTradingExecutionEvent({
    eventType: 'signal_received', occurredAt: 1_700_000_002_000, channelId: '-100123',
    correlationId: 'telegram-message-77', details: { telegramMessageId: '77' },
  });
  let notificationTypes = (await listTradingNotificationEvents({ afterSeq: 0, limit: 100 })).events.map(event => event.eventType);
  assert.equal(notificationTypes.filter(type => type === 'signal_received').length, 1,
    'Existing execution telemetry must fan out once to the generic notification log.');

  await getDatabase().run(
    `INSERT INTO trading_accounts
     (id, name, exchange, mode, status, enabled, max_concurrent_positions,
      kill_switch_active, created_at, updated_at)
     VALUES ('viewer-incident-account', 'Viewer incident account', 'paper', 'paper', 'ready', 1, 20, 0, ?, ?)`,
    [1_700_000_002_100, 1_700_000_002_100],
  );
  await updateTradingAccountConfiguration('viewer-incident-account', {
    killSwitchActive: true,
    killSwitchReason: 'Viewer contract test',
  });
  await updateTradingAccountConfiguration('viewer-incident-account', {
    killSwitchActive: true,
    killSwitchReason: 'Viewer contract test repeated',
  });
  assert.equal(
    (await listTradingNotificationEvents({ afterSeq: 0, limit: 100 })).events
      .filter(event => event.eventType === 'kill_switch_activated' && event.accountId === 'viewer-incident-account').length,
    1,
    'An account kill-switch transition must produce exactly one notification event.',
  );
  const incident = await recordTradingAccountIncident({
    accountId: 'viewer-incident-account', category: 'reconciliation_transient', severity: 'warning',
    message: 'Temporary executor outage', now: 1_700_000_002_200,
  });
  await recordTradingAccountIncident({
    accountId: 'viewer-incident-account', category: 'reconciliation_transient', severity: 'warning',
    message: 'Temporary executor outage', now: 1_700_000_002_300,
  });
  assert.equal(await resolveTradingAccountIncidents(
    'viewer-incident-account', ['reconciliation_transient'], 1_700_000_002_400,
  ), 1);
  const incidentEvents = (await listTradingNotificationEvents({ afterSeq: 0, limit: 100 })).events
    .filter(event => event.details.incidentId === incident.id);
  assert.deepEqual(incidentEvents.map(event => event.eventType), ['account_incident_opened', 'account_incident_resolved']);
  notificationTypes = incidentEvents.map(event => event.eventType);
  assert.equal(notificationTypes.length, 2, 'Incident retries must not create repeated open notifications.');

  const defaults = validateTelegramViewerSettings(DEFAULT_TELEGRAM_VIEWER_SETTINGS);
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.eventPollingIntervalMs, 2_000);
  assert.deepEqual(defaults.allowedUserIds, []);
  assert.equal(defaults.display.timeFormat, '24h');
  assert.throws(
    () => validateTelegramViewerSettings({ ...defaults, allowedUserIds: ['@username'] }),
    /user id/i,
  );
  assert.throws(
    () => validateTelegramViewerSettings({ ...defaults, allowedUserIds: ['123', '123'] }),
    /duplicate/i,
  );
  assert.throws(
    () => validateTelegramViewerSettings({ ...defaults, eventPollingIntervalMs: 999 }),
    /polling/i,
  );
  assert.throws(
    () => validateTelegramViewerSettings({ ...defaults, unknown: true }),
    /unknown/i,
  );
  assert.throws(() => validateTelegramViewerSettings(null), /object/i);
  assert.throws(
    () => validateTelegramViewerSettings({ enabled: false }),
    /missing/i,
  );
  assert.throws(
    () => validateTelegramViewerSettings({ ...defaults, enabled: 'yes' }),
    /true or false/i,
  );
  for (const timezone of ['', 'Not/A-Timezone', 'UTC\nEurope']) {
    assert.throws(
      () => validateTelegramViewerSettings({ ...defaults, timezone }),
      /timezone/i,
    );
  }
  for (const locale of ['', '_invalid', 'de-DE\n']) {
    assert.throws(
      () => validateTelegramViewerSettings({ ...defaults, locale }),
      /locale/i,
    );
  }
  assert.throws(
    () => validateTelegramViewerSettings({ ...defaults, allowedUserIds: '123' }),
    /user ids/i,
  );
  assert.throws(
    () => validateTelegramViewerSettings({ ...defaults, allowedUserIds: Array.from({ length: 101 }, (_, index) => String(index + 1)) }),
    /user ids/i,
  );
  assert.throws(
    () => validateTelegramViewerSettings({ ...defaults, notifications: null }),
    /notifications.*object/i,
  );
  assert.throws(
    () => validateTelegramViewerSettings({
      ...defaults,
      notifications: { ...defaults.notifications, positionOpened: 'yes' },
    }),
    /true or false/i,
  );
  assert.throws(
    () => validateTelegramViewerSettings({
      ...defaults,
      notifications: { ...defaults.notifications, unexpected: true },
    }),
    /unknown/i,
  );
  assert.throws(
    () => validateTelegramViewerSettings({ ...defaults, display: null }),
    /display.*object/i,
  );
  for (const display of [
    { ...defaults.display, detailLevel: 'verbose' },
    { ...defaults.display, pnlMode: 'percent_only' },
    { ...defaults.display, timeFormat: '12h' },
  ]) {
    assert.throws(
      () => validateTelegramViewerSettings({ ...defaults, display }),
      /detail level|pnl mode|time format/i,
    );
  }
  assert.throws(
    () => validateTelegramViewerSettings({ ...defaults, eventPollingIntervalMs: Number.NaN }),
    /polling/i,
  );

  const settingsStore = new ManagedTelegramViewerSettingsStore(settingsPath);
  await settingsStore.initialize();
  assert.deepEqual(settingsStore.snapshot(), defaults);
  const configuredSettings = await settingsStore.set({
    ...defaults,
    enabled: true,
    allowedUserIds: ['241170476'],
    timezone: 'Europe/Berlin',
    locale: 'de-DE',
    notifications: { ...defaults.notifications, signalReceived: true },
    display: { detailLevel: 'detailed', pnlMode: 'absolute_and_percent', timeFormat: '24h' },
  });
  assert.equal(configuredSettings.allowedUserIds[0], '241170476');
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), configuredSettings);
  await settingsStore.reset();
  assert.deepEqual(settingsStore.snapshot(), defaults);
  assert.equal(settingsStore.recoveryStatus().active, false);
  assert.equal(
    telegramViewerSettingsFromEnvironment({ TELEGRAM_VIEWER_SETTINGS_PATH: settingsPath }) instanceof ManagedTelegramViewerSettingsStore,
    true,
  );
  assert.equal(telegramViewerSettingsFromEnvironment({}) instanceof ManagedTelegramViewerSettingsStore, true);
  const recoverableSettingsPath = path.join(directory, 'config', 'recoverable-viewer-settings.json');
  await writeFile(recoverableSettingsPath, '{invalid json');
  const recoverableSettings = new ManagedTelegramViewerSettingsStore(recoverableSettingsPath);
  await recoverableSettings.initialize({ recoverInvalidFile: true });
  assert.equal(recoverableSettings.recoveryStatus().active, true);
  assert.match(recoverableSettings.recoveryStatus().reason, /json/i);
  await writeFile(settingsPath, JSON.stringify({ ...configuredSettings, padding: 'x'.repeat(140_000) }));
  await assert.rejects(
    new ManagedTelegramViewerSettingsStore(settingsPath).initialize(),
    /small regular file/i,
  );

  const secretStore = new TelegramViewerSecretStore(secretDirectory);
  await secretStore.initialize();
  const initialStatus = secretStore.status();
  assert.deepEqual(Object.keys(initialStatus).sort(), ['botToken', 'serviceToken']);
  assert.equal(initialStatus.botToken.configured, false);
  assert.equal(initialStatus.serviceToken.configured, true);
  assert.equal(JSON.stringify(initialStatus).includes(await secretStore.serviceToken()), false);
  const firstServiceToken = await secretStore.serviceToken();
  assert.match(firstServiceToken, /^[A-Za-z0-9_-]{43}$/);
  await secretStore.setBotToken('123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghi-123456789');
  assert.equal((await secretStore.readBotToken()).startsWith('123456789:'), true);
  assert.equal(secretStore.status().botToken.configured, true);
  const rotatedServiceToken = await secretStore.rotateServiceToken();
  assert.notEqual(rotatedServiceToken, firstServiceToken);
  assert.equal(await secretStore.serviceToken(), rotatedServiceToken);
  await secretStore.deleteBotToken();
  assert.equal(await secretStore.readBotToken(), null);
  assert.deepEqual((await readdir(secretDirectory)).sort(), ['viewer_service_token']);
  assert.equal(
    telegramViewerSecretStoreFromEnvironment({ TELEGRAM_VIEWER_SECRET_DIR: secretDirectory }) instanceof TelegramViewerSecretStore,
    true,
  );
  assert.equal(telegramViewerSecretStoreFromEnvironment({}) instanceof TelegramViewerSecretStore, true);
  await secretStore.clear();
  await secretStore.clear();
  assert.equal(await secretStore.serviceToken(), '');

  if (process.platform !== 'win32') {
    const symlinkPath = path.join(directory, 'viewer-settings-link.json');
    await symlink(settingsPath, symlinkPath);
    await assert.rejects(
      new ManagedTelegramViewerSettingsStore(symlinkPath).initialize(),
      /regular file/i,
    );
  }

  console.log('Telegram viewer core contracts passed.');
} finally {
  await closeDb().catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}
