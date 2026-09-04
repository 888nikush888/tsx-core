import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { getTradingAccount, listTradingStrategies } from '../src/trading_repository.js';
import { prepareTradingOperation, recoverPreparedExits, transitionTradingOperation } from '../src/trading_recovery.js';
import { seedTradingFixtures } from './trading_fixtures.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-prepared-exit-recovery-'));
const variants = [
  ['prepared', true, null], ['abandoned-before-dispatch', true, null], ['abandoned-after-fence', true, null],
  ['dispatching', false, null], ['acknowledged', false, null], ['unresolved', false, null],
  ['prepared-with-ack', false, ['evidence_json', '[{"exchangeOrderId":"original-remote"}]']],
  ['prepared-with-empty-ack', false, ['evidence_json', '[]']],
  ['prepared-with-history', false, ['state_version', 2]],
  ['abandoned-with-history', false, ['state_version', 3]],
  ['abandoned-with-ack', false, ['evidence_json', '[{"exchangeOrderId":"original-remote"}]']],
  ['expected-remote', false, null], ['expected-active', false, null], ['expected-submitting', false, null],
  ['local-response', false, null], ['local-average', false, null], ['bad-request-hash', false, ['request_hash', '0'.repeat(64)]],
];

async function seed(role, variant) {
  const id = `${role}-${variant}`;
  const account = await getTradingAccount('paper-default'), [strategy] = await listTradingStrategies();
  await saveSignal(id, '-exit-recovery', 1, '<signal/>', '<signal/>');
  await getDatabase().run(`INSERT INTO trading_trade_intents (id,source_signal_id,root_source_signal_id,channel_id,
    strategy_version_id,account_id,exchange,mode,symbol,side,status,signal_json,created_at,updated_at)
    VALUES (?,?,?,'-exit-recovery',?,?,'paper','paper','ETHUSDT','LONG','monitoring','{}',1,1)`,
  [id, id, id, strategy.id, account.id]);
  const planned = { clientOrderId: `${id}-exit`, role, side: 'sell', orderType: role === 'stop_loss' ? 'stop_market' : 'limit',
    quantity: '0.1', price: role === 'stop_loss' ? null : '3200', triggerPrice: role === 'stop_loss' ? '2900' : null,
    reduceOnly: true, postOnly: false, targetIndex: role === 'take_profit' ? 1 : null };
  await getDatabase().run(`INSERT INTO trading_orders (id,intent_id,account_id,client_order_id,role,side,order_type,
    status,quantity,price,trigger_price,filled_quantity,reduce_only,request_json,created_at,updated_at)
    VALUES (?,?,?,?,?,'sell',?,'created','0.1',?,?,'0',1,?,1,1)`,
  [planned.clientOrderId, id, account.id, planned.clientOrderId, role, planned.orderType, planned.price, planned.triggerPrice,
    JSON.stringify(planned)]);
  const operationId = await prepareTradingOperation({ account, intentId: id, kind: 'submit',
    clientOrderIds: [planned.clientOrderId], request: { ...planned, accountId: account.id, symbol: 'ETHUSDT' } });
  await getDatabase().run("UPDATE trading_orders SET status='submitting' WHERE id=?", [planned.clientOrderId]);
  return { id, account, operationId, orderId: planned.clientOrderId };
}

async function arrange(fixture, variant, patch) {
  const db = getDatabase(), id = fixture.operationId;
  if (variant === 'abandoned-before-dispatch' || variant.startsWith('abandoned-with-')) {
    await transitionTradingOperation(id, 'prepared', 'abandoned');
  } else if (['abandoned-after-fence', 'dispatching', 'acknowledged', 'unresolved'].includes(variant)) {
    await transitionTradingOperation(id, 'prepared', 'dispatching');
    if (variant !== 'dispatching') await transitionTradingOperation(id, 'dispatching',
      variant === 'abandoned-after-fence' ? 'abandoned' : variant);
  }
  if (patch) await db.run(`UPDATE trading_operations SET ${patch[0]}=? WHERE id=?`, [patch[1], id]);
  if (variant.startsWith('expected-')) {
    const row = await db.get('SELECT expected_orders_json FROM trading_operations WHERE id=?', [id]);
    const expected = JSON.parse(row.expected_orders_json);
    if (variant === 'expected-remote') expected[0].exchange_order_id = 'original-remote';
    else expected[0].status = variant === 'expected-active' ? 'open' : 'submitting';
    await db.run('UPDATE trading_operations SET expected_orders_json=? WHERE id=?', [JSON.stringify(expected), id]);
  }
  if (variant === 'local-response') await db.run('UPDATE trading_orders SET response_json=? WHERE id=?',
    ['{"id":"original-remote"}', fixture.orderId]);
  if (variant === 'local-average') await db.run("UPDATE trading_orders SET average_price='3200' WHERE id=?", [fixture.orderId]);
}

try {
  const file = path.join(directory, 'recovery.db');
  await initDb(file);
  await seedTradingFixtures();
  const cases = [];
  for (const role of ['take_profit', 'stop_loss', 'flatten']) {
    for (const [variant, safe, patch] of variants) {
      const fixture = await seed(role, variant);
      await arrange(fixture, variant, patch);
      cases.push({ ...fixture, role, variant, safe,
        operation: await getDatabase().get('SELECT * FROM trading_operations WHERE id=?', [fixture.operationId]),
        order: await getDatabase().get('SELECT * FROM trading_orders WHERE id=?', [fixture.orderId]) });
    }
  }
  await closeDb();
  await initDb(file);
  const failures = [];
  for (const fixture of cases) {
    await recoverPreparedExits(fixture.account, fixture.id, fixture.role);
    const actual = await getDatabase().get('SELECT * FROM trading_orders WHERE id=?', [fixture.orderId]);
    const expected = fixture.safe ? 'created' : 'submitting';
    if (actual.status !== expected) failures.push(`${fixture.role}/${fixture.variant}: ${actual.status}, expected ${expected}`);
    if (!fixture.safe && actual.status === expected) assert.deepEqual(actual, fixture.order, 'Uncertain originals remain untouched.');
    assert.deepEqual(await getDatabase().get('SELECT * FROM trading_operations WHERE id=?', [fixture.operationId]), fixture.operation);
  }
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS n FROM trading_paper_orders')).n, 0, 'Recovery proof never calls an exchange.');
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  assert.deepEqual(failures, [], 'Only original evidence-free standalone exit preparations can become submit-ready after restart.');
  console.log('Standalone exit no-send recovery: 51 phase/evidence/identity cases, original preservation and restart passed.');
} finally {
  await closeDb();
  assert.equal(path.dirname(directory), os.tmpdir());
  assert.ok(path.basename(directory).startsWith('tsx-prepared-exit-recovery-'));
  await rm(directory, { recursive: true, force: true });
}
