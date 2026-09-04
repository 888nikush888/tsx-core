import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { TradingEngine } from '../src/trading_engine.js';
import {
  createTradingIntent, getTradingAccount, getTradingIntent, listTradingAccounts, listTradingStrategies,
  setTradingRoute, updateTradingRuntimeState,
} from '../src/trading_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { completeSafetyState } from './fixtures/safety_acquisition.js';
import { requiredAccountEvidenceSince } from '../src/trading_account_baseline.js';
import { historyCheckpoints } from '../src/trading_history_repository.js';

const fingerprint = 'a'.repeat(64);
const generation = 'b'.repeat(64);
const profileHash = 'c'.repeat(64);
function evidence(exchange) {
  const observedAt = Date.now();
  return { version: 1, exchange, symbol: 'BTCUSDT', providerSymbol: 'BTC/USDT:USDT',
    accountFingerprint: fingerprint, credentialGeneration: generation, ccxtVersion: '4.5.75', profileVersion: 1,
    profileHash, providerApiVersion: 'hyperliquid-info-exchange-v1', origin: 'public_bound_account', observedAt, expiresAt: observedAt + 10_000,
    accountAbstraction: 'disabled',
    entryAllowed: true, reason: null, positionMode: 'oneway', marginMode: 'cross', leverage: 10,
    leverageSemantics: 'configured', sources: ['activeAssetData', 'userState'] };
}

async function syntheticFlatAccountState(account) {
  const previous = (await historyCheckpoints(account, await requiredAccountEvidenceSince(account))).find(row => row.source === 'fills');
  const state = completeSafetyState({ accountFingerprint: fingerprint });
  const now = state.observedAt;
  state.acquisition.history = [{ baseRevision: previous.revision, pages: 1, checkpoint: { ...previous,
    revision: previous.revision + 1, cursor: null, scannedThrough: now, completeness: 'complete', reason: null,
    coverage: { version: 1, profile: account.exchange === 'bybit' ? 'bybit_v5_linear_endpoint_v1' : 'hyperliquid_retained_fills_v1',
      since: previous.baselineSince, through: now } } }];
  return state;
}

async function fixture(file, blockRead, exchange = 'hyperliquid') {
  await initDb(file);
  await seedTradingFixtures();
  const [paperAccount] = await listTradingAccounts();
  const [strategy] = await listTradingStrategies();
  const paper = new PaperExchangeAdapter();
  await paper.setMarket(paperAccount.id, { symbol: 'BTCUSDT', markPrice: '105', priceTick: '0.1', quantityStep: '0.01',
    minimumQuantity: '0.01', minimumNotional: '1', maxLeverage: 10 });
  // Local transport fixture, not a provider test: execution stays in the paper tables.
  await getDatabase().run(`UPDATE trading_accounts SET exchange = ?, mode = 'testnet', credential_ref = 'fixture-no-secrets',
    external_account_id = ?, credential_generation = ?, capabilities_json = ? WHERE id = ?`,
  [exchange, fingerprint, generation, JSON.stringify({ executionProfileHash: profileHash }), paperAccount.id]);
  const account = await getTradingAccount(paperAccount.id);
  await setTradingRoute({ channelId: '-mode-fence', strategyVersionId: strategy.id, accountId: account.id, enabled: true });
  await updateTradingRuntimeState({ executionEnabled: true });
  await saveSignal('mode-fence', '-mode-fence', 1, '<signal/>', '<signal/>');
  const intent = await createTradingIntent({ sourceSignalId: 'mode-fence', channelId: '-mode-fence', signal: {
    schema: 'standard', action: 'LONG', symbol: 'BTCUSDT', entry: { type: 'range', min: '100', max: '100' },
    targets: [{ min: '110', max: '110' }, { min: '120', max: '120' }], stopLoss: '90',
  } });
  const state = { reads: 0, submits: 0, finalEvidence: null };
  const adapter = {
    exchange,
    openState: syntheticFlatAccountState,
    accountSnapshot: async () => {
      const snapshot = await paper.accountSnapshot(paperAccount);
      snapshot.accounting.accountFingerprint = fingerprint;
      return snapshot;
    },
    marketSnapshot: async (_account, symbol) => {
      const market = await paper.marketSnapshot(paperAccount, symbol);
      market.accounting.providerSymbol = 'BTC/USDT:USDT';
      market.accounting.source = 'ccxt-market-v1';
      Object.assign(market.leverageTiers, { exchange, providerSymbol: 'BTC/USDT:USDT', accountFingerprint: fingerprint,
        credentialGeneration: generation, ccxtVersion: '4.5.75', profileHash, source: 'hyperliquid_meta_asset_context_bound_scope_v1' });
      return market;
    },
    entryConstraints: async () => {
      state.reads += 1;
      state.finalEvidence = evidence(exchange);
      if (state.reads === blockRead) Object.assign(state.finalEvidence, { entryAllowed: false, reason: 'HEDGE_MODE_UNSUPPORTED', positionMode: 'hedged' });
      return state.finalEvidence;
    },
    submitProtectedEntry: (_account, entry, stop) => {
      state.submits += 1;
      return paper.submitProtectedEntry(paperAccount, entry, stop);
    },
  };
  return { intent, adapter, state };
}

async function assertReadGate(file, blockRead) {
  const { intent, adapter, state } = await fixture(file, blockRead);
  await new TradingEngine([adapter]).processIntent(intent.id);
  const stored = await getTradingIntent(intent.id);
  assert.equal(state.reads, blockRead || 2, stored.error);
  assert.equal(state.submits, blockRead ? 0 : 1, stored.error);
  if (blockRead) {
    assert.equal(stored.blockReason, 'EXECUTION_MODE_UNPROVEN');
    assert.match(stored.error, /HEDGE_MODE_UNSUPPORTED/);
    assert.equal((await getDatabase().get('SELECT COUNT(*) AS count FROM trading_paper_orders')).count, 0);
  } else assert.equal(stored.status, 'monitoring', stored.error);
}

async function assertPostJournalExpiry(file) {
  const { intent, adapter, state } = await fixture(file, 0);
  const database = getDatabase();
  const run = database.run.bind(database);
  const originalNow = Date.now;
  let crossed = false;
  database.run = async (...args) => {
    const result = await run(...args);
    if (String(args[0]).includes('UPDATE trading_operations SET phase = ?') && args[1][0] === 'dispatching') {
      crossed = true;
      Date.now = () => state.finalEvidence.expiresAt;
    }
    return result;
  };
  try { await new TradingEngine([adapter]).processIntent(intent.id); }
  finally { database.run = run; Date.now = originalNow; }
  assert.equal(crossed, true, 'Must reach the await immediately before the synchronous dispatch fence.');
  assert.equal(state.reads, 2);
  assert.equal(state.submits, 0);
  assert.equal((await getTradingIntent(intent.id)).blockReason, 'EXECUTION_MODE_UNPROVEN');
  assert.equal((await database.get('SELECT phase FROM trading_operations WHERE intent_id = ?', [intent.id])).phase, 'abandoned');
}

const directory = await mkdtemp(path.join(os.tmpdir(), 'execution-mode-fence-'));
try {
  for (const [name, blockRead] of [['correct', 0], ['preflight', 1], ['changed', 2]]) {
    await assertReadGate(path.join(directory, `${name}.db`), blockRead);
    await closeDb();
  }
  await assertPostJournalExpiry(path.join(directory, 'stale.db'));
  await closeDb();
  const bybit = await fixture(path.join(directory, 'bybit-scope.db'), 0, 'bybit');
  await new TradingEngine([bybit.adapter]).processIntent(bybit.intent.id);
  assert.equal(bybit.state.submits, 0, 'A synthetic linear EOF must not bypass the unresolved Bybit option scope.');
  assert.match((await getTradingIntent(bybit.intent.id)).error, /FILL_OPTION_SCOPE_UNPROVED/);
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
console.log('Real engine entry-mode admission, changed-mode and post-journal freshness fence tests passed (local fixtures only).');
