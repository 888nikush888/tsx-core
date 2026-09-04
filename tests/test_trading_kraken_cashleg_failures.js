import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb } from '../src/db.js';
import { getMoneyEvent, moneyLedgerSnapshot, valueKrakenCashlegFee } from '../src/trading_money_ledger.js';
import { projectAccountLogMoney } from '../src/trading_account_log_money.js';
import { cashlegAsset } from '../src/trading_kraken_cashleg_contract.js';
import { cashlegAccount, cashlegFill, cashlegRows, appendCashlegs } from './fixtures/kraken_cashleg.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-kraken-cashleg-failures-'));
const filename = path.join(directory, 'test.db');
const now = Date.now();

const cases = [
  ['null-funding', rows => { rows[1].realized_funding = null; }, 'missing_cash_component'],
  ['null-pnl', rows => { rows[1].realized_pnl = null; }, 'missing_cash_component'],
  ['null-fee', rows => { rows[1].fee = null; }, 'missing_cash_component'],
  ['unknown-delta', rows => { rows[1].new_balance = '99'; }, 'cash_delta_mismatch'],
  ['wrong-fee', rows => { rows[1].fee = '0.02'; }, 'fee_mismatch'],
  ['wrong-pnl', rows => { rows[1].realized_pnl = '1'; }, 'price_pnl_mismatch'],
  ['wrong-position', rows => { rows[0].new_balance = '2'; }, 'position_delta_mismatch'],
  ['wrong-price', rows => { rows[1].trade_price = '101'; }, 'trade_price_mismatch'],
  ['wrong-wallet', rows => { rows[0].margin_account = 'other'; }, 'wallet_mismatch'],
  ['wrong-contract', rows => { rows[1].contract = 'PF_ETHUSD'; }, 'contract_mismatch'],
  ['wrong-collateral', rows => { rows[1].collateral = 'USDC'; }, 'collateral_mismatch'],
  ['foreign-asset', rows => { for (const row of rows) row.collateral = 'usdc'; rows[1].asset = 'usdc'; }, 'non_native_reporting_asset'],
  ['conversion-fee-percent', rows => { rows[1].conversion_fee = '0.05'; }, 'conversion_or_liquidation'],
  ['conversion-spread-percent', rows => { rows[1].conversion_spread_percentage = '0.05'; }, 'conversion_or_liquidation'],
  ['conversion-rate', rows => { rows[1].exchange_rate = '1'; rows[1].exchange_rate_from = 'usdc'; }, 'conversion_route'],
  ['liquidation-fee', rows => { rows[1].liquidation_fee = '0.1'; }, 'conversion_or_liquidation'],
  ['kfee', rows => { rows[1].info = 'kfee applied'; }, 'missing_cash_or_position_leg'],
  ['tax', rows => { rows[1].info = 'tax'; }, 'missing_cash_or_position_leg'],
  ['missing-cash', rows => { rows.pop(); }, 'missing_cash_or_position_leg'],
  ['missing-position', rows => { rows.shift(); }, 'missing_cash_or_position_leg'],
  ['wrong-execution', rows => { rows[1].execution = '99999999-9999-4999-8999-999999999999'; }, 'missing_cash_or_position_leg'],
  ['unicode-asset', rows => { rows[1].asset = 'uſd'; }, 'invalid_asset'],
];

async function rejectsUnproved(name, mutate, reason) {
  const trade = await cashlegFill(await cashlegAccount(name, now));
  const rows = cashlegRows(trade); mutate(rows);
  await appendCashlegs(trade, rows); await projectAccountLogMoney(trade.account);
  const event = await getMoneyEvent(trade.eventId);
  assert.equal(event.reportingAmount, null, name); assert.equal(event.valuationStatus, 'unresolved', name);
  assert.equal(event.asset, null, name);
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS n FROM trading_kraken_cashleg_evidence WHERE event_id=?', [event.id])).n, 0, name);
  const consumer = await getDatabase().get(`SELECT result_json FROM trading_account_log_consumers work
    JOIN trading_account_log_receipts receipt ON receipt.id=work.receipt_id WHERE receipt.account_id=?`, [trade.account.id]);
  assert.match(consumer.result_json, new RegExp(reason), name);
}

async function originalUnitConflict() {
  const trade = await cashlegFill(await cashlegAccount('known-unit', now), { feeAsset: 'USD' });
  const original = await getMoneyEvent(trade.eventId);
  assert.equal(original.reportingAmount, '-0.01');
  const rows = cashlegRows(trade, { asset: 'usdc' });
  await appendCashlegs(trade, rows); await projectAccountLogMoney(trade.account);
  const conflicted = await getMoneyEvent(trade.eventId);
  assert.equal(conflicted.reportingAmount, '-0.01', 'Keep the original native value auditable.');
  assert.equal(conflicted.valuationStatus, 'unresolved', 'A genuine unit conflict cannot appear green at the single-event API.');
  assert.ok((await moneyLedgerSnapshot(trade.account.id, 0, now + 1)).conflictCount > 0);
}

async function sourceAndCallerBinding() {
  const trade = await cashlegFill(await cashlegAccount('source-uid', now));
  const rows = cashlegRows(trade), receiptId = await appendCashlegs(trade, rows, { uid: '99999999-9999-4999-8999-999999999999' });
  await projectAccountLogMoney(trade.account);
  assert.equal((await getMoneyEvent(trade.eventId)).reportingAmount, null);
  const request = { eventId: trade.eventId, cashOccurrence: { receiptId, ordinal: 1 }, positionOccurrence: { receiptId, ordinal: 0 } };
  await assert.rejects(valueKrakenCashlegFee(request), /source_binding_mismatch/);
  await assert.rejects(valueKrakenCashlegFee({ ...request, rate: '1' }), /Invalid native cashleg request/);
  await assert.rejects(valueKrakenCashlegFee({ ...request, cashOccurrence: { receiptId: 'missing', ordinal: 1 } }), /missing_original_occurrence/);
  await getDatabase().run('UPDATE trading_accounts SET external_account_id=? WHERE id=?', ['c'.repeat(64), trade.account.id]);
  await assert.rejects(valueKrakenCashlegFee(request), /account_binding_unproven/);
}

async function nativeExecutionEconomics() {
  for (const [id, rawPatch] of [['price', { price: '101' }], ['quantity', { amount: '2' }], ['fee-unit', { fee: { cost: '0.01', currency: 'USDC' } }]]) {
    const trade = await cashlegFill(await cashlegAccount(`raw-${id}`, now), { rawPatch });
    await appendCashlegs(trade, cashlegRows(trade)); await projectAccountLogMoney(trade.account);
    assert.equal((await getMoneyEvent(trade.eventId)).reportingAmount, null, `Contradictory native ${id} cannot be replaced by normalized values.`);
  }
  const known = await cashlegFill(await cashlegAccount('unknown-contract-size', now), { feeAsset: 'USD', rawPatch: { amount: '2' } });
  await appendCashlegs(known, cashlegRows(known)); await projectAccountLogMoney(known.account);
  assert.equal((await moneyLedgerSnapshot(known.account.id, 0, now + 1)).conflictCount, 0,
    'Contract/base quantity inequality without the original conversion factor is unknown, not a proved monetary contradiction.');
  const result = await getDatabase().get(`SELECT result_json FROM trading_account_log_consumers work
    JOIN trading_account_log_receipts receipt ON receipt.id=work.receipt_id WHERE receipt.account_id=?`, [known.account.id]);
  assert.match(result.result_json, /contract_quantity_unit_unproven/);
}

try {
  await initDb(filename);
  assert.equal(cashlegAsset('usd'), 'USD');
  for (const value of ['uſd', 'uıd', 'ｕｓｄ', 'USD ']) assert.throws(() => cashlegAsset(value), /invalid_asset|missing_original_identity/);
  for (const row of cases) await rejectsUnproved(...row);
  await originalUnitConflict(); await sourceAndCallerBinding(); await nativeExecutionEconomics();
  assert.equal((await getDatabase().all('PRAGMA foreign_key_check')).length, 0);
  console.log('Kraken cashleg failures: missing/null/ambiguous units, exact economics, conversion percentages, source/caller binding passed.');
} finally { await closeDb(); await rm(directory, { recursive: true, force: true }); }
