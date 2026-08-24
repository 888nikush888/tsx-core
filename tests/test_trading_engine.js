import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { TradingEngine } from '../src/trading_engine.js';
import { DEFAULT_STRATEGY_CONFIGURATION } from '../src/trading_strategy.js';
import {
  createTradingIntent,
  createTradingStrategyDraft,
  getTradingAccount,
  getTradingIntent,
  listTradingAccounts,
  listTradingStrategies,
  publishTradingStrategyVersion,
  setTradingRoute,
  updateTradingAccountConfiguration,
  updateTradingRuntimeState,
} from '../src/trading_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { validateSignalXml } from '../src/signal_schema.js';

const SIGNAL = `<signal>
<action>LONG</action>
<pair>BTCUSDT</pair>
<entry_range><min>60000</min><max>61000</max></entry_range>
<targets><target id="1">62000</target><target id="2">63000</target></targets>
<stoploss>59000</stoploss>
<leverage>3</leverage>
</signal>`;

const ADAPTIVE_SIGNAL = `<signal>
<action>LONG</action>
<pair>BTCUSDT</pair>
<entry_range><min>60000</min><max>61000</max></entry_range>
<targets><target id="1">62000</target><target id="2">63000</target><target id="3">64000</target><target id="4">65000</target></targets>
<stoploss>59000</stoploss>
<leverage>3</leverage>
</signal>`;

async function setupIntent(paper) {
  await seedTradingFixtures(1_700_000_000_000);
  const [account] = await listTradingAccounts();
  const [strategy] = await listTradingStrategies();
  await setTradingRoute({
    channelId: '-100001',
    strategyVersionId: strategy.id,
    accountId: account.id,
    enabled: true,
  });
  await updateTradingRuntimeState({ executionEnabled: true });
  await paper.setMarket(account.id, {
    symbol: 'BTCUSDT',
    markPrice: '60000',
    priceTick: '0.1',
    quantityStep: '0.001',
    minimumQuantity: '0.001',
    minimumNotional: '10',
    maxLeverage: 50,
  });
  const validated = validateSignalXml(SIGNAL, 'default');
  await saveSignal('trading-signal-1', '-100001', 1, SIGNAL, SIGNAL);
  const intent = await createTradingIntent({
    sourceSignalId: 'trading-signal-1',
    channelId: '-100001',
    signal: validated.execution,
  });
  return { account, intent };
}

async function setPaperMark(paper, accountId, markPrice) {
  await paper.setMarket(accountId, {
    symbol: 'BTCUSDT', markPrice, priceTick: '0.1', quantityStep: '0.001',
    minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 50,
  });
}

async function setupAdaptiveTargetTest(databasePath) {
  await initDb(databasePath);
  const paper = new PaperExchangeAdapter();
  await seedTradingFixtures(1_700_000_100_000);
  const [account] = await listTradingAccounts();
  const configuration = structuredClone(DEFAULT_STRATEGY_CONFIGURATION);
  configuration.exits.targetAllocationMode = 'adaptive_halving';
  configuration.exits.stopLossMode = 'adaptive_targets';
  const draft = await createTradingStrategyDraft({
    name: 'Adaptive Blueprint exits',
    configuration,
  });
  const strategy = await publishTradingStrategyVersion(draft.id, 1_700_000_100_100);
  await setTradingRoute({
    channelId: '-adaptive', strategyVersionId: strategy.id, accountId: account.id, enabled: true,
  });
  await updateTradingRuntimeState({ executionEnabled: true });
  await setPaperMark(paper, account.id, '60000');
  const validated = validateSignalXml(ADAPTIVE_SIGNAL, 'default');
  await saveSignal('adaptive-signal', '-adaptive', 1, ADAPTIVE_SIGNAL, ADAPTIVE_SIGNAL);
  const intent = await createTradingIntent({
    sourceSignalId: 'adaptive-signal', channelId: '-adaptive', signal: validated.execution,
  });
  const engine = new TradingEngine([paper]);
  await engine.processIntent(intent.id);
  const plan = (await getTradingIntent(intent.id)).plan;
  assert.deepEqual(plan.targetAllocationsPercent, ['50', '25', '12.5', '12.5']);
  assert.equal(plan.stopLossMode, 'adaptive_targets');
  assert.deepEqual(
    plan.orders.filter(order => order.role === 'take_profit').map(order => order.quantity),
    ['0.008', '0.004', '0.002', '0.002'],
  );
  return { paper, account, intent, engine, plan };
}

async function assertAdaptiveTakeProfitRepair({ account, intent, engine, plan }) {
  const plannedTakeProfits = plan.orders.filter(order => order.role === 'take_profit');
  const stalePartialFillQuantities = ['0.004', '0.002', '0.001', '0.001'];
  for (let index = 0; index < plannedTakeProfits.length; index += 1) {
    const order = plannedTakeProfits[index];
    await getDatabase().run(
      `UPDATE trading_orders SET quantity = ?
       WHERE intent_id = ? AND client_order_id = ?`,
      [stalePartialFillQuantities[index], intent.id, order.clientOrderId],
    );
    await getDatabase().run(
      `UPDATE trading_paper_orders SET quantity = ?
       WHERE account_id = ? AND client_order_id = ?`,
      [stalePartialFillQuantities[index], account.id, order.clientOrderId],
    );
  }
  await engine.reconcileAccount(account.id);
  const repairedTakeProfits = await getDatabase().all(
    `SELECT client_order_id, quantity, request_json FROM trading_orders
     WHERE intent_id = ? AND role = 'take_profit' AND status = 'open' ORDER BY price`,
    [intent.id],
  );
  assert.equal(repairedTakeProfits.length, 4, 'Reconciliation must leave one active order per target.');
  assert.deepEqual(
    repairedTakeProfits
      .map(order => ({ targetIndex: JSON.parse(order.request_json).targetIndex, quantity: order.quantity }))
      .sort((left, right) => left.targetIndex - right.targetIndex),
    [
      { targetIndex: 1, quantity: '0.008' },
      { targetIndex: 2, quantity: '0.004' },
      { targetIndex: 3, quantity: '0.002' },
      { targetIndex: 4, quantity: '0.002' },
    ],
    'Take profits must be rebuilt from the terminal entry fill, not the earlier partial position.',
  );
  assert.ok(
    repairedTakeProfits.every(order => !plannedTakeProfits.some(planned => planned.clientOrderId === order.client_order_id)),
    'Resized take profits must use fresh client order identifiers after authoritative cancellation.',
  );
  const repairedIds = repairedTakeProfits.map(order => order.client_order_id).sort();
  await engine.reconcileAccount(account.id);
  assert.deepEqual(
    (await getDatabase().all(
      `SELECT client_order_id FROM trading_orders
       WHERE intent_id = ? AND role = 'take_profit' AND status = 'open' ORDER BY client_order_id`,
      [intent.id],
    )).map(order => order.client_order_id),
    repairedIds,
    'A second reconciliation must not create duplicate take-profit replacements.',
  );
  assert.equal(
    (await getDatabase().get(
      `SELECT COUNT(*) AS count FROM trading_risk_events
       WHERE intent_id = ? AND code = 'TAKE_PROFIT_COVERAGE_RESIZED'`,
      [intent.id],
    )).count,
    1,
  );
}

async function assertAdaptiveStopManagement({ paper, account, intent, engine }) {
  await setPaperMark(paper, account.id, '62000');
  await engine.reconcileAccount(account.id);
  let remote = await paper.openState(account);
  assert.equal(remote.positions[0].quantity, '0.008');
  assert.equal(remote.orders.find(order => order.role === 'stop_loss' && order.status === 'open').triggerPrice, '60500');
  let localPosition = await getDatabase().get('SELECT stop_price FROM trading_positions WHERE intent_id = ?', [intent.id]);
  assert.equal(localPosition.stop_price, '60500', 'The web-visible position stop must reflect the active replacement stop.');

  await setPaperMark(paper, account.id, '63000');
  await engine.reconcileAccount(account.id);
  remote = await paper.openState(account);
  assert.equal(remote.positions[0].quantity, '0.004');
  assert.equal(remote.orders.find(order => order.role === 'stop_loss' && order.status === 'open').triggerPrice, '60500');

  await setPaperMark(paper, account.id, '64000');
  await engine.reconcileAccount(account.id);
  remote = await paper.openState(account);
  assert.equal(remote.positions[0].quantity, '0.002');
  assert.equal(remote.orders.find(order => order.role === 'stop_loss' && order.status === 'open').triggerPrice, '62000');
  localPosition = await getDatabase().get('SELECT stop_price FROM trading_positions WHERE intent_id = ?', [intent.id]);
  assert.equal(localPosition.stop_price, '62000');

  const moves = await getDatabase().all(
    `SELECT details_json FROM trading_risk_events
     WHERE intent_id = ? AND code = 'STOP_LOSS_MOVED' ORDER BY rowid`,
    [intent.id],
  );
  assert.equal(moves.length, 2, 'Only actual stop-price changes should be logged.');
  assert.deepEqual(JSON.parse(moves[0].details_json), {
    fromTrigger: '59000', toTrigger: '60500', filledTargets: 1,
    reason: 'break_even_after_target', referenceTargetIndex: null,
  });
  assert.deepEqual(JSON.parse(moves[1].details_json), {
    fromTrigger: '60500', toTrigger: '62000', filledTargets: 3,
    reason: 'target_ladder_after_target', referenceTargetIndex: 1,
  });

  await setPaperMark(paper, account.id, '65000');
  await engine.reconcileAccount(account.id);
  remote = await paper.openState(account);
  assert.equal(remote.positions.length, 0, 'The final adaptive target must close the complete remainder.');
  assert.equal((await getTradingIntent(intent.id)).status, 'completed');
}

async function testAdaptiveTargetAndStopManagement(databasePath) {
  const context = await setupAdaptiveTargetTest(databasePath);
  await assertAdaptiveTakeProfitRepair(context);
  await assertAdaptiveStopManagement(context);
}

async function testAccountCapacitySpansStrategies(databasePath) {
  await initDb(databasePath);
  const paper = new PaperExchangeAdapter();
  await seedTradingFixtures(1_700_000_200_000);
  const [account] = await listTradingAccounts();
  const [firstStrategy] = await listTradingStrategies();
  const secondDraft = await createTradingStrategyDraft({
    name: 'Independent second strategy',
    configuration: structuredClone(DEFAULT_STRATEGY_CONFIGURATION),
  });
  const secondStrategy = await publishTradingStrategyVersion(secondDraft.id, 1_700_000_200_100);
  await updateTradingAccountConfiguration(account.id, { maxConcurrentPositions: 1 });
  await setTradingRoute({ channelId: '-capacity-a', strategyVersionId: firstStrategy.id, accountId: account.id, enabled: true });
  await setTradingRoute({ channelId: '-capacity-b', strategyVersionId: secondStrategy.id, accountId: account.id, enabled: true });
  await updateTradingRuntimeState({ executionEnabled: true });
  for (const symbol of ['BTCUSDT', 'ETHUSDT']) {
    await paper.setMarket(account.id, {
      symbol, markPrice: symbol === 'BTCUSDT' ? '60000' : '3000', priceTick: '0.1', quantityStep: '0.001',
      minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 50,
    });
  }
  const firstXml = SIGNAL;
  const secondXml = SIGNAL
    .replace('BTCUSDT', 'ETHUSDT')
    .replaceAll('60000', '3000').replaceAll('61000', '3050')
    .replaceAll('62000', '3100').replaceAll('63000', '3200').replaceAll('59000', '2900');
  await saveSignal('capacity-signal-a', '-capacity-a', 1, firstXml, firstXml);
  await saveSignal('capacity-signal-b', '-capacity-b', 2, secondXml, secondXml);
  const firstIntent = await createTradingIntent({
    sourceSignalId: 'capacity-signal-a', channelId: '-capacity-a', signal: validateSignalXml(firstXml, 'default').execution,
  });
  const secondIntent = await createTradingIntent({
    sourceSignalId: 'capacity-signal-b', channelId: '-capacity-b', signal: validateSignalXml(secondXml, 'default').execution,
  });
  const engine = new TradingEngine([paper]);
  await engine.processIntent(firstIntent.id);
  await engine.processIntent(secondIntent.id);
  const rejected = await getTradingIntent(secondIntent.id);
  assert.equal(rejected.status, 'blocked');
  assert.equal(rejected.blockReason, 'MAX_CONCURRENT_POSITIONS');
  assert.notEqual(firstIntent.strategyVersionId, secondIntent.strategyVersionId);
  await closeDb();
}

async function run() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'trading-engine-'));
  try {
    await initDb(path.join(directory, 'forwarder.db'));
    const paper = new PaperExchangeAdapter();
    const { account, intent } = await setupIntent(paper);
    const engine = new TradingEngine([paper]);
    await engine.processIntent(intent.id);

    const processed = await getTradingIntent(intent.id);
    assert.equal(processed.status, 'monitoring');
    assert.equal(processed.plan.quantity, '0.016');
    assert.equal(processed.plan.riskAmount, '100');
    assert.equal(processed.plan.notional, '968');
    const localOrders = await getDatabase().all(
      'SELECT role, status, quantity, trigger_price FROM trading_orders WHERE intent_id = ? ORDER BY role, created_at',
      [intent.id],
    );
    assert.equal(localOrders.find(order => order.role === 'entry').status, 'filled');
    assert.equal(localOrders.find(order => order.role === 'stop_loss').status, 'open');
    assert.equal(localOrders.filter(order => order.role === 'take_profit').length, 2);

    await paper.setMarket(account.id, {
      symbol: 'BTCUSDT', markPrice: '62000', priceTick: '0.1', quantityStep: '0.001',
      minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 50,
    });
    await engine.reconcileAccount(account.id);
    const remoteAfterTarget = await paper.openState(account);
    const positionAfterTarget = remoteAfterTarget.positions[0];
    assert.equal(positionAfterTarget.quantity, '0.008', 'First take profit must reduce the position.');
    const activeStops = remoteAfterTarget.orders.filter(order => order.role === 'stop_loss' && order.status === 'open');
    assert.equal(activeStops.length, 1, 'Exactly one protective stop must remain active.');
    assert.equal(activeStops[0].quantity, '0.008', 'Protective stop must track remaining quantity.');
    assert.equal(activeStops[0].triggerPrice, '60500', 'Stop must move to break-even after target one.');

    await paper.setMarket(account.id, {
      symbol: 'BTCUSDT', markPrice: '58000', priceTick: '0.1', quantityStep: '0.001',
      minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 50,
    });
    await engine.reconcileAccount(account.id);
    const remoteClosed = await paper.openState(account);
    assert.equal(remoteClosed.positions.length, 0, 'Protective stop must close the remaining position.');
    assert.equal((await getTradingIntent(intent.id)).status, 'completed');
    const localPosition = await getDatabase().get('SELECT * FROM trading_positions WHERE intent_id = ?', [intent.id]);
    assert.equal(localPosition.status, 'closed');
    assert.equal(localPosition.quantity, '0');
    assert.equal(localPosition.realized_pnl, '-8');

    const fillsBeforeRestart = await getDatabase().get('SELECT COUNT(*) AS count FROM trading_fills');
    const runsBeforeRestart = await getDatabase().get(
      'SELECT COUNT(*) AS count FROM trading_reconciliation_runs WHERE account_id = ?', [account.id],
    );
    const restartedEngine = new TradingEngine([paper]);
    await restartedEngine.reconcileAccount(account.id);
    const fillsAfterRestart = await getDatabase().get('SELECT COUNT(*) AS count FROM trading_fills');
    assert.equal(fillsAfterRestart.count, fillsBeforeRestart.count, 'Fill replay must be idempotent after restart.');
    const runsAfterRestart = await getDatabase().get(
      'SELECT COUNT(*) AS count FROM trading_reconciliation_runs WHERE account_id = ?', [account.id],
    );
    assert.equal(
      runsAfterRestart.count,
      runsBeforeRestart.count,
      'Unchanged successful reconciliation state must coalesce instead of appending a full snapshot.',
    );
    const compact = await getDatabase().get(
      `SELECT remote_snapshot_json FROM trading_reconciliation_runs
       WHERE account_id = ? AND status = 'succeeded' ORDER BY completed_at DESC LIMIT 1`,
      [account.id],
    );
    const compactPayload = JSON.parse(compact.remote_snapshot_json);
    assert.equal(compactPayload.version, 2);
    assert.match(compactPayload.stateDigest, /^[a-f0-9]{64}$/);
    assert.equal('orders' in compactPayload, false, 'Reconciliation evidence must not duplicate the full provider response.');

    const now = Date.now();
    for (let index = 0; index < 300; index += 1) {
      await getDatabase().run(
        `INSERT INTO trading_reconciliation_runs (
           id, account_id, status, last_error, started_at, completed_at
         ) VALUES (?, ?, 'failed', 'bounded-test', ?, ?)`,
        [`bounded-${index}`, account.id, now + index, now + index],
      );
    }
    await restartedEngine.pruneReconciliationRuns(account.id);
    const boundedRuns = await getDatabase().get(
      'SELECT COUNT(*) AS count FROM trading_reconciliation_runs WHERE account_id = ?', [account.id],
    );
    assert.equal(boundedRuns.count, 256, 'Per-account reconciliation evidence must remain bounded.');

    const readyAccount = await getTradingAccount(account.id);
    const snapshot = await paper.accountSnapshot(readyAccount);
    assert.equal(snapshot.equity, '9992', 'Paper equity must include exact realized PnL and stop slippage.');

    await closeDb();
    await testAdaptiveTargetAndStopManagement(path.join(directory, 'adaptive.db'));
    await closeDb();
    await testAccountCapacitySpansStrategies(path.join(directory, 'account-capacity.db'));
  } finally {
    await closeDb();
    await rm(directory, { recursive: true, force: true });
  }
  console.log('Trading engine and reconciliation tests passed.');
}

await run();
