import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb } from '../src/db.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { TradingEngine } from '../src/trading_engine.js';
import { TradingWebControl } from '../src/trading_web_control.js';
import { TradingCredentialStore } from '../src/trading_credentials.js';
import { createTradingAccount, getTradingAccount, getTradingRuntimeState,
  updateTradingAccountState, updateTradingRuntimeState } from '../src/trading_repository.js';
import { recordTradingAccountIncident } from '../src/trading_incidents.js';
import { seedTradingFixtures } from './trading_fixtures.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'account-retirement-'));
try {
  await initDb(path.join(directory, 'test.db'));
  await seedTradingFixtures();
  const paper = new PaperExchangeAdapter();
  const engine = new TradingEngine([paper]);
  const control = new TradingWebControl(new TradingCredentialStore(directory), paper, [], engine);
  const retired = await createTradingAccount({ name: 'Retained audit', exchange: 'paper', mode: 'paper', initialBalance: '10000' });
  await engine.reconcileAccount(retired.id);
  const history = await getDatabase().all('SELECT * FROM trading_reconciliation_runs WHERE account_id = ?', [retired.id]);
  assert.ok(history.length > 0);
  await control.removeAccount(retired.id);
  assert.equal(await getTradingAccount(retired.id), null);
  assert.ok((await getDatabase().get('SELECT retired_at FROM trading_accounts WHERE id = ?', [retired.id])).retired_at);

  const disabled = await createTradingAccount({ name: 'Disabled but retained', exchange: 'paper', mode: 'paper', initialBalance: '10000' });
  await updateTradingAccountState(disabled.id, { status: 'disabled', enabled: false });
  const read = paper.openState.bind(paper);
  const observed = [];
  paper.openState = account => { observed.push(account.id); return read(account); };
  assert.equal(await engine.cancelOpenEntries(), 0,
    'Historical soft-retired accounts must not turn a global drain into account-not-found errors.');
  assert.ok(observed.includes('paper-default'));
  assert.ok(observed.includes(disabled.id), 'Disabled accounts are not retired and must still be drained.');
  assert.ok(!observed.includes(retired.id));
  assert.deepEqual(await getDatabase().all('SELECT * FROM trading_reconciliation_runs WHERE account_id = ?', [retired.id]), history);
  await updateTradingRuntimeState({ executionEnabled: false, killSwitchActive: true, killSwitchReason: 'Retirement regression' });
  await control.setRuntime({ action: 'kill-switch', active: false, confirmation: 'RELEASE GLOBAL KILL SWITCH' });
  assert.equal((await getTradingRuntimeState()).killSwitchActive, false);

  // An inconsistent legacy/restore row must not hide an unresolved obligation behind retired_at.
  await recordTradingAccountIncident({ accountId: retired.id, category: 'unmanaged_remote', severity: 'critical',
    message: 'Restored unclassified remote exposure' });
  observed.length = 0;
  await assert.rejects(engine.cancelOpenEntries(), /Entry drain unresolved/);
  assert.ok(observed.includes('paper-default'), 'A quarantined retired account does not prevent independent account protection.');
  await updateTradingRuntimeState({ killSwitchActive: true, killSwitchReason: 'Unresolved retired obligation' });
  await assert.rejects(control.setRuntime({ action: 'kill-switch', active: false, confirmation: 'RELEASE GLOBAL KILL SWITCH' }),
    /ACCOUNT_SCOPE_CHANGED/);
  assert.equal((await getTradingRuntimeState()).killSwitchActive, true);
  assert.equal((await getDatabase().get('SELECT status FROM trading_account_incidents WHERE account_id = ?', [retired.id])).status, 'open');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
console.log('Global drain excludes historical retired accounts, retains disabled accounts and rejects unresolved retired obligations.');
