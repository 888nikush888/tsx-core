import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, initDb } from '../src/db.js';
import { createTradingAccount, getTradingAccount, updateTradingAccountState } from '../src/trading_repository.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { TradingCredentialStore } from '../src/trading_credentials.js';
import { TradingEngine } from '../src/trading_engine.js';
import { TradingWebControl } from '../src/trading_web_control.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'trading-error-types-'));
try {
  await initDb(path.join(directory, 'test.db'));
  const credentials = new TradingCredentialStore(path.join(directory, 'secrets'));
  await credentials.initialize();
  const paper = new PaperExchangeAdapter();
  let failure = new Error('Provider temporarily unavailable');
  const adapter = { exchange: 'bybit',
    accountSnapshot() { throw failure; },
    verifyAccount() { throw failure; },
  };
  const engine = new TradingEngine([paper, adapter]);
  const control = new TradingWebControl(credentials, paper, [adapter], engine);
  const account = await createTradingAccount({ name: 'Error fixture', exchange: 'bybit', mode: 'testnet', credentialRef: 'managed-secret' });
  const boundaries = [
    { name: 'replace credentials', call: id => control.replaceAccountCredentials({ id }), fences: true },
    { name: 'verify account', call: id => control.verifyAccount(id), fences: false },
    { name: 'disable account', call: id => control.setAccountEnabled(id, false), fences: true },
    { name: 'release kill switch', call: id => control.releaseAccountKillSwitch({ id }), fences: false },
    { name: 'remove account', call: id => control.removeAccount(id), fences: true },
    { name: 'configure paper', call: id => control.configurePaper({ accountId: id }), fences: false },
  ];
  const originalRun = engine.mutations.run;
  try {
    for (const boundary of boundaries) {
      let runs = 0;
      engine.mutations.run = () => { runs += 1; throw new Error('Unexpected invalid-input dispatch'); };
      let result = null;
      assert.doesNotThrow(() => { result = boundary.call(''); }, `${boundary.name} returns rejected promises for validation errors.`);
      assert.ok(result instanceof Promise);
      await assert.rejects(result, /Account identifier/);
      assert.equal(runs, 0);

      const value = { status: 'injected mutation completion' };
      const returned = Promise.resolve(value);
      engine.mutations.run = id => { runs += 1; assert.equal(id, account.id); return returned; };
      const before = engine.mutations.entryEpoch(account.id);
      result = boundary.call(account.id);
      assert.equal(runs, 1, 'Mutation ownership is requested before the control method returns.');
      assert.equal(engine.mutations.entryEpoch(account.id) !== before, boundary.fences,
        'Operator fences remain synchronous and retain their account/global scope.');
      assert.ok(result instanceof Promise);
      assert.notEqual(result, returned, 'The existing native async boundary adopts the mutation result.');
      assert.equal(await result, value);

      const thrown = new Error('Synchronous mutation dependency failure');
      engine.mutations.run = () => { throw thrown; };
      assert.doesNotThrow(() => { result = boundary.call(account.id); });
      await assert.rejects(result, error => error === thrown);
      const rejected = new Error('Asynchronous mutation dependency failure');
      engine.mutations.run = () => Promise.reject(rejected);
      await assert.rejects(boundary.call(account.id), error => error === rejected);
    }
  } finally {
    engine.mutations.run = originalRun;
  }
  let invalidPaper = null;
  assert.doesNotThrow(() => { invalidPaper = paper.openState({ ...account, exchange: 'bybit' }); });
  assert.ok(invalidPaper instanceof Promise);
  await assert.rejects(invalidPaper, /paper/i);
  const ready = () => updateTradingAccountState(account.id, { status: 'ready', enabled: true });
  await ready();
  let snapshot = await control.portfolioSnapshot(true);
  assert.equal(snapshot.accounts.find(row => row.accountId === account.id).error, failure.message);
  let coercions = 0;
  failure = { message: 'private internal marker', toString() { coercions += 1; return 'private coercion marker'; } };
  snapshot = await control.portfolioSnapshot(true);
  const diagnostic = snapshot.accounts.find(row => row.accountId === account.id).error;
  assert.match(diagnostic, /non-Error value/);
  assert.equal(diagnostic.includes('private'), false);
  await assert.rejects(control.verifyAccount(account.id), error => error === failure);
  let stored = await getTradingAccount(account.id);
  assert.equal(stored.status, 'error');
  assert.equal(stored.enabled, false);
  assert.equal(stored.lastError, diagnostic);
  assert.equal(coercions, 0, 'An unexpected thrown object must not supply a diagnostic via coercion.');
  failure = new Error('Provider verification denied');
  await ready();
  await assert.rejects(control.verifyAccount(account.id), error => error === failure);
  stored = await getTradingAccount(account.id);
  assert.equal(stored.lastError, failure.message);
  assert.equal(stored.enabled, false);
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
console.log('Trading portfolio and verification diagnostic boundaries passed.');
