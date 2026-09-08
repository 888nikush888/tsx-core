import assert from 'node:assert/strict';
import { requireTakeProfitTargets, requireTakeProfitAllocation } from '../src/trading_take_profit.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { createTradingIntent, getTradingIntent, listTradingAccounts, listTradingStrategies, setTradingRoute, updateTradingRuntimeState } from '../src/trading_repository.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { TradingEngine } from '../src/trading_engine.js';
import { seedTradingFixtures } from './trading_fixtures.js';

const validTarget = { role: 'take_profit', price: '110', targetIndex: 1 };
assert.deepEqual(requireTakeProfitTargets({ orders: [validTarget] }), [validTarget]);
for (const target of [{ ...validTarget, price: null }, { ...validTarget, price: '-1' },
  { ...validTarget, targetIndex: null }, { ...validTarget, targetIndex: 2 }]) {
  assert.throws(() => requireTakeProfitTargets({ orders: [target] }));
}
assert.deepEqual(requireTakeProfitAllocation(['1'], ['0'], 0), { desired: '1', remaining: '0' });
for (const [totals, remaining] of [[[], ['0']], [['1'], []], [['-1'], ['0']], [['1'], ['bad']]]) {
  assert.throws(() => requireTakeProfitAllocation(totals, remaining, 0));
}

const directory = await mkdtemp(path.join(os.tmpdir(), 'engine-plan-guard-'));
try {
  await initDb(path.join(directory, 'test.db'));
  await seedTradingFixtures();
  const [account] = await listTradingAccounts();
  const [strategy] = await listTradingStrategies();
  await setTradingRoute({ channelId: '-100001', accountId: account.id, strategyVersionId: strategy.id, enabled: true });
  await updateTradingRuntimeState({ executionEnabled: true });
  await saveSignal('missing-entry', '-100001', 1, '<signal/>', '<signal/>');
  const intent = await createTradingIntent({ sourceSignalId: 'missing-entry', channelId: '-100001',
    signal: { schema: 'standard', action: 'LONG', symbol: 'BTCUSDT', entry: { type: 'market' },
      targets: [{ min: '110', max: '110' }], stopLoss: '90' } });
  assert.ok(intent, 'Fixture must create an executable intent.');
  await getDatabase().run('UPDATE trading_trade_intents SET plan_json = ? WHERE id = ?', [JSON.stringify({ orders: [] }), intent.id]);
  const paper = new PaperExchangeAdapter();
  let providerCalls = 0;
  paper.accountSnapshot = () => { providerCalls += 1; throw new Error('Provider must not be queried for an invalid stored plan.'); };
  const engine = new TradingEngine([paper]);
  await engine.processIntent(intent.id);
  const outcome = await getTradingIntent(intent.id);
  assert.equal(outcome.status, 'blocked');
  assert.equal(outcome.blockReason, 'TRADE_PLAN_INVALID');
  assert.equal(providerCalls, 0);
  for (const table of ['trading_orders', 'trading_operations']) {
    assert.equal((await getDatabase().get('SELECT COUNT(*) AS count FROM ' + table)).count, 0,
      'An invalid resumed plan must not create dispatch artifacts.');
  }
  // Exercise the actual reconciliation method against a persisted damaged plan.
  // All DB access after loading the plan is trapped: exit recovery requires DB reads/writes.
  const db = getDatabase();
  const originalAll = db.all, originalGet = db.get, originalRun = db.run;
  for (const damage of [{ price: null }, { targetIndex: 2 }]) {
    const damaged = { orders: [{ ...validTarget, ...damage }] };
    await db.run('UPDATE trading_trade_intents SET plan_json = ? WHERE id = ?', [JSON.stringify(damaged), intent.id]);
    const persisted = await db.get('SELECT plan_json FROM trading_trade_intents WHERE id = ?', [intent.id]);
    let recoveryAccesses = 0, cancellations = 0, submissions = 0;
    const guardedAdapter = new PaperExchangeAdapter();
    guardedAdapter.cancelOrder = async () => { cancellations += 1; throw new Error('Unexpected exit cancellation.'); };
    guardedAdapter.submitOrder = async () => { submissions += 1; throw new Error('Unexpected exit submission.'); };
    const failDatabaseAccess = async () => { recoveryAccesses += 1; throw new Error('Unexpected exit recovery database access.'); };
    try {
      db.all = failDatabaseAccess;
      db.get = failDatabaseAccess;
      db.run = failDatabaseAccess;
      await assert.rejects(engine.ensureTakeProfitCoverage(guardedAdapter, account, intent,
        JSON.parse(persisted.plan_json), { orders: [], positions: [] }), /Take-profit plan has no valid target/);
    } finally {
      db.all = originalAll;
      db.get = originalGet;
      db.run = originalRun;
    }
    assert.equal(recoveryAccesses, 0, 'Malformed persisted TP contract must be rejected before exit recovery.');
    assert.equal(cancellations, 0, 'Malformed persisted TP contract must not cancel exits.');
    assert.equal(submissions, 0, 'Malformed persisted TP contract must not submit exits.');
  }

} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
console.log('Malformed persisted trade plan is blocked before provider or dispatch effects.');
