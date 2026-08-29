import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, LATEST_SCHEMA_VERSION } from '../src/db.js';
import { ExchangeCatalogClient } from '../src/exchange_catalog.js';
import { TradingEngine } from '../src/trading_engine.js';
import { createTradingAccount } from '../src/trading_repository.js';
import { TRADING_EXCHANGE_ID_PATTERN, tradingExchangeId } from '../src/trading_types.js';

assert.equal(LATEST_SCHEMA_VERSION, 19, 'Phase 2 must add migration 19.');
assert.equal(tradingExchangeId('okx'), 'okx');
assert.equal(tradingExchangeId('kraken_futures'), 'kraken_futures');
assert.match('a-1', TRADING_EXCHANGE_ID_PATTERN);
for (const invalid of ['', 'OKX', '-okx', 'okx!', 'a'.repeat(65), null]) {
  assert.throws(() => tradingExchangeId(invalid), /exchange identifier/i);
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
  const indexes = new Set((await getDatabase().all("SELECT name FROM sqlite_master WHERE type = 'index'")).map((row) => row.name));
  for (const expected of [
    'uq_trading_external_account_identity', 'idx_trading_accounts_runtime',
    'idx_trading_intents_status', 'idx_trading_intents_account_status',
    'uq_trading_intent_execution_path', 'idx_exchange_events_account_time',
    'idx_exchange_events_type_time',
  ]) assert.equal(indexes.has(expected), true, `Migration 19 must preserve ${expected}.`);
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}

console.log('Dynamic exchange registry and migration tests passed.');
