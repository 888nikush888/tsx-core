import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { TradingEngine } from '../src/trading_engine.js';
import { createTradingIntent, createTradingStrategyDraft, getTradingAccount, getTradingIntent, listTradingStrategies,
  publishTradingStrategyVersion, setTradingRoute, updateTradingRuntimeState } from '../src/trading_repository.js';
import { prepareTradingOperation } from '../src/trading_recovery.js';
import { requestFromOrder } from '../src/trading_order_request.js';
import { prepareProtectedOrderIdentityRequests } from '../src/trading_order_identity.js';
import { proveEntrySafety } from '../src/trading_entry_safety.js';
import { assertCandidateNeverSent } from '../src/trading_entry_candidate.js';
import { seedTradingFixtures } from './trading_fixtures.js';

async function withFixture(test, multipleTrades = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-entry-safety-'));
  try {
    const databasePath = path.join(directory, 'entry.db');
    await initDb(databasePath);
    await seedTradingFixtures();
    let [strategy] = await listTradingStrategies();
    if (multipleTrades) {
      const configuration = structuredClone(strategy.configuration);
      configuration.safety.maxDailyLoss = '1000';
      strategy = await createTradingStrategyDraft({ name: 'Multi-trade proof fixture', configuration });
      await publishTradingStrategyVersion(strategy.id);
    }
    await setTradingRoute({ channelId: '-entry-safety', accountId: 'paper-default', strategyVersionId: strategy.id, enabled: true });
    await updateTradingRuntimeState({ executionEnabled: true });
    await saveSignal('entry-safety', '-entry-safety', 1, '<signal/>', '<signal/>');
    const signal = { schema: 'standard', action: 'LONG', symbol: 'BTCUSDT', entry: { type: 'market' },
      targets: [{ min: '110', max: '110' }, { min: '120', max: '120' }], stopLoss: '90' };
    const intent = await createTradingIntent({ sourceSignalId: 'entry-safety', channelId: '-entry-safety', signal });
    const paper = new PaperExchangeAdapter();
    await paper.setMarket('paper-default', { symbol: 'BTCUSDT', markPrice: '100', priceTick: '0.1', quantityStep: '0.01',
      minimumQuantity: '0.01', minimumNotional: '1', maxLeverage: 10 });
    await test({ intent, paper, engine: new TradingEngine([paper]), databasePath });
  } finally { await closeDb(); await rm(directory, { recursive: true, force: true }); }
}

async function noEntry(intent, code) {
  const stored = await getTradingIntent(intent.id);
  assert.equal(stored.status, 'blocked', stored.error);
  assert.equal(stored.blockReason, 'ENTRY_SAFETY_UNPROVEN', stored.error);
  assert.match(stored.error, code);
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS count FROM trading_paper_orders')).count, 0);
}

for (const missing of ['acquisition', 'orders', 'positions', 'fills']) {
  await withFixture(async ({ intent, paper, engine }) => {
    const read = paper.openState.bind(paper);
    paper.openState = async account => {
      const snapshot = await read(account);
      if (missing === 'acquisition') delete snapshot.acquisition;
      else snapshot.acquisition.sources.find(source => source.source === missing).completeness = 'partial';
      return snapshot;
    };
    await engine.processIntent(intent.id);
    await noEntry(intent, missing === 'acquisition' ? /ACQUISITION_MISSING/ : /SOURCE_.*_INCOMPLETE/);
  });
}

await withFixture(async ({ intent, engine }) => {
  await engine.processIntent(intent.id);
  assert.equal((await getTradingIntent(intent.id)).status, 'monitoring');
  const proof = await getDatabase().get("SELECT details_json FROM trading_risk_events WHERE intent_id = ? AND code = 'ENTRY_SAFETY_PROVED'", [intent.id]);
  assert.equal(JSON.parse(proof.details_json).proof.purpose, 'entryAdmission');
  assert.equal(JSON.parse(proof.details_json).proof.safe, true);
  assert.equal(JSON.parse(proof.details_json).proof.intentId, null, 'Admission proves the entire account, not only the candidate.');
  const candidate = JSON.parse(proof.details_json).proof.candidateExemption;
  assert.equal(candidate.intentId, intent.id);
  assert.equal(candidate.noSendBasis, 'current_dispatch_fence');
  assert.equal(candidate.generation, 1);
  assert.match(candidate.planHash, /^[a-f0-9]{64}$/);
  assert.match(candidate.noSendEvidenceHash, /^[a-f0-9]{64}$/);
  const operation = await getDatabase().get('SELECT id, request_hash FROM trading_operations WHERE id = ?', [candidate.operationId]);
  assert.equal(candidate.requestHash, operation.request_hash);
});

for (const change of [
  acquisition => { acquisition.startedAt -= 31_000; },
  acquisition => { acquisition.completedAt += 31_000; },
  acquisition => { acquisition.sources[0].startedAt -= 1; },
  acquisition => { acquisition.sources.find(source => source.source === 'fills').since = Date.now() + 1; },
]) {
  await withFixture(async ({ intent, paper, engine }) => {
    const read = paper.openState.bind(paper);
    paper.openState = async account => { const state = await read(account); change(state.acquisition); return state; };
    await engine.processIntent(intent.id);
    await noEntry(intent, /ACQUISITION_NOT_FRESH|SOURCE_WINDOW_INVALID|FILL_BASELINE_UNPROVED|Acquisition source falls outside|Acquisition start exceeds/);
  });
}

async function afterDispatchJournal(engine, intent, change) {
  const database = getDatabase();
  const run = database.run.bind(database);
  let crossed = false;
  database.run = async (...args) => {
    const result = await run(...args);
    if (!crossed && String(args[0]).includes('UPDATE trading_operations SET phase = ?') && args[1][0] === 'dispatching') {
      crossed = true;
      await change(run);
    }
    return result;
  };
  try { await engine.processIntent(intent.id); } finally { database.run = run; }
  assert.equal(crossed, true, 'The test reaches the durable dispatching boundary, before the adapter is called.');
  assert.equal((await database.get("SELECT COUNT(*) AS count FROM trading_risk_events WHERE intent_id = ? AND code = 'ENTRY_SAFETY_PROVED'", [intent.id])).count, 0);
}

for (const [name, change, reason] of [
  ['version', run => run("UPDATE trading_accounts SET state_version = state_version + 1 WHERE id = 'paper-default'"), /ACCOUNT_STATE_CHANGED/],
  ['profile', run => run("UPDATE trading_accounts SET capabilities_json = '{\"executionProfileHash\":\"changed\"}' WHERE id = 'paper-default'"), /ACCOUNT_IDENTITY_UNPROVED/],
  ['disabled', run => run("UPDATE trading_accounts SET enabled = 0 WHERE id = 'paper-default'"), /ACCOUNT_NOT_VERIFIED_READY/],
  ['operation-request', run => run("UPDATE trading_operations SET request_json = '{}' WHERE kind = 'protected_entry'"), /CANDIDATE_NO_DISPATCH_UNPROVED/],
  ['operation-binding', run => run("UPDATE trading_operations SET account_fingerprint = 'different-account' WHERE kind = 'protected_entry'"), /CANDIDATE_NO_DISPATCH_UNPROVED/],
  ['operation-orders', run => run("UPDATE trading_operations SET expected_orders_json = '[]' WHERE kind = 'protected_entry'"), /CANDIDATE_NO_DISPATCH_UNPROVED/],
  ['critical-risk', run => run(`INSERT INTO trading_risk_events (id, account_id, severity, code, details_json, created_at)
     VALUES ('new-critical-risk', 'paper-default', 'critical', 'NEW_CRITICAL', '{}', ?)`, [Date.now()]), /BLOCKING_ACCOUNT_INCIDENT/],
]) {
  await withFixture(async ({ intent, engine }) => {
    await afterDispatchJournal(engine, intent, change);
    try { await noEntry(intent, reason); } catch (error) { error.message = `${name}: ${error.message}`; throw error; }
    assert.equal((await getDatabase().get('SELECT phase FROM trading_operations WHERE intent_id = ?', [intent.id])).phase, 'abandoned', name);
  });
}

await withFixture(async ({ intent, engine, paper }) => {
  const originalNow = Date.now;
  const readMarket = paper.marketSnapshot.bind(paper);
  let delayed = false;
  paper.marketSnapshot = async (...args) => {
    if (!delayed) { delayed = true; const now = originalNow(); Date.now = () => now + 31_000; }
    return readMarket(...args);
  };
  try {
    await engine.processIntent(intent.id);
  } finally { Date.now = originalNow; }
  assert.equal(delayed, true, 'Slow planning expires the earlier account proof, while the later tier read itself stays fresh.');
  await noEntry(intent, /ACQUISITION_NOT_FRESH/);
});

for (const phase of ['planned', 'prepared', 'dispatching', 'unresolved']) {
  await withFixture(async ({ intent, engine, paper, databasePath }) => {
    const account = await getTradingAccount(intent.accountId);
    const { plan } = await engine.mutations.run(account.id, () => engine.preparePendingIntent(intent, engine.mutations.entryEpoch(account.id)));
    if (phase !== 'planned') {
      const entry = plan.orders.find(order => order.role === 'entry');
      const stop = plan.orders.find(order => order.role === 'stop_loss');
      await prepareTradingOperation({ account, intentId: intent.id, kind: 'protected_entry', clientOrderIds: [entry.clientOrderId, stop.clientOrderId],
        request: { entry: requestFromOrder(account, plan, entry), protectiveStop: requestFromOrder(account, plan, stop) } });
      await getDatabase().run("UPDATE trading_orders SET status = 'submitting' WHERE intent_id = ? AND role IN ('entry', 'stop_loss')", [intent.id]);
      await getDatabase().run("UPDATE trading_trade_intents SET status = 'submitting' WHERE id = ?", [intent.id]);
      if (phase !== 'prepared') await getDatabase().run('UPDATE trading_operations SET phase = ? WHERE intent_id = ?', [phase, intent.id]);
    }
    await closeDb(); await initDb(databasePath);
    if (phase === 'dispatching') {
      const old = await getDatabase().get('SELECT id FROM trading_operations WHERE intent_id = ?', [intent.id]);
      await assert.rejects(assertCandidateNeverSent(account, intent.id, plan, old.id), /CANDIDATE_NO_DISPATCH_UNPROVED/,
        'A durable ID from before restart cannot impersonate the live no-send writer capability.');
    }
    await new TradingEngine([paper]).processIntent(intent.id);
    const safeResume = ['planned', 'prepared'].includes(phase);
    const orders = await getDatabase().get('SELECT COUNT(*) AS count FROM trading_paper_orders');
    if (safeResume) {
      assert.equal((await getTradingIntent(intent.id)).status, 'monitoring', phase);
      assert.ok(orders.count > 0);
      assert.equal((await getDatabase().get("SELECT COUNT(*) AS count FROM trading_operations WHERE intent_id = ? AND kind = 'protected_entry'", [intent.id])).count, 1);
    } else {
      assert.equal(orders.count, 0, 'A restart does not turn a possibly sent candidate into a never-sent preparation.');
      assert.equal((await getDatabase().get('SELECT phase FROM trading_operations WHERE intent_id = ?', [intent.id])).phase, phase);
    }
  });
}

async function anotherIntent(first, symbol = 'ETHUSDT') {
  await saveSignal('second-entry-safety', first.channelId, 2, '<signal/>', '<signal/>');
  return createTradingIntent({ sourceSignalId: 'second-entry-safety', channelId: first.channelId,
    signal: { ...first.signal, symbol } });
}

await withFixture(async ({ intent, paper, engine }) => {
  await engine.processIntent(intent.id);
  assert.equal((await getTradingIntent(intent.id)).status, 'monitoring');
  const read = paper.openState.bind(paper);
  paper.openState = async account => {
    const state = await read(account);
    state.orders.forEach(order => { order.clientOrderId = null; });
    state.fills.forEach(fill => { fill.clientOrderId = null; });
    return state;
  };
  await paper.setMarket(intent.accountId, { symbol: 'ETHUSDT', markPrice: '100', priceTick: '0.1', quantityStep: '0.01',
    minimumQuantity: '0.01', minimumNotional: '1', maxLeverage: 10 });
  const next = await anotherIntent(intent);
  await engine.processIntent(next.id);
  const stored = await getTradingIntent(next.id);
  assert.equal(stored.status, 'monitoring', stored.error);
  assert.equal((await getDatabase().get("SELECT COUNT(*) AS count FROM trading_risk_events WHERE code = 'ENTRY_SAFETY_PROVED'")).count, 2);
  assert.equal((await read(await getTradingAccount(intent.accountId))).positions.length, 2,
    'A proved protected position and exact exchange-ID correlation do not falsely prohibit the next trade.');
}, true);

await withFixture(async ({ intent, engine }) => {
  const historical = await anotherIntent(intent);
  await getDatabase().run("UPDATE trading_trade_intents SET status = 'completed' WHERE id = ?", [historical.id]);
  await engine.processIntent(intent.id);
  await noEntry(intent, /HISTORICAL_ENTRY_MISSING/);
});

await withFixture(async ({ intent, engine }) => {
  // A different trade's durable preparation is never covered by this candidate's no-send exemption.
  const account = await getTradingAccount(intent.accountId);
  const { plan } = await engine.mutations.run(account.id, () => engine.preparePendingIntent(intent, engine.mutations.entryEpoch(account.id)));
  const entry = plan.orders.find(order => order.role === 'entry');
  const stop = plan.orders.find(order => order.role === 'stop_loss');
  await prepareTradingOperation({ account, intentId: intent.id, kind: 'protected_entry', clientOrderIds: [entry.clientOrderId, stop.clientOrderId],
    request: { entry: requestFromOrder(account, plan, entry), protectiveStop: requestFromOrder(account, plan, stop) } });
  const next = await anotherIntent(intent);
  await engine.processIntent(next.id);
  await noEntry(next, /EXCHANGE_OPERATION_UNRESOLVED/);
  assert.equal((await getDatabase().get('SELECT phase FROM trading_operations WHERE intent_id = ?', [intent.id])).phase, 'prepared');
});

await withFixture(async ({ intent, engine, paper }) => {
  const account = await getTradingAccount(intent.accountId);
  const prepared = await engine.mutations.run(account.id, () => engine.preparePendingIntent(intent, engine.mutations.entryEpoch(account.id)));
  const foreign = { symbol: intent.symbol, providerSymbol: intent.symbol, side: 'LONG', quantity: '1',
    averageEntryPrice: '100', unrealizedPnl: '0' };
  prepared.observation.reconciled.remote.positions = [foreign];
  await assert.rejects(proveEntrySafety(prepared.observation, intent.id, prepared.plan), /FOREIGN_POSITION_PRESENT/,
    'The candidate opening/zero row must not disguise foreign exposure that shares its symbol.');
  const read = paper.openState.bind(paper);
  paper.openState = async current => ({ ...await read(current), positions: [foreign] });
  await engine.processIntent(intent.id);
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS count FROM trading_paper_orders')).count, 0);
  assert.notEqual((await getTradingIntent(intent.id)).status, 'monitoring');
  assert.equal((await getTradingAccount(account.id)).killSwitchActive, true,
    'Real resumed-entry reconciliation independently isolates unowned same-symbol exposure.');
});

for (const change of [
  run => run("UPDATE trading_operations SET evidence_json = '[{\"exchangeOrderId\":\"provider-ack\",\"status\":\"open\"}]'"),
  run => run('UPDATE trading_operations SET state_version = state_version + 1'),
]) {
  await withFixture(async ({ intent, engine }) => {
    await afterDispatchJournal(engine, intent, change);
    const operation = await getDatabase().get('SELECT phase FROM trading_operations WHERE intent_id = ?', [intent.id]);
    assert.equal(operation.phase, 'unresolved', 'Contradictory ACK/history is not a proof of abandonment.');
    assert.equal((await getDatabase().get('SELECT COUNT(*) AS count FROM trading_paper_orders')).count, 0);
    const stored = await getTradingIntent(intent.id);
    assert.equal(stored.status, 'unknown');
    assert.match(stored.error, /NO_SEND_CONTRADICTED/);
    assert.equal((await getTradingAccount(intent.accountId)).killSwitchActive, true);
    assert.notEqual((await getDatabase().get('SELECT status FROM trading_positions WHERE intent_id = ?', [intent.id])).status, 'closed');
  });
}

for (const change of [
  () => getDatabase().run("UPDATE trading_operations SET evidence_json = '[{\"exchangeOrderId\":\"provider-ack\",\"status\":\"open\"}]'"),
  () => getDatabase().run('UPDATE trading_operations SET state_version = 1'),
]) {
  await withFixture(async ({ intent, engine }) => {
    const account = await getTradingAccount(intent.accountId);
    const { plan } = await engine.mutations.run(account.id, () => engine.preparePendingIntent(intent, engine.mutations.entryEpoch(account.id)));
    const entry = plan.orders.find(order => order.role === 'entry');
    const stop = plan.orders.find(order => order.role === 'stop_loss');
    await prepareTradingOperation({ account, intentId: intent.id, kind: 'protected_entry', clientOrderIds: [entry.clientOrderId, stop.clientOrderId],
      request: { entry: requestFromOrder(account, plan, entry), protectiveStop: requestFromOrder(account, plan, stop) } });
    await change();
    await assert.rejects(assertCandidateNeverSent(account, intent.id, plan), /CANDIDATE_NO_DISPATCH_UNPROVED/);
    await engine.processIntent(intent.id);
    assert.equal((await getDatabase().get('SELECT COUNT(*) AS count FROM trading_paper_orders')).count, 0);
    assert.equal((await getDatabase().get('SELECT phase FROM trading_operations WHERE intent_id = ?', [intent.id])).phase, 'prepared');
    assert.equal((await getDatabase().get('SELECT status FROM trading_positions WHERE intent_id = ?', [intent.id])).status, 'opening');
  });
}

for (const legacy of [false, true]) {
  await withFixture(async ({ intent, engine, databasePath }) => {
    const paperAccount = await getTradingAccount(intent.accountId);
    const { plan } = await engine.mutations.run(paperAccount.id,
      () => engine.preparePendingIntent(intent, engine.mutations.entryEpoch(paperAccount.id)));
    // This tests only the original-request/NoSend contract, not Kraken price/history/provider admission.
    await getDatabase().run("UPDATE trading_accounts SET exchange = 'krakenfutures', mode = 'testnet', credential_ref = 'isolated-fixture', external_account_id = ?, credential_generation = ? WHERE id = ?",
      ['a'.repeat(64), 'b'.repeat(64), paperAccount.id]);
    await getDatabase().run("UPDATE trading_trade_intents SET exchange = 'krakenfutures', mode = 'testnet' WHERE id = ?", [intent.id]);
    const account = await getTradingAccount(intent.accountId);
    const entry = requestFromOrder(account, plan, plan.orders.find(order => order.role === 'entry'));
    const protectiveStop = requestFromOrder(account, plan, plan.orders.find(order => order.role === 'stop_loss'));
    const request = legacy ? { entry, protectiveStop }
      : await prepareProtectedOrderIdentityRequests(account, intent.id, entry, protectiveStop);
    const operationId = await prepareTradingOperation({ account, intentId: intent.id, kind: 'protected_entry',
      clientOrderIds: [entry.clientOrderId, protectiveStop.clientOrderId], request });
    const original = await getDatabase().get('SELECT * FROM trading_operations WHERE id = ?', [operationId]);
    const candidate = await assertCandidateNeverSent(account, intent.id, plan);
    assert.equal(candidate.operationId, operationId);
    assert.equal(candidate.requestHash, original.request_hash);
    await closeDb(); await initDb(databasePath);
    assert.equal((await assertCandidateNeverSent(account, intent.id, plan)).requestHash, original.request_hash);
    assert.deepEqual(await getDatabase().get('SELECT * FROM trading_operations WHERE id = ?', [operationId]), original,
      'New exact tags and old tagless originals both retain their byte-identical journal across restart.');
    assert.equal((await getDatabase().get('SELECT COUNT(*) AS count FROM trading_paper_orders')).count, 0);
  });
}

console.log('Entry admission uses complete current account safety evidence before protected dispatch.');
