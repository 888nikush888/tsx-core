import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { TradingEngine } from '../src/trading_engine.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { persistTradingOrderResult, transitionTradingIntent } from '../src/trading_order_repository.js';
import { persistCorrelatedFill } from '../src/trading_evidence_repository.js';
import { getTradingAccount, listTradingStrategies } from '../src/trading_repository.js';
import { prepareTradingOperation, resolveObservedOperations, transitionTradingOperation } from '../src/trading_recovery.js';
import { entryCommitmentReason, resolveActiveEntryCancelAttempts } from '../src/trading_entry_commitment.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { completeSafetyState } from './fixtures/safety_acquisition.js';
import { bindAccountReportingCurrency } from '../src/trading_money_ledger.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'trading-entry-commitment-'));
const databasePath = path.join(directory, 'test.db');
async function crashDuringCancel(accountId) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/entry_drain_crash.js', databasePath, accountId], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
  });
  await new Promise((resolve, reject) => {
    let output = '';
    let errors = '';
    let killed = false;
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Crash fixture did not reach dispatch.')); }, 10_000);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (!killed && output.includes('CANCEL_DISPATCHED')) { killed = true; child.kill('SIGKILL'); }
    });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', () => { clearTimeout(timeout); if (killed) resolve(); else reject(new Error(errors || output)); });
  });
}
let sequence = 0;
async function syntheticTerminalHistory(account) {
  // The cancellation test double's accepted terminal results are explicitly available on its next account read.
  const rows = await getDatabase().all(`SELECT orders.*, intent.symbol FROM trading_orders orders
    JOIN trading_trade_intents intent ON intent.id = orders.intent_id
    WHERE orders.account_id = ? AND orders.status IN ('filled', 'cancelled', 'rejected') AND orders.exchange_order_id IS NOT NULL`, [account.id]);
  return completeSafetyState({ orders: rows.map(row => ({ clientOrderId: row.client_order_id, exchangeOrderId: row.exchange_order_id,
    providerSymbol: row.provider_symbol, symbol: row.symbol, role: row.role, side: row.side, status: row.status,
    quantity: row.quantity, filledQuantity: row.filled_quantity, price: row.price, triggerPrice: row.trigger_price,
    reduceOnly: Boolean(row.reduce_only), averagePrice: row.average_price, error: null, raw: {} })) });
}
async function fixture(status = 'open', accountId = 'paper-default', symbol = 'BTCUSDT') {
  const id = `drain-${++sequence}`;
  const [strategy] = await listTradingStrategies();
  if (accountId !== 'paper-default') await getDatabase().run(
    `INSERT OR IGNORE INTO trading_accounts (id, name, exchange, mode, status, enabled, created_at, updated_at)
     VALUES (?, ?, 'paper', 'paper', 'ready', 1, 1, 1)`, [accountId, accountId]);
  await saveSignal(id, '-drain', sequence, '<signal/>', '<signal/>');
  const order = { clientOrderId: id, role: 'entry', side: 'buy', orderType: 'limit', quantity: '1', price: '100',
    triggerPrice: null, reduceOnly: false, postOnly: false, targetIndex: null };
  const plan = { version: 1, orders: [order], createdAt: Date.now(), entryOrderTtlSeconds: 900 };
  await getDatabase().run(
    `INSERT INTO trading_trade_intents (id, source_signal_id, root_source_signal_id, channel_id, strategy_version_id,
     account_id, exchange, mode, symbol, side, status, signal_json, plan_json, created_at, updated_at)
     VALUES (?, ?, ?, '-drain', ?, ?, 'paper', 'paper', ?, 'LONG', ?, '{}', ?, 1, 1)`,
    [id, id, id, strategy.id, accountId, symbol, status === 'created' ? 'planned' : 'submitting', JSON.stringify(plan)]);
  await getDatabase().run(
    `INSERT INTO trading_positions (id, intent_id, account_id, strategy_version_id, channel_id, symbol, side, status,
     quantity, stop_price, updated_at) VALUES (?, ?, ?, ?, '-drain', ?, 'LONG', 'opening', '0', '90', 1)`,
    [id, id, accountId, strategy.id, symbol]);
  await getDatabase().run(
    `INSERT INTO trading_orders (id, intent_id, account_id, client_order_id, exchange_order_id, provider_symbol, role,
     side, order_type, status, quantity, filled_quantity, price, reduce_only, request_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'entry', 'buy', 'limit', ?, '1', '0', '100', 0, ?, 1, 1)`,
    [id, id, accountId, id, status === 'created' || status === 'unknown' ? null : `remote-${id}`,
      status === 'created' || status === 'unknown' ? null : symbol, status, JSON.stringify(order)]);
  return { id, accountId, result: { clientOrderId: id, exchangeOrderId: `remote-${id}`, providerSymbol: symbol,
    status: 'cancelled', filledQuantity: '0', averagePrice: null, error: null, raw: {} } };
}

async function roundTripFixture(partial) {
  const row = await fixture('created', partial ? 'late-entry' : 'zero-roundtrip');
  await getDatabase().run(
    `INSERT OR IGNORE INTO trading_paper_accounts (account_id, equity, available_balance, realized_pnl, updated_at)
     VALUES (?, '10000', '10000', '0', ?)`, [row.accountId, Date.now()]);
  await bindAccountReportingCurrency({ accountId: row.accountId, accountFingerprint: `paper:${row.accountId}`, profile: 'paper',
    reportingCurrency: 'USDT', settlementAssets: ['USDT'], source: 'paper-contract-v1', verifiedAt: 1 });
  const account = await getTradingAccount(row.accountId);
  const paper = new PaperExchangeAdapter({ maximumFillQuantity: '1' });
  // Actual simulator entry and immediate stop; a partial entry retains its unfilled commitment.
  await paper.setMarket(account.id, { symbol: 'BTCUSDT', markPrice: '90', priceTick: '0.1', quantityStep: '0.1',
    minimumQuantity: '0.1', minimumNotional: '1', maxLeverage: 10 });
  const entry = { accountId: account.id, clientOrderId: row.id, symbol: 'BTCUSDT', role: 'entry', side: 'buy',
    orderType: 'limit', quantity: partial ? '2' : '1', price: '100', triggerPrice: null,
    reduceOnly: false, postOnly: false, targetIndex: null, leverage: 1 };
  const stop = { ...entry, clientOrderId: `${row.id}-stop`, role: 'stop_loss', side: 'sell', orderType: 'stop_market',
    quantity: '1', price: null, triggerPrice: '90', reduceOnly: true };
  await getDatabase().run('UPDATE trading_orders SET quantity=?,request_json=? WHERE id=?', [entry.quantity, JSON.stringify(entry), row.id]);
  const stored = await getDatabase().get('SELECT plan_json FROM trading_trade_intents WHERE id=?', [row.id]);
  await getDatabase().run('UPDATE trading_trade_intents SET plan_json=? WHERE id=?',
    [JSON.stringify({ ...JSON.parse(stored.plan_json), orders: [entry, stop] }), row.id]);
  await getDatabase().run(
    `INSERT INTO trading_orders (id, intent_id, account_id, client_order_id, exchange_order_id, provider_symbol, role,
     side, order_type, status, quantity, filled_quantity, average_price, trigger_price, reduce_only, request_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, NULL, 'stop_loss', 'sell', 'stop_market', 'created', '1', '0', NULL, '90', 1, ?, 1, 1)`,
    [stop.clientOrderId, row.id, row.accountId, stop.clientOrderId, JSON.stringify(stop)]);
  await transitionTradingIntent(row.id, 'submitting');
  const accepted = await paper.submitProtectedEntry(account, entry, stop);
  await persistTradingOrderResult(row.id, entry.clientOrderId, accepted.entry);
  await persistTradingOrderResult(row.id, stop.clientOrderId, accepted.protectiveStop);
  const state = await paper.openState(account);
  assert.equal(state.positions.length, 0, 'The simulator closed only the actually filled entry quantity.');
  assert.equal(accepted.entry.status, partial ? 'partially_filled' : 'filled');
  assert.equal(accepted.protectiveStop.status, 'filled');
  for (const fill of state.fills) await persistCorrelatedFill(account, fill);
  if (partial) await getDatabase().run("UPDATE trading_positions SET quantity = '1', average_entry_price = '100', status = 'open' WHERE id = ?", [row.id]);
  return row;
}

try {
  await initDb(databasePath);
  await seedTradingFixtures();
  for (const status of ['created', 'submitting', 'open', 'partially_filled', 'cancel_pending', 'unknown', 'unexpected']) {
    assert.ok(entryCommitmentReason(status, false), `${status} is not a terminal entry commitment.`);
  }
  for (const status of ['filled', 'cancelled', 'rejected']) {
    assert.equal(entryCommitmentReason(status, false), null);
    assert.equal(entryCommitmentReason(status, true), 'ENTRY_OPERATION_UNRESOLVED');
  }
  const uncertain = await fixture();
  const sends = [];
  const adapter = { exchange: 'paper', openState: syntheticTerminalHistory, cancelOrder: async (_account, id) => {
    sends.push(id);
    return { ...uncertain.result, status: 'open' };
  } };
  let engine = new TradingEngine([adapter]);
  await assert.rejects(engine.cancelOpenEntries(uncertain.accountId), /drain|cancellation|unresolved/i,
    'An open cancellation acknowledgement must not be reported as a completed drain.');
  assert.equal((await getTradingAccount(uncertain.accountId)).killSwitchActive, true);
  const requested = await getDatabase().get('SELECT entry_drain_requested_at FROM trading_orders WHERE id = ?', [uncertain.id]);
  assert.ok(requested.entry_drain_requested_at > 0);
  await closeDb();
  await initDb(databasePath);
  engine = new TradingEngine([adapter]);
  await assert.rejects(engine.cancelOpenEntries(uncertain.accountId), /drain|cancellation|unresolved/i);
  assert.equal(sends.length, 1, 'Restart and repeated operator clicks cannot blindly repeat a possibly dispatched cancel.');
  await getDatabase().run("UPDATE trading_orders SET status = 'cancelled' WHERE id = ?", [uncertain.id]);
  await resolveObservedOperations(await getTradingAccount(uncertain.accountId), [uncertain.result]);
  assert.equal(await engine.cancelOpenEntries(uncertain.accountId), 0);

  const unknown = await fixture('unknown', 'unknown-account');
  await assert.rejects(engine.cancelOpenEntries(unknown.accountId), /drain|cancellation|unresolved/i);
  assert.equal(sends.length, 1, 'An unbound, unknown entry must be recovered, not cancelled using invented identity.');

  const created = await fixture('created', 'created-account');
  assert.equal(await engine.cancelOpenEntries(created.accountId), 1);
  assert.equal((await getDatabase().get('SELECT status FROM trading_positions WHERE id = ?', [created.id])).status, 'closed');
  assert.equal(sends.length, 1, 'A proved unsubmitted plan is abandoned locally.');

  const failing = await fixture('open', 'a-failing');
  const healthy = await fixture('open', 'z-healthy');
  adapter.cancelOrder = async (_account, id) => {
    sends.push(id);
    if (id === failing.id) throw new Error('simulated timeout after cancel dispatch');
    assert.equal(id, healthy.id);
    return healthy.result;
  };
  await assert.rejects(engine.cancelOpenEntries(), /drain|cancellation|unresolved/i);
  assert.ok(sends.includes(healthy.id), 'One account failure must not stop cancellation on another account.');
  assert.equal((await getDatabase().get('SELECT status FROM trading_orders WHERE id = ?', [healthy.id])).status, 'cancelled');

  const zero = await fixture('open', 'zero-position');
  adapter.cancelOrder = async (_account, id) => { sends.push(id); assert.equal(id, zero.id); return zero.result; };
  adapter.openState = syntheticTerminalHistory;
  await engine.emergencyFlattenManaged(zero.accountId);
  assert.ok(sends.includes(zero.id), 'Emergency flatten must drain an entry even when local position quantity is zero.');

  const retry = await fixture('open', 'bounded-retry');
  adapter.cancelOrder = async () => { sends.push(retry.id); return { ...retry.result, status: 'open' }; };
  await assert.rejects(engine.cancelOpenEntries(retry.accountId), /unresolved/);
  await getDatabase().run("UPDATE trading_orders SET status = 'cancel_pending', entry_drain_attempted_at = 1 WHERE id = ?", [retry.id]);
  const retryAccount = await getTradingAccount(retry.accountId);
  await getDatabase().run('UPDATE trading_operations SET updated_at = 1 WHERE account_id = ?', [retry.accountId]);
  const remote = completeSafetyState({ orders: [{ ...retry.result, status: 'open', reduceOnly: false, side: 'buy',
    role: 'entry', symbol: 'BTCUSDT', quantity: '1', price: '100', triggerPrice: null }] });
  await resolveActiveEntryCancelAttempts(retryAccount, { ...remote, acquisition: { ...remote.acquisition, startedAt: 0 } });
  await assert.rejects(engine.cancelOpenEntries(retry.accountId), /unresolved/);
  assert.equal(sends.filter(id => id === retry.id).length, 1, 'Old evidence must not authorize another cancel.');
  await resolveActiveEntryCancelAttempts(retryAccount, remote);
  await getDatabase().run('UPDATE trading_orders SET entry_drain_attempted_at = 1 WHERE id = ?', [retry.id]);
  adapter.cancelOrder = async () => { sends.push(retry.id); return retry.result; };
  assert.equal(await engine.cancelOpenEntries(retry.accountId), 1);
  assert.equal(sends.filter(id => id === retry.id).length, 2, 'Only fresh, exact active evidence permits bounded retry of the same cancellation target.');

  const crashed = await fixture('open', 'crash-account');
  await closeDb();
  await crashDuringCancel(crashed.accountId);
  await initDb(databasePath);
  assert.equal((await getDatabase().get('SELECT phase FROM trading_operations WHERE account_id = ?', [crashed.accountId])).phase, 'dispatching');
  const restarted = new TradingEngine([{ exchange: 'paper', cancelOrder: async () => { throw new Error('No blind cancel after hard crash'); } }]);
  await assert.rejects(restarted.cancelOpenEntries(crashed.accountId), /unresolved/);
  assert.equal((await getDatabase().get('SELECT status FROM trading_orders WHERE id = ?', [crashed.id])).status, 'cancel_pending');

  const partial = await roundTripFixture(true);
  const flatAdapter = { exchange: 'paper', openState: syntheticTerminalHistory };
  const flatEngine = new TradingEngine([flatAdapter]);
  await assert.rejects(flatEngine.reconcileAccount(partial.accountId), /entry|terminal|closure|drain/i);
  assert.notEqual((await getDatabase().get('SELECT status FROM trading_positions WHERE id = ?', [partial.id])).status, 'closed',
    'A filled stop and zero remote quantity cannot close a trade while its entry can still fill.');
  const roundTrip = await roundTripFixture(false);
  await flatEngine.reconcileAccount(roundTrip.accountId);
  assert.deepEqual(await getDatabase().get('SELECT status, quantity, realized_pnl FROM trading_positions WHERE id = ?', [roundTrip.id]),
    { status: 'closed', quantity: '0', realized_pnl: '-10' }, 'A fully proved round trip closes even if no intermediate position was observed.');

  const unfinishedExit = await roundTripFixture(false);
  const extraExit = `${unfinishedExit.id}-tp`;
  await getDatabase().run(
    `INSERT INTO trading_orders (id, intent_id, account_id, client_order_id, exchange_order_id, provider_symbol, role,
     side, order_type, status, quantity, filled_quantity, price, reduce_only, request_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'BTCUSDT', 'take_profit', 'sell', 'limit', 'open', '1', '0', '120', 1, '{}', 1, 1)`,
    [extraExit, unfinishedExit.id, unfinishedExit.accountId, extraExit, `remote-${extraExit}`]);
  const exitResult = { clientOrderId: extraExit, exchangeOrderId: `remote-${extraExit}`, providerSymbol: 'BTCUSDT', status: 'open',
    filledQuantity: '0', averagePrice: null, error: null, raw: {} };
  flatAdapter.openState = async account => {
    const state = await syntheticTerminalHistory(account);
    state.orders.push({ ...exitResult, role: 'take_profit', side: 'sell', reduceOnly: true, symbol: 'BTCUSDT',
      quantity: '1', price: '120', triggerPrice: null });
    return state;
  };
  flatAdapter.cancelOrder = async () => exitResult;
  await assert.rejects(flatEngine.reconcileAccount(unfinishedExit.accountId), /sibling cancellation.*unresolved/);
  assert.notEqual((await getDatabase().get('SELECT status FROM trading_positions WHERE id = ?', [unfinishedExit.id])).status, 'closed',
    'An exit sibling with unresolved cancellation prevents clean closure.');

  for (let index = 0; index < 6; index += 1) await fixture('unknown', 'fair-drain', `TEST${index}USDT`);
  const fair = await fixture('open', 'fair-drain');
  let fairCancelled = 0;
  const fairEngine = new TradingEngine([{ exchange: 'paper', cancelOrder: async () => { fairCancelled += 1; return fair.result; } }]);
  await assert.rejects(fairEngine.cancelOpenEntries(fair.accountId), /unresolved/);
  assert.equal(fairCancelled, 0, 'Only five commitments may be attempted in one drain pass.');
  await assert.rejects(fairEngine.cancelOpenEntries(fair.accountId), /unresolved/);
  assert.equal(fairCancelled, 1, 'Unresolvable older commitments must not starve a later cancellable entry.');

  const terminalUnknown = await fixture('cancelled', 'terminal-unknown');
  const terminalOperation = await prepareTradingOperation({ account: await getTradingAccount(terminalUnknown.accountId),
    intentId: terminalUnknown.id, kind: 'cancel', clientOrderIds: [terminalUnknown.id], request: { clientOrderId: terminalUnknown.id } });
  await transitionTradingOperation(terminalOperation, 'prepared', 'dispatching');
  adapter.openState = async () => completeSafetyState();
  await assert.rejects(engine.cancelOpenEntries(terminalUnknown.accountId), /unresolved/,
    'Even a terminal local row remains a commitment without fresh exact evidence resolving its write journal.');
  adapter.openState = syntheticTerminalHistory;
  assert.equal(await engine.cancelOpenEntries(terminalUnknown.accountId), 0,
    'The new authoritative drain read may resolve the previous cancellation from exact terminal provider evidence.');

  const expired = [];
  for (let index = 0; index < 6; index += 1) expired.push(await fixture('open', 'ttl-bounded', `TTL${index}USDT`));
  let expiryCalls = 0;
  const expiryEngine = new TradingEngine([{ exchange: 'paper', cancelOrder: async (_account, id) => {
    const row = expired.find(item => item.id === id);
    if (!row) throw new Error('Other test accounts stay isolated.');
    expiryCalls += 1;
    return row.result;
  } }]);
  await assert.rejects(expiryEngine.cancelExpiredEntries(Date.now() + 1_000_000), /unresolved/);
  assert.equal(expiryCalls, 5, 'Multiple expired entries cannot multiply the per-account drain budget.');
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  console.log('Durable entry drain, unknown cancel, restart, independent accounts and zero-position tests passed.');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
