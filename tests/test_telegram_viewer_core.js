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
  validateTelegramViewerSettings,
} from '../src/telegram_viewer_settings.js';
import { TelegramViewerSecretStore } from '../src/telegram_viewer_secrets.js';
import {
  createTelegramViewerTestEvent,
  listTelegramViewerTestEvents,
  listTradingNotificationEvents,
  recordTradingNotificationEvent,
  TRADING_NOTIFICATION_EVENT_TYPES,
} from '../src/viewer_repository.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-telegram-viewer-core-'));
const databasePath = path.join(directory, 'forwarder.db');
const settingsPath = path.join(directory, 'config', 'telegram-viewer-settings.json');
const secretDirectory = path.join(directory, 'viewer-secrets');

try {
  await initDb(databasePath);

  assert.equal(LATEST_SCHEMA_VERSION, 21);
  assert.deepEqual(expectedDatabaseMigrations().at(-1), {
    version: 21,
    name: 'trading_notification_and_telegram_viewer_support',
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
