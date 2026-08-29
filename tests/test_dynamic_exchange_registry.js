import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import {
  closeDb, expectedDatabaseMigrations, getDatabase, initDb, LATEST_SCHEMA_VERSION,
} from '../src/db.js';
import { ExchangeCatalogClient } from '../src/exchange_catalog.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { TradingCredentialStore } from '../src/trading_credentials.js';
import { TradingEngine } from '../src/trading_engine.js';
import { createTradingAccount } from '../src/trading_repository.js';
import { TRADING_EXCHANGE_ID_PATTERN, tradingExchangeId } from '../src/trading_types.js';
import { TradingWebControl } from '../src/trading_web_control.js';

assert.equal(LATEST_SCHEMA_VERSION, 19, 'Phase 2 must add migration 19.');
assert.equal(tradingExchangeId('okx'), 'okx');
assert.equal(tradingExchangeId('kraken_futures'), 'kraken_futures');
assert.match('a-1', TRADING_EXCHANGE_ID_PATTERN);
for (const invalid of ['', 'OKX', '-okx', 'okx!', 'a'.repeat(65), null]) {
  assert.throws(() => tradingExchangeId(invalid), /exchange identifier/i);
}

async function createVersion18Fixture(databasePath, { orphanEvent = false } = {}) {
  const fixture = await open({ filename: databasePath, driver: sqlite3.Database });
  try {
    await fixture.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL
      );
      CREATE TABLE trading_accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
        exchange TEXT NOT NULL CHECK(exchange IN ('paper', 'hyperliquid', 'bybit', 'krakenfutures')),
        mode TEXT NOT NULL CHECK(mode IN ('paper', 'testnet', 'live')),
        status TEXT NOT NULL CHECK(status IN ('unverified', 'ready', 'disabled', 'error', 'degraded')),
        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
        credential_ref TEXT,
        external_account_id TEXT,
        max_concurrent_positions INTEGER NOT NULL DEFAULT 20 CHECK(max_concurrent_positions BETWEEN 1 AND 20),
        kill_switch_active INTEGER NOT NULL DEFAULT 0 CHECK(kill_switch_active IN (0, 1)),
        kill_switch_reason TEXT,
        capabilities_json TEXT,
        last_verified_at INTEGER,
        last_reconciled_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK((exchange = 'paper' AND mode = 'paper' AND credential_ref IS NULL)
           OR (exchange <> 'paper' AND mode <> 'paper' AND credential_ref IS NOT NULL))
      );
      CREATE UNIQUE INDEX uq_trading_external_account_identity
        ON trading_accounts(exchange, mode, external_account_id) WHERE external_account_id IS NOT NULL;
      CREATE INDEX idx_trading_accounts_runtime
        ON trading_accounts(enabled, status, exchange, created_at);
      CREATE TABLE signals (id TEXT PRIMARY KEY);
      CREATE TABLE trading_strategy_versions (id TEXT PRIMARY KEY);
      CREATE TABLE workflow_signal_runs (id TEXT PRIMARY KEY);
      CREATE TABLE workflow_revisions (id TEXT PRIMARY KEY);
      CREATE TABLE workflow_execution_paths (id TEXT PRIMARY KEY);
      CREATE TABLE trading_trade_intents (
        id TEXT PRIMARY KEY,
        source_signal_id TEXT NOT NULL REFERENCES signals(id) ON DELETE RESTRICT,
        root_source_signal_id TEXT NOT NULL REFERENCES signals(id) ON DELETE RESTRICT,
        signal_run_id TEXT REFERENCES workflow_signal_runs(id) ON DELETE RESTRICT,
        workflow_revision_id TEXT REFERENCES workflow_revisions(id) ON DELETE RESTRICT,
        execution_path_id TEXT REFERENCES workflow_execution_paths(id) ON DELETE RESTRICT,
        channel_id TEXT NOT NULL,
        strategy_version_id TEXT NOT NULL REFERENCES trading_strategy_versions(id) ON DELETE RESTRICT,
        account_id TEXT NOT NULL REFERENCES trading_accounts(id) ON DELETE RESTRICT,
        exchange TEXT NOT NULL CHECK(exchange IN ('paper', 'hyperliquid', 'bybit', 'krakenfutures')),
        mode TEXT NOT NULL CHECK(mode IN ('paper', 'testnet', 'live')),
        symbol TEXT NOT NULL,
        side TEXT NOT NULL CHECK(side IN ('LONG', 'SHORT')),
        status TEXT NOT NULL CHECK(status IN ('pending', 'planned', 'submitting', 'monitoring', 'completed', 'blocked', 'failed', 'unknown')),
        signal_json TEXT NOT NULL,
        plan_json TEXT,
        block_reason TEXT,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_trading_intents_status ON trading_trade_intents(status, created_at);
      CREATE INDEX idx_trading_intents_account_status ON trading_trade_intents(account_id, status, created_at);
      CREATE UNIQUE INDEX uq_trading_intent_execution_path
        ON trading_trade_intents(root_source_signal_id, execution_path_id) WHERE execution_path_id IS NOT NULL;
      CREATE TABLE trading_exchange_events (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES trading_accounts(id) ON DELETE RESTRICT,
        exchange TEXT NOT NULL CHECK(exchange IN ('hyperliquid', 'bybit', 'krakenfutures')),
        mode TEXT NOT NULL CHECK(mode IN ('testnet', 'live')),
        event_key TEXT NOT NULL CHECK(length(event_key) = 64),
        event_type TEXT NOT NULL CHECK(event_type IN ('order', 'execution', 'position', 'market', 'candle', 'stream_status')),
        symbol TEXT,
        sequence INTEGER,
        occurred_at INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE(account_id, event_key)
      );
      CREATE INDEX idx_exchange_events_account_time ON trading_exchange_events(account_id, received_at DESC);
      CREATE INDEX idx_exchange_events_type_time ON trading_exchange_events(event_type, received_at DESC);
    `);
    for (const migration of expectedDatabaseMigrations().slice(0, 18)) {
      await fixture.run(
        'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, 1)',
        migration.version, migration.name, migration.checksum,
      );
    }
    await fixture.run(
      `INSERT INTO trading_accounts (
         id, name, exchange, mode, status, enabled, credential_ref, external_account_id,
         max_concurrent_positions, kill_switch_active, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      'legacy-account', 'Legacy Hyperliquid', 'hyperliquid', 'testnet', 'ready', 1,
      'legacy-credential', '1'.repeat(64), 7, 0, 100, 200,
    );
    await fixture.run(
      "INSERT INTO signals (id) VALUES ('legacy-signal')",
    );
    await fixture.run(
      "INSERT INTO trading_strategy_versions (id) VALUES ('legacy-strategy')",
    );
    await fixture.run(
      `INSERT INTO trading_trade_intents (
         id, source_signal_id, root_source_signal_id, channel_id, strategy_version_id,
         account_id, exchange, mode, symbol, side, status, signal_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      'legacy-intent', 'legacy-signal', 'legacy-signal', 'legacy-channel', 'legacy-strategy',
      'legacy-account', 'hyperliquid', 'testnet', 'BTCUSDT', 'LONG', 'monitoring',
      '{"legacy":true}', 250, 251,
    );
    await fixture.run(
      `INSERT INTO trading_exchange_events (
         id, account_id, exchange, mode, event_key, event_type, symbol,
         sequence, occurred_at, received_at, payload_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      'legacy-event', orphanEvent ? 'missing-account' : 'legacy-account', 'hyperliquid', 'testnet',
      '2'.repeat(64), 'order', 'BTCUSDT', 9, 300, 301, '{"legacy":true}',
    );
  } finally {
    await fixture.close();
  }
}

const migrationDirectory = await mkdtemp(path.join(os.tmpdir(), 'dynamic-exchange-migration-'));
try {
  const migrationPath = path.join(migrationDirectory, 'valid-v18.db');
  await createVersion18Fixture(migrationPath);
  await initDb(migrationPath);
  assert.equal((await getDatabase().get('SELECT MAX(version) AS version FROM schema_migrations')).version, 19);
  assert.equal((await getDatabase().get("SELECT exchange FROM trading_accounts WHERE id = 'legacy-account'")).exchange, 'hyperliquid');
  assert.equal((await getDatabase().get("SELECT status FROM trading_trade_intents WHERE id = 'legacy-intent'")).status, 'monitoring');
  assert.equal((await getDatabase().get("SELECT payload_json FROM trading_exchange_events WHERE id = 'legacy-event'")).payload_json, '{"legacy":true}');
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  await closeDb();

  const rollbackPath = path.join(migrationDirectory, 'invalid-v18.db');
  await createVersion18Fixture(rollbackPath, { orphanEvent: true });
  await assert.rejects(initDb(rollbackPath), /migration 19.*failed/i);
  const rollbackInspection = await open({ filename: rollbackPath, driver: sqlite3.Database });
  try {
    assert.equal((await rollbackInspection.get('SELECT MAX(version) AS version FROM schema_migrations')).version, 18);
    const schema = await rollbackInspection.get(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'trading_accounts'",
    );
    assert.match(schema.sql, /exchange IN \('paper', 'hyperliquid', 'bybit', 'krakenfutures'\)/);
    assert.equal((await rollbackInspection.get('SELECT COUNT(*) AS count FROM trading_exchange_events')).count, 1);
  } finally {
    await rollbackInspection.close();
  }
} finally {
  await closeDb();
  await rm(migrationDirectory, { recursive: true, force: true });
}

const requests = [];
const catalogClient = new ExchangeCatalogClient(
  { getOrCreateExecutorToken: async () => 'f'.repeat(64) },
  {
    baseUrl: 'http://executor.test',
    cacheTtlMs: 1_000,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          implementation: { library: 'ccxt', version: '4.5.75', streaming: 'ccxt-pro', orderAuthority: 'rest' },
          exchanges: [{
            id: 'okx', name: 'OKX', status: 'candidate', reason: null, provider: 'ccxt',
            ccxt: { rest: true, pro: true }, markets: { linearSwap: true },
            credentialFields: [{ id: 'apiKey', label: 'API Key', required: true, secret: true }],
            modes: [], capabilities: { fetchBalance: true },
          }],
        }),
      };
    },
  },
);
const browserCatalog = await catalogClient.browserCatalog();
assert.equal(browserCatalog.exchanges[0].id, 'paper');
assert.equal(browserCatalog.exchanges[0].status, 'certified');
assert.equal(browserCatalog.exchanges[1].id, 'okx');
assert.equal(requests.length, 1);
assert.equal(requests[0].url, 'http://executor.test/v1/exchange-catalog');
assert.equal(requests[0].init.headers.Authorization, `Bearer ${'f'.repeat(64)}`);
await catalogClient.browserCatalog();
assert.equal(requests.length, 1, 'Catalog responses must use the bounded cache.');

const dynamicAdapter = {
  exchange: 'okx',
  accountSnapshot: async () => ({}),
  marketSnapshot: async () => ({}),
  submitOrder: async () => ({}),
  cancelOrder: async () => ({}),
  openState: async () => ({}),
};
const engine = new TradingEngine([]);
engine.registerAdapter(dynamicAdapter);
engine.registerAdapter(dynamicAdapter);
assert.throws(
  () => engine.registerAdapter({ ...dynamicAdapter }),
  /already registered/i,
  'A conflicting adapter for one exchange id must fail closed.',
);

const directory = await mkdtemp(path.join(os.tmpdir(), 'dynamic-exchange-registry-'));
try {
  await initDb(path.join(directory, 'state.db'));
  const account = await createTradingAccount({
    name: 'OKX candidate fixture',
    exchange: 'okx',
    mode: 'testnet',
    credentialRef: 'managed-secret',
    maxConcurrentPositions: 3,
  });
  assert.equal(account.exchange, 'okx');
  await assert.rejects(
    getDatabase().run(
      `INSERT INTO trading_accounts (
         id, name, exchange, mode, status, enabled, credential_ref,
         max_concurrent_positions, kill_switch_active, created_at, updated_at
       ) VALUES ('invalid-empty', 'Invalid', '', 'testnet', 'unverified', 0, 'managed-secret', 1, 0, 1, 1)`,
    ),
    /CHECK constraint failed/,
  );
  await assert.rejects(
    createTradingAccount({
      name: 'Oversized exchange fixture', exchange: 'x'.repeat(65), mode: 'testnet',
      credentialRef: 'managed-secret', maxConcurrentPositions: 1,
    }),
    /exchange identifier/i,
  );
  await assert.rejects(
    getDatabase().run(
      `INSERT INTO trading_accounts (
         id, name, exchange, mode, status, enabled, credential_ref,
         max_concurrent_positions, kill_switch_active, created_at, updated_at
       ) VALUES ('invalid-paper', 'Invalid paper', 'paper', 'paper', 'ready', 1, 'must-not-exist', 1, 0, 1, 1)`,
    ),
    /CHECK constraint failed/,
  );
  const indexes = new Set((await getDatabase().all("SELECT name FROM sqlite_master WHERE type = 'index'")).map((row) => row.name));
  for (const expected of [
    'uq_trading_external_account_identity', 'idx_trading_accounts_runtime',
    'idx_trading_intents_status', 'idx_trading_intents_account_status',
    'uq_trading_intent_execution_path', 'idx_exchange_events_account_time',
    'idx_exchange_events_type_time',
  ]) assert.equal(indexes.has(expected), true, `Migration 19 must preserve ${expected}.`);
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);

  const credentials = new TradingCredentialStore(path.join(directory, 'secrets'));
  await credentials.initialize();
  const paper = new PaperExchangeAdapter();
  const dynamicEngine = new TradingEngine([paper]);
  const registered = [];
  const gateioAdapter = {
    exchange: 'gateio',
    verifyAccount: async () => ({
      verified: true,
      equity: '1000',
      externalAccountId: '9'.repeat(64),
      capabilities: { reportingCurrency: 'USDT' },
    }),
    accountSnapshot: async () => ({}),
    marketSnapshot: async () => ({}),
    submitOrder: async () => ({}),
    cancelOrder: async () => ({}),
    openState: async () => ({ orders: [], positions: [], fills: [], observedAt: Date.now() }),
  };
  const controlCatalog = {
    browserCatalog: async () => ({
      implementation: { library: 'ccxt', version: '4.5.75', streaming: 'ccxt-pro', orderAuthority: 'rest' },
      exchanges: [
        {
          id: 'gateio', name: 'Gate.io', status: 'certified', reason: null, provider: 'ccxt',
          ccxt: { rest: true, pro: true }, markets: { linearSwap: true },
          credentialFields: [
            { id: 'apiKey', label: 'API Key', required: true, secret: true },
            { id: 'secret', label: 'API Secret', required: true, secret: true },
          ],
          modes: ['testnet', 'live'], capabilities: {},
        },
        {
          id: 'okx', name: 'OKX', status: 'candidate', reason: null, provider: 'ccxt',
          ccxt: { rest: true, pro: true }, markets: { linearSwap: true },
          credentialFields: [], modes: [], capabilities: {},
        },
      ],
    }),
    probe: async exchange => ({ id: exchange, status: 'candidate' }),
  };
  const control = new TradingWebControl(
    credentials,
    paper,
    [],
    dynamicEngine,
    null,
    controlCatalog,
    exchange => {
      registered.push(exchange);
      if (exchange !== 'gateio') throw new Error('Unexpected adapter creation.');
      return gateioAdapter;
    },
  );
  await assert.rejects(
    control.createAccount({
      name: 'Blocked candidate', exchange: 'okx', mode: 'testnet',
      maxConcurrentPositions: 2, credentials: {},
    }),
    /certified/i,
  );
  const created = await control.createAccount({
    name: 'Certified dynamic account', exchange: 'gateio', mode: 'testnet',
    maxConcurrentPositions: 2,
    credentials: { apiKey: 'gateio-key-123', secret: 'gateio-secret-123' },
  });
  assert.equal(created.exchange, 'gateio');
  assert.equal(created.status, 'ready');
  assert.deepEqual(registered, ['gateio']);
  await getDatabase().exec('PRAGMA foreign_keys = OFF;');
  try {
    await getDatabase().run(
      `INSERT INTO trading_trade_intents (
         id, source_signal_id, root_source_signal_id, channel_id, strategy_version_id,
         account_id, exchange, mode, symbol, side, status, signal_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      'dynamic-intent', 'fixture-signal', 'fixture-signal', 'fixture-channel', 'fixture-strategy',
      created.id, 'gateio', 'testnet', 'BTCUSDT', 'LONG', 'pending', '{}', 350, 351,
    );
    assert.equal(
      (await getDatabase().get("SELECT exchange FROM trading_trade_intents WHERE id = 'dynamic-intent'")).exchange,
      'gateio',
    );
    await getDatabase().run("DELETE FROM trading_trade_intents WHERE id = 'dynamic-intent'");
  } finally {
    await getDatabase().exec('PRAGMA foreign_keys = ON;');
  }
  await getDatabase().run(
    `INSERT INTO trading_exchange_events (
       id, account_id, exchange, mode, event_key, event_type, symbol,
       occurred_at, received_at, payload_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    'dynamic-event', created.id, 'gateio', 'testnet', '3'.repeat(64), 'order',
    'BTCUSDT', 400, 401, '{"dynamic":true}',
  );
  assert.equal(
    (await getDatabase().get("SELECT exchange FROM trading_exchange_events WHERE id = 'dynamic-event'")).exchange,
    'gateio',
  );
  await assert.rejects(
    getDatabase().run(
      `INSERT INTO trading_exchange_events (
         id, account_id, exchange, mode, event_key, event_type, occurred_at, received_at, payload_json
       ) VALUES (?, ?, 'paper', 'testnet', ?, 'order', 1, 1, '{}')`,
      'invalid-paper-event', created.id, '4'.repeat(64),
    ),
    /CHECK constraint failed/,
  );
  assert.equal((await control.exchangeCatalog()).exchanges[0].id, 'gateio');
  assert.equal((await control.probeExchange('okx')).status, 'candidate');

  const unavailableCatalog = {
    browserCatalog: async () => { throw new Error('catalog offline'); },
    probe: async () => { throw new Error('catalog offline'); },
  };
  const existingAccountControl = new TradingWebControl(
    credentials, paper, [gateioAdapter], dynamicEngine, null, unavailableCatalog,
  );
  const verifiedExisting = await existingAccountControl.verifyAccount(created.id, true);
  assert.equal(verifiedExisting.status, 'ready', 'Existing adapters must keep working while catalog access is down.');
  const accountCountBeforeCatalogFailure = Number(
    (await getDatabase().get('SELECT COUNT(*) AS count FROM trading_accounts')).count,
  );
  await assert.rejects(
    existingAccountControl.createAccount({
      name: 'Catalog outage account', exchange: 'gateio', mode: 'testnet',
      maxConcurrentPositions: 1, credentials: { apiKey: 'key', secret: 'secret' },
    }),
    /catalog offline/,
  );
  assert.equal(
    Number((await getDatabase().get('SELECT COUNT(*) AS count FROM trading_accounts')).count),
    accountCountBeforeCatalogFailure,
    'Catalog failure must block new accounts without mutating account state.',
  );
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}

console.log('Dynamic exchange registry and migration tests passed.');
