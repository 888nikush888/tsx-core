import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { TradingEngine } from '../src/trading_engine.js';
import { createTradingAccount, getTradingAccount, listTradingStrategies, updateTradingAccountState } from '../src/trading_repository.js';
import { recordRemoteEvidence, unresolvedEvidenceCount } from '../src/trading_evidence_repository.js';
import { exchangeRecoveryQuery } from '../src/trading_recovery.js';
import { observeAccountBaseline } from '../src/trading_account_baseline.js';
import { persistHistoryProgress } from '../src/trading_history_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'account-baseline-'));
const databasePath = path.join(directory, 'test.db');
const fingerprint = 'a'.repeat(64);
const generation = 'b'.repeat(64);
function snapshot(fills = []) {
  const now = Date.now();
  return { orders: [], positions: [], fills, observedAt: now, accountFingerprint: fingerprint,
    acquisition: { version: 1, startedAt: now, completedAt: now, checkedOrders: [], history: [],
      sources: ['positions', 'orders', 'fills', 'targeted_orders'].map(source => ({ source, startedAt: now, completedAt: now,
        completeness: ['orders', 'positions'].includes(source) ? 'complete' : 'unknown', since: null, reason: null,
        ...(['orders', 'positions'].includes(source) ? { scopes: [{ scope: 'linear:all', pages: 1, complete: true }] } : {}) })) } };
}
const oldFill = { exchangeFillId: 'old-external-fill', exchangeOrderId: 'old-external-order', clientOrderId: null,
  symbol: 'BTCUSDT', providerSymbol: 'BTC/USDT:USDT', price: '100', quantity: '1', fee: '0', feeAsset: 'USDT',
  filledAt: Date.now() - 86_400_000, raw: {} };

async function createFixture(filename) {
  await initDb(path.join(directory, filename));
  const created = await createTradingAccount({ name: 'Boundary checks', exchange: 'bybit', mode: 'testnet', credentialRef: 'fixture-only' });
  return updateTradingAccountState(created.id, { status: 'ready', enabled: true, verifiedAt: Date.now(),
    externalAccountId: fingerprint, credentialGeneration: generation });
}

async function invalidCandidateCases() {
  await closeDb();
  const changes = [
    state => { state.acquisition.sources[0].completeness = 'unknown'; },
    state => { delete state.acquisition.sources[0].scopes; },
    state => { state.acquisition.sources[1].scopes[0].complete = false; },
    state => { state.acquisition.startedAt -= 60_000; },
    state => { state.accountFingerprint = 'f'.repeat(64); },
    state => { state.positions.push({ symbol: 'BTCUSDT', side: 'LONG', quantity: '1' }); },
    state => { state.orders.push({ status: 'unknown' }); },
  ];
  for (const [index, change] of changes.entries()) {
    const account = await createFixture(`invalid-${index}.db`);
    for (let pass = 0; pass < 2; pass += 1) {
      const state = snapshot(); change(state);
      await observeAccountBaseline(account, state);
      await delay(2);
    }
    assert.equal((await getDatabase().get('SELECT COUNT(*) AS n FROM trading_account_baselines')).n, 0, `Invalid candidate ${index}`);
    await closeDb();
  }
}

async function generationAndRollbackCases() {
  const account = await createFixture('generation.db');
  await observeAccountBaseline(account, snapshot());
  const original = await getDatabase().get('SELECT * FROM trading_account_baselines');
  await delay(3);
  const rotated = await updateTradingAccountState(account.id, { status: 'ready', enabled: true, verifiedAt: Date.now(),
    externalAccountId: fingerprint, credentialGeneration: 'c'.repeat(64) });
  await observeAccountBaseline(rotated, snapshot());
  const renewed = await getDatabase().get('SELECT * FROM trading_account_baselines');
  assert.equal(renewed.status, 'candidate');
  assert.ok(renewed.boundary_at > original.boundary_at, 'Credential rotation invalidates an unfinished first observation.');
  await recordRemoteEvidence(rotated, { kind: 'fill', source: 'fetchMyTrades', reason: 'unmapped_fill',
    providerId: oldFill.exchangeFillId, providerSymbol: oldFill.providerSymbol, evidence: oldFill });
  await delay(3);
  const database = getDatabase();
  const run = database.run.bind(database);
  database.run = async (sql, ...args) => {
    if (sql.includes('SET baseline_reviewed_at')) throw new Error('Simulated classification transaction failure');
    return run(sql, ...args);
  };
  try { await assert.rejects(observeAccountBaseline(rotated, snapshot()), /transaction failure/); }
  finally { database.run = run; }
  assert.equal((await database.get('SELECT status FROM trading_account_baselines')).status, 'candidate', 'Classification failure rolls back establishment.');
  assert.equal((await database.get('SELECT classification FROM trading_remote_evidence')).classification, 'unresolved');
  await observeAccountBaseline(rotated, snapshot());
  assert.equal((await database.get('SELECT status FROM trading_account_baselines')).status, 'established');
  await closeDb();
}

async function insertClosedLedger(account, scenario) {
  await seedTradingFixtures();
  const [strategy] = await listTradingStrategies();
  await saveSignal('baseline-owned', '-baseline', 1, '<signal/>', '<signal/>');
  await getDatabase().run(`INSERT INTO trading_trade_intents (id, source_signal_id, root_source_signal_id, channel_id, strategy_version_id,
    account_id, exchange, mode, symbol, side, status, signal_json, created_at, updated_at)
    VALUES ('owned', 'baseline-owned', 'baseline-owned', '-baseline', ?, ?, 'bybit', 'testnet', 'BTCUSDT', 'LONG', 'completed', '{}', 1, 1)`,
  [strategy.id, account.id]);
  for (const role of ['entry', 'flatten']) {
    const status = role === 'entry' && scenario === 'pending' ? 'unknown' : 'filled';
    const quantity = role === 'entry' && scenario === 'false-terminal' ? '0' : '1';
    const symbol = role === 'flatten' && scenario === 'namespace' ? 'BTC/USDC:USDC' : 'BTC/USDT:USDT';
    await getDatabase().run(`INSERT INTO trading_orders (id, intent_id, account_id, client_order_id, exchange_order_id, provider_symbol,
      role, side, order_type, status, quantity, filled_quantity, reduce_only, request_json, created_at, updated_at)
      VALUES (?, 'owned', ?, ?, ?, ?, ?, ?, 'market', ?, '1', ?, ?, '{}', 1, 1)`,
    [role, account.id, role, role, symbol, role, role === 'entry' ? 'buy' : 'sell', status, quantity, role === 'entry' ? 0 : 1]);
    if (scenario !== 'missing-fills') await getDatabase().run(`INSERT INTO trading_fills
      (id, order_id, account_id, exchange_fill_id, price, quantity, fee, fee_asset, filled_at, raw_json)
      VALUES (?, ?, ?, ?, '100', '1', '0', 'USDT', 1, '{}')`, [role, role, account.id, role]);
  }
}

async function localLedgerCases() {
  for (const scenario of ['closed', 'pending', 'false-terminal', 'missing-fills', 'namespace']) {
    const account = await createFixture(`ledger-${scenario}.db`);
    await insertClosedLedger(account, scenario);
    await observeAccountBaseline(account, snapshot());
    await delay(3);
    await observeAccountBaseline(account, snapshot());
    const baseline = await getDatabase().get('SELECT * FROM trading_account_baselines');
    if (scenario === 'closed') {
      assert.equal(baseline.status, 'established');
      assert.equal(JSON.parse(baseline.proof_json).localLedger.orderCount, 2);
      assert.equal(JSON.parse(baseline.proof_json).localLedger.fillCount, 2);
      assert.equal((await exchangeRecoveryQuery(account)).since, 1, 'Old owned obligations are never hidden by a newer flat baseline.');
    } else assert.equal(baseline, undefined, `Unproved local ledger ${scenario} cannot bootstrap external-history classification.`);
    await closeDb();
  }
}

try {
  await initDb(databasePath);
  const created = await createTradingAccount({ name: 'Baseline fixture', exchange: 'bybit', mode: 'testnet', credentialRef: 'fixture-only' });
  await updateTradingAccountState(created.id, { status: 'ready', enabled: true, verifiedAt: Date.now(),
    externalAccountId: fingerprint, credentialGeneration: generation });
  const initialQuery = await exchangeRecoveryQuery(await getTradingAccount(created.id));
  let state = snapshot([oldFill]);
  let mutations = 0;
  const adapter = { exchange: 'bybit', openState: async () => state,
    submitOrder: async () => { mutations += 1; throw new Error('No real order permitted.'); },
    cancelOrder: async () => { mutations += 1; throw new Error('No real cancel permitted.'); } };
  const engine = new TradingEngine([adapter]);
  await assert.rejects(engine.reconcileAccount(created.id), /unresolved/);
  assert.equal(await unresolvedEvidenceCount(created.id), 1);
  const firstCandidate = await getDatabase().get('SELECT * FROM trading_account_baselines');
  assert.equal(firstCandidate.status, 'candidate');
  await assert.rejects(engine.reconcileAccount(created.id), /unresolved/, 'Replaying the same response is not a second fresh observation.');
  assert.equal((await getDatabase().get('SELECT status FROM trading_account_baselines')).status, 'candidate');
  await delay(5);
  state = snapshot([oldFill]);
  await engine.reconcileAccount(created.id);
  assert.equal(await unresolvedEvidenceCount(created.id), 0, 'Proved pre-baseline external history does not remain an unexplained current obligation.');
  assert.equal((await getDatabase().get('SELECT classification FROM trading_remote_evidence')).classification, 'external');
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS n FROM trading_fills')).n, 0, 'External history is never booked into owned fills.');
  assert.equal((await getTradingAccount(created.id)).killSwitchActive, true, 'Baseline classification must never auto-release the account.');
  assert.equal(mutations, 0);
  await closeDb();
  await initDb(databasePath);
  await delay(5);
  state = snapshot([oldFill]);
  await new TradingEngine([adapter]).reconcileAccount(created.id);
  assert.equal(await unresolvedEvidenceCount(created.id), 0, 'The bounded baseline survives a process/database restart.');
  assert.equal((await getDatabase().get('SELECT occurrence_count FROM trading_remote_evidence')).occurrence_count, 4);
  const baseline = await getDatabase().get('SELECT * FROM trading_account_baselines');
  const boundedQuery = await exchangeRecoveryQuery(await getTradingAccount(created.id));
  assert.equal(boundedQuery.since, baseline.boundary_at, 'Only the proven boundary can replace the arbitrary account-created history start.');
  assert.ok(boundedQuery.history.every(row => row.baselineSince === baseline.boundary_at && row.revision > initialQuery.history[0].revision));
  await assert.rejects(persistHistoryProgress(await getTradingAccount(created.id), initialQuery.history.map(checkpoint => ({
    baseRevision: checkpoint.revision, pages: 0, checkpoint: { ...checkpoint, revision: checkpoint.revision + 1 },
  }))), /checkpoint/, 'A pre-baseline in-flight history response cannot overwrite the reset checkpoint.');
  assert.equal(baseline.boundary_at, firstCandidate.boundary_at);
  assert.equal((await getDatabase().get("SELECT COUNT(*) AS n FROM trading_risk_events WHERE code = 'ACCOUNT_BASELINE_ESTABLISHED'")).n, 1,
    'The verified boundary is journaled once and is not duplicated on replay/restart.');
  assert.equal(JSON.parse(baseline.proof_json).first.startedAt, baseline.boundary_at);
  assert.ok(JSON.parse(baseline.proof_json).second.startedAt > baseline.first_completed_at);
  const recentFill = { ...oldFill, exchangeFillId: 'after-boundary', exchangeOrderId: 'after-order', filledAt: baseline.boundary_at };
  state = snapshot([oldFill, recentFill]);
  await assert.rejects(engine.reconcileAccount(created.id), /unresolved/);
  assert.equal(await unresolvedEvidenceCount(created.id), 1, 'An event exactly at or after the boundary stays unresolved.');
  await delay(5);
  state = snapshot([]);
  await assert.rejects(engine.reconcileAccount(created.id), /unresolved/);
  assert.equal((await getDatabase().get('SELECT boundary_at FROM trading_account_baselines')).boundary_at, baseline.boundary_at,
    'Repeated flat snapshots never advance the established boundary past unknown later activity.');
  state = snapshot([{ ...oldFill, price: '101' }]);
  await assert.rejects(engine.reconcileAccount(created.id), /unresolved/);
  assert.equal((await getDatabase().get("SELECT COUNT(*) AS n FROM trading_remote_evidence WHERE classification = 'conflict'")).n, 2,
    'A conflicting provider fill cannot be cleared by an established baseline.');
  await recordRemoteEvidence(await getTradingAccount(created.id), { kind: 'fill', source: 'fetchMyTrades', reason: 'unmapped_fill',
    providerId: 'legacy-unbound', providerSymbol: oldFill.providerSymbol,
    evidence: { ...oldFill, exchangeFillId: 'legacy-unbound', exchangeOrderId: 'legacy-order' } });
  await getDatabase().run("UPDATE trading_remote_evidence SET account_fingerprint = NULL WHERE provider_id = 'legacy-unbound'");
  state = snapshot();
  await assert.rejects(engine.reconcileAccount(created.id), /unresolved/);
  assert.equal((await getDatabase().get("SELECT classification FROM trading_remote_evidence WHERE provider_id = 'legacy-unbound'")).classification,
    'unresolved', 'Legacy evidence without a proved account binding is never backfilled by guessing.');
  await invalidCandidateCases();
  await generationAndRollbackCases();
  await localLedgerCases();
  console.log('Account baseline ownership boundary tests passed.');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
