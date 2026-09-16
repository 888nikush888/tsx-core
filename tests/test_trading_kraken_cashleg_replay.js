import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb } from '../src/db.js';
import { getTradingAccount } from '../src/trading_repository.js';
import { getMoneyEvent, moneyLedgerSnapshot, valueKrakenCashlegFee } from '../src/trading_money_ledger.js';
import { projectAccountLogMoney } from '../src/trading_account_log_money.js';
import { projectAccountFillAccounting } from '../src/trading_fill_accounting.js';
import { observedFundingEvidence, assertFundingObservationCurrent } from '../src/trading_funding_observation.js';
import { createRiskAdmission } from '../src/trading_risk_admission.js';
import { cashlegAccount, cashlegFill, cashlegRows, appendCashlegs } from './fixtures/kraken_cashleg.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-kraken-cashleg-replay-'));
const filename = path.join(directory, 'test.db');
const now = Date.now();

async function valueTrade(trade, rows = cashlegRows(trade)) {
  await appendCashlegs(trade, rows); await appendCashlegs(trade, []);
  const funding = await observedFundingEvidence(trade.account, now);
  assert.equal(funding.observation.status, 'observed', funding.reason);
  return funding;
}
async function nativeAndRebate() {
  for (const [id, fee, feeAsset, expected] of [['rebate', '-0.125', null, '0.125'], ['native-known', '0.25', 'USD', '-0.25']]) {
    const trade = await cashlegFill(await cashlegAccount(id, now), { fee, feeAsset });
    const before = await getDatabase().get('SELECT content_json FROM trading_money_valuations WHERE event_id=?', [trade.eventId]);
    await valueTrade(trade);
    assert.equal((await getMoneyEvent(trade.eventId)).reportingAmount, expected);
    assert.equal((await moneyLedgerSnapshot(trade.account.id, 0, now + 1)).fees, expected);
    if (before) assert.deepEqual(await getDatabase().get('SELECT content_json FROM trading_money_valuations WHERE event_id=?', [trade.eventId]), before,
      'An equal existing native value is retained, not falsely conflicted because the proof route differs.');
  }
  const sameAsset = await cashlegFill(await cashlegAccount('native-btc-report', now, 'BTC'));
  await valueTrade(sameAsset, cashlegRows(sameAsset, { asset: 'btc' }));
  assert.equal((await getMoneyEvent(sameAsset.eventId)).reportingCurrency, 'BTC', 'Zero explicit PnL needs no fictitious USD/BTC rate to prove a BTC-denominated fee.');
}
async function partialRealisation() {
  const context = await cashlegAccount('partial', now);
  const entry = await cashlegFill(context, { quantity: '3', occurredAt: now - 4000, fee: '0.03' });
  const exit = await cashlegFill(context, { quantity: '1', price: '90', fee: '0.02', occurredAt: now - 2000, role: 'take_profit' });
  await getDatabase().run(`INSERT INTO trading_positions (id,intent_id,account_id,strategy_version_id,channel_id,symbol,side,
    status,quantity,average_entry_price,stop_price,realized_pnl,opened_at,updated_at)
    VALUES ('partial-position',?, ?,?,'-cashleg','BTCUSD','LONG','open','2','100','80','0',?,?)`,
  [context.intentId, context.account.id, context.strategyId, entry.fill.filledAt, now]);
  await appendCashlegs(entry, cashlegRows(entry));
  const exitRows = cashlegRows(exit, { startId: 3, oldPosition: '3', pnl: '-10', funding: '-0.5' });
  await appendCashlegs(exit, exitRows); await appendCashlegs(exit, []);
  assert.equal((await observedFundingEvidence(context.account, now)).observation.status, 'observed');
  const snapshot = await moneyLedgerSnapshot(context.account.id, 0, now + 1);
  assert.deepEqual([snapshot.pricePnl, snapshot.fees, snapshot.funding, snapshot.amount], ['-10', '-0.05', '-0.5', '-10.55']);
  assert.equal((await getDatabase().get("SELECT COUNT(*) AS n FROM trading_money_events WHERE account_id=? AND kind='realized_price_pnl'", [context.account.id])).n, 1);
  assert.equal((await getDatabase().get("SELECT COUNT(*) AS n FROM trading_money_events WHERE account_id=? AND kind='funding' AND amount<>'0'", [context.account.id])).n, 1);
  assert.equal((await getDatabase().get("SELECT provider_event_id FROM trading_money_events WHERE account_id=? AND kind='funding' AND amount<>'0'", [context.account.id])).provider_event_id, 'kraken-account-log:4');
  assert.deepEqual(await getDatabase().get("SELECT status,quantity,ledger_realized_pnl FROM trading_positions WHERE id='partial-position'"),
    { status: 'open', quantity: '2', ledger_realized_pnl: '-10.05' });
}
async function crosspageAndGeneration() {
  const trade = await cashlegFill(await cashlegAccount('crosspage', now));
  const rows = cashlegRows(trade);
  await appendCashlegs(trade, [rows[0]]); await projectAccountLogMoney(trade.account);
  assert.equal((await getMoneyEvent(trade.eventId)).reportingAmount, null);
  await closeDb(); await initDb(filename);
  await appendCashlegs(trade, [rows[1]]); await appendCashlegs(trade, []);
  assert.equal((await observedFundingEvidence(trade.account, now)).observation.status, 'observed');
  const original = await getDatabase().get('SELECT content_json FROM trading_money_valuations WHERE event_id=?', [trade.eventId]);
  const originalProof = await getDatabase().get('SELECT proof_json FROM trading_kraken_cashleg_evidence WHERE event_id=?', [trade.eventId]);
  await valueTrade(trade, rows); // Overlap has different receipt IDs, unchanged original booking IDs and economics.
  await getDatabase().run('UPDATE trading_accounts SET credential_generation=? WHERE id=?', ['c'.repeat(64), trade.account.id]);
  trade.account = await getTradingAccount(trade.account.id);
  await valueTrade(trade, rows); // Same verified account/UID, independently bound new receipt generation.
  assert.deepEqual(await getDatabase().get('SELECT content_json FROM trading_money_valuations WHERE event_id=?', [trade.eventId]), original);
  assert.deepEqual(await getDatabase().get('SELECT proof_json FROM trading_kraken_cashleg_evidence WHERE event_id=?', [trade.eventId]), originalProof);
  assert.equal((await moneyLedgerSnapshot(trade.account.id, 0, now + 1)).conflictCount, 0);
  assert.equal((await getDatabase().get('SELECT COUNT(DISTINCT credential_generation) AS n FROM trading_kraken_log_occurrences WHERE account_id=?', [trade.account.id])).n, 2);
}
async function laterContradiction() {
  const trade = await cashlegFill(await cashlegAccount('late-conflict', now));
  const rows = cashlegRows(trade), initial = await valueTrade(trade, rows);
  const original = await getDatabase().get('SELECT content_json FROM trading_money_valuations WHERE event_id=?', [trade.eventId]);
  await getDatabase().run(`INSERT INTO trading_orders (id,intent_id,account_id,client_order_id,exchange_order_id,provider_symbol,
    role,side,order_type,status,trigger_price,quantity,filled_quantity,reduce_only,request_json,created_at,updated_at)
    VALUES ('unchanged-protection',?,?,'protect-client','protect-provider','BTC/USD:USD','stop_loss','sell','stop_market',
      'open','90','1','0',1,'{}',?,?)`, [trade.intentId, trade.account.id, now - 1000, now]);
  const protection = await getDatabase().get("SELECT * FROM trading_orders WHERE id='unchanged-protection'");
  const changed = structuredClone(rows); changed[1].fee = '0.02'; changed[1].new_balance = '99.98';
  await appendCashlegs(trade, changed);
  await assert.rejects(assertFundingObservationCurrent(trade.account, initial.observation), /stale|unresolved/);
  await projectAccountLogMoney(trade.account); await projectAccountFillAccounting(trade.account.id);
  const event = await getMoneyEvent(trade.eventId);
  assert.equal(event.reportingAmount, '-0.01'); assert.equal(event.valuationStatus, 'unresolved');
  assert.equal((await moneyLedgerSnapshot(trade.account.id, 0, now + 1)).amount, null);
  assert.equal((await observedFundingEvidence(trade.account, now)).observation.status, 'incomplete');
  await assert.rejects(createRiskAdmission({ account: trade.account, intentId: trade.intentId, plan: {}, market: {},
    snapshot: { accounting: {} }, budget: '400', epoch: 'local-fixture' }), error => error.code === 'ACCOUNTING_INCOMPLETE');
  assert.deepEqual(await getDatabase().get("SELECT * FROM trading_orders WHERE id='unchanged-protection'"), protection,
    'The monetary projection/negative Entry gate performs no protection mutation.');
  const proof = JSON.parse((await getDatabase().get('SELECT proof_json FROM trading_kraken_cashleg_evidence WHERE event_id=?', [trade.eventId])).proof_json);
  await assert.rejects(valueKrakenCashlegFee({ eventId: trade.eventId, cashOccurrence: proof.cashOccurrence, positionOccurrence: proof.positionOccurrence }), /contradictory/);
  await closeDb(); await initDb(filename); await projectAccountLogMoney(trade.account);
  assert.equal((await getMoneyEvent(trade.eventId)).valuationStatus, 'unresolved');
  assert.deepEqual(await getDatabase().get('SELECT content_json FROM trading_money_valuations WHERE event_id=?', [trade.eventId]), original);
}

async function legacyAliasAndUtc() {
  const legacy = await cashlegFill(await cashlegAccount('legacy-cashfee', now), { legacyMoneyId: 'preserved-legacy-fee' });
  assert.equal(legacy.eventId, 'preserved-legacy-fee');
  await valueTrade(legacy); await projectAccountFillAccounting(legacy.account.id);
  const retained = await getDatabase().get('SELECT * FROM trading_money_events WHERE id=?', [legacy.eventId]);
  assert.equal(retained.content_json, legacy.original.content_json);
  assert.equal(retained.provider_event_id, 'legacy-envelope-id');
  assert.equal((await getDatabase().get("SELECT COUNT(*) AS n FROM trading_money_events WHERE account_id=? AND kind='fee'", [legacy.account.id])).n, 1);
  const today = Math.floor(now / 86400000) * 86400000;
  const context = await cashlegAccount('utc-cashleg', now);
  await getDatabase().run('UPDATE trading_trade_intents SET created_at=? WHERE id=?', [today - 1000, context.intentId]);
  const entry = await cashlegFill(context, { occurredAt: today - 1, quantity: '2', fee: '0.4' });
  const exit = await cashlegFill(context, { occurredAt: Math.max(today, now - 1000), quantity: '1', price: '105', fee: '-0.2', role: 'take_profit' });
  await appendCashlegs(entry, cashlegRows(entry));
  await appendCashlegs(exit, cashlegRows(exit, { startId: 3, oldPosition: '2', pnl: '5', funding: '-0.1' }));
  await appendCashlegs(context, []); await observedFundingEvidence(context.account, now);
  const daily = await moneyLedgerSnapshot(context.account.id, today, now + 1);
  assert.deepEqual([daily.pricePnl, daily.fees, daily.funding, daily.amount], ['5', '0.2', '-0.1', '5.1']);
  assert.equal((await moneyLedgerSnapshot(context.account.id, today - 86400000, today)).fees, '-0.4');
}

async function changedExecutionUnderSameBooking() {
  const trade = await cashlegFill(await cashlegAccount('booking-conflict', now));
  const rows = cashlegRows(trade); await valueTrade(trade, rows);
  const changed = { ...rows[1], execution: '99999999-9999-4999-8999-999999999999' };
  await appendCashlegs(trade, [changed]); await projectAccountLogMoney(trade.account);
  assert.equal((await getMoneyEvent(trade.eventId)).valuationStatus, 'unresolved');
  assert.equal((await getMoneyEvent(trade.eventId)).reportingAmount, '-0.01');
}

try {
  await initDb(filename);
  await nativeAndRebate(); await partialRealisation(); await crosspageAndGeneration(); await laterContradiction();
  await legacyAliasAndUtc(); await changedExecutionUnderSameBooking();
  assert.equal((await getDatabase().all('PRAGMA foreign_key_check')).length, 0);
  console.log('Kraken cashleg replay: rebates, native units, partial PnL, one funding cashleg, page/restart/overlap/generation and sticky conflicts passed.');
} finally { await closeDb(); await rm(directory, { recursive: true, force: true }); }
