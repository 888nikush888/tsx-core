import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDatabase, saveSignal } from '../src/db.js';
import { listTradingAccounts, listTradingStrategies } from '../src/trading_repository.js';
import { persistCorrelatedFill } from '../src/trading_evidence_repository.js';
import { recordFeeEvent } from '../src/trading_money_ledger.js';
import { seedTradingFixtures } from './trading_fixtures.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'fill-namespace-'));
const databasePath = path.join(directory, 'fixture.db');
try {
  await initDb(databasePath);
  await seedTradingFixtures();
  const [account] = await listTradingAccounts();
  const [strategy] = await listTradingStrategies();
  await saveSignal('fill-namespace', '-fill-namespace', 1, '<signal/>', '<signal/>');
  async function owned(symbol) {
    await getDatabase().run(`INSERT INTO trading_trade_intents(id,source_signal_id,root_source_signal_id,channel_id,strategy_version_id,
      account_id,exchange,mode,symbol,side,status,signal_json,created_at,updated_at)
      VALUES(?,'fill-namespace','fill-namespace','-fill-namespace',?,?,'paper','paper',?,'LONG','monitoring','{}',1,1)`, [symbol, strategy.id, account.id, symbol]);
    await getDatabase().run(`INSERT INTO trading_orders(id,intent_id,account_id,client_order_id,exchange_order_id,provider_symbol,
      role,side,order_type,status,quantity,filled_quantity,reduce_only,request_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'entry','buy','limit','partially_filled','5','2',0,'{}',1,1)`, [symbol, symbol, account.id, symbol, `order-${symbol}`, symbol]);
    return { exchangeFillId: 'same-real-id', clientOrderId: symbol, exchangeOrderId: `order-${symbol}`, symbol, providerSymbol: symbol,
      price: '100', quantity: '1', fee: '0.1', feeAsset: 'USDT', filledAt: 123, raw: {} };
  }
  const first = await owned('BTCUSDT');
  const second = await owned('ETHUSDT');
  assert.equal((await persistCorrelatedFill(account, first)).inserted, true);
  assert.equal((await persistCorrelatedFill(account, second)).inserted, true, 'Same real fill ID on a different native market must not collide.');
  const rows = await getDatabase().all('SELECT * FROM trading_fills ORDER BY provider_symbol');
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].remote_fill_key, rows[1].remote_fill_key);
  assert.ok(rows.every(row => row.exchange_fill_id === 'same-real-id' && row.identity_status === 'proven'));
  const event = row => ({ accountId: account.id, accountFingerprint: `paper:${account.id}`, providerEventId: row.exchange_fill_id,
    source: 'paper:own-fill-v1', basis: 'fill', occurredAt: row.filled_at, fee: row.fee, asset: row.fee_asset, fillId: row.id });
  const money = await Promise.all(rows.map(row => recordFeeEvent(event(row))));
  assert.notEqual(money[0].id, money[1].id, 'Money identity follows the actual persisted fill, not an ambiguous bare provider ID.');
  const originalMoney = await getDatabase().get('SELECT * FROM trading_money_events WHERE id=?', [money[0].id]);
  assert.equal((await recordFeeEvent({ ...event(rows[0]), source: 'another-authenticated-transport', providerEventId: 'alternate-original-label' })).id, money[0].id);
  assert.deepEqual(await getDatabase().get('SELECT * FROM trading_money_events WHERE id=?', [money[0].id]), originalMoney);
  assert.equal((await persistCorrelatedFill(account, first)).fillId, rows[0].id, 'Replay returns the already persisted fill identity.');
  assert.equal((await persistCorrelatedFill(account, { ...first, price: '101' })).inserted, false);
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS n FROM trading_fills')).n, 2);
  await closeDb();
  await initDb(databasePath);
  assert.equal((await persistCorrelatedFill(account, second)).fillId, rows[1].id);
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  console.log('Native-market fill identity, immutable originals and restart dedupe passed.');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
