import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { createTradingAccount, listTradingStrategies, updateTradingAccountState } from '../src/trading_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { accountLogCheckpoint, persistAccountLogProgress } from '../src/trading_account_log_repository.js';
import { projectAccountLogScope, accountScopeObservation } from '../src/trading_account_scope.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-log-scope-'));
const filename = path.join(directory, 'fixture.db');
const fingerprint = 'a'.repeat(64), generation = 'b'.repeat(64), now = Date.now();
const trade = { id: 'ledger-1', transactionTime: String(now - 100), type: 'TRADE', category: 'linear', symbol: 'BTCUSDT',
  side: 'Buy', currency: 'USDT', funding: '0', cashFlow: '0', change: '-0.1', fee: '0.1', qty: '1', tradePrice: '100',
  tradeId: 'ledger-trade-id-not-an-exec-id', orderId: 'actual-order', orderLinkId: 'client-order' };
async function append(account, records) {
  const checkpoint = await accountLogCheckpoint(account);
  const receipt = { version: 1, namespace: checkpoint.namespace, filterHash: checkpoint.filterHash,
    accountFingerprint: fingerprint, credentialGeneration: generation, since: checkpoint.windowSince,
    until: now, cursor: checkpoint.cursor, nextCursor: null, startedAt: now, completedAt: now,
    providerResponseAt: now, providerAccountUid: null, exhausted: true, records };
  await persistAccountLogProgress(account, { baseRevision: checkpoint.revision, calls: 1, receipts: [receipt],
    checkpoint: { ...checkpoint, revision: checkpoint.revision + 1, scannedThrough: now, lastServedAt: now, cursor: null, windowUntil: null } });
}
async function result() {
  return JSON.parse((await getDatabase().get(`SELECT result_json FROM trading_account_log_consumers consumer
    JOIN trading_account_log_receipts receipt ON receipt.id=consumer.receipt_id WHERE consumer.consumer='scope'
    ORDER BY receipt.sequence DESC LIMIT 1`)).result_json);
}
async function fill(id, patch = {}) {
  const raw = { id, order: 'actual-order', symbol: 'BTC/USDT:USDT', side: 'buy', timestamp: now - 100,
    info: { execId: id, orderId: 'actual-order', orderLinkId: 'client-order', symbol: 'BTCUSDT', side: 'Buy',
      execType: 'Trade', execQty: '1', execPrice: '100', execTime: String(now - 100), execFee: '0.1', feeCurrency: 'USDT', ...patch } };
  await getDatabase().run(`INSERT INTO trading_fills (id,order_id,account_id,exchange_fill_id,price,quantity,fee,fee_asset,filled_at,raw_json,
    account_fingerprint,accounting_json) VALUES (?, 'order', 'scope-account', ?, '100','1','0.1','USDT',?,?,?,?)`,
  [id, id, now - 100, JSON.stringify(raw), fingerprint, JSON.stringify({ version: 1, source: 'ccxt-market-v1',
    providerSymbol: 'BTC/USDT:USDT', settlementAsset: 'USDT', linear: true, quantityUnit: 'base' })]);
}
try {
  await initDb(filename); await seedTradingFixtures();
  const created = await createTradingAccount({ name: 'Scope', exchange: 'bybit', mode: 'testnet', credentialRef: 'fixture' });
  // Account API creates its own stable ID; use that ID in the fixture inserts below.
  await getDatabase().run('UPDATE trading_accounts SET id=? WHERE id=?', ['scope-account', created.id]);
  const account = await updateTradingAccountState('scope-account', { status: 'ready', enabled: true, verifiedAt: now,
    externalAccountId: fingerprint, credentialGeneration: generation });
  const [strategy] = await listTradingStrategies();
  await saveSignal('scope-signal', '-scope', 1, '<signal/>', '<signal/>');
  await getDatabase().run(`INSERT INTO trading_trade_intents (id,source_signal_id,root_source_signal_id,channel_id,strategy_version_id,
    account_id,exchange,mode,symbol,side,status,signal_json,created_at,updated_at)
    VALUES ('intent','scope-signal','scope-signal','-scope',?,'scope-account','bybit','testnet','BTCUSDT','LONG','unknown','{}',?,?)`, [strategy.id, now - 200, now]);
  await getDatabase().run(`INSERT INTO trading_orders (id,intent_id,account_id,client_order_id,exchange_order_id,provider_symbol,role,side,
    order_type,status,quantity,filled_quantity,reduce_only,request_json,created_at,updated_at)
    VALUES ('order','intent','scope-account','client-order','actual-order','BTC/USDT:USDT','entry','buy','market','filled','1','1',0,'{}',?,?)`, [now - 200, now]);
  await append(account, [trade]); await projectAccountLogScope(account);
  assert.equal((await result()).records[0].reason, 'real_execution_not_observed');
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS n FROM trading_fills')).n, 0, 'A transaction log is never inserted as a fill.');
  await fill('actual-exec'); await closeDb(); await initDb(filename);
  await projectAccountLogScope(account);
  const matched = await result();
  assert.equal(matched.records[0].status, 'correlated_execution');
  assert.equal(matched.records[0].executionId, 'actual-exec');
  assert.notEqual(matched.records[0].executionId, trade.tradeId, 'Do not silently equate ledger trade ID with execution ID.');
  assert.equal(matched.orders[0].status, 'observed_terminal_execution_set');
  assert.deepEqual(matched.orders[0].executionIds, ['actual-exec']);
  assert.equal(matched.finality, 'not_proven'); assert.equal(matched.finalizedThrough, null);
  assert.equal((await accountScopeObservation(account)).finality, 'not_proven');

  for (const [id, patch, reason] of [
    ['no-trade-id', { tradeId: null }, 'trade_identity_unproved'],
    ['wrong-side', { side: 'Sell' }, 'owned_order_identity_conflict'],
    ['wrong-link', { orderLinkId: 'foreign' }, 'owned_order_identity_conflict'],
    ['wrong-symbol', { symbol: 'BTCUSDC' }, 'real_execution_not_observed'],
    ['missing-qty', { qty: null }, 'real_execution_not_observed'],
    ['wrong-time', { transactionTime: String(now - 99) }, 'real_execution_not_observed'],
    ['missing-time', { transactionTime: null }, 'record_identity_or_time_unproved'],
  ]) {
    await append(account, [{ ...trade, id, ...patch }]); await projectAccountLogScope(account);
    assert.equal((await result()).records[0].reason, reason, id);
  }
  await getDatabase().run("UPDATE trading_orders SET status='partially_filled',quantity='2' WHERE id='order'");
  await append(account, [{ ...trade, id: 'partial-order' }]); await projectAccountLogScope(account);
  assert.equal((await result()).records[0].reason, 'terminal_execution_set_unproved');
  await getDatabase().run("UPDATE trading_orders SET status='filled',quantity='1' WHERE id='order'");

  await append(account, [Object.fromEntries(Object.entries({ ...trade, id: 'reordered' }).reverse())]); await projectAccountLogScope(account);
  await append(account, [{ ...trade, id: 'reordered' }]); await projectAccountLogScope(account);
  assert.equal((await result()).records[0].status, 'correlated_execution', 'Object key order is not a different economic payload.');

  await append(account, [
    { id: 'transfer', transactionTime: String(now), type: 'TRANSFER_IN', currency: 'USDT', change: '1', fee: '0', funding: '0' },
    { id: 'funding', transactionTime: String(now), type: 'SETTLEMENT', category: 'linear', funding: '-0.2', currency: 'USDT' },
    { ...trade, id: 'old-option', category: 'option', symbol: 'DELISTED-OPTION', orderId: 'external' },
    { ...trade, id: 'event', category: 'event', orderId: 'event-order' },
  ]);
  await projectAccountLogScope(account);
  assert.deepEqual((await result()).records.map(row => row.status), ['non_execution', 'non_execution', 'unresolved_activity', 'unresolved_activity']);
  assert.ok((await accountScopeObservation(account)).unresolvedOccurrences >= 2);

  await append(account, []); await projectAccountLogScope(account);
  assert.equal((await result()).exhausted, true);
  assert.equal((await result()).finality, 'not_proven', 'Empty EOF with possible delayed entries cannot certify finality.');
  await append(account, [{ ...trade, id: 'late-event', category: 'option', orderId: 'late-external' }]); await projectAccountLogScope(account);
  assert.equal((await result()).records[0].status, 'unresolved_activity', 'Late post-EOF activity remains durable and visible.');

  await append(account, [{ ...trade, fee: '9' }]); await projectAccountLogScope(account);
  assert.equal((await result()).records[0].reason, 'provider_record_conflict');
  const first = JSON.parse((await getDatabase().get(`SELECT work.result_json FROM trading_account_log_consumers work
    JOIN trading_account_log_receipts r ON r.id=work.receipt_id WHERE work.consumer='scope' ORDER BY r.sequence LIMIT 1`)).result_json);
  assert.equal(first.records[0].reason, 'provider_record_conflict', 'A later correction invalidates old completed correlation evidence too.');
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS n FROM trading_fills')).n, 1);
  assert.equal((await getDatabase().get("SELECT status FROM trading_trade_intents WHERE id='intent'")).status, 'unknown');
  await assert.rejects(getDatabase().run('UPDATE trading_account_log_records SET payload_json=?', ['{}']), /immutable/);

  await append(account, [{ ...trade, id: 'ambiguous' }]); await fill('second-actual-exec'); await projectAccountLogScope(account);
  assert.equal((await result()).records[0].reason, 'ambiguous_real_executions');
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS n FROM trading_account_log_consumers WHERE consumer=\'money\' AND status=\'pending\'')).n > 0, true,
    'Scope consumption cannot acknowledge or consume the independent money work.');
  await closeDb(); await initDb(filename); await projectAccountLogScope(account);
  assert.equal((await result()).records[0].reason, 'ambiguous_real_executions');
  console.log('Account scope: durable occurrences, real execution correlation, nonlinear activity, conflict replay and finality boundary passed.');
} finally { await closeDb(); await rm(directory, { recursive: true, force: true }); }
