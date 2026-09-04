import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDatabase, saveSignal } from '../src/db.js';
import { listTradingAccounts, listTradingStrategies } from '../src/trading_repository.js';
import { persistTradingOrderResult, persistTradingRemoteOrder, transitionTradingIntent } from '../src/trading_order_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'trading-order-cas-'));
try {
  await initDb(path.join(directory, 'test.db'));
  await seedTradingFixtures();
  const [account] = await listTradingAccounts();
  const [strategy] = await listTradingStrategies();
  await saveSignal('cas-signal', '-cas', 1, '<signal/>', '<signal/>');
  await getDatabase().run(
    `INSERT INTO trading_trade_intents (
      id, source_signal_id, root_source_signal_id, channel_id, strategy_version_id, account_id,
      exchange, mode, symbol, side, status, signal_json, created_at, updated_at
    ) VALUES ('cas-intent', 'cas-signal', 'cas-signal', '-cas', ?, ?, 'paper', 'paper',
      'BTCUSDT', 'LONG', 'pending', '{}', ?, ?)`,
    [strategy.id, account.id, Date.now(), Date.now()],
  );
  for (const state of ['planned', 'submitting', 'monitoring', 'completed']) {
    await transitionTradingIntent('cas-intent', state);
  }
  await assert.rejects(transitionTradingIntent('cas-intent', 'monitoring'), /conflicts/);
  await assert.rejects(
    getDatabase().run("UPDATE trading_trade_intents SET status = 'monitoring' WHERE id = 'cas-intent'"),
    /Terminal trading intent/,
  );
  assert.equal((await getDatabase().get("SELECT state_version FROM trading_trade_intents WHERE id = 'cas-intent'")).state_version, 4);
  for (const id of ['client-a', 'client-b']) {
    await getDatabase().run(
      `INSERT INTO trading_orders (
        id, intent_id, account_id, client_order_id, role, side, order_type, status,
        quantity, filled_quantity, reduce_only, request_json, created_at, updated_at
      ) VALUES (?, 'cas-intent', ?, ?, 'entry', 'buy', 'limit', 'submitting', '1', '0', 0, '{}', ?, ?)`,
      [id, account.id, id, Date.now(), Date.now()],
    );
  }
  const result = { clientOrderId: 'client-a', exchangeOrderId: 'remote-a', status: 'partially_filled',
    filledQuantity: '0.4', averagePrice: '100', error: null, raw: {} };
  await persistTradingOrderResult('cas-intent', 'client-a', result);
  await persistTradingOrderResult('cas-intent', 'client-a', { ...result, status: 'open', filledQuantity: '0', averagePrice: null }, Date.now() - 5_000);
  let stored = await getDatabase().get("SELECT * FROM trading_orders WHERE id = 'client-a'");
  assert.equal(stored.status, 'partially_filled');
  assert.equal(stored.filled_quantity, '0.4');
  assert.equal(stored.average_price, '100');
  assert.equal(stored.remote_order_key, JSON.stringify(['v1', 'paper', 'BTCUSDT', 'remote-a']));
  await persistTradingOrderResult('cas-intent', 'client-a', { ...result, status: 'cancelled' });
  await persistTradingOrderResult('cas-intent', 'client-a', { ...result, status: 'open', filledQuantity: '0.6', averagePrice: '101' });
  stored = await getDatabase().get("SELECT * FROM trading_orders WHERE id = 'client-a'");
  assert.equal(stored.status, 'cancelled');
  assert.equal(stored.filled_quantity, '0.6');
  await assert.rejects(persistTradingOrderResult('cas-intent', 'client-a', { ...result, exchangeOrderId: 'wrong' }), /identifier.*match/i);
  await assert.rejects(persistTradingOrderResult('cas-intent', 'client-a', { ...result, clientOrderId: 'other' }), /identifier.*match/i);
  await assert.rejects(persistTradingOrderResult('cas-intent', 'missing', { ...result, clientOrderId: 'missing' }), /no matching local/);
  await persistTradingRemoteOrder('cas-intent', 'client-a', {
    ...result, status: 'cancelled', filledQuantity: null, averagePrice: null,
    symbol: 'BTCUSDT', role: 'entry', side: 'buy', quantity: '1', price: '100', triggerPrice: null, reduceOnly: false,
  }, Date.now());
  assert.equal((await getDatabase().get("SELECT filled_quantity FROM trading_orders WHERE id = 'client-a'")).filled_quantity, '0.6');
  await assert.rejects(
    persistTradingOrderResult('cas-intent', 'client-b', { ...result, clientOrderId: 'client-b' }),
    /UNIQUE constraint/,
  );
  assert.equal((await getDatabase().get("SELECT exchange_order_id FROM trading_orders WHERE id = 'client-b'")).exchange_order_id, null);
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  console.log('Order identity, monotone persistence and intent CAS tests passed.');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
