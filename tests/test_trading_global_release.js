import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { TradingCredentialStore } from '../src/trading_credentials.js';
import { TradingEngine } from '../src/trading_engine.js';
import { TradingWebControl } from '../src/trading_web_control.js';
import { createTradingAccount, createTradingIntent, getTradingAccount, getTradingRuntimeState, listTradingStrategies,
  setTradingRoute, updateTradingAccountConfiguration, updateTradingAccountState, updateTradingRuntimeState } from '../src/trading_repository.js';
import { validateSignalXml } from '../src/signal_schema.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { insertAccountedFill } from './fixtures/accounted_trades.js';

const releaseRequest = { action: 'kill-switch', active: false, confirmation: 'RELEASE GLOBAL KILL SWITCH' };

async function withFixture(test) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-global-release-'));
  try {
    await initDb(path.join(directory, 'release.db'));
    await seedTradingFixtures();
    const paper = new PaperExchangeAdapter();
    const engine = new TradingEngine([paper]);
    const control = new TradingWebControl(new TradingCredentialStore(directory), paper, [], engine);
    await updateTradingRuntimeState({ killSwitchActive: true, killSwitchReason: 'Global release test' });
    await test({ paper, engine, control });
  } finally {
    await closeDb();
    await rm(directory, { recursive: true, force: true });
  }
}

async function denied(control, pattern) {
  await assert.rejects(control.setRuntime(releaseRequest), pattern);
  assert.equal((await getTradingRuntimeState()).killSwitchActive, true);
  assert.equal((await getTradingRuntimeState()).executionEnabled, false);
}

async function historicalTrade() {
  const [strategy] = await listTradingStrategies();
  await setTradingRoute({ channelId: '-historical', strategyVersionId: strategy.id, accountId: 'paper-default', enabled: true });
  await updateTradingRuntimeState({ killSwitchActive: false, killSwitchReason: null, executionEnabled: true });
  const xml = '<signal><action>LONG</action><pair>ETHUSDT</pair><entry_range><min>3000</min><max>3100</max></entry_range><targets><target id="1">3200</target><target id="2">3300</target></targets><stoploss>2900</stoploss></signal>';
  await saveSignal('historical-signal', '-historical', 1, xml, xml);
  const intent = await createTradingIntent({ sourceSignalId: 'historical-signal', channelId: '-historical', signal: validateSignalXml(xml).execution });
  await getDatabase().run("UPDATE trading_trade_intents SET status = 'completed' WHERE id = ?", [intent.id]);
  await updateTradingRuntimeState({ killSwitchActive: true, killSwitchReason: 'Check old completion claim' });
  return intent;
}

await withFixture(async ({ paper, control }) => {
  const read = paper.openState.bind(paper);
  paper.openState = async account => {
    const state = await read(account);
    delete state.acquisition;
    return state;
  };
  await denied(control, /ACQUISITION_MISSING/);
});

await withFixture(async ({ control }) => {
  await assert.rejects(control.setRuntime({ ...releaseRequest, confirmation: undefined }), /confirmation/i);
  await updateTradingAccountConfiguration('paper-default', { killSwitchActive: true, killSwitchReason: 'Independent account lock' });
  const result = await control.setRuntime(releaseRequest);
  assert.equal(result.killSwitchActive, false);
  assert.equal(result.executionEnabled, false, 'Global release does not start execution.');
  assert.equal((await getTradingAccount('paper-default')).killSwitchActive, true, 'Account locks remain independent.');
  assert.equal(result.safetyProofs.length, 1);
  assert.equal(result.safetyProofs[0].safe, true);
});

await withFixture(async ({ paper, control }) => {
  const second = await createTradingAccount({ name: 'Second Paper', exchange: 'paper', mode: 'paper', initialBalance: '10000' });
  const read = paper.openState.bind(paper);
  paper.openState = async account => {
    const state = await read(account);
    if (account.id === second.id) state.acquisition.sources.find(source => source.source === 'fills').completeness = 'partial';
    return state;
  };
  await denied(control, /SOURCE_FILLS_INCOMPLETE/);
});

await withFixture(async ({ paper, control }) => {
  const snapshot = paper.accountSnapshot.bind(paper);
  paper.accountSnapshot = async account => ({ ...await snapshot(account), equity: null });
  await denied(control, /ACCOUNT_BALANCE_UNPROVED/);
});

await withFixture(async ({ control }) => {
  await createTradingAccount({ name: 'Unused unverified account', exchange: 'bybit', mode: 'testnet', credentialRef: 'not-used' });
  const result = await control.setRuntime(releaseRequest);
  assert.equal(result.safetyProofs.length, 1, 'An unused disabled account is not silently enabled or required to have credentials.');
});

await withFixture(async ({ control }) => {
  const intent = await historicalTrade();
  await denied(control, /HISTORICAL_ENTRY_MISSING/);
  await insertAccountedFill({ intentId: intent.id, id: 'historic-entry', price: '3000', symbol: 'ETHUSDT', filledAt: Date.now() });
  await denied(control, /HISTORICAL_TRADE_NOT_FLAT/);
  await insertAccountedFill({ intentId: intent.id, id: 'historic-exit', role: 'stop_loss', price: '2900', symbol: 'ETHUSDT', filledAt: Date.now() });
  await denied(control, /FILL_IDENTITY_UNPROVEN/);
  await updateTradingRuntimeState({ killSwitchActive: true, killSwitchReason: 'Late cumulative-history conflict' });
  await getDatabase().run("UPDATE trading_orders SET filled_quantity = '0.5' WHERE id = 'order-historic-exit'");
  await denied(control, /ORDER_QUANTITY_UNPROVED|HISTORICAL_OWNERSHIP_UNPROVED/);
});

async function managedTrade(paper, engine) {
  const [strategy] = await listTradingStrategies();
  await setTradingRoute({ channelId: '-global-release', strategyVersionId: strategy.id, accountId: 'paper-default', enabled: true });
  await updateTradingRuntimeState({ killSwitchActive: false, killSwitchReason: null, executionEnabled: true });
  await paper.setMarket('paper-default', { symbol: 'ETHUSDT', markPrice: '3000', priceTick: '0.1', quantityStep: '0.001',
    minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 25 });
  const xml = '<signal><action>LONG</action><pair>ETHUSDT</pair><entry_range><min>3000</min><max>3100</max></entry_range><targets><target id="1">3200</target><target id="2">3300</target></targets><stoploss>2900</stoploss></signal>';
  await saveSignal('global-signal', '-global-release', 1, xml, xml);
  const intent = await createTradingIntent({ sourceSignalId: 'global-signal', channelId: '-global-release', signal: validateSignalXml(xml).execution });
  await engine.processIntent(intent.id);
  return intent;
}

await withFixture(async ({ paper, engine, control }) => {
  const intent = await managedTrade(paper, engine);
  await paper.setMarket('paper-default', { symbol: 'ETHUSDT', markPrice: '2900', priceTick: '0.1', quantityStep: '0.001',
    minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 25 });
  await engine.reconcileAccount('paper-default');
  assert.equal((await getDatabase().get('SELECT status FROM trading_trade_intents WHERE id=?', [intent.id])).status, 'completed');
  assert.equal((await paper.openState(await getTradingAccount('paper-default'))).positions.length, 0);
  await updateTradingRuntimeState({ killSwitchActive: true, killSwitchReason: 'Actual historical roundtrip' });
  const result = await control.setRuntime(releaseRequest);
  assert.equal(result.safetyProofs[0].safe, true, 'A historical roundtrip with independent simulator originals permits release.');
});

await withFixture(async ({ paper, engine, control }) => {
  await managedTrade(paper, engine);
  await control.setRuntime({ action: 'kill-switch', active: true, reason: 'Protected position test' });
  const account = await getTradingAccount('paper-default');
  const before = await paper.openState(account);
  assert.equal(before.positions.length, 1);
  const read = paper.openState.bind(paper);
  paper.openState = async input => {
    const remote = await read(input);
    remote.orders = remote.orders.map(order => ({ ...order, clientOrderId: null }));
    remote.fills = remote.fills.map(fill => ({ ...fill, clientOrderId: null }));
    return remote;
  };
  const result = await control.setRuntime(releaseRequest);
  paper.openState = read;
  assert.equal(result.safetyProofs[0].safe, true);
  assert.equal(result.killSwitchActive, false, 'Known orders/fills with missing client IDs remain safely correlatable by exact exchange ID.');
  const after = await paper.openState(account);
  assert.deepEqual(after.positions, before.positions, 'A protected position can remain open across release.');
  assert.deepEqual(after.fills, before.fills, 'Release does not flatten a protected position.');
  await updateTradingRuntimeState({ killSwitchActive: true, killSwitchReason: 'Disabled account still owns exposure' });
  await updateTradingAccountState(account.id, { enabled: false, status: 'disabled' });
  await denied(control, /ACCOUNT_NOT_VERIFIED_READY/);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

for (const scope of ['global', 'account']) {
  await withFixture(async ({ paper, control }) => {
    const read = paper.openState.bind(paper);
    const entered = deferred();
    const proceed = deferred();
    let paused = false;
    paper.openState = async account => {
      if (!paused) { paused = true; entered.resolve(); await proceed.promise; }
      return read(account);
    };
    const release = denied(control, /operator fence/);
    await entered.promise;
    const stop = scope === 'global'
      ? control.setRuntime({ action: 'kill-switch', active: true, reason: 'New global incident' })
      : control.configureAccount({ id: 'paper-default', killSwitchActive: true, killSwitchReason: 'New account incident' });
    proceed.resolve();
    await Promise.all([release, stop]);
    assert.equal((await getTradingRuntimeState()).killSwitchActive, true);
    if (scope === 'account') assert.equal((await getTradingAccount('paper-default')).killSwitchReason, 'New account incident');
  });
}

for (const change of ['runtime-fence', 'account-fence', 'account-version', 'clock', 'account-added']) {
  await withFixture(async ({ engine, control }) => {
    const database = getDatabase();
    const run = database.run.bind(database);
    const now = Date.now;
    let injected = false;
    database.run = async (sql, parameters, ...rest) => {
      const result = await run(sql, parameters, ...rest);
      if (!injected && /UPDATE trading_runtime_state SET/.test(sql) && parameters?.[2] === 0) {
        injected = true;
        if (change === 'runtime-fence') engine.mutations.fenceEntries();
        if (change === 'account-fence') engine.mutations.fenceEntries('paper-default');
        if (change === 'account-version') await run('UPDATE trading_accounts SET state_version = state_version + 1 WHERE id = ?', ['paper-default']);
        if (change === 'clock') Date.now = () => now() + 31_000;
        if (change === 'account-added') await createTradingAccount({ name: 'Racing account', exchange: 'paper', mode: 'paper', initialBalance: '10000' });
      }
      return result;
    };
    try { await denied(control, /operator fence|ACCOUNT_STATE_CHANGED|ACQUISITION_NOT_FRESH|ACCOUNT_SCOPE_CHANGED/); }
    finally { database.run = run; Date.now = now; }
    assert.equal(injected, true);
    const proofCount = await database.get("SELECT COUNT(*) AS count FROM trading_risk_events WHERE code = 'GLOBAL_KILL_SWITCH_RELEASE_PROVED'");
    assert.equal(proofCount.count, 0, 'The release proof audit rolls back with the rejected write.');
  });
}

console.log('Global kill-switch release source proofs, independent locks and final transaction races passed.');
