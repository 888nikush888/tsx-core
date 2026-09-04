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
import { getTradingAccount, getTradingRuntimeState, listTradingAccounts, listTradingStrategies, setTradingRoute } from '../src/trading_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
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
