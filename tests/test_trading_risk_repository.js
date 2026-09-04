import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { getTradingAccount, listTradingStrategies } from '../src/trading_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { insertAccountedFill } from './fixtures/accounted_trades.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { refreshReconciledRisk } from '../src/trading_risk_reconciliation.js';
import { assertEntryAccountingReady, assertPersistedMoneyReady } from '../src/trading_accounting.js';
import { createRiskAdmission, verifyRiskAdmission } from '../src/trading_risk_admission.js';
import { recordMoneyEvent } from '../src/trading_money_ledger.js';
import { dropFxSchema } from './fixtures/fx_schema.js';
const risk = await import('../src/trading_risk_repository.js');
const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-risk-proof-'));
const filename = path.join(directory, 'test.db');
const market = { version: 1, source: 'paper-contract-v1', providerSymbol: 'BTCUSDT', settlementAsset: 'USDT', linear: true, quantityUnit: 'base' };
async function balanceAndAdmission(account, remote, strategy) {
  const paper = new PaperExchangeAdapter();
  let reads = 0;
  const readBalance = async () => { reads += 1; return { ...await paper.accountSnapshot(account), unrealizedPnl: '-10' }; };
  assert.equal(await refreshReconciledRisk({ account, remote, epoch: '0:0', readBalance, budgetForIntent: async () => '19' }), true);
  assert.equal(reads, 1, 'Exactly one account read per completed risk refresh.');
  assert.equal((await getDatabase().get('SELECT balance_reason FROM trading_risk_current')).balance_reason, 'MAX_DAILY_RISK');
  await refreshReconciledRisk({ account, remote, epoch: '0:0', readBalance: async () => { throw new Error('account read failed'); }, budgetForIntent: async () => '19' });
  const failed = await getDatabase().get('SELECT balance_json, balance_reason FROM trading_risk_current');
  assert.equal(failed.balance_json, null); assert.match(failed.balance_reason, /failed/);
  assert.equal((await getDatabase().get("SELECT status FROM trading_orders WHERE id = 'risk-stop'")).status, 'open');
  const snapshot = await readBalance(); await assertEntryAccountingReady(account, snapshot);
  const now = Date.now();
  const orders = [{ role: 'entry', clientOrderId: 'candidate-entry', quantity: '1', price: '101', triggerPrice: null, orderType: 'limit', side: 'buy', reduceOnly: false },
    { role: 'stop_loss', clientOrderId: 'candidate-stop', quantity: '1', price: null, triggerPrice: '90', orderType: 'stop_market', side: 'sell', reduceOnly: true }];
  const plan = { version: 1, side: 'LONG', symbol: 'ETHUSDT', stopPrice: '90', riskAmount: '999', orders, createdAt: now };
  await saveSignal('candidate-signal', '-risk', 2, '<signal/>', '<signal/>');
  await getDatabase().run(`INSERT INTO trading_trade_intents (id, source_signal_id, root_source_signal_id, channel_id,
    strategy_version_id, account_id, exchange, mode, symbol, side, status, signal_json, plan_json, created_at, updated_at)
    VALUES ('candidate', 'candidate-signal', 'candidate-signal', '-risk', ?, ?, 'paper', 'paper', 'ETHUSDT', 'LONG', 'submitting', '{}', ?, ?, ?)`,
  [strategy.id, account.id, JSON.stringify(plan), now, now]);
  for (const order of orders) await getDatabase().run(`INSERT INTO trading_orders (id, intent_id, account_id, client_order_id, role, side,
    order_type, status, quantity, filled_quantity, price, trigger_price, reduce_only, request_json, created_at, updated_at)
    VALUES (?, 'candidate', ?, ?, ?, ?, ?, 'created', ?, '0', ?, ?, ?, '{}', ?, ?)`,
  [order.clientOrderId, account.id, order.clientOrderId, order.role, order.side, order.orderType, order.quantity, order.price, order.triggerPrice, Number(order.reduceOnly), now, now]);
  const input = { account, intentId: 'candidate', plan, market: { observedAt: now, accounting: { ...market, providerSymbol: 'ETHUSDT' } }, snapshot, budget: '31', epoch: '0:0' };
  const proof = await createRiskAdmission(input);
  assert.equal(proof.candidateCommitment, '11', 'Real executable quantity/price, not configured plan.riskAmount=999, drives candidate commitment.');
  await verifyRiskAdmission(proof, plan);
  await assert.rejects(createRiskAdmission({ ...input, budget: '30.999999999999999999' }), /budget/);
  await getDatabase().run("UPDATE trading_orders SET quantity = '2' WHERE id = 'candidate-entry'");
  await assert.rejects(verifyRiskAdmission(proof, plan), /economics changed/);
  await getDatabase().run("UPDATE trading_orders SET quantity = '1' WHERE id = 'candidate-entry'");
  await assertPersistedMoneyReady(account.id);
  await recordMoneyEvent({ accountId: account.id, accountFingerprint: `paper:${account.id}`, providerEventId: 'new-zero-funding', kind: 'funding',
    source: 'paper-contract-v1', basis: 'provider', occurredAt: now, amount: '0', asset: 'USDT' });
  await assert.rejects(verifyRiskAdmission(proof, plan), /monetary evidence changed/, 'Even offsetting/zero new source generations invalidate the prepared monetary proof.');
  await getDatabase().run("UPDATE trading_orders SET status = 'cancelled' WHERE intent_id = 'candidate'");
}

async function partialCancelAndLateFill(account, remote) {
  await getDatabase().run("UPDATE trading_orders SET quantity = '5', price = '101', status = 'partially_filled' WHERE id = 'order-risk-entry'");
  await getDatabase().run("UPDATE trading_orders SET quantity = '5' WHERE id = 'risk-stop'");
  remote.orders[0].quantity = '5';
  await risk.observeRiskReservations(account, remote, '0:0');
  assert.equal((await risk.existingRiskCommitment(account, 'candidate', '0:0', 'USDT')).commitment, '43');
  await getDatabase().run("UPDATE trading_orders SET status = 'cancel_pending' WHERE id = 'order-risk-entry'");
  await risk.observeRiskReservations(account, remote, '0:0');
  assert.equal((await risk.existingRiskCommitment(account, 'candidate', '0:0', 'USDT')).commitment, '43');
  await getDatabase().run("UPDATE trading_orders SET status = 'cancelled' WHERE id = 'order-risk-entry'");
  await risk.observeRiskReservations(account, remote, '0:0');
  assert.equal((await risk.existingRiskCommitment(account, 'candidate', '0:0', 'USDT')).commitment, '10');
  await getDatabase().run("UPDATE trading_orders SET filled_quantity = '3' WHERE id = 'order-risk-entry'");
  await risk.observeRiskReservations(account, remote, '0:0');
  await assert.rejects(risk.existingRiskCommitment(account, 'candidate', '0:0', 'USDT'), /unresolved/);
  await getDatabase().run(`INSERT INTO trading_fills (id, order_id, account_id, exchange_fill_id, price, quantity, fee, fee_asset, filled_at, raw_json, account_fingerprint, accounting_json)
    SELECT 'late-fill', order_id, account_id, 'late-remote-fill', price, '1', fee, fee_asset, filled_at + 1, raw_json, account_fingerprint, accounting_json FROM trading_fills WHERE id = 'fill-risk-entry'`);
  await getDatabase().run("UPDATE trading_positions SET quantity = '3' WHERE intent_id = 'risk-owned'");
  remote.positions[0].quantity = '3';
  await risk.observeRiskReservations(account, remote, '0:0');
  assert.equal((await risk.existingRiskCommitment(account, 'candidate', '0:0', 'USDT')).commitment, '15', 'Late fill changes only owned quantity; cancelled residual stays released.');
}
try {
  await initDb(filename); await seedTradingFixtures();
  const account = await getTradingAccount('paper-default');
  const [strategy] = await listTradingStrategies();
  const now = Date.now();
  await saveSignal('risk-owned', '-risk', 1, '<signal/>', '<signal/>');
  await getDatabase().run(`INSERT INTO trading_trade_intents (id, source_signal_id, root_source_signal_id, channel_id,
    strategy_version_id, account_id, exchange, mode, symbol, side, status, signal_json, created_at, updated_at)
    VALUES ('risk-owned', 'risk-owned', 'risk-owned', '-risk', ?, ?, 'paper', 'paper', 'BTCUSDT', 'LONG', 'monitoring', '{}', ?, ?)`,
  [strategy.id, account.id, now, now]);
  await insertAccountedFill({ intentId: 'risk-owned', id: 'risk-entry', price: '100', quantity: '2', filledAt: now });
  await getDatabase().run(`INSERT INTO trading_positions (id, intent_id, account_id, strategy_version_id, channel_id, symbol, side, status, quantity, average_entry_price,
    stop_price, opened_at, updated_at) VALUES ('risk-position', 'risk-owned', ?, ?, '-risk', 'BTCUSDT', 'LONG', 'open', '2', '100', '90', ?, ?)`, [account.id, strategy.id, now, now]);
  await getDatabase().run(`INSERT INTO trading_orders (id, intent_id, account_id, client_order_id, exchange_order_id, provider_symbol,
    role, side, order_type, status, trigger_price, quantity, filled_quantity, reduce_only, request_json, created_at, updated_at)
    VALUES ('risk-stop', 'risk-owned', ?, 'risk-stop-client', 'risk-stop-remote', 'BTCUSDT', 'stop_loss', 'sell', 'stop_market',
    'open', '90', '2', '0', 1, '{}', ?, ?)`, [account.id, now, now]);
  const remote = { observedAt: now, positions: [{ symbol: 'BTCUSDT', providerSymbol: 'BTCUSDT', side: 'LONG', quantity: '2',
    averageEntryPrice: '100', markPrice: '95', accounting: market }], orders: [{ clientOrderId: 'risk-stop-client', exchangeOrderId: 'risk-stop-remote',
    providerSymbol: 'BTCUSDT', symbol: 'BTCUSDT', role: 'stop_loss', side: 'sell', status: 'open', quantity: '2', filledQuantity: '0', reduceOnly: true, triggerPrice: '90' }] };
  const originals = async () => ({ fills: await getDatabase().all('SELECT * FROM trading_fills ORDER BY id'),
    orders: await getDatabase().all('SELECT * FROM trading_orders ORDER BY id'), positions: await getDatabase().all('SELECT * FROM trading_positions ORDER BY id') });
  const beforeMigration = await originals();
  // Later FX/schedule objects must not survive the genuine pre-risk fixture.
  await getDatabase().exec(`${dropFxSchema}
    DROP TRIGGER trading_kraken_occurrence_insert;
    DROP TABLE trading_fill_quantity_evidence;
    DROP TABLE trading_kraken_cashleg_evidence;
    DROP TABLE trading_kraken_log_occurrences;
    DROP TABLE trading_order_identity_bindings;
    DROP TABLE trading_account_baseline_bindings; DROP TABLE trading_account_mode_observations;
    DROP TABLE trading_account_log_consumers; DROP TABLE trading_account_log_records;
    DROP TABLE trading_account_log_receipts; DROP TABLE trading_account_log_checkpoints;
    DROP TABLE trading_risk_current; DROP TABLE trading_risk_observations; DROP TABLE trading_risk_contracts;
    DELETE FROM schema_migrations WHERE version >= 37;`);
  await closeDb(); await initDb(filename);
  assert.deepEqual(await originals(), beforeMigration, 'Migration37 never manufactures historical reserves or alters financial originals.');
  await assert.rejects(risk.existingRiskCommitment(account, 'candidate', '0:0', 'USDT'), /missing observation/);
  await risk.observeRiskReservations(account, remote, '0:0');
  const proof = await risk.existingRiskCommitment(account, 'candidate', '0:0', 'USDT');
  assert.equal(proof.commitment, '10', 'Current mark risk, not original entry-to-stop risk, is reserved.');
  assert.equal(proof.reservations[0].amounts.actualFillToStopRisk, '20');
  const count = (await getDatabase().get('SELECT COUNT(*) AS n FROM trading_risk_observations')).n;
  await risk.observeRiskReservations(account, remote, '0:0');
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS n FROM trading_risk_observations')).n, count, 'Replay is idempotent.');
  await balanceAndAdmission(account, remote, strategy);
  await closeDb(); await initDb(filename);
  assert.equal((await risk.existingRiskCommitment(account, 'candidate', '0:0', 'USDT')).commitment, '10', 'Restart retains only still-fresh evidence.');
  await assert.rejects(risk.existingRiskCommitment(account, 'candidate', '0:1', 'USDT'), /risk|epoch/i);
  await getDatabase().run("UPDATE trading_orders SET trigger_price = '94' WHERE id = 'risk-stop'");
  await assert.rejects(risk.existingRiskCommitment(account, 'candidate', '0:0', 'USDT'), /risk|changed/i);
  remote.orders[0].triggerPrice = '94';
  await risk.observeRiskReservations(account, remote, '0:0');
  assert.equal((await risk.existingRiskCommitment(account, 'candidate', '0:0', 'USDT')).commitment, '2');
  remote.orders[0].triggerPrice = '90';
  await getDatabase().run("UPDATE trading_orders SET trigger_price = '90' WHERE id = 'risk-stop'");
  await partialCancelAndLateFill(account, remote);
  delete remote.positions[0].markPrice;
  await risk.observeRiskReservations(account, remote, '0:0');
  await assert.rejects(risk.existingRiskCommitment(account, 'candidate', '0:0', 'USDT'), /risk|unproven/i);
  assert.equal((await getDatabase().all('PRAGMA foreign_key_check')).length, 0);
  console.log('Dynamic reservation provenance, replay, restart, stop tightening, stale identity and unknown mark passed.');
} finally { await closeDb(); await rm(directory, { recursive: true, force: true }); }
