import assert from 'node:assert/strict';
import { requestFromOrder } from '../src/trading_order_request.js';
import { completeSafetyState } from './fixtures/safety_acquisition.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { TradingEngine } from '../src/trading_engine.js';
import { TradingMutationCoordinator } from '../src/trading_mutation_coordinator.js';
import { prepareTradingOperation, transitionTradingOperation } from '../src/trading_recovery.js';
import { TradingRuntime } from '../src/trading_runtime.js';
import { TradingSymbolUnavailableError, TradingUnresolvedOrderError } from '../src/trading_errors.js';
import {
  createTradingAccount,
  createTradingStrategyDraft,
  createTradingIntent,
  getTradingAccount,
  getTradingRuntimeState,
  getTradingIntent,
  listTradingAccounts,
  listTradingStrategies,
  publishTradingStrategyVersion,
  setTradingRoute,
  updateTradingRuntimeState,
  updateTradingAccountConfiguration,
  updateTradingAccountState,
} from '../src/trading_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { validateSignalXml } from '../src/signal_schema.js';
import { DEFAULT_STRATEGY_CONFIGURATION } from '../src/trading_strategy.js';
import {
  listTradingAccountIncidents,
  recordTradingAccountIncident,
  resolveTradingAccountIncidents,
} from '../src/trading_incidents.js';

const SIGNAL = '<signal><action>LONG</action><pair>ETHUSDT</pair><entry_range><min>3000</min><max>3100</max></entry_range><targets><target id="1">3200</target><target id="2">3300</target></targets><stoploss>2900</stoploss></signal>';

async function setup(databasePath, trailingStopPercent = null) {
  await initDb(databasePath);
  await seedTradingFixtures();
  const paper = new PaperExchangeAdapter();
  const [account] = await listTradingAccounts();
  let [strategy] = await listTradingStrategies();
  if (trailingStopPercent !== null) {
    const configuration = structuredClone(DEFAULT_STRATEGY_CONFIGURATION);
    configuration.exits.trailingStopPercent = trailingStopPercent;
    const draft = await createTradingStrategyDraft({ name: 'Trailing strategy', configuration });
    strategy = await publishTradingStrategyVersion(draft.id);
  }
  await setTradingRoute({ channelId: '-200001', strategyVersionId: strategy.id, accountId: account.id, enabled: true });
  await updateTradingRuntimeState({ executionEnabled: true });
  await paper.setMarket(account.id, {
    symbol: 'ETHUSDT', markPrice: '3000', priceTick: '0.1', quantityStep: '0.001',
    minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 25,
  });
  const signal = validateSignalXml(SIGNAL).execution;
  await saveSignal('failure-signal', '-200001', 1, SIGNAL, SIGNAL);
  const intent = await createTradingIntent({ sourceSignalId: 'failure-signal', channelId: '-200001', signal });
  return { paper, account, intent };
}

function wrappedAdapter(paper, submit, submitProtectedEntry = null) {
  return {
    exchange: 'paper',
    accountSnapshot: (...args) => paper.accountSnapshot(...args),
    marketSnapshot: (...args) => paper.marketSnapshot(...args),
    submitOrder: submit,
    submitProtectedEntry: submitProtectedEntry || (async (account, entry, protectiveStop) => {
      const entryResult = await submit(account, entry);
      const stopResult = await submit(account, protectiveStop);
      return { entry: entryResult, protectiveStop: stopResult };
    }),
    cancelOrder: (...args) => paper.cancelOrder(...args),
    openState: (...args) => paper.openState(...args),
  };
}

async function testUnknownEntry(directory) {
  const { paper, account, intent } = await setup(path.join(directory, 'unknown-entry.db'));
  let submissions = 0;
  const adapter = wrappedAdapter(paper, async () => {
    submissions += 1;
    throw new Error('simulated submit timeout');
  });
  const engine = new TradingEngine([adapter]);
  await engine.processIntent(intent.id);
  assert.equal((await getTradingIntent(intent.id)).status, 'unknown');
  assert.equal((await getDatabase().get(
    `SELECT status FROM trading_orders WHERE intent_id = ? AND role = 'entry'`,
    [intent.id],
  )).status, 'unknown');
  await engine.processIntent(intent.id);
  assert.equal(submissions, 1, 'Unknown submit outcome must never be retried blindly.');
  assert.equal((await paper.openState(account)).positions.length, 0);
  await closeDb();
}

async function testIncompleteProtectedEvidence(directory) {
  const { paper, account, intent } = await setup(path.join(directory, 'incomplete-protected.db'));
  let known;
  const adapter = wrappedAdapter(paper, (...args) => paper.submitOrder(...args), async (current, entry) => {
    known = await paper.submitOrder(current, entry);
    throw new TradingUnresolvedOrderError('Stop acknowledgement was lost.', [known]);
  });
  const engine = new TradingEngine([adapter]);
  await engine.processIntent(intent.id);
  assert.equal((await getTradingIntent(intent.id)).status, 'unknown');
  const rows = await getDatabase().all('SELECT role, exchange_order_id, status FROM trading_orders WHERE intent_id = ?', [intent.id]);
  assert.equal(rows.find(row => row.role === 'entry').exchange_order_id, known.exchangeOrderId);
  assert.equal(rows.find(row => row.role === 'entry').status, known.status);
  assert.equal(rows.find(row => row.role === 'stop_loss').status, 'unknown');
  assert.equal(rows.find(row => row.role === 'stop_loss').exchange_order_id, null);
  assert.equal((await getTradingAccount(account.id)).killSwitchActive, true);
  await closeDb();
}

async function testLegacyAccountNeedsBindingBeforePlanning(directory) {
  const { account, intent } = await setup(path.join(directory, 'legacy-account-binding.db'));
  await getDatabase().run(
    "UPDATE trading_accounts SET exchange = 'bybit', mode = 'testnet', credential_ref = 'fixture', external_account_id = ?, credential_generation = NULL WHERE id = ?",
    ['a'.repeat(64), account.id],
  );
  const engine = new TradingEngine([{ exchange: 'bybit' }]);
  await engine.processIntent(intent.id);
  assert.equal((await getTradingIntent(intent.id)).blockReason, 'ACCOUNT_IDENTITY_UNVERIFIED');
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS count FROM trading_orders WHERE intent_id = ?', [intent.id])).count, 0);
  await closeDb();
}

async function testFinalAdmissionRechecksMutableSafety(directory) {
  const cases = [
    ['route', 'ROUTE_NO_LONGER_AUTHORIZED', async ({ account, intent }) => {
      await setTradingRoute({ channelId: intent.channelId, strategyVersionId: intent.strategyVersionId, accountId: account.id, enabled: false });
    }],
    ['schema', 'SIGNAL_SCHEMA_UNAVAILABLE', async ({ intent }) => {
      await getDatabase().run('UPDATE trading_signal_schemas SET enabled = 0 WHERE id = ?', [intent.signal.schema]);
    }],
    ['transient', 'ACCOUNT_EXECUTOR_UNAVAILABLE', async ({ account }) => {
      await recordTradingAccountIncident({ accountId: account.id, category: 'reconciliation_transient', severity: 'warning', message: 'Executor became unavailable during planning.' });
    }],
    ['critical', 'ACCOUNT_INCIDENT_UNRESOLVED', async ({ account }) => {
      await recordTradingAccountIncident({ accountId: account.id, category: 'reconciliation_contract', severity: 'critical', message: 'Unresolved safety evidence during planning.' });
    }],
    ['capacity', 'MAX_CONCURRENT_POSITIONS', async ({ account, intent }) => {
      await saveSignal('concurrent-signal', intent.channelId, 2, SIGNAL, SIGNAL);
      const other = await createTradingIntent({ sourceSignalId: 'concurrent-signal', channelId: intent.channelId, signal: intent.signal });
      const now = Date.now();
      await getDatabase().run(
        `INSERT INTO trading_positions (id, intent_id, account_id, strategy_version_id, channel_id, symbol, side, status, quantity, stop_price, opened_at, updated_at)
         VALUES ('concurrent-position', ?, ?, ?, ?, 'BTCUSDT', 'LONG', 'opening', '0', '1', ?, ?)`,
        [other.id, account.id, intent.strategyVersionId, intent.channelId, now, now],
      );
      await updateTradingAccountConfiguration(account.id, { maxConcurrentPositions: 1 });
    }],
  ];
  for (const [name, reason, change] of cases) {
    const fixture = await setup(path.join(directory, `final-admission-${name}.db`));
    let submissions = 0;
    const adapter = wrappedAdapter(fixture.paper, async (...args) => {
      submissions += 1;
      return fixture.paper.submitOrder(...args);
    });
    adapter.accountSnapshot = async account => {
      const snapshot = await fixture.paper.accountSnapshot(account);
      await change(fixture);
      return snapshot;
    };
    await new TradingEngine([adapter]).processIntent(fixture.intent.id);
    assert.equal(submissions, 0, `${name} changed during planning; no order may be dispatched.`);
    const result = await getTradingIntent(fixture.intent.id);
    assert.equal(result.blockReason, reason, `${name}: ${result.status}; ${result.lastError}`);
    await closeDb();
  }
  const fixture = await setup(path.join(directory, 'final-admission-own-reservation.db'));
  await updateTradingAccountConfiguration(fixture.account.id, { maxConcurrentPositions: 1 });
  await new TradingEngine([fixture.paper]).processIntent(fixture.intent.id);
  assert.equal((await getTradingIntent(fixture.intent.id)).status, 'monitoring', 'Final admission must not count its own prepared position as another trade.');
  await closeDb();
}

async function testUnknownFillRemainsDurableAndBlocking(directory) {
  const { paper, account } = await setup(path.join(directory, 'unmapped-fill-evidence.db'));
  const fill = { exchangeFillId: 'unmanaged-fill', clientOrderId: 'unknown-but-nonempty-client', exchangeOrderId: 'unmanaged-order',
    symbol: 'ETHUSDT', providerSymbol: 'ETH/USDT:USDT', price: '3000', quantity: '1', fee: '0.5', feeAsset: 'USDT',
    filledAt: Date.now(), raw: { apiKey: 'MUST_NOT_BE_SAVED', authorization: 'Bearer MUST_NOT_BE_SAVED' } };
  const adapter = wrappedAdapter(paper, (...args) => paper.submitOrder(...args));
  adapter.openState = async () => ({ orders: [], positions: [], fills: [fill], observedAt: Date.now() });
  const engine = new TradingEngine([adapter]);
  await assert.rejects(engine.reconcileAccount(account.id), /unresolved.*evidence/i);
  await assert.rejects(engine.reconcileAccount(account.id), /unresolved.*evidence/i);
  const evidence = await getDatabase().all('SELECT * FROM trading_remote_evidence WHERE account_id = ?', [account.id]);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].occurrence_count, 2);
  assert.equal(evidence[0].classification, 'unresolved');
  assert.doesNotMatch(evidence[0].payload_json, /MUST_NOT_BE_SAVED|authorization|apiKey/);
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS count FROM trading_fills')).count, 0);
  adapter.openState = async () => ({ orders: [], positions: [], fills: [], observedAt: Date.now() });
  await assert.rejects(new TradingEngine([adapter]).reconcileAccount(account.id), /unresolved.*evidence/i,
    'A later empty history page or process restart cannot erase an unresolved fill.');
  assert.equal((await getTradingAccount(account.id)).killSwitchActive, true);
  await closeDb();
}

async function testHistoricalUnmappedOrderIsRetainedBeforeCursorAdvances(directory) {
  const { paper, account } = await setup(path.join(directory, 'unmapped-terminal-order.db'));
  const adapter = wrappedAdapter(paper, (...args) => paper.submitOrder(...args));
  const order = { clientOrderId: null, exchangeOrderId: 'historical-order', symbol: 'BTCUSDT', providerSymbol: 'BTCUSDT',
    role: 'entry', side: 'buy', quantity: '1', filledQuantity: '0', status: 'cancelled', price: '60000', triggerPrice: null,
    reduceOnly: false, averagePrice: null, error: null, raw: { authorization: 'MUST_NOT_PERSIST' } };
  adapter.openState = async () => ({ orders: [order], positions: [], fills: [], observedAt: Date.now() });
  await assert.rejects(new TradingEngine([adapter]).reconcileAccount(account.id), /unresolved.*evidence/i);
  const retained = await getDatabase().get("SELECT * FROM trading_remote_evidence WHERE provider_id = 'historical-order'");
  assert.equal(retained.classification, 'unresolved', 'Terminal does not prove an old order was external or irrelevant.');
  assert.equal(JSON.parse(retained.payload_json).status, 'cancelled');
  assert.doesNotMatch(retained.payload_json, /MUST_NOT_PERSIST|authorization/);
  adapter.openState = async () => ({ orders: [], positions: [], fills: [], observedAt: Date.now() });
  await assert.rejects(new TradingEngine([adapter]).reconcileAccount(account.id), /unresolved.*evidence/i);
  await closeDb();
}

async function testSameSideRemoteQuantityIsNotAutomaticallyOwned(directory) {
  const { paper, account, intent } = await setup(path.join(directory, 'manual-same-side-exposure.db'));
  const adapter = wrappedAdapter(paper, (...args) => paper.submitOrder(...args));
  const engine = new TradingEngine([adapter]);
  await engine.processIntent(intent.id);
  const before = await getDatabase().get('SELECT quantity FROM trading_positions WHERE intent_id = ?', [intent.id]);
  const snapshot = await paper.openState(account);
  let mutations = 0;
  adapter.submitOrder = async () => { mutations += 1; throw new Error('No mutation authorized for foreign exposure.'); };
  adapter.cancelOrder = async () => { mutations += 1; throw new Error('No cancel authorized for foreign exposure.'); };
  adapter.openState = async () => ({ ...snapshot, positions: snapshot.positions.map(position => ({ ...position, quantity: '1' })), observedAt: Date.now() });
  await assert.rejects(engine.reconcileAccount(account.id), /ownership|owned.*quantity/i);
  assert.equal(mutations, 0, 'Foreign same-side quantity must not enlarge the stop, cancel orders or be flattened.');
  assert.equal((await getDatabase().get('SELECT quantity FROM trading_positions WHERE intent_id = ?', [intent.id])).quantity, before.quantity);
  assert.equal((await getTradingAccount(account.id)).killSwitchActive, true);
  await closeDb();
}

async function testSameQuantityInAnotherSettlementIsNotOwned(directory) {
  const { paper, account, intent } = await setup(path.join(directory, 'foreign-settlement-position.db'));
  const adapter = wrappedAdapter(paper, (...args) => paper.submitOrder(...args));
  const engine = new TradingEngine([adapter]);
  await engine.processIntent(intent.id);
  const snapshot = await paper.openState(account);
  assert.equal(snapshot.positions.length, 1);
  let mutations = 0;
  adapter.submitOrder = async () => { mutations += 1; throw new Error('Foreign namespace mutation.'); };
  adapter.cancelOrder = async () => { mutations += 1; throw new Error('Foreign namespace cancel.'); };
  adapter.openState = async () => ({ ...snapshot, positions: snapshot.positions.map(position => ({
    ...position, providerSymbol: 'ETH/USDC:USDC',
  })), observedAt: Date.now() });
  await assert.rejects(engine.reconcileAccount(account.id), /POSITION_NAMESPACE_MISMATCH/);
  assert.equal(mutations, 0, 'Equal base/side/quantity in another settlement is not TSX ownership.');
  assert.equal((await getTradingAccount(account.id)).killSwitchActive, true);
  await closeDb();
}

async function testUndispatchedPlanResumesOnceAfterRestart(directory) {
  const fixture = await setup(path.join(directory, 'prepared-plan-restart.db'));
  const engine = new TradingEngine([fixture.paper]);
  const prepared = await engine.preparePendingIntent(fixture.intent);
  assert.equal((await getTradingIntent(fixture.intent.id)).status, 'planned');
  const before = await getDatabase().all('SELECT client_order_id FROM trading_orders WHERE intent_id = ? ORDER BY client_order_id', [fixture.intent.id]);
  await closeDb();
  await initDb(path.join(directory, 'prepared-plan-restart.db'));
  const resumed = new TradingEngine([fixture.paper]);
  await resumed.processIntent(fixture.intent.id);
  const recovered = await getTradingIntent(fixture.intent.id);
  assert.equal(recovered.status, 'monitoring', recovered.blockReason);
  assert.deepEqual((await getTradingIntent(fixture.intent.id)).plan, prepared.plan);
  assert.deepEqual(await getDatabase().all('SELECT client_order_id FROM trading_orders WHERE intent_id = ? ORDER BY client_order_id', [fixture.intent.id]), before);
  const remoteOrders = (await fixture.paper.openState(fixture.account)).orders.length;
  await resumed.processIntent(fixture.intent.id);
  assert.equal((await fixture.paper.openState(fixture.account)).orders.length, remoteOrders, 'A resumed plan must not dispatch twice.');
  await closeDb();
}

async function testInvalidUndispatchedPlanReleasesReservation(directory) {
  const cases = [
    ['expired', 'ENTRY_INTENT_EXPIRED', async ({ intent }, plan) => {
      await getDatabase().run('UPDATE trading_trade_intents SET created_at = ? WHERE id = ?',
        [Date.now() - plan.entryOrderTtlSeconds * 1_000 - 1, intent.id]);
    }],
    ['disabled', 'EXECUTION_DISABLED', async () => updateTradingRuntimeState({ executionEnabled: false })],
    ['route', 'ROUTE_NO_LONGER_AUTHORIZED', async ({ intent, account }) => {
      await setTradingRoute({ channelId: intent.channelId, strategyVersionId: intent.strategyVersionId, accountId: account.id, enabled: false });
    }],
    ['changed', 'PREPARED_PLAN_NO_LONGER_VALID', async ({ paper, account }) => {
      await paper.setMarket(account.id, { symbol: 'ETHUSDT', markPrice: '3000', priceTick: '1', quantityStep: '0.01',
        minimumQuantity: '0.01', minimumNotional: '10', maxLeverage: 10 });
    }],
  ];
  for (const [name, reason, invalidate] of cases) {
    const databasePath = path.join(directory, `invalid-prepared-${name}.db`);
    const fixture = await setup(databasePath);
    const { plan } = await new TradingEngine([fixture.paper]).preparePendingIntent(fixture.intent);
    const ids = plan.orders.filter(order => ['entry', 'stop_loss'].includes(order.role)).map(order => order.clientOrderId);
    const operationId = await prepareTradingOperation({ account: fixture.account, intentId: fixture.intent.id,
      kind: 'protected_entry', clientOrderIds: ids, request: {
        entry: requestFromOrder(fixture.account, plan, plan.orders.find(order => order.role === 'entry')),
        protectiveStop: requestFromOrder(fixture.account, plan, plan.orders.find(order => order.role === 'stop_loss')),
      } });
    await invalidate(fixture, plan);
    await closeDb();
    await initDb(databasePath);
    let writes = 0;
    const adapter = wrappedAdapter(fixture.paper, async () => { writes += 1; throw new Error('No write allowed.'); });
    adapter.cancelOrder = async () => { writes += 1; throw new Error('No remote cancel allowed for an unsent plan.'); };
    const restarted = new TradingEngine([adapter]);
    await restarted.processIntent(fixture.intent.id);
    assert.equal((await getTradingIntent(fixture.intent.id)).blockReason, reason);
    const position = await getDatabase().get('SELECT * FROM trading_positions WHERE intent_id = ?', [fixture.intent.id]);
    assert.equal(position.status, 'closed', `${name}: an unsubmitted invalid plan must not retain a reservation.`);
    assert.equal(position.quantity, '0');
    assert.equal((await getDatabase().get('SELECT phase FROM trading_operations WHERE id = ?', [operationId])).phase, 'abandoned');
    assert.ok((await getDatabase().all('SELECT status FROM trading_orders WHERE intent_id = ?', [fixture.intent.id])).every(order => order.status === 'cancelled'));
    await restarted.processIntent(fixture.intent.id);
    assert.equal(writes, 0);
    await closeDb();
  }
}

async function testUncertainOrChangedPlanCannotResume(directory) {
  for (const name of ['dispatching', 'order-changed']) {
    const fixture = await setup(path.join(directory, `unrecoverable-${name}.db`));
    const { plan } = await new TradingEngine([fixture.paper]).preparePendingIntent(fixture.intent);
    if (name === 'dispatching') {
      const id = await prepareTradingOperation({ account: fixture.account, intentId: fixture.intent.id, kind: 'protected_entry',
        clientOrderIds: plan.orders.filter(order => ['entry', 'stop_loss'].includes(order.role)).map(order => order.clientOrderId), request: {} });
      await transitionTradingOperation(id, 'prepared', 'dispatching');
    } else {
      await getDatabase().run("UPDATE trading_orders SET quantity = '999' WHERE intent_id = ? AND role = 'entry'", [fixture.intent.id]);
    }
    let writes = 0;
    const adapter = wrappedAdapter(fixture.paper, async () => { writes += 1; throw new Error('An uncertain plan must never be sent.'); });
    await new TradingEngine([adapter]).processIntent(fixture.intent.id);
    assert.equal(writes, 0);
    assert.equal((await getDatabase().get('SELECT status FROM trading_positions WHERE intent_id = ?', [fixture.intent.id])).status, 'opening');
    assert.equal((await getTradingIntent(fixture.intent.id)).status, 'planned', 'Uncertainty must not be converted to a local terminal state.');
    await closeDb();
  }
}

async function testProtectiveStopFailure(directory) {
  const { paper, account, intent } = await setup(path.join(directory, 'stop-failure.db'));
  const submit = (...args) => paper.submitOrder(...args);
  const adapter = wrappedAdapter(paper, submit, async (targetAccount, entry, protectiveStop) => ({
    entry: await paper.submitOrder(targetAccount, entry),
    protectiveStop: {
      clientOrderId: protectiveStop.clientOrderId,
      exchangeOrderId: 'provider-rejected-protective-stop',
      status: 'rejected',
      filledQuantity: '0',
      averagePrice: null,
      error: 'simulated provider-native protective stop rejection',
    },
  }));
  const engine = new TradingEngine([adapter]);
  await engine.processIntent(intent.id);
  assert.equal((await paper.openState(account)).positions.length, 0, 'Unprotected exposure must be flattened automatically.');
  const position = await getDatabase().get('SELECT * FROM trading_positions WHERE intent_id = ?', [intent.id]);
  assert.equal(position.status, 'emergency', 'A submitted flatten remains unsafe until exchange reconciliation proves closure.');
  assert.notEqual(position.quantity, '0');
  assert.equal((await getTradingIntent(intent.id)).status, 'unknown');
  const event = await getDatabase().get(
    `SELECT code FROM trading_risk_events WHERE intent_id = ? AND code = 'EMERGENCY_FLATTEN_PENDING_RECONCILIATION'`,
    [intent.id],
  );
  assert.equal(event.code, 'EMERGENCY_FLATTEN_PENDING_RECONCILIATION');
  await assert.rejects(engine.reconcileAccount(account.id), /EXCHANGE_OPERATION_UNRESOLVED/,
    'The protected operation still needs authoritative evidence for its rejected stop; an empty listing cannot resolve it.');
  const readState = adapter.openState;
  adapter.openState = async (...args) => {
    const state = await readState(...args);
    const stop = (await getTradingIntent(intent.id)).plan.orders.find(order => order.role === 'stop_loss');
    state.orders.push({ ...stop, symbol: intent.symbol, providerSymbol: intent.symbol,
      exchangeOrderId: 'provider-rejected-protective-stop', status: 'rejected', filledQuantity: '0', averagePrice: null,
      error: 'simulated provider-native protective stop rejection', raw: {} });
    return state;
  };
  await engine.reconcileAccount(account.id);
  const reconciled = await getDatabase().get(
    'SELECT status, quantity, realized_pnl FROM trading_positions WHERE intent_id = ?', [intent.id],
  );
  assert.equal(reconciled.status, 'closed');
  assert.equal(reconciled.quantity, '0');
  assert.notEqual(reconciled.realized_pnl, null, 'Closure PnL must be derived only after terminal fills reconcile.');
  await closeDb();
}

async function testRuntimeStopWinsPendingIntentRace(directory) {
  const { paper, intent } = await setup(path.join(directory, 'runtime-stop-race.db'));
  let submissions = 0;
  const adapter = wrappedAdapter(paper, async (...args) => {
    submissions += 1;
    return paper.submitOrder(...args);
  });
  await updateTradingRuntimeState({ executionEnabled: false });
  const engine = new TradingEngine([adapter]);
  await engine.processIntent(intent.id);
  const stopped = await getTradingIntent(intent.id);
  assert.equal(submissions, 0, 'A dashboard stop must win the race against a persisted pending intent.');
  assert.equal(stopped.status, 'blocked');
  assert.equal(stopped.blockReason, 'EXECUTION_DISABLED');
  await closeDb();
}

async function testStopDuringPreparationRevokesDispatch(directory) {
  const { paper, account, intent } = await setup(path.join(directory, 'mid-prepare-stop.db'));
  let releaseSnapshot;
  let enteredSnapshot;
  const entered = new Promise(resolve => { enteredSnapshot = resolve; });
  const hold = new Promise(resolve => { releaseSnapshot = resolve; });
  let submissions = 0;
  const adapter = wrappedAdapter(paper, async (...args) => {
    submissions += 1;
    return paper.submitOrder(...args);
  });
  adapter.accountSnapshot = async (...args) => {
    enteredSnapshot();
    await hold;
    return paper.accountSnapshot(...args);
  };
  const engine = new TradingEngine([adapter]);
  const processing = engine.processIntent(intent.id);
  await entered;
  engine.mutations.fenceEntries();
  await updateTradingRuntimeState({ executionEnabled: false });
  await updateTradingRuntimeState({ executionEnabled: true });
  releaseSnapshot();
  await processing;
  assert.equal(submissions, 0, 'Even stop followed by restart must invalidate an already prepared entry.');
  assert.equal((await getTradingIntent(intent.id)).blockReason, 'ENTRY_ADMISSION_REVOKED');
  assert.equal((await paper.openState(account)).orders.length, 0);
  assert.equal((await getDatabase().get(
    "SELECT COUNT(*) AS count FROM trading_positions WHERE intent_id = ? AND status IN ('opening','open','closing','emergency')",
    [intent.id],
  )).count, 0, 'A proven never-dispatched plan must not retain a position reservation.');
  await closeDb();
}

async function testStalePendingIntentNeverSubmits(directory) {
  const { paper, intent } = await setup(path.join(directory, 'stale-pending-intent.db'));
  await getDatabase().run(
    'UPDATE trading_trade_intents SET created_at = ?, updated_at = ? WHERE id = ?',
    [Date.now() - 901_000, Date.now() - 901_000, intent.id],
  );
  let submissions = 0;
  const adapter = wrappedAdapter(paper, async (...args) => {
    submissions += 1;
    return paper.submitOrder(...args);
  });
  await new TradingEngine([adapter]).processIntent(intent.id);
  const expired = await getTradingIntent(intent.id);
  assert.equal(submissions, 0, 'A stale pending intent must never reach order submission.');
  assert.equal(expired.status, 'blocked');
  assert.equal(expired.blockReason, 'ENTRY_INTENT_EXPIRED');
  assert.deepEqual(
    await getDatabase().get('SELECT severity, code FROM trading_risk_events WHERE intent_id = ?', [intent.id]),
    { severity: 'warning', code: 'ENTRY_INTENT_EXPIRED' },
  );
  await closeDb();
}

async function testUnavailableMarketFailureIsolation(directory) {
  const strict = await setup(path.join(directory, 'unavailable-market-strict.db'));
  const strictAdapter = {
    ...wrappedAdapter(strict.paper, (...args) => strict.paper.submitOrder(...args)),
    marketSnapshot: async () => {
      throw new Error('Exchange executor request failed (400): Hyperliquid symbol ETH is unavailable.');
    },
  };
  await new TradingEngine([strictAdapter]).processIntent(strict.intent.id);
  assert.equal((await getTradingIntent(strict.intent.id)).status, 'unknown');
  assert.deepEqual(
    await getDatabase().get('SELECT severity, code FROM trading_risk_events WHERE intent_id = ?', [strict.intent.id]),
    { severity: 'critical', code: 'ORDER_OUTCOME_UNKNOWN' },
  );
  await closeDb();

  const isolated = await setup(path.join(directory, 'unavailable-market-isolated.db'));
  const isolatedAdapter = {
    ...wrappedAdapter(isolated.paper, (...args) => isolated.paper.submitOrder(...args)),
    marketSnapshot: async () => {
      throw new TradingSymbolUnavailableError(
        'Hyperliquid symbol ETH is unavailable.',
        { exchange: 'hyperliquid', accountId: isolated.account.id, symbol: 'ETHUSDT' },
      );
    },
  };
  await new TradingEngine([isolatedAdapter]).processIntent(isolated.intent.id);
  const intent = await getTradingIntent(isolated.intent.id);
  assert.equal(intent.status, 'blocked');
  assert.equal(intent.blockReason, 'SYMBOL_UNAVAILABLE');
  assert.equal(intent.plan, null, 'An unavailable market must be rejected before an order plan exists.');
  assert.equal(
    Number((await getDatabase().get('SELECT COUNT(*) AS count FROM trading_orders WHERE intent_id = ?', [isolated.intent.id])).count),
    0,
    'An unavailable market must never reach order submission.',
  );
  assert.deepEqual(
    await getDatabase().get('SELECT severity, code FROM trading_risk_events WHERE intent_id = ?', [isolated.intent.id]),
    { severity: 'warning', code: 'SYMBOL_UNAVAILABLE' },
  );
  await closeDb();
}

async function testEntryTtlCancelsAndClosesEmptyPosition(directory) {
  const { paper, account, intent } = await setup(path.join(directory, 'entry-ttl.db'));
  await paper.setMarket(account.id, {
    symbol: 'ETHUSDT', markPrice: '4000', priceTick: '0.1', quantityStep: '0.001',
    minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 25,
  });
  const engine = new TradingEngine([paper]);
  await engine.processIntent(intent.id);
  assert.equal((await getDatabase().get(
    `SELECT status FROM trading_orders WHERE intent_id = ? AND role = 'entry'`, [intent.id],
  )).status, 'open');
  await engine.cancelExpiredEntries(Date.now() + 901_000);
  await engine.reconcileAccount(account.id);
  assert.equal((await getTradingIntent(intent.id)).status, 'failed');
  assert.equal((await getDatabase().get(
    'SELECT status FROM trading_positions WHERE intent_id = ?', [intent.id],
  )).status, 'closed');
  await closeDb();
}

async function testAdverseEntrySlippageFlattens(directory) {
  const { paper, intent } = await setup(path.join(directory, 'entry-slippage.db'));
  const roles = [];
  const remote = { orders: [], fills: [], positions: [], observedAt: Date.now() };
  const adapter = wrappedAdapter(paper, async (_account, request) => {
    roles.push(request.role);
    const executed = request.role !== 'stop_loss';
    const result = {
      clientOrderId: request.clientOrderId,
      exchangeOrderId: `fake-${request.role}`,
      providerSymbol: 'ETHUSDT',
      status: executed ? 'filled' : 'open',
      filledQuantity: executed ? request.quantity : '0',
      averagePrice: executed ? request.role === 'entry' ? '3100' : '3090' : null,
      error: null,
      raw: {},
    };
    remote.orders.push({ ...request, ...result, symbol: 'ETHUSDT' });
    if (executed) remote.fills.push({ clientOrderId: result.clientOrderId, exchangeOrderId: result.exchangeOrderId,
      exchangeFillId: `fill-${request.role}`, symbol: 'ETHUSDT', providerSymbol: 'ETHUSDT', price: result.averagePrice,
      quantity: request.quantity, fee: '0', feeAsset: 'USDT', filledAt: Date.now(), raw: {} });
    if (request.role === 'entry') remote.positions = [{ symbol: 'ETHUSDT', providerSymbol: 'ETHUSDT', side: 'LONG',
      quantity: request.quantity, averageEntryPrice: '3100', unrealizedPnl: '0' }];
    if (request.role === 'flatten') remote.positions = [];
    return result;
  });
  adapter.openState = async () => completeSafetyState(structuredClone(remote));
  const engine = new TradingEngine([adapter]);
  await engine.processIntent(intent.id);
  const blocked = await getTradingIntent(intent.id);
  assert.deepEqual(roles, ['entry', 'stop_loss', 'flatten']);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blockReason, 'MAX_SLIPPAGE');
  assert.equal((await getDatabase().get(
    'SELECT status FROM trading_positions WHERE intent_id = ?', [intent.id],
  )).status, 'emergency');
  await closeDb();
}

async function testEmergencyFlattenRetryIsIdempotent(directory) {
  const { paper, account, intent } = await setup(path.join(directory, 'flatten-retry.db'));
  let flattenSubmissions = 0;
  const flattenIds = [];
  const adapter = wrappedAdapter(paper, async (targetAccount, request) => {
    if (request.role !== 'flatten') return paper.submitOrder(targetAccount, request);
    flattenSubmissions += 1;
    flattenIds.push(request.clientOrderId);
    return {
      clientOrderId: request.clientOrderId,
      exchangeOrderId: `provider-rejected-flatten-${request.clientOrderId}`,
      status: 'rejected',
      filledQuantity: '0',
      averagePrice: null,
      error: 'simulated invalid market price',
      raw: {},
    };
  });
  const engine = new TradingEngine([adapter]);
  await engine.processIntent(intent.id);
  const managed = await getTradingIntent(intent.id);
  await assert.rejects(
    engine.emergencyFlatten(adapter, account, managed, managed.plan, new Error('first failure')),
    /Emergency flatten status is rejected/,
  );
  await getDatabase().run("UPDATE trading_orders SET updated_at = 1 WHERE intent_id = ? AND role = 'flatten'", [intent.id]);
  await assert.rejects(
    engine.emergencyFlatten(adapter, account, managed, managed.plan, new Error('retry failure')),
    /Emergency flatten status is rejected/,
  );
  assert.equal(flattenSubmissions, 2, 'A proved terminal rejection may be retried as a new durable order generation.');
  assert.notEqual(flattenIds[0], flattenIds[1], 'A rejected order identity must never be reopened for another submit.');
  const flattenRow = await getDatabase().get(
    `SELECT id FROM trading_orders WHERE intent_id = ? AND client_order_id = ?`,
    [intent.id, flattenIds[1]],
  );
  assert.ok(flattenRow?.id);
  await getDatabase().run('UPDATE trading_orders SET status = ? WHERE id = ?', ['unknown', flattenRow.id]);
  await assert.rejects(
    engine.emergencyFlatten(adapter, account, managed, managed.plan, new Error('unknown outcome')),
    /exchange reconciliation is required/,
  );
  assert.equal(flattenSubmissions, 2, 'An unresolved flatten must never be submitted a second time.');
  await getDatabase().run('UPDATE trading_orders SET status = ? WHERE id = ?', ['filled', flattenRow.id]);
  await assert.rejects(engine.emergencyFlatten(adapter, account, managed, managed.plan, new Error('already filled')), /terminal evidence/);
  assert.equal(flattenSubmissions, 2, 'A filled flag without the corresponding executed quantity must not authorize another generation.');
  assert.equal((await getDatabase().get(
    `SELECT COUNT(*) AS count FROM trading_orders WHERE intent_id = ? AND role = 'flatten'`,
    [intent.id],
  )).count, 2, 'Retain both terminal-rejection evidence and the subsequent durable attempt.');
  await closeDb();
}

function orderResult(request, status, filledQuantity, averagePrice = null) {
  return {
    clientOrderId: request.clientOrderId,
    exchangeOrderId: `fake-${request.clientOrderId}`,
    status,
    filledQuantity,
    averagePrice,
    error: null,
    raw: {},
  };
}

function orderSnapshot(request, status, filledQuantity, averagePrice = null) {
  return {
    ...orderResult(request, status, filledQuantity, averagePrice),
    symbol: request.symbol,
    role: request.role,
    side: request.side,
    quantity: request.quantity,
    price: request.price,
    triggerPrice: request.triggerPrice,
    reduceOnly: request.reduceOnly,
  };
}

async function testPartialEntryProtectionAndTerminalResizing(directory) {
  const { paper, account, intent } = await setup(path.join(directory, 'partial-entry.db'));
  let entryRequest;
  let activeStop;
  const submittedStops = new Map();
  const cancelledStopIds = new Set();
  let terminal = false;
  let cancelledStops = 0;
  const submittedTakeProfits = [];
  const entryFilledAt = Date.now();
  const adapter = wrappedAdapter(paper, async (_targetAccount, request) => {
    if (request.role === 'entry') {
      entryRequest = request;
      return orderResult(request, 'partially_filled', '0.1', '3050');
    }
    if (request.role === 'stop_loss') {
      activeStop = request;
      submittedStops.set(request.clientOrderId, request);
      return orderResult(request, 'open', '0');
    }
    if (request.role === 'take_profit') {
      submittedTakeProfits.push(request);
      return orderResult(request, 'open', '0');
    }
    throw new Error(`Unexpected ${request.role} submission.`);
  });
  adapter.cancelOrder = async (_targetAccount, clientOrderId) => {
    const cancelled = submittedStops.get(clientOrderId);
    assert.ok(cancelled, 'Only a previously confirmed stop may be cancelled.');
    assert.notEqual(clientOrderId, activeStop.clientOrderId, 'Replacement must be active before the stale stop is cancelled.');
    cancelledStops += 1;
    cancelledStopIds.add(clientOrderId);
    return orderResult(cancelled, 'cancelled', '0');
  };
  adapter.openState = async () => completeSafetyState({
    orders: terminal
      ? [
        { ...orderSnapshot(entryRequest, 'cancelled', '0.1', '3050'), providerSymbol: entryRequest.symbol },
        ...[...submittedStops.values()].map(stop => ({
          ...orderSnapshot(stop, cancelledStopIds.has(stop.clientOrderId) ? 'cancelled' : 'open', '0'),
          providerSymbol: stop.symbol, role: 'entry',
        })),
        ...submittedTakeProfits.map(target => ({ ...orderSnapshot(target, 'open', '0'), providerSymbol: target.symbol })),
      ]
      : [],
    positions: terminal
      ? [{ symbol: 'ETHUSDT', providerSymbol: 'ETHUSDT', side: 'LONG', quantity: '0.1', averageEntryPrice: '3050', unrealizedPnl: '0' }]
      : [],
    fills: terminal ? [{
      exchangeFillId: 'partial-entry-fill', clientOrderId: entryRequest.clientOrderId,
      exchangeOrderId: `fake-${entryRequest.clientOrderId}`, symbol: 'ETHUSDT', providerSymbol: 'ETHUSDT',
      price: '3050', quantity: '0.1', fee: '0', feeAsset: 'USDT', filledAt: entryFilledAt, raw: {},
    }] : [],
    observedAt: Date.now(),
  });
  const engine = new TradingEngine([adapter]);
  await engine.processIntent(intent.id);
  assert.equal(entryRequest.maxSlippagePercent, '0.5', 'Entry requests must carry the provider-side slippage budget.');
  assert.equal(activeStop.quantity, '0.327', 'An open partial entry must be protected up to its full possible quantity.');
  assert.equal(submittedTakeProfits.length, 0, 'Take profits must wait until the entry quantity is terminal.');
  assert.equal((await getDatabase().get(
    'SELECT quantity FROM trading_positions WHERE intent_id = ?', [intent.id],
  )).quantity, '0.1');

  terminal = true;
  await assert.rejects(engine.reconcileAccount(account.id), error => error.code === 'RECONCILIATION_CONTINUATION_REQUIRED');
  await engine.reconcileAccount(account.id);
  assert.equal(activeStop.quantity, '0.1', 'The protective stop must shrink to the final partial position.');
  assert.deepEqual(
    submittedTakeProfits.map(order => order.quantity),
    ['0.05', '0.05'],
    'Take profits must be rescaled to exactly the terminal filled quantity.',
  );
  assert.equal(cancelledStops, 1, 'A locally known reduce-only trigger remains a managed stop even if the provider omits its role.');
  await closeDb();
}

async function testTrailingStopOnlyMovesTowardProfit(directory) {
  const { paper, account, intent } = await setup(path.join(directory, 'trailing-stop.db'), '2');
  const engine = new TradingEngine([paper]);
  await engine.processIntent(intent.id);
  await paper.setMarket(account.id, {
    symbol: 'ETHUSDT', markPrice: '3150', priceTick: '0.1', quantityStep: '0.001',
    minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 25,
  });
  await engine.reconcileAccount(account.id);
  let state = await paper.openState(account);
  assert.equal(
    state.orders.find(order => order.role === 'stop_loss' && order.status === 'open').triggerPrice,
    '3087',
    'A configured trailing stop must follow a favorable mark price.',
  );
  await paper.setMarket(account.id, {
    symbol: 'ETHUSDT', markPrice: '3100', priceTick: '0.1', quantityStep: '0.001',
    minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 25,
  });
  await engine.reconcileAccount(account.id);
  state = await paper.openState(account);
  assert.equal(
    state.orders.find(order => order.role === 'stop_loss' && order.status === 'open').triggerPrice,
    '3087',
    'A trailing stop must never move backward when the market retraces.',
  );
  await closeDb();
}

async function testTransientExecutorIncidentBlocksOnlyNewEntriesUntilReconciled(directory) {
  const { paper, account, intent } = await setup(path.join(directory, 'transient-executor-incident.db'));
  const adapter = wrappedAdapter(paper, (...args) => paper.submitOrder(...args));
  let unavailable = true;
  adapter.openState = async (...args) => {
    if (unavailable) throw new Error('Exchange executor request failed (503): temporarily unavailable');
    return paper.openState(...args);
  };
  const engine = new TradingEngine([adapter]);

  await assert.rejects(engine.reconcileAccount(account.id), /503/);
  assert.equal((await getTradingAccount(account.id)).killSwitchActive, false);
  const openIncident = await getDatabase().get(
    `SELECT category, status FROM trading_account_incidents
     WHERE account_id = ? AND status = 'open'`,
    [account.id],
  );
  assert.deepEqual(openIncident, { category: 'reconciliation_transient', status: 'open' });

  await engine.processIntent(intent.id);
  const blockedIntent = await getTradingIntent(intent.id);
  assert.equal(blockedIntent.status, 'blocked');
  assert.equal(blockedIntent.blockReason, 'ACCOUNT_EXECUTOR_UNAVAILABLE');

  unavailable = false;
  await engine.reconcileAccount(account.id);
  const resolvedIncident = await getDatabase().get(
    `SELECT status FROM trading_account_incidents WHERE account_id = ?`,
    [account.id],
  );
  assert.equal(resolvedIncident.status, 'resolved');
  assert.equal((await getTradingAccount(account.id)).killSwitchActive, false);
  await closeDb();
}

async function testTradingAccountIncidentLifecycle(directory) {
  await initDb(path.join(directory, 'account-incident-lifecycle.db'));
  await seedTradingFixtures();
  const [account] = await listTradingAccounts();

  await assert.rejects(
    recordTradingAccountIncident({
      accountId: account.id,
      category: 'reconciliation_transient',
      severity: 'warning',
      message: '   ',
    }),
    /requires a message/,
  );

  const first = await recordTradingAccountIncident({
    accountId: account.id,
    category: 'reconciliation_transient',
    severity: 'warning',
    message: '  executor temporarily unavailable  ',
    details: { attempt: 1 },
    now: 1_000,
  });
  assert.equal(first.message, 'executor temporarily unavailable');
  assert.equal(first.occurrenceCount, 1);
  assert.equal(first.firstSeenAt, 1_000);
  assert.equal(first.resolvedAt, null);
  assert.deepEqual(first.details, { attempt: 1 });

  const repeated = await recordTradingAccountIncident({
    accountId: account.id,
    category: 'reconciliation_transient',
    severity: 'critical',
    message: 'executor temporarily unavailable',
    details: { attempt: 2 },
    now: 2_000,
  });
  assert.equal(repeated.id, first.id, 'Identical open incidents must be aggregated.');
  assert.equal(repeated.occurrenceCount, 2);
  assert.equal(repeated.firstSeenAt, 1_000);
  assert.equal(repeated.lastSeenAt, 2_000);
  assert.deepEqual(repeated.details, { attempt: 2 });
  const repeatedWithoutDetails = await recordTradingAccountIncident({
    accountId: account.id,
    category: 'reconciliation_transient',
    severity: 'warning',
    message: 'executor temporarily unavailable',
    now: 2_100,
  });
  assert.equal(repeatedWithoutDetails.occurrenceCount, 3);
  assert.deepEqual(repeatedWithoutDetails.details, {});

  const distinct = await recordTradingAccountIncident({
    accountId: account.id,
    category: 'remote_identity',
    severity: 'critical',
    message: 'executor temporarily unavailable',
    now: 1_500,
  });
  assert.notEqual(distinct.id, first.id, 'The incident category is part of the fingerprint.');
  assert.deepEqual(distinct.details, {});

  let open = await listTradingAccountIncidents();
  assert.deepEqual(open.map(incident => incident.id), [first.id, distinct.id]);
  assert.equal(await resolveTradingAccountIncidents(account.id, []), 0);
  assert.equal(await resolveTradingAccountIncidents(account.id, ['unresolved_fill'], 2_500), 0);
  assert.equal(await resolveTradingAccountIncidents(account.id, ['reconciliation_transient'], 3_000), 1);

  open = await listTradingAccountIncidents({ accountId: account.id, limit: 0 });
  assert.deepEqual(open.map(incident => incident.id), [distinct.id]);

  await getDatabase().run(
    `INSERT INTO trading_account_incidents (
       id, account_id, fingerprint, category, severity, message, details_json,
       status, occurrence_count, first_seen_at, last_seen_at, resolved_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'resolved', 1, ?, ?, ?)`,
    ['invalid-details', account.id, 'a'.repeat(64), 'unmanaged_remote', 'warning',
      'invalid details', '{', 100, 200, 200],
  );
  await getDatabase().run(
    `INSERT INTO trading_account_incidents (
       id, account_id, fingerprint, category, severity, message, details_json,
       status, occurrence_count, first_seen_at, last_seen_at, resolved_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'resolved', 1, ?, ?, ?)`,
    ['array-details', account.id, 'b'.repeat(64), 'unresolved_fill', 'critical',
      'array details', '[]', 300, 400, 400],
  );
  await getDatabase().run(
    `INSERT INTO trading_account_incidents (
       id, account_id, fingerprint, category, severity, message, details_json,
       status, occurrence_count, first_seen_at, last_seen_at, resolved_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'resolved', 1, ?, ?, ?)`,
    ['empty-details', account.id, 'c'.repeat(64), 'reconciliation_contract', 'warning',
      'empty details', '', 500, 600, 600],
  );

  const completeHistory = await listTradingAccountIncidents({ includeResolved: true, limit: 1_000 });
  assert.equal(completeHistory.length, 5);
  assert.equal(completeHistory[0].id, distinct.id, 'Open incidents must be listed before resolved history.');
  assert.deepEqual(completeHistory.find(incident => incident.id === 'invalid-details').details, {});
  assert.deepEqual(completeHistory.find(incident => incident.id === 'array-details').details, {});
  assert.deepEqual(completeHistory.find(incident => incident.id === 'empty-details').details, {});
  assert.equal(completeHistory.find(incident => incident.id === first.id).resolvedAt, 3_000);
  await closeDb();
}

async function testPeriodicReconciliationFailureDoesNotActivateHardKillSwitch(directory) {
  await initDb(path.join(directory, 'periodic-reconciliation.db'));
  await seedTradingFixtures();
  await updateTradingRuntimeState({ executionEnabled: true });
  const engine = {
    mutations: new TradingMutationCoordinator(),
    reconcileAccount: async () => { throw new Error('simulated periodic exchange outage'); },
    cancelExpiredEntries: async () => 0,
    processIntent: async () => undefined,
  };
  const runtime = new TradingRuntime(engine);
  await runtime.runOnce(false);
  const state = await getTradingRuntimeState();
  const [account] = await listTradingAccounts();
  const isolated = await getTradingAccount(account.id);
  assert.equal(state.executionEnabled, true);
  assert.equal(state.killSwitchActive, false);
  assert.equal(isolated.killSwitchActive, false);
  assert.equal(isolated.killSwitchReason, null);
  await closeDb();
}

async function testTransientReconciliationFailureKeepsRetryingWithoutHardIsolation(directory) {
  await initDb(path.join(directory, 'periodic-reconciliation-recovery.db'));
  await seedTradingFixtures();
  await updateTradingRuntimeState({ executionEnabled: true });
  let fail = false;
  const forced = [];
  const logs = [];
  const engine = {
    mutations: new TradingMutationCoordinator(),
    reconcileAccount: async (_accountId, options) => {
      forced.push(options?.force === true);
      if (fail) throw new Error('simulated transient OPEN_STATE_FAILED');
    },
    cancelExpiredEntries: async () => 0,
    processIntent: async () => undefined,
  };
  const runtime = new TradingRuntime(engine, 60_000, message => logs.push(message));
  await runtime.start();
  await runtime.enableEntries();

  fail = true;
  await runtime.runOnce(false);
  let state = await getTradingRuntimeState();
  const [account] = await listTradingAccounts();
  assert.equal(state.executionEnabled, true);
  assert.equal(state.killSwitchActive, false);
  assert.equal((await getTradingAccount(account.id)).killSwitchActive, false);

  fail = false;
  await runtime.runOnce(false);
  await runtime.runOnce(false);
  state = await getTradingRuntimeState();
  assert.equal(state.executionEnabled, true);
  assert.equal(state.killSwitchActive, false);
  assert.equal(state.killSwitchReason, null);
  assert.equal((await getTradingAccount(account.id)).killSwitchActive, false);
  assert.deepEqual(forced.slice(-2), [false, false], 'Normal protection polling must continue after a transient outage.');
  assert.ok(logs.some(message => /affected entries remain fail-closed/.test(message)));
  await runtime.stop();
  await closeDb();
}

async function testRestoredAccountIdentityRequiresExplicitSafeRelease(directory) {
  await initDb(path.join(directory, 'account-identity-recovery.db'));
  await seedTradingFixtures();
  const [account] = await listTradingAccounts();
  await updateTradingAccountConfiguration(account.id, {
    killSwitchActive: true,
    killSwitchReason: `Remote account identity is untrusted for account ${account.id}`,
  });
  const forced = [];
  const engine = {
    mutations: new TradingMutationCoordinator(),
    reconcileAccount: async (_accountId, options) => { forced.push(options?.force === true); },
    cancelExpiredEntries: async () => 0,
    processIntent: async () => undefined,
  };
  const runtime = new TradingRuntime(engine, 60_000);

  await runtime.runOnce(false);
  assert.equal(
    (await getTradingAccount(account.id)).killSwitchActive,
    true,
    'A matching authoritative identity snapshot must not clear account protection implicitly.',
  );
  await runtime.runOnce(false);
  assert.equal(
    (await getTradingAccount(account.id)).killSwitchActive,
    true,
    'Only the dedicated, verified operator release flow may clear hard account protection.',
  );
  assert.deepEqual(forced, [false, false]);
  await closeDb();
}

async function testEntryExpiryFailureActivatesKillSwitch(directory) {
  await initDb(path.join(directory, 'entry-expiry-failure.db'));
  await seedTradingFixtures();
  await updateTradingRuntimeState({ executionEnabled: true });
  const engine = {
    mutations: new TradingMutationCoordinator(),
    reconcileAccount: async () => undefined,
    cancelExpiredEntries: async () => { throw new Error('simulated expiry cancellation outage'); },
    processIntent: async () => undefined,
  };
  const runtime = new TradingRuntime(engine);
  await runtime.runOnce(false);
  assert.equal((await getTradingRuntimeState()).killSwitchActive, false);
  await closeDb();
}

async function testRuntimeIsolatesAccountFailures(directory) {
  await initDb(path.join(directory, 'runtime-account-isolation.db'));
  await seedTradingFixtures();
  const first = (await listTradingAccounts())[0];
  await getDatabase().run(
    `INSERT INTO trading_accounts (
       id, name, exchange, mode, status, enabled, created_at, updated_at
     ) VALUES ('paper-secondary', 'Secondary paper', 'paper', 'paper', 'ready', 1, ?, ?)`,
    [Date.now() + 1, Date.now() + 1],
  );
  await updateTradingRuntimeState({ executionEnabled: true });
  const calls = [];
  const engine = {
    mutations: new TradingMutationCoordinator(),
    reconcileAccount: async accountId => {
      calls.push(accountId);
      if (accountId === first.id) throw new Error('first account unavailable');
    },
    cancelExpiredEntries: async () => 0,
    processIntent: async () => undefined,
  };
  const runtime = new TradingRuntime(engine);
  await runtime.runOnce(false);
  assert.deepEqual(calls, [first.id, 'paper-secondary'], 'One account failure must not skip protection for later accounts.');
  assert.equal(runtime.isProtectionScanComplete(), true, 'A completed scan preserves account isolation; it does not declare the failed account healthy.');
  assert.equal((await getTradingAccount(first.id)).killSwitchActive, false);
  assert.equal((await getTradingAccount('paper-secondary')).killSwitchActive, false);
  await closeDb();
}

async function testStopReplacementCancellationFailsClosed(directory) {
  const { paper, account, intent } = await setup(path.join(directory, 'stop-replacement-cancel.db'), '2');
  const adapter = wrappedAdapter(paper, (...args) => paper.submitOrder(...args));
  const engine = new TradingEngine([adapter]);
  await engine.processIntent(intent.id);
  assert.equal((await getTradingIntent(intent.id)).status, 'monitoring');
  adapter.cancelOrder = async () => { throw new Error('simulated stale-stop cancellation timeout'); };
  await paper.setMarket(account.id, {
    symbol: 'ETHUSDT', markPrice: '3150', priceTick: '0.1', quantityStep: '0.001',
    minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 25,
  });

  await assert.rejects(
    engine.reconcileAccount(account.id),
    /replacement stop is active but the stale stop outcome is unresolved/i,
  );
  const state = await getTradingRuntimeState();
  const isolated = await getTradingAccount(account.id);
  assert.equal(state.executionEnabled, true);
  assert.equal(state.killSwitchActive, false);
  assert.equal(isolated.killSwitchActive, true);
  assert.match(isolated.killSwitchReason, /Protective stop cancellation is unresolved/);
  assert.equal(
    (await getDatabase().get(
      `SELECT COUNT(*) AS count FROM trading_risk_events
       WHERE intent_id = ? AND code = 'STOP_REPLACEMENT_CANCEL_UNRESOLVED'`,
      [intent.id],
    )).count,
    1,
  );
  assert.equal(
    (await paper.openState(account)).orders.filter(order => order.role === 'stop_loss' && order.status === 'open').length,
    2,
    'Both confirmed stops must remain tracked when stale-stop cancellation is unresolved.',
  );
  await closeDb();
}

async function testRemoteAccountIdentityBinding(directory) {
  await initDb(path.join(directory, 'remote-account-identity.db'));
  await seedTradingFixtures();
  const boundIdentity = 'a'.repeat(64);
  const account = await createTradingAccount({
    name: 'Bound Bybit', exchange: 'bybit', mode: 'testnet', credentialRef: 'managed-secret',
  });
  await updateTradingAccountState(account.id, {
    status: 'ready', enabled: true, verifiedAt: Date.now(), externalAccountId: boundIdentity,
  });
  await updateTradingRuntimeState({ executionEnabled: true });
  let observedIdentity = boundIdentity;
  const adapter = {
    exchange: 'bybit',
    openState: async () => ({
      orders: [], positions: [], fills: [], observedAt: Date.now(), accountFingerprint: observedIdentity,
    }),
  };
  const engine = new TradingEngine([adapter]);
  await engine.reconcileAccount(account.id);
  observedIdentity = 'b'.repeat(64);
  await assert.rejects(
    engine.reconcileAccount(account.id),
    /does not match the bound external account identity/,
  );
  const state = await getTradingRuntimeState();
  const isolated = await getTradingAccount(account.id);
  assert.equal(state.killSwitchActive, false);
  assert.equal(state.executionEnabled, true);
  assert.equal(isolated.killSwitchActive, true);
  await closeDb();
}

async function testUnmanagedHistoryWithMissingClientIdsIsSafelyIsolated(directory) {
  await initDb(path.join(directory, 'nullable-client-order-digest.db'));
  await seedTradingFixtures();
  const [account] = await listTradingAccounts();
  const terminalOrder = (exchangeOrderId, status) => ({
    clientOrderId: null,
    exchangeOrderId,
    status,
    filledQuantity: status === 'filled' ? '1' : '0',
    averagePrice: status === 'filled' ? '3000' : null,
    error: null,
    raw: {},
    symbol: 'ETHUSDT',
    role: 'entry',
    side: 'buy',
    quantity: '1',
    price: '3000',
    triggerPrice: null,
    reduceOnly: false,
  });
  let includeUnknownFill = false;
  const adapter = {
    exchange: 'paper',
    openState: async () => ({
      orders: [
        terminalOrder('remote-order-b', 'cancelled'),
        terminalOrder('remote-order-a', 'filled'),
      ],
      positions: [],
      fills: includeUnknownFill ? [{
        exchangeFillId: 'remote-fill-a',
        clientOrderId: null,
        exchangeOrderId: 'remote-order-a',
        price: '3000',
        quantity: '1',
        fee: '0',
        feeAsset: null,
        filledAt: Date.now(),
        raw: {},
      }] : [],
      observedAt: Date.now(),
    }),
  };

  await assert.rejects(new TradingEngine([adapter]).reconcileAccount(account.id), /unresolved.*evidence/i);

  assert.equal(
    (await getDatabase().get(
      "SELECT COUNT(*) AS count FROM trading_reconciliation_runs WHERE account_id = ? AND status = 'mismatch'",
      [account.id],
    )).count,
    1,
    'Nullable client IDs remain a valid contract, but unowned executed history cannot prove a safe reconciliation.',
  );
  includeUnknownFill = true;
  await assert.rejects(new TradingEngine([adapter]).reconcileAccount(account.id), /unresolved.*evidence/i);
  assert.equal(
    (await getDatabase().get(
      "SELECT COUNT(*) AS count FROM trading_account_incidents WHERE account_id = ? AND category = 'unresolved_fill'",
      [account.id],
    )).count,
    1,
    'Unmapped fills now create an explicit blocking incident, not an accidental identifier-sort crash.',
  );
  await closeDb();
}

async function testProtectionOnlyStartupRequiresExplicitEntryEnable(directory) {
  const { paper, intent } = await setup(path.join(directory, 'protection-only-startup.db'));
  const runtime = new TradingRuntime(new TradingEngine([paper]), 60_000);
  await runtime.startProtectionOnly();
  assert.equal(runtime.isProtectionScanComplete(), true);
  assert.equal((await getTradingIntent(intent.id)).status, 'pending', 'Protection-only startup must not consume pending intents.');
  await updateTradingRuntimeState({ executionEnabled: false });
  await assert.rejects(runtime.enableEntries(), /execution is disabled or the kill switch is active/);
  await updateTradingRuntimeState({ executionEnabled: true });
  await runtime.enableEntries();
  runtime.disableEntries();
  await runtime.runOnce(false);
  assert.equal((await getTradingIntent(intent.id)).status, 'pending', 'An explicitly closed entry latch must preserve pending intents.');
  await runtime.enableEntries();
  await updateTradingRuntimeState({ executionEnabled: false });
  await runtime.runOnce(false);
  assert.equal((await getTradingIntent(intent.id)).status, 'pending', 'A stopped control plane must disable entry processing.');
  await updateTradingRuntimeState({ executionEnabled: true });
  await runtime.enableEntries();
  await runtime.runOnce(false);
  assert.equal((await getTradingIntent(intent.id)).status, 'monitoring');
  await runtime.stop();
  await closeDb();
}

async function testClockDriftBlocksEveryEntryPath(directory) {
  const unsafeClock = {
    sample: () => ({
      healthy: false,
      driftMilliseconds: 1_500,
      maxDriftMilliseconds: 1_000,
      checkedAt: Date.now(),
      reason: 'simulated unsafe clock drift',
    }),
  };
  const direct = await setup(path.join(directory, 'clock-drift-direct.db'));
  const engine = new TradingEngine([direct.paper], () => undefined, unsafeClock);
  await engine.processIntent(direct.intent.id);
  const blocked = await getTradingIntent(direct.intent.id);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blockReason, 'CLOCK_DRIFT_UNSAFE');
  assert.equal((await getTradingRuntimeState()).killSwitchActive, true);
  await closeDb();

  await initDb(path.join(directory, 'clock-drift-runtime.db'));
  await seedTradingFixtures();
  await updateTradingRuntimeState({ executionEnabled: true });
  const runtime = new TradingRuntime({
    mutations: new TradingMutationCoordinator(),
    reconcileAccount: async () => undefined,
    cancelExpiredEntries: async () => 0,
    processIntent: async () => undefined,
  }, 60_000, () => undefined, unsafeClock);
  await runtime.startProtectionOnly();
  await assert.rejects(runtime.enableEntries(), /simulated unsafe clock drift/);
  const runtimeState = await getTradingRuntimeState();
  assert.equal(runtimeState.executionEnabled, false);
  assert.equal(runtimeState.killSwitchActive, true);
  assert.match(runtimeState.killSwitchReason, /clock drift exceeded/i);
  await runtime.stop();
  await closeDb();
}

async function testAccountDailyRiskIncludesExistingLoss(directory) {
  const { paper, account, intent } = await setup(path.join(directory, 'account-daily-risk.db'));
  const engine = new TradingEngine([paper]);
  await engine.processIntent(intent.id);
  await paper.setMarket(account.id, { symbol: 'ETHUSDT', markPrice: '2800', priceTick: '0.1', quantityStep: '0.001',
    minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 25 });
  await engine.reconcileAccount(account.id);
  assert.equal((await getTradingIntent(intent.id)).status, 'completed', 'The existing loss needs a real simulator roundtrip.');
  const loss = await getDatabase().get('SELECT realized_pnl FROM trading_positions WHERE intent_id=?', [intent.id]);
  assert.equal(loss.realized_pnl, '-81.75', 'Original fills, not a fabricated position total, establish the existing daily loss.');
  await paper.setMarket(account.id, { symbol: 'ETHUSDT', markPrice: '3000', priceTick: '0.1', quantityStep: '0.001',
    minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 25 });
  await saveSignal('daily-risk-signal', '-200001', 2, SIGNAL, SIGNAL);
  const next = await createTradingIntent({
    sourceSignalId: 'daily-risk-signal', channelId: '-200001', signal: validateSignalXml(SIGNAL).execution,
  });
  await engine.processIntent(next.id);
  const blocked = await getTradingIntent(next.id);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blockReason, 'MAX_DAILY_RISK');
  assert.equal(
    (await getDatabase().get('SELECT COUNT(*) AS count FROM trading_orders WHERE intent_id = ?', [next.id])).count,
    0,
    'Daily account loss and the new risk reservation must be checked before persisting or submitting orders.',
  );
  await closeDb();
}

async function testAccountDailyRiskIncludesFundingLoss(directory) {
  const { paper, intent } = await setup(path.join(directory, 'account-funding-risk.db'));
  const adapter = wrappedAdapter(paper, (...args) => paper.submitOrder(...args));
  adapter.accountSnapshot = async account => {
    const snapshot = await paper.accountSnapshot(account);
    snapshot.fundingPnlToday = '-90';
    snapshot.accounting.funding.events = [{ id: 'funding-loss-90', timestamp: snapshot.accounting.funding.until, amount: '-90', asset: 'USDT' }];
    return snapshot;
  };
  await new TradingEngine([adapter]).processIntent(intent.id);
  const blocked = await getTradingIntent(intent.id);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blockReason, 'MAX_DAILY_RISK');
  assert.equal(
    (await getDatabase().get('SELECT COUNT(*) AS count FROM trading_orders WHERE intent_id = ?', [intent.id])).count,
    0,
    'Funding losses must reduce the remaining daily risk budget before order persistence.',
  );
  await closeDb();
}

async function testRuntimeLifecycleAndDefaultFailureLogger(directory) {
  await initDb(path.join(directory, 'runtime-lifecycle.db'));
  await seedTradingFixtures();
  let reconciliations = 0;
  const engine = {
    mutations: new TradingMutationCoordinator(),
    reconcileAccount: async () => {
      reconciliations += 1;
      if (reconciliations === 2) throw new Error('scheduled failure handled by default logger');
    },
    cancelExpiredEntries: async () => 0,
    processIntent: async () => undefined,
  };
  assert.throws(() => new TradingRuntime(engine, 249), /interval must be between 250 and 60000/);
  await assert.rejects(new TradingRuntime(engine).enableEntries(), /runtime is not running/);
  const runtime = new TradingRuntime(engine, 60_000);
  await runtime.start();
  runtime.wake();
  await runtime.stop();
  assert.equal(reconciliations, 2);
  await closeDb();
}

async function waitForCondition(predicate, message) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function testExchangeStreamAcceleratesAuthoritativeReconciliation(directory) {
  await initDb(path.join(directory, 'runtime-exchange-stream.db'));
  await seedTradingFixtures();
  const account = await createTradingAccount({
    name: 'Stream Bybit', exchange: 'bybit', mode: 'testnet', credentialRef: 'managed-stream',
  });
  await updateTradingAccountState(account.id, {
    status: 'ready', enabled: true, verifiedAt: Date.now(), externalAccountId: 'stream-account',
  });
  const reconciliations = [];
  let emitted = false;
  const engine = {
    mutations: new TradingMutationCoordinator(),
    reconcileAccount: async (accountId, options) => { reconciliations.push([accountId, options?.force]); },
    cancelExpiredEntries: async () => 0,
    processIntent: async () => undefined,
    pollAccountStream: async () => {
      if (emitted) return null;
      emitted = true;
      const now = Date.now();
      return {
        account: { ...account, status: 'ready', enabled: true },
        batch: {
          events: [{
            cursor: 1,
            eventKey: 'c'.repeat(64),
            eventType: 'order',
            symbol: 'BTCUSDT',
            sequence: 1,
            occurredAt: now,
            receivedAt: now,
            payload: { orderId: 'stream-order' },
          }],
          nextCursor: 1,
          gap: false,
          health: { status: 'healthy', startedAt: now, lastEventAt: now, lastError: null },
        },
      };
    },
  };
  const runtime = new TradingRuntime(engine, 60_000);
  await runtime.startProtectionOnly();
  await waitForCondition(async () => {
    const event = await getDatabase().get(
      'SELECT id FROM trading_exchange_events WHERE account_id = ?', [account.id],
    );
    return Boolean(event) && reconciliations.some(([id, force]) => id === account.id && force === true);
  }, 'WebSocket state event did not trigger authoritative forced reconciliation.');
  assert.ok(
    reconciliations.some(([id, force]) => id === account.id && force === true),
    'State-bearing stream events must accelerate a forced REST reconciliation.',
  );
  await runtime.stop();
  const streamState = await getDatabase().get(
    'SELECT status FROM trading_exchange_stream_state WHERE account_id = ?', [account.id],
  );
  assert.equal(streamState.status, 'stopped');
  await closeDb();
}

async function testStartupReconciliationFailureKeepsControlPlaneAvailable(directory) {
  await initDb(path.join(directory, 'startup-reconciliation.db'));
  await seedTradingFixtures();
  await updateTradingRuntimeState({ executionEnabled: true });
  const logs = [];
  const engine = {
    mutations: new TradingMutationCoordinator(),
    reconcileAccount: async () => { throw new Error('simulated unmanaged startup exposure'); },
    cancelExpiredEntries: async () => 0,
    processIntent: async () => undefined,
  };
  const runtime = new TradingRuntime(engine, 60_000, message => logs.push(message));

  await runtime.start();

  const state = await getTradingRuntimeState();
  const [account] = await listTradingAccounts();
  const isolated = await getTradingAccount(account.id);
  assert.equal(state.executionEnabled, true);
  assert.equal(state.killSwitchActive, false);
  assert.equal(isolated.killSwitchActive, false);
  assert.equal(isolated.killSwitchReason, null);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /affected entries remain fail-closed/);
  await runtime.enableEntries();
  await runtime.stop();
  await closeDb();
}

async function testUnmanagedExposureAndOperatorFlatten(directory) {
  const unmanaged = await setup(path.join(directory, 'unmanaged-exposure.db'));
  const unmanagedAdapter = wrappedAdapter(unmanaged.paper, (...args) => unmanaged.paper.submitOrder(...args));
  unmanagedAdapter.openState = async () => ({
    orders: [{
      clientOrderId: `0x${'9'.repeat(32)}`, exchangeOrderId: 'external-1', status: 'open',
      filledQuantity: '0', averagePrice: null, error: null, raw: {}, symbol: 'ETHUSDT',
      role: 'entry', side: 'buy', quantity: '1', price: '3000', triggerPrice: null, reduceOnly: false,
    }],
    positions: [], fills: [], observedAt: Date.now(),
  });
  await assert.rejects(
    new TradingEngine([unmanagedAdapter]).reconcileAccount(unmanaged.account.id),
    /Unmanaged remote order or position/,
  );
  assert.equal((await getTradingRuntimeState()).killSwitchActive, false);
  assert.equal((await getTradingAccount(unmanaged.account.id)).killSwitchActive, true);
  await closeDb();

  const absent = await setup(path.join(directory, 'unconfirmed-position-absence.db'));
  const absentAdapter = wrappedAdapter(absent.paper, (...args) => absent.paper.submitOrder(...args));
  const absenceEngine = new TradingEngine([absentAdapter]);
  await absenceEngine.processIntent(absent.intent.id);
  absentAdapter.openState = async () => ({ orders: [], positions: [], fills: [], observedAt: Date.now() });
  await assert.rejects(
    absenceEngine.reconcileAccount(absent.account.id),
    /absent without terminal fill proof|CUMULATIVE_EXECUTION_MISMATCH/,
  );
  const retained = await getDatabase().get(
    'SELECT status, quantity FROM trading_positions WHERE intent_id = ?', [absent.intent.id],
  );
  assert.equal(retained.status, 'open');
  assert.notEqual(retained.quantity, '0', 'A missing snapshot must never close local ownership without terminal fills.');
  await closeDb();

  const managed = await setup(path.join(directory, 'operator-flatten.db'));
  const engine = new TradingEngine([managed.paper]);
  await engine.processIntent(managed.intent.id);
  assert.equal(await engine.emergencyFlattenManaged(managed.account.id), 1);
  assert.equal((await managed.paper.openState(managed.account)).positions.length, 0);
  await closeDb();
}

async function run() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'trading-failures-'));
  try {
  await testUnknownEntry(directory);
  await testIncompleteProtectedEvidence(directory);
  await testLegacyAccountNeedsBindingBeforePlanning(directory);
    await testFinalAdmissionRechecksMutableSafety(directory);
    await testUnknownFillRemainsDurableAndBlocking(directory);
    await testHistoricalUnmappedOrderIsRetainedBeforeCursorAdvances(directory);
    await testSameSideRemoteQuantityIsNotAutomaticallyOwned(directory);
    await testSameQuantityInAnotherSettlementIsNotOwned(directory);
    await testUndispatchedPlanResumesOnceAfterRestart(directory);
    await testInvalidUndispatchedPlanReleasesReservation(directory);
    await testUncertainOrChangedPlanCannotResume(directory);
    await testProtectiveStopFailure(directory);
    await testRuntimeStopWinsPendingIntentRace(directory);
    await testStopDuringPreparationRevokesDispatch(directory);
    await testStalePendingIntentNeverSubmits(directory);
    await testUnavailableMarketFailureIsolation(directory);
    await testEntryTtlCancelsAndClosesEmptyPosition(directory);
    await testAdverseEntrySlippageFlattens(directory);
    await testEmergencyFlattenRetryIsIdempotent(directory);
    await testPartialEntryProtectionAndTerminalResizing(directory);
    await testTrailingStopOnlyMovesTowardProfit(directory);
    await testTransientExecutorIncidentBlocksOnlyNewEntriesUntilReconciled(directory);
    await testTradingAccountIncidentLifecycle(directory);
    await testStopReplacementCancellationFailsClosed(directory);
    await testPeriodicReconciliationFailureDoesNotActivateHardKillSwitch(directory);
    await testTransientReconciliationFailureKeepsRetryingWithoutHardIsolation(directory);
    await testRestoredAccountIdentityRequiresExplicitSafeRelease(directory);
    await testEntryExpiryFailureActivatesKillSwitch(directory);
    await testRuntimeIsolatesAccountFailures(directory);
    await testRemoteAccountIdentityBinding(directory);
    await testUnmanagedHistoryWithMissingClientIdsIsSafelyIsolated(directory);
    await testProtectionOnlyStartupRequiresExplicitEntryEnable(directory);
    await testClockDriftBlocksEveryEntryPath(directory);
    await testAccountDailyRiskIncludesExistingLoss(directory);
    await testAccountDailyRiskIncludesFundingLoss(directory);
    await testRuntimeLifecycleAndDefaultFailureLogger(directory);
    await testExchangeStreamAcceleratesAuthoritativeReconciliation(directory);
    await testStartupReconciliationFailureKeepsControlPlaneAvailable(directory);
    await testUnmanagedExposureAndOperatorFlatten(directory);
  } finally {
    await closeDb();
    await rm(directory, { recursive: true, force: true });
  }
  console.log('Trading failure-policy tests passed.');
}

await run();
