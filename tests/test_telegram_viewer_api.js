import assert from 'node:assert';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { closeDb, getDatabase, initDb } from '../src/db.js';
import { ManagedTelegramViewerSettingsStore } from '../src/telegram_viewer_settings.js';
import { TelegramViewerSecretStore } from '../src/telegram_viewer_secrets.js';
import { createTelegramViewerTestEvent, recordTradingNotificationEvent } from '../src/viewer_repository.js';
import { startWebServer, stopWebServer } from '../src/web_server.js';

const ADMIN = 'dashboard-admin';
const DASHBOARD_VIEWER = 'dashboard-viewer';

function authorization(token) {
  return { Authorization: `Bearer ${token}` };
}

function mutationHeaders() {
  return {
    ...authorization(ADMIN),
    'Content-Type': 'application/json',
    'X-Requested-With': 'forwarder-dashboard',
  };
}

const authenticator = {
  isConfigured: () => true,
  authenticate: async header => {
    if (header === `Bearer ${ADMIN}`) return { id: 'operator:1', role: 'admin', mode: 'bearer' };
    if (header === `Bearer ${DASHBOARD_VIEWER}`) return { id: 'viewer:1', role: 'viewer', mode: 'bearer' };
    return null;
  },
};

async function seedViewerReadModels(now) {
  const db = getDatabase();
  await db.run(
    `INSERT INTO trading_strategy_versions
     (id, strategy_id, version, name, description, status, configuration_json,
      configuration_sha256, created_at, published_at)
     VALUES (?, ?, 1, ?, '', 'published', ?, ?, ?, ?)`,
    ['strategy-v1', 'strategy', 'Viewer strategy', JSON.stringify({ schemaVersion: 4 }), 'a'.repeat(64), now, now],
  );
  await db.run(
    `INSERT INTO trading_accounts
     (id, name, exchange, mode, status, enabled, credential_ref, external_account_id,
      max_concurrent_positions, kill_switch_active, capabilities_json, last_verified_at,
      last_reconciled_at, created_at, updated_at)
     VALUES (?, ?, ?, 'testnet', 'ready', 1, ?, ?, 20, 0, ?, ?, ?, ?, ?)`,
    [
      'account-dynamic', 'Dynamic account', 'coinbaseinternational', 'credential-ref', 'external-1',
      JSON.stringify({ reportingCurrency: 'USDC', supports: { marketOrder: true } }), now, now, now, now,
    ],
  );
  await db.run(
     `INSERT INTO trading_accounts
     (id, name, exchange, mode, status, enabled, credential_ref, max_concurrent_positions,
      kill_switch_active, created_at, updated_at)
     VALUES ('account-second', 'Second account', 'okx', 'testnet', 'ready', 1,
             'managed:account-second', 20, 0, ?, ?)`,
    [now - 1, now - 1],
  );
  await db.run(
    `INSERT INTO signals (id, chat_id, message_id, xml_content, normalized_content, created_at)
     VALUES ('signal-1', '-1001', 1, '<signal/>', '<signal/>', ?)`,
    [now],
  );
  await db.run(
    `INSERT INTO trading_trade_intents
     (id, source_signal_id, root_source_signal_id, channel_id, strategy_version_id, account_id,
      exchange, mode, symbol, side, status, signal_json, plan_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'intent-1', 'signal-1', 'signal-1', '-1001', 'strategy-v1', 'account-dynamic',
      'coinbaseinternational', 'testnet', 'BTC/USDT:USDT', 'LONG', 'monitoring', '{}',
      JSON.stringify({
        leverage: 7,
        leverageDecision: { requested: 12, effective: 7, source: 'signal', cappedBy: 'exchange' },
      }),
      now, now,
    ],
  );
  await db.run(
    `INSERT INTO trading_positions
     (id, intent_id, account_id, strategy_version_id, channel_id, symbol, side, status,
      quantity, average_entry_price, stop_price, realized_pnl, opened_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', '0.01', '60000', '59000', '0', ?, ?)`,
    ['position-1', 'intent-1', 'account-dynamic', 'strategy-v1', '-1001', 'BTC/USDT:USDT', 'LONG', now, now],
  );
  await db.run(
    `INSERT INTO trading_orders
     (id, intent_id, account_id, client_order_id, exchange_order_id, role, side, order_type,
      status, price, quantity, filled_quantity, reduce_only, request_json, response_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'entry', 'buy', 'limit', 'filled', '60000', '0.01', '0.01', 0, '{}', '{}', ?, ?)`,
    ['order-1', 'intent-1', 'account-dynamic', 'client-1', 'exchange-1', now, now],
  );
  await db.run(
    `INSERT INTO trading_fills
     (id, order_id, account_id, exchange_fill_id, price, quantity, fee, fee_asset, filled_at, raw_json)
     VALUES ('fill-1', 'order-1', 'account-dynamic', 'fill-exchange-1', '60000', '0.01', '0.25', 'USDC', ?, '{}')`,
    [now],
  );
  await db.run(
    `INSERT INTO trading_equity_snapshots
     (id, account_id, equity, available_balance, unrealized_pnl, margin_used, observed_at, bucket_minute)
     VALUES ('equity-1', 'account-dynamic', '10000', '9000', '25', '1000', ?, ?)`,
    [now, Math.floor(now / 60_000)],
  );
  await db.run(
    `INSERT INTO trading_risk_events
     (id, severity, code, account_id, intent_id, details_json, created_at)
     VALUES ('risk-1', 'warning', 'VIEWER_FIXTURE', 'account-dynamic', 'intent-1', '{}', ?)`,
    [now],
  );
  await db.run(
    `INSERT INTO trading_account_incidents
     (id, account_id, fingerprint, category, severity, message, details_json, status,
      occurrence_count, first_seen_at, last_seen_at)
     VALUES ('incident-1', 'account-dynamic', ?, 'protection', 'warning', 'Fixture incident', '{}', 'open', 1, ?, ?)`,
    ['b'.repeat(64), now, now],
  );
}

async function verifyInternalViewerApi(baseUrl, serviceToken) {
  let response = await fetch(`${baseUrl}/internal/viewer/v1/summary`);
  assert.strictEqual(response.status, 401, 'Internal viewer API must reject anonymous access');
  response = await fetch(`${baseUrl}/internal/viewer/v1/summary`, { headers: authorization('w'.repeat(43)) });
  assert.strictEqual(response.status, 401, 'Internal viewer API must reject an incorrect service token');
  response = await fetch(`${baseUrl}/internal/viewer/v1/summary`, { headers: authorization(ADMIN) });
  assert.strictEqual(response.status, 401, 'Dashboard tokens must be rejected by the internal viewer API');
  response = await fetch(`${baseUrl}/internal/viewer/v1/summary`, { headers: authorization(serviceToken) });
  assert.strictEqual(response.status, 200);
  const summary = await response.json();
  assert.strictEqual(summary.accounts.total, 2);
  assert.strictEqual(JSON.stringify(summary).includes('credential-ref'), false, 'Viewer projections must not leak credential references');

  response = await fetch(`${baseUrl}/internal/viewer/v1/summary`, { method: 'POST', headers: authorization(serviceToken) });
  assert.strictEqual(response.status, 405, 'Internal viewer API must be GET-only');
  response = await fetch(`${baseUrl}/api/status`, { headers: authorization(serviceToken) });
  assert.strictEqual(response.status, 401, 'Viewer service token must be useless on dashboard APIs');
  response = await fetch(`${baseUrl}/api/trading`, { headers: authorization(serviceToken) });
  assert.strictEqual(response.status, 401, 'Viewer service token must be useless on trading APIs');

  const routes = [
    '/config', '/system', '/accounts', '/accounts/account-dynamic', '/positions', '/positions/position-1',
    '/orders', '/orders/order-1', '/trades', '/trades/intent-1', '/performance', '/risk', '/incidents',
    '/events?afterSeq=0', '/test-events?afterSeq=0',
  ];
  const payloads = new Map();
  for (const route of routes) {
    response = await fetch(`${baseUrl}/internal/viewer/v1${route}`, { headers: authorization(serviceToken) });
    assert.strictEqual(response.status, 200, `${route} must expose a bounded read model`);
    payloads.set(route, await response.json());
  }
  assert.strictEqual(payloads.get('/accounts').accounts[0].exchange, 'coinbaseinternational');
  assert.strictEqual(payloads.get('/accounts').accounts[0].reportingCurrency, 'USDC');
  assert.deepStrictEqual(payloads.get('/positions').positions[0].leverage, {
    requested: 12, effective: 7, source: 'signal', cappedBy: 'exchange', legacy: 7,
  });
  assert.strictEqual(payloads.get('/events?afterSeq=0').events.length, 1);
  assert.strictEqual(payloads.get('/test-events?afterSeq=0').events.length, 1);
  response = await fetch(`${baseUrl}/internal/viewer/v1/accounts?limit=1&offset=1`, { headers: authorization(serviceToken) });
  assert.strictEqual(response.status, 200);
  const secondAccountPage = await response.json();
  assert.deepStrictEqual(secondAccountPage.pagination, { offset: 1, limit: 1, hasMore: false });
  assert.strictEqual(secondAccountPage.accounts.length, 1);
}

async function verifyDashboardViewerControl(baseUrl, serviceToken, settings, secrets, auditEvents) {
  let response = await fetch(`${baseUrl}/api/telegram-viewer`, { headers: authorization(DASHBOARD_VIEWER) });
  assert.strictEqual(response.status, 200, 'Dashboard viewers may inspect non-secret viewer status');
  const dashboard = await response.json();
  assert.strictEqual(dashboard.secrets.botToken.configured, true);
  assert.strictEqual(JSON.stringify(dashboard).includes(serviceToken), false);
  assert.strictEqual(dashboard.service.lastTestEventId, 77, 'Web status must expose the viewer test-delivery cursor.');
  response = await fetch(`${baseUrl}/api/telegram-viewer/settings`, {
    method: 'POST', headers: mutationHeaders(), body: JSON.stringify({
      ...settings.snapshot(), enabled: true, allowedUserIds: ['123456789'], eventPollingIntervalMs: 2500,
    }),
  });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(settings.snapshot().enabled, true);
  response = await fetch(`${baseUrl}/api/telegram-viewer/token`, {
    method: 'POST', headers: mutationHeaders(), body: JSON.stringify({ token: '987654321:abcdefghijklmnopqrstuvwxyzABCDE' }),
  });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(JSON.stringify(await response.json()).includes('987654321:'), false, 'Bot token must never be echoed');
  response = await fetch(`${baseUrl}/api/telegram-viewer/service-token/rotate`, {
    method: 'POST', headers: mutationHeaders(), body: '{}',
  });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(JSON.stringify(await response.json()).includes(await secrets.serviceToken()), false, 'Service token must never be disclosed');
  response = await fetch(`${baseUrl}/api/telegram-viewer/test`, {
    method: 'POST', headers: mutationHeaders(), body: JSON.stringify({ message: 'Web control test' }),
  });
  assert.strictEqual(response.status, 202);
  response = await fetch(`${baseUrl}/api/telegram-viewer/token`, { method: 'DELETE', headers: mutationHeaders() });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(secrets.status().botToken.configured, false);
  response = await fetch(`${baseUrl}/api/telegram-viewer/settings`, {
    method: 'POST', headers: authorization(DASHBOARD_VIEWER), body: JSON.stringify(settings.snapshot()),
  });
  assert.strictEqual(response.status, 403, 'Dashboard viewers must not mutate viewer configuration');
  assert.ok(auditEvents.some(event => event.action === 'telegram-viewer.settings.update'));
  assert.strictEqual(JSON.stringify(auditEvents).includes('987654321:'), false, 'Audit records must not contain viewer tokens');
}

async function run() {
  const testDir = await mkdtemp(path.join(os.tmpdir(), 'tsx-viewer-api-'));
  let started = false;
  try {
    await initDb(path.join(testDir, 'tsx.db'));
    const now = Date.now();
    await seedViewerReadModels(now);
    const settings = new ManagedTelegramViewerSettingsStore(path.join(testDir, 'config', 'telegram-viewer-settings.json'));
    const secrets = new TelegramViewerSecretStore(path.join(testDir, 'viewer-secrets'));
    await settings.initialize();
    await secrets.initialize();
    await secrets.setBotToken('123456789:abcdefghijklmnopqrstuvwxyzABCDE');
    const serviceToken = await secrets.serviceToken();
    await recordTradingNotificationEvent({
      dedupeKey: 'test:event:1', eventType: 'position_opened', intentId: 'intent-1', channelId: '-1001',
      accountId: 'account-dynamic', exchange: 'coinbaseinternational', mode: 'testnet', occurredAt: now,
      details: { symbol: 'BTC/USDT:USDT' },
    });
    await createTelegramViewerTestEvent({ createdBy: 'operator:seed', message: 'Seed test', now });

    const auditEvents = [];
    const appState = {
      config: { sourceChannels: [] }, state: { isRunning: false, resolvedSourceChatIds: new Set() },
      getQueueState: () => ({ running: 0, queued: 0, maxConcurrency: 1, paused: false }),
      startForwarding: async () => {}, stopForwarding: async () => {}, reloadConfig: () => {}, applyRuntimeConfig: () => {},
      authenticator,
      telegramViewerSettings: settings,
      telegramViewerSecrets: secrets,
      getTelegramViewerStatus: async () => ({
        healthy: true, ready: true, lastPollAt: now, lastTestEventId: 77,
        lastTest: { sourceSeq: 77, status: 'delivered', attemptedAt: now, deliveredAt: now, error: null },
      }),
      auditTrail: {
        record: async event => { auditEvents.push(event); },
        snapshot: () => ({ healthy: true }), replayRemote: async () => 0, flush: async () => {},
      },
    };
    const server = startWebServer(0, appState);
    started = true;
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    await verifyInternalViewerApi(baseUrl, serviceToken);
    await verifyDashboardViewerControl(baseUrl, serviceToken, settings, secrets, auditEvents);
    console.log('TELEGRAM VIEWER API SECURITY TESTS PASSED');
  } finally {
    if (started) await stopWebServer();
    await closeDb();
    await rm(testDir, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
