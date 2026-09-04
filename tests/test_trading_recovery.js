import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDatabase, saveSignal } from '../src/db.js';
import { listTradingAccounts, listTradingStrategies } from '../src/trading_repository.js';
import { exchangeRecoveryQuery, prepareTradingOperation, resolveObservedOperations, runJournaledExchangeWrite, transitionTradingOperation, unresolvedOperationCount } from '../src/trading_recovery.js';
import { recordAcquisitionEvidence } from '../src/trading_evidence_repository.js';
import { persistTradingOrderResult } from '../src/trading_order_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'trading-recovery-'));
const databasePath = path.join(directory, 'test.db');
try {
  await initDb(databasePath);
  await seedTradingFixtures();
  const [account] = await listTradingAccounts();
  const [strategy] = await listTradingStrategies();
  await saveSignal('recovery-signal', '-recovery', 1, '<signal/>', '<signal/>');
  await getDatabase().run(
    `INSERT INTO trading_trade_intents (id, source_signal_id, root_source_signal_id, channel_id, strategy_version_id, account_id, exchange, mode,
     symbol, side, status, signal_json, created_at, updated_at)
     VALUES ('recovery-intent', 'recovery-signal', 'recovery-signal', '-recovery', ?, ?, 'paper', 'paper', 'BTCUSDT', 'LONG', 'submitting', '{}', 1, 1)`,
    [strategy.id, account.id],
  );
  const fixture = async clientId => {
    await getDatabase().run(
      `INSERT INTO trading_orders (id, intent_id, account_id, client_order_id, role, side, order_type, status,
       quantity, filled_quantity, reduce_only, request_json, created_at, updated_at)
       VALUES (?, 'recovery-intent', ?, ?, 'entry', 'buy', 'limit', 'created', '1', '0', 0, '{}', 1, 1)`, [clientId, account.id, clientId],
    );
    const result = { clientOrderId: clientId, exchangeOrderId: `remote-${clientId}`, providerSymbol: 'BTCUSDT', status: 'open',
      filledQuantity: '0', averagePrice: null, error: null, raw: {} };
    return { account, intentId: 'recovery-intent', kind: 'submit', clientOrderIds: [clientId], request: { clientOrderId: clientId },
      beforeDispatch: async () => {}, guard: () => {}, send: async () => result,
      persist: async response => { await persistTradingOrderResult('recovery-intent', clientId, response); return [response]; } };
  };
  const normal = await fixture('normal');
  normal.send = async () => {
    assert.equal((await getDatabase().get("SELECT phase FROM trading_operations WHERE request_json = ?", [JSON.stringify(normal.request)])).phase, 'dispatching');
    return { clientOrderId: 'normal', exchangeOrderId: 'remote-normal', status: 'open', filledQuantity: '0', averagePrice: null, error: null, raw: {} };
  };
  await runJournaledExchangeWrite(normal);
  assert.equal((await getDatabase().get("SELECT phase FROM trading_operations WHERE request_json = ?", [JSON.stringify(normal.request)])).phase, 'acknowledged');
  await assert.rejects(runJournaledExchangeWrite(normal), /acknowledged/);

  const fenced = await fixture('fenced');
  let sends = 0;
  fenced.guard = () => { throw new Error('operator fence'); };
  fenced.send = async () => { sends += 1; throw new Error('must not send'); };
  await assert.rejects(runJournaledExchangeWrite(fenced), /operator fence/);
  assert.equal(sends, 0);
  assert.equal((await getDatabase().get("SELECT phase FROM trading_operations WHERE request_json = ?", [JSON.stringify(fenced.request)])).phase, 'abandoned');

  const timedOut = await fixture('timeout');
  timedOut.send = async () => { sends += 1; throw new Error('connection lost after acceptance'); };
  await assert.rejects(runJournaledExchangeWrite(timedOut), /connection lost/);
  await assert.rejects(runJournaledExchangeWrite(timedOut), /unresolved/);
  assert.equal(sends, 1);
  const crashed = await fixture('crashed');
  const operationId = await prepareTradingOperation(crashed);
  assert.equal(await prepareTradingOperation(crashed), operationId, 'Repeated preparation retains the operation identity.');
  await assert.rejects(prepareTradingOperation({ ...crashed, request: { changed: true } }), /request changed/);
  await transitionTradingOperation(operationId, 'prepared', 'dispatching');
  await closeDb();
  await initDb(databasePath);
  await assert.rejects(runJournaledExchangeWrite(crashed), /dispatching/);
  await assert.rejects(runJournaledExchangeWrite(timedOut), /unresolved/);
  assert.equal(sends, 1, 'Restart never repeats an unresolved exchange mutation.');
  assert.equal((await getDatabase().get("SELECT exchange_order_id FROM trading_orders WHERE id = 'normal'")).exchange_order_id, 'remote-normal');
  await resolveObservedOperations(account, []);
  assert.equal(await unresolvedOperationCount(account.id), 2, 'An empty snapshot proves neither write absent.');
  const cancel = await fixture('cancel');
  cancel.kind = 'cancel';
  await getDatabase().run("UPDATE trading_orders SET exchange_order_id = 'remote-cancel', provider_symbol = 'BTCUSDT', status = 'open' WHERE id = 'cancel'");
  await runJournaledExchangeWrite(cancel);
  assert.equal(await unresolvedOperationCount(account.id), 3, 'A cancel acknowledgement reporting open remains an outstanding obligation.');
  const cancelSnapshot = { clientOrderId: 'cancel', exchangeOrderId: 'remote-cancel', providerSymbol: 'BTCUSDT', status: 'open', filledQuantity: '0' };
  await resolveObservedOperations(account, [cancelSnapshot]);
  assert.equal(await unresolvedOperationCount(account.id), 3);
  await resolveObservedOperations(account, [{ ...cancelSnapshot, status: 'cancelled', filledQuantity: null }]);
  assert.equal(await unresolvedOperationCount(account.id), 3, 'Terminal lifecycle with unknown executed quantity is not a resolution.');
  await resolveObservedOperations(account, [{ ...cancelSnapshot, status: 'cancelled', exchangeOrderId: 'different' }]);
  assert.equal(await unresolvedOperationCount(account.id), 3, 'Different exchange order cannot resolve the cancel.');
  await resolveObservedOperations(account, [{ ...cancelSnapshot, status: 'cancelled' }]);
  assert.equal(await unresolvedOperationCount(account.id), 2);
  const oldCreatedAt = Date.now() - 45 * 86_400_000;
  await getDatabase().run("UPDATE trading_orders SET status = 'unknown', created_at = ? WHERE id = 'crashed'", [oldCreatedAt]);
  const query = await exchangeRecoveryQuery(account);
  assert.ok(query.orders.some(order => order.clientOrderId === 'crashed'));
  assert.ok(query.since <= oldCreatedAt, 'Recovery must not silently clamp local obligations to 30 days.');
  const observedAt = Date.now();
  await recordAcquisitionEvidence(account, { version: 1, startedAt: observedAt, completedAt: observedAt,
    sources: ['positions', 'orders', 'targeted_orders', 'fills'].map(source => ({ source, startedAt: observedAt, completedAt: observedAt,
      completeness: 'unknown', reason: 'history_pending', since: 0 })),
    checkedOrders: [{ clientOrderId: 'crashed', status: 'not_found' }, { clientOrderId: 'normal', status: 'budget_exhausted' }],
    raw: { authorization: 'MUST_NOT_PERSIST' },
  });
  await closeDb();
  await initDb(databasePath);
  const attempted = await getDatabase().get("SELECT status, last_recovery_attempt_at FROM trading_orders WHERE id = 'crashed'");
  assert.equal(attempted.status, 'unknown', 'A negative query result must not terminalize an uncertain order.');
  assert.equal(attempted.last_recovery_attempt_at, observedAt);
  assert.equal((await getDatabase().get("SELECT last_recovery_attempt_at FROM trading_orders WHERE id = 'normal'")).last_recovery_attempt_at, null);
  assert.doesNotMatch((await getDatabase().get('SELECT payload_json FROM trading_acquisition_evidence')).payload_json, /MUST_NOT_PERSIST|authorization/);
  assert.equal(await unresolvedOperationCount(account.id), 2);
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  console.log('Durable pre-dispatch, fence, acknowledgement, timeout and restart operation tests passed.');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
