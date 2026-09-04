// Isolated analysis regression. Only temporary SQLite fixtures; no production edits or exchange calls.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { getTradingAccount, listTradingStrategies } from '../src/trading_repository.js';
import { prepareTradingOperation, recoverPreparedExits } from '../src/trading_recovery.js';
import { seedTradingFixtures } from '../tests/trading_fixtures.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-prepared-exit-probe-'));
const results = [];
try {
  for (const variant of ['pristine', 'dispatching', 'prepared-with-ack', 'prepared-with-history']) {
    const file = path.join(directory, `${variant}.db`);
    await initDb(file);
    await seedTradingFixtures();
    const account = await getTradingAccount('paper-default'), [strategy] = await listTradingStrategies();
    await saveSignal(variant, '-exit-probe', 1, '<signal/>', '<signal/>');
    await getDatabase().run(`INSERT INTO trading_trade_intents (id,source_signal_id,root_source_signal_id,channel_id,
      strategy_version_id,account_id,exchange,mode,symbol,side,status,signal_json,created_at,updated_at)
      VALUES (?,?,?,'-exit-probe',?,?,'paper','paper','ETHUSDT','LONG','monitoring','{}',1,1)`,
    [variant, variant, variant, strategy.id, account.id]);
    const planned = { clientOrderId: `${variant}-tp`, role: 'take_profit', side: 'sell', orderType: 'limit',
      quantity: '0.1', price: '3200', triggerPrice: null, reduceOnly: true, postOnly: false, targetIndex: 1 };
    await getDatabase().run(`INSERT INTO trading_orders (id,intent_id,account_id,client_order_id,provider_symbol,role,side,
      order_type,status,quantity,price,filled_quantity,reduce_only,request_json,created_at,updated_at)
      VALUES (?,?,?,?,'ETHUSDT','take_profit','sell','limit','created','0.1','3200','0',1,?,1,1)`,
    [planned.clientOrderId, variant, account.id, planned.clientOrderId, JSON.stringify(planned)]);
    const request = { ...planned, symbol: 'ETHUSDT' };
    const operationId = await prepareTradingOperation({ account, intentId: variant, kind: 'submit',
      clientOrderIds: [planned.clientOrderId], request });
    // Match the actual writer: journal the original created order, then mark local dispatch preparation.
    await getDatabase().run("UPDATE trading_orders SET status='submitting' WHERE id=?", [planned.clientOrderId]);
    if (variant === 'dispatching') await getDatabase().run(
      "UPDATE trading_operations SET phase='dispatching',state_version=1 WHERE id=?", [operationId]);
    if (variant === 'prepared-with-ack') await getDatabase().run(
      'UPDATE trading_operations SET evidence_json=? WHERE id=?',
      [JSON.stringify([{ clientOrderId: planned.clientOrderId, exchangeOrderId: 'observed-remote-tp',
        status: 'open', filledQuantity: '0', providerSymbol: 'ETHUSDT' }]), operationId]);
    if (variant === 'prepared-with-history') await getDatabase().run(
      'UPDATE trading_operations SET state_version=2 WHERE id=?', [operationId]);
    const originalOperation = await getDatabase().get('SELECT * FROM trading_operations WHERE id=?', [operationId]);
    await closeDb(); await initDb(file);
    await recoverPreparedExits(account, variant, 'take_profit');
    const actual = (await getDatabase().get('SELECT status FROM trading_orders WHERE id=?', [planned.clientOrderId])).status;
    results.push({ variant, expected: variant === 'pristine' ? 'created' : 'submitting', actual });
    assert.deepEqual(await getDatabase().get('SELECT * FROM trading_operations WHERE id=?', [operationId]), originalOperation);
    assert.equal((await getDatabase().get('SELECT COUNT(*) AS n FROM trading_paper_orders')).n, 0);
    assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
    await closeDb();
  }
  console.log(JSON.stringify(results));
  assert.deepEqual(results.filter(row => row.expected !== row.actual), [],
    'Prepared exit with ACK or impossible phase history is not positive no-send evidence and cannot reset to created.');
} finally {
  await closeDb();
  assert.equal(path.dirname(directory), os.tmpdir());
  assert.ok(path.basename(directory).startsWith('tsx-prepared-exit-probe-'));
  await rm(directory, { recursive: true, force: true });
}
