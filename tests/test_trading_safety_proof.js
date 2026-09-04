import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { TradingEngine } from '../src/trading_engine.js';
import { TradingWebControl } from '../src/trading_web_control.js';
import { TradingCredentialStore } from '../src/trading_credentials.js';
import { createTradingIntent, getTradingAccount, getTradingIntent, listTradingStrategies, setTradingRoute,
  updateTradingAccountConfiguration, updateTradingRuntimeState } from '../src/trading_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { evaluateTradingSafety } from '../src/trading_safety_proof.js';
import { validateSignalXml } from '../src/signal_schema.js';
import { prepareTradingOperation, transitionTradingOperation } from '../src/trading_recovery.js';

function completeEvidence() {
  const now = Date.now();
  return { binding: { accountId: 'a', accountVersion: 1, runtimeEpoch: '0:0', accountFingerprint: 'account', credentialGeneration: 'credentials' },
    identityVerified: true, stateCurrent: true, accountReady: true, entryAllowed: true, now, requiredSince: 1, minimumAcquisitionStart: now - 100,
    acquisition: { version: 1, startedAt: now - 50, completedAt: now, checkedOrders: [],
      sources: ['orders', 'positions', 'fills', 'targeted_orders'].map(source => ({ source, startedAt: now - 50, completedAt: now,
        completeness: 'complete', reason: null, since: source === 'fills' ? 0 : null })) },
    orders: [], positions: [], operations: [], unresolvedEvidence: 0, fillIdentityUnresolved: 0, foreignOrders: 0, foreignPositions: 0,
    blockingIncidents: [], reviewRequiredIntents: [], balanceVerified: true };
}
function assertReason(input, purpose, reason, intentId) {
  const result = evaluateTradingSafety(input, purpose, intentId);
  assert.equal(result.safe, false, reason);
  assert.ok(result.reasons.some(item => item.code === reason), `${reason}: ${JSON.stringify(result.reasons)}`);
}
function proofTables() {
  for (const purpose of ['entryAdmission', 'entriesDrained', 'accountRelease']) assert.equal(evaluateTradingSafety(completeEvidence(), purpose).safe, true);
  for (const [field, value, code] of [
    ['identityVerified', false, 'ACCOUNT_IDENTITY_UNPROVED'], ['stateCurrent', false, 'ACCOUNT_STATE_CHANGED'],
    ['unresolvedEvidence', 1, 'REMOTE_EVENTS_UNRESOLVED'], ['foreignOrders', 1, 'FOREIGN_ORDER_PRESENT'],
    ['fillIdentityUnresolved', 1, 'FILL_IDENTITY_UNPROVEN'], ['fillIdentityUnresolved', undefined, 'FILL_IDENTITY_UNPROVEN'],
    ['foreignPositions', 1, 'FOREIGN_POSITION_PRESENT'], ['blockingIncidents', ['incident'], 'BLOCKING_ACCOUNT_INCIDENT'],
    ['reviewRequiredIntents', ['trade'], 'TRADE_REVIEW_REQUIRED'], ['balanceVerified', false, 'ACCOUNT_BALANCE_UNPROVED'],
    ['accountReady', false, 'ACCOUNT_NOT_VERIFIED_READY'],
  ]) assertReason({ ...completeEvidence(), [field]: value }, 'accountRelease', code);
  assertReason({ ...completeEvidence(), entryAllowed: false }, 'entryAdmission', 'ENTRY_ADMISSION_DISABLED');
  const entry = { accountId: 'a', intentId: 't', clientOrderId: 'entry', exchangeOrderId: 'entry-remote', symbol: 'BTCUSDT',
    role: 'entry', side: 'buy', status: 'filled', reduceOnly: false, quantity: '1', filledQuantity: '1', triggerPrice: null, remoteConfirmed: true };
  const stop = { ...entry, clientOrderId: 'stop', exchangeOrderId: 'stop-remote', role: 'stop_loss', side: 'sell', status: 'partially_filled',
    reduceOnly: true, filledQuantity: '0.5', triggerPrice: '90' };
  const position = { need: { accountId: 'a', intentId: 't', symbol: 'BTCUSDT', side: 'LONG', quantity: '0.5', minimumTrigger: '90' },
    ownership: { entryQuantity: '1', exitQuantity: '0.5', netQuantity: '0.5' }, remoteMatches: true };
  const protectedInput = { ...completeEvidence(), orders: [entry, stop], positions: [position] };
  assert.equal(evaluateTradingSafety(protectedInput, 'accountRelease').safe, true, 'A positively proved partial stop covers only its remaining quantity.');
  assert.equal(evaluateTradingSafety(protectedInput, 'positionProtected', 't').safe, true);
  for (const patch of [{ side: 'buy' }, { reduceOnly: false }, { quantity: '0.75' }, { triggerPrice: '89' }, { remoteConfirmed: false },
    { status: 'filled', filledQuantity: '1' }, { status: 'cancelled' }, { status: 'rejected' }, { exchangeOrderId: null }]) {
    assertReason({ ...protectedInput, orders: [entry, { ...stop, ...patch }] }, 'accountRelease', 'POSITION_NOT_PROTECTED');
  }
  assertReason({ ...protectedInput, positions: [{ ...position, ownership: null }] }, 'accountRelease', 'OWNED_QUANTITY_UNPROVED');
  assertReason({ ...protectedInput, positions: [{ ...position, remoteMatches: false }] }, 'accountRelease', 'REMOTE_OWNERSHIP_MISMATCH');
  for (const status of ['created', 'submitting', 'open', 'partially_filled', 'cancel_pending', 'unknown']) {
    const unsafe = { ...completeEvidence(), orders: [{ ...entry, status, filledQuantity: '0' }] };
    assert.equal(evaluateTradingSafety(unsafe, 'entriesDrained').safe, false, `Zero position is not drained with ${status} entry.`);
    assert.equal(evaluateTradingSafety(unsafe, 'accountRelease').safe, false);
  }
  for (const status of ['filled', 'cancelled', 'rejected']) {
    const historical = { ...completeEvidence(), orders: [{ ...entry, status, filledQuantity: status === 'filled' ? '1' : '0', remoteConfirmed: false }] };
    assert.equal(evaluateTradingSafety(historical, 'accountRelease').safe, true, 'Classified terminal history alone is not an active commitment.');
  }
  const historicalTrade = { intentId: 'historical', accountId: 'a', hasEntryHistory: true,
    ownership: { entryQuantity: '1', exitQuantity: '1', netQuantity: '0' }, closedProjectionQuantity: '0' };
  assert.equal(evaluateTradingSafety({ ...protectedInput, historicalTrades: [historicalTrade] }, 'accountRelease').safe, true,
    'An earlier flat trade does not have to match a newer same-symbol remote position.');
  for (const [patch, code] of [
    [{ accountId: 'other' }, 'HISTORICAL_ACCOUNT_MISMATCH'],
    [{ hasEntryHistory: false }, 'HISTORICAL_ENTRY_MISSING'],
    [{ ownership: null }, 'HISTORICAL_OWNERSHIP_UNPROVED'],
    [{ ownership: { entryQuantity: '1', exitQuantity: '0', netQuantity: '1' } }, 'HISTORICAL_TRADE_NOT_FLAT'],
    [{ closedProjectionQuantity: '1' }, 'CLOSED_POSITION_NOT_ZERO'],
  ]) {
    for (const purpose of ['accountRelease', 'entryAdmission']) {
      assertReason({ ...completeEvidence(), historicalTrades: [{ ...historicalTrade, ...patch }] }, purpose, code);
    }
  }
  const flat = { ...protectedInput, orders: [entry, { ...stop, status: 'filled', filledQuantity: '1' }],
    positions: [{ ...position, need: { ...position.need, quantity: '0' }, ownership: { entryQuantity: '1', exitQuantity: '1', netQuantity: '0' } }] };
  assert.equal(evaluateTradingSafety(flat, 'tradeClosed', 't').safe, true);
  assertReason({ ...flat, orders: [entry, { ...stop, status: 'open' }] }, 'tradeClosed', 'EXIT_SIBLING_NOT_TERMINAL', 't');
  for (const phase of ['prepared', 'dispatching', 'unresolved', 'acknowledged']) {
    assertReason({ ...flat, operations: [{ id: 'op', intentId: 't', phase, hasEntry: false }] }, 'tradeClosed', 'EXCHANGE_OPERATION_UNRESOLVED', 't');
  }
}

async function assertReleaseDenied(control, pattern) {
  await assert.rejects(control.releaseAccountKillSwitch({ id: 'paper-default', confirmation: 'RELEASE ACCOUNT KILL SWITCH' }), pattern);
  assert.equal((await getTradingAccount('paper-default')).killSwitchActive, true);
}

async function failedEvidenceCases(control, paper, engine, openState) {
  for (const source of ['orders', 'positions', 'fills']) {
    for (const completeness of ['partial', 'unknown']) {
      paper.openState = async account => {
        const state = await openState(account);
        state.acquisition.sources.find(item => item.source === source).completeness = completeness;
        return state;
      };
      await assertReleaseDenied(control, new RegExp(`SOURCE_${source.toUpperCase()}_INCOMPLETE`));
    }
  }
  paper.openState = async account => {
    const state = await openState(account);
    state.acquisition.sources.find(source => source.source === 'fills').since = state.observedAt;
    return state;
  };
  await assertReleaseDenied(control, /FILL_BASELINE_UNPROVED/);
  paper.openState = async account => {
    const state = await openState(account);
    state.acquisition.startedAt -= 1_000;
    state.acquisition.completedAt -= 1_000;
    for (const source of state.acquisition.sources) { source.startedAt -= 1_000; source.completedAt -= 1_000; }
    return state;
  };
  await assertReleaseDenied(control, /ACQUISITION_NOT_FRESH/);
  paper.openState = openState;
  const accountSnapshot = paper.accountSnapshot.bind(paper);
  paper.accountSnapshot = async account => ({ ...await accountSnapshot(account), equity: null });
  await assertReleaseDenied(control, /ACCOUNT_BALANCE_UNPROVED/);
  paper.accountSnapshot = accountSnapshot;
  const reconcile = engine.reconcileAccount.bind(engine);
  let reads = 0;
  engine.reconcileAccount = async (...args) => {
    const result = await reconcile(...args);
    if (++reads === 2) await updateTradingAccountConfiguration('paper-default', { maxConcurrentPositions: 9 });
    return result;
  };
  await assertReleaseDenied(control, /ACCOUNT_STATE_CHANGED/);
  engine.reconcileAccount = reconcile;
  const database = getDatabase();
  const run = database.run.bind(database);
  let fenced = false;
  database.run = async (sql, parameters, ...rest) => {
    const result = await run(sql, parameters, ...rest);
    if (/UPDATE trading_accounts SET max_concurrent_positions/.test(sql) && parameters?.[1] === 0) {
      fenced = true; engine.mutations.fenceEntries('paper-default');
    }
    return result;
  };
  try { await assertReleaseDenied(control, /operator fence/); } finally { database.run = run; }
  assert.equal(fenced, true, 'A fence at the final write rolls the attempted release back.');
  for (const mode of ['clock', 'account-version']) {
    const now = Date.now;
    let injected = false;
    database.run = async (sql, parameters, ...rest) => {
      const result = await run(sql, parameters, ...rest);
      if (!injected && /UPDATE trading_accounts SET max_concurrent_positions/.test(sql) && parameters?.[1] === 0) {
        injected = true;
        if (mode === 'clock') Date.now = () => now() + 31_000;
        else await run("UPDATE trading_accounts SET state_version = state_version + 1 WHERE id = 'paper-default'");
      }
      return result;
    };
    try { await assertReleaseDenied(control, /ACQUISITION_NOT_FRESH|ACCOUNT_STATE_CHANGED/); }
    finally { database.run = run; Date.now = now; }
    assert.equal(injected, true, 'Post-write freshness and account version remain part of the same release transaction.');
  }
}

async function protectedRelease(control, paper, engine) {
  const [strategy] = await listTradingStrategies();
  await setTradingRoute({ channelId: '-safety', strategyVersionId: strategy.id, accountId: 'paper-default', enabled: true });
  await updateTradingRuntimeState({ executionEnabled: true });
  await paper.setMarket('paper-default', { symbol: 'ETHUSDT', markPrice: '3000', priceTick: '0.1', quantityStep: '0.001',
    minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 25 });
  const xml = '<signal><action>LONG</action><pair>ETHUSDT</pair><entry_range><min>3000</min><max>3100</max></entry_range><targets><target id="1">3200</target><target id="2">3300</target></targets><stoploss>2900</stoploss></signal>';
  await saveSignal('safety-signal', '-safety', 1, xml, xml);
  const intent = await createTradingIntent({ sourceSignalId: 'safety-signal', channelId: '-safety', signal: validateSignalXml(xml).execution });
  await engine.processIntent(intent.id);
  assert.equal((await getTradingIntent(intent.id)).status, 'monitoring');
  await control.configureAccount({ id: 'paper-default', killSwitchActive: true, killSwitchReason: 'Protected release test' });
  const account = await getTradingAccount('paper-default');
  const before = await paper.openState(account);
  const reconcile = engine.reconcileAccount.bind(engine);
  let reads = 0;
  let operation;
  engine.reconcileAccount = async (...args) => {
    const result = await reconcile(...args);
    if (++reads === 2) {
      const entry = before.orders.find(order => order.role === 'entry');
      operation = await prepareTradingOperation({ account, intentId: intent.id, kind: 'cancel',
        clientOrderIds: [entry.clientOrderId], request: { clientOrderId: entry.clientOrderId } });
    }
    return result;
  };
  await assertReleaseDenied(control, /EXCHANGE_OPERATION_UNRESOLVED/);
  engine.reconcileAccount = reconcile;
  await transitionTradingOperation(operation, 'prepared', 'abandoned');
  const result = await control.releaseAccountKillSwitch({ id: 'paper-default', confirmation: 'RELEASE ACCOUNT KILL SWITCH' });
  assert.equal(result.proof.safe, true, 'The real collector proves an existing managed, protected position without flattening.');
  const after = await paper.openState(account);
  assert.deepEqual(after.positions, before.positions);
  assert.deepEqual(after.orders.map(order => order.clientOrderId), before.orders.map(order => order.clientOrderId));
  assert.equal(after.fills.length, before.fills.length);
}

const directory = await mkdtemp(path.join(os.tmpdir(), 'trading-safety-proof-'));
try {
  proofTables();
  await initDb(path.join(directory, 'safety.db'));
  await seedTradingFixtures();
  const paper = new PaperExchangeAdapter();
  const engine = new TradingEngine([paper]);
  const control = new TradingWebControl(new TradingCredentialStore(directory), paper, [], engine);
  await updateTradingAccountConfiguration('paper-default', { killSwitchActive: true, killSwitchReason: 'Proof test' });
  const openState = paper.openState.bind(paper);
  paper.openState = async account => {
    const state = await openState(account);
    delete state.acquisition;
    return state;
  };
  await assert.rejects(control.releaseAccountKillSwitch({ id: 'paper-default', confirmation: 'RELEASE ACCOUNT KILL SWITCH' }),
    /ACQUISITION_MISSING/, 'Two successful empty reconciliations are not evidence of complete remote sources.');
  assert.equal((await getTradingAccount('paper-default')).killSwitchActive, true);
  paper.openState = openState;
  await failedEvidenceCases(control, paper, engine, openState);
  const result = await control.releaseAccountKillSwitch({ id: 'paper-default', confirmation: 'RELEASE ACCOUNT KILL SWITCH' });
  assert.equal(result.account.killSwitchActive, false, 'A complete, verified empty Paper account can be released.');
  assert.equal(result.proof.purpose, 'accountRelease');
  assert.equal(result.proof.safe, true);
  await protectedRelease(control, paper, engine);
  console.log('Structured account release safety proof tests passed.');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
