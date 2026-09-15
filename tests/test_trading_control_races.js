import { tradingAccountTargetIds } from '../src/trading_account_targets.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, initDb } from '../src/db.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { TradingCredentialStore } from '../src/trading_credentials.js';
import { TradingEngine } from '../src/trading_engine.js';
import { TradingRuntime } from '../src/trading_runtime.js';
import { TradingWebControl } from '../src/trading_web_control.js';
import { createTradingAccount, getTradingAccount, getTradingRuntimeState, listTradingAccounts, listTradingStrategies, setTradingRoute } from '../src/trading_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';

function deferred() {
  const { promise, resolve } = Promise.withResolvers();
  return { promise, resolve };
}
const directory = await mkdtemp(path.join(os.tmpdir(), 'trading-control-race-'));
let runtime;
try {
  await initDb(path.join(directory, 'control.db'));
  await seedTradingFixtures();
  const [account] = await listTradingAccounts();
  const [strategy] = await listTradingStrategies();
  await setTradingRoute({ channelId: '-control-race', strategyVersionId: strategy.id, accountId: account.id, enabled: true });
  const paper = new PaperExchangeAdapter();
  const credentials = new TradingCredentialStore(directory);
  const engine = new TradingEngine([paper]);
  runtime = new TradingRuntime(engine, 60_000);
  const control = new TradingWebControl(credentials, paper, [], engine, runtime);
  await runtime.start();
  await control.setRuntime({ action: 'execution', enabled: true });
  assert.equal((await getTradingRuntimeState()).executionEnabled, true, 'Startup admission hold must not prevent an explicit successful start.');
  await control.setRuntime({ action: 'execution', enabled: false });

  const reconcile = engine.reconcileAccount.bind(engine);
  let entered = deferred();
  let proceed = deferred();
  let paused = false;
  engine.reconcileAccount = async (...args) => {
    if (!paused) { paused = true; entered.resolve(); await proceed.promise; }
    return reconcile(...args);
  };
  const enabling = assert.rejects(control.setRuntime({ action: 'execution', enabled: true }), /operator fence/i);
  await entered.promise;
  const stop = control.setRuntime({ action: 'execution', enabled: false });
  proceed.resolve();
  await Promise.all([enabling, stop]);
  assert.equal((await getTradingRuntimeState()).executionEnabled, false, 'A queued stop wins over the older enable request.');

  engine.reconcileAccount = reconcile;
  await control.configureAccount({ id: account.id, killSwitchActive: true, killSwitchReason: 'first incident' });
  entered = deferred();
  proceed = deferred();
  paused = false;
  engine.reconcileAccount = async (...args) => {
    if (!paused) { paused = true; entered.resolve(); await proceed.promise; }
    return reconcile(...args);
  };
  const releasing = assert.rejects(control.releaseAccountKillSwitch({
    id: account.id, confirmation: 'RELEASE ACCOUNT KILL SWITCH',
  }), /operator fence/i);
  await entered.promise;
  const rekill = control.configureAccount({ id: account.id, killSwitchActive: true, killSwitchReason: 'new incident' });
  proceed.resolve();
  await Promise.all([releasing, rekill]);
  const protectedAccount = await getTradingAccount(account.id);
  assert.equal(protectedAccount.killSwitchActive, true);
  assert.equal(protectedAccount.killSwitchReason, 'new incident');
  console.log('Real runtime start/stop and concurrent account release/re-kill tests passed.');
} finally {
  await runtime?.stop();
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}

// Exercise the actual expiry catch without starting a runtime or opening a database.
const uninformativeObjects = [{ message: '' }, { message: 0 }, { message: false }, { message: null }, {}, { message: {} }];
const thrownValues = [undefined, null, false, 0, 1, '', 'failure', 1n, Symbol('failure'),
  new Error('native'), { message: 'text' }, { message: 42 }, { message: true },
  ...uninformativeObjects, '[object Object]', { message: '[object Object]' },
  { message: { toString() { return 'nested'; } } }, { message: Symbol('nested') },
  Object.assign(() => undefined, { message: 'callable' })];
const getterFailure = new Error('getter failure');
const coercionFailure = new Error('coercion failure');
thrownValues.push({ get message() { throw getterFailure; } },
  { message: { toString() { throw coercionFailure; } } });
for (const thrown of thrownValues) {
  let expected = undefined;
  let expectedError = undefined;
  try {
    expected = uninformativeObjects.includes(thrown)
      ? 'entry-expiry: Non-Error object thrown without a useful message'
      : `entry-expiry: ${thrown?.message || String(thrown)}`;
  }
  catch (error) { expectedError = error; }
  const fixtureRuntime = new TradingRuntime({ cancelExpiredEntries: () => Promise.reject(thrown) });
  const failures = [];
  await fixtureRuntime.captureEntryExpiryFailure(failures);
  assert.deepEqual(failures, [expectedError ? 'entry-expiry: Runtime failure could not be formatted safely.' : expected]);
}
const oldNumberMessage = Object.getOwnPropertyDescriptor(Number.prototype, 'message');
try {
  // Test the legacy primitive getter receiver; the original descriptor is restored in finally.
  // skipcq: JS-0061
  Object.defineProperty(Number.prototype, 'message', { configurable: true, get() {
    assert.equal(typeof this, 'number', 'Primitive message getters retain their original receiver.');
    return 'primitive receiver';
  } });
  // An Error would not exercise the numeric rejection and primitive receiver regression.
  // skipcq: JS-0114
  const fixtureRuntime = new TradingRuntime({ cancelExpiredEntries: () => Promise.reject(7) });
  const failures = [];
  await fixtureRuntime.captureEntryExpiryFailure(failures);
  assert.deepEqual(failures, ['entry-expiry: primitive receiver']);
} finally {
  // Restore exactly the pre-test descriptor, including its getter and flags.
  // skipcq: JS-0061
  if (oldNumberMessage) Object.defineProperty(Number.prototype, 'message', oldNumberMessage);
  else delete Number.prototype.message;
}
console.log('Runtime failure diagnostics retain primitive, getter and coercion behavior.');

// Diagnostic formatting must never prevent protection of an independent targeted account.
const isolationDirectory = await mkdtemp(path.join(os.tmpdir(), 'runtime-diagnostic-isolation-'));
try {
  await initDb(path.join(isolationDirectory, 'isolation.db'));
  await createTradingAccount({ name: 'Diagnostic first', exchange: 'paper', mode: 'paper', initialBalance: '1000' });
  await createTradingAccount({ name: 'Diagnostic independent', exchange: 'paper', mode: 'paper', initialBalance: '1000' });
  const targets = await tradingAccountTargetIds();
  assert.ok(targets.length >= 2);
  const malformedFactories = [
    () => ({ message: Symbol('unrenderable') }),
    () => ({ get message() { throw new Error('private getter payload'); } }),
    () => ({ message: { [Symbol.toPrimitive]() { throw new Error('private coercion payload'); } } }),
    () => ({ message: { toString() { throw new Error('private string payload'); } } }),
  ];
  for (const phase of ['preparation', 'reconciliation']) {
    for (const makeMalformed of malformedFactories) {
      const calls = [];
      const engine = {
        retireUnauthorizedPreparations: async id => {
          calls.push('prepare:' + id);
          if (id === targets[0] && phase === 'preparation') throw makeMalformed();
        },
        reconcileAccount: async id => {
          calls.push('reconcile:' + id);
          if (id === targets[0] && phase === 'reconciliation') throw makeMalformed();
        },
        cancelExpiredEntries: async () => { throw makeMalformed(); },
      };
      const fixture = new TradingRuntime(engine);
      const failures = await fixture.reconcileAccounts(false);
      assert.deepEqual(calls, targets.flatMap(id => ['prepare:' + id, 'reconcile:' + id]));
      const prefix = phase === 'preparation' ? targets[0] + ' preparation-recovery: ' : targets[0] + ': ';
      assert.deepEqual(failures, [prefix + 'Runtime failure could not be formatted safely.']);
      await fixture.captureEntryExpiryFailure(failures);
      assert.deepEqual(failures, [prefix + 'Runtime failure could not be formatted safely.',
        'entry-expiry: Runtime failure could not be formatted safely.']);
      assert.equal(fixture.isProtectionScanComplete(), false, 'Direct diagnostics must not grant scan completion.');
    }
  }
} finally {
  await closeDb();
  await rm(isolationDirectory, { recursive: true, force: true });
}
console.log('Diagnostic failures retain all targeted-account protection and expiry failure collection.');
