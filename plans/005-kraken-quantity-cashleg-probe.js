// Analysis-only local controls. No metadata is fabricated into original rows.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDatabase } from '../src/db.js';
import { projectAccountLogMoney } from '../src/trading_account_log_money.js';
import { getMoneyEvent, valueKrakenCashlegFee } from '../src/trading_money_ledger.js';
import { cashlegAccount, cashlegFill, cashlegRows, appendCashlegs } from '../tests/fixtures/kraken_cashleg.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-quantity-original-probe-'));
const filename = path.join(directory, 'test.db');
const preserved = [];

async function sample(id, inputQuantity, outputQuantity) {
  const account = await cashlegAccount(id);
  const trade = await cashlegFill(account, { quantity: outputQuantity, rawPatch: { amount: inputQuantity } });
  const rows = cashlegRows(trade);
  // Hypothesis under examination: native log delta is in the execution's native units.
  // This synthetic shape is not proof that Kraken lists such a non-1 instrument.
  rows[0].new_balance = inputQuantity;
  const receiptId = await appendCashlegs(account, rows);
  const originals = await getDatabase().get('SELECT raw_json,accounting_json,quantity FROM trading_fills WHERE id=?', [trade.fillId]);
  return { trade, receiptId, originals };
}

try {
  await initDb(filename);
  const unit = await sample('quantity-unit-control', '1', '1');
  await projectAccountLogMoney(unit.trade.account);
  assert.equal((await getMoneyEvent(unit.trade.eventId)).reportingAmount, '-0.01');
  for (const [id, input, output] of [['quarter', '4', '1'], ['large', '4', '10']]) {
    const item = await sample(`quantity-${id}`, input, output);
    const request = { eventId: item.trade.eventId, cashOccurrence: { receiptId: item.receiptId, ordinal: 1 },
      positionOccurrence: { receiptId: item.receiptId, ordinal: 0 } };
    await assert.rejects(valueKrakenCashlegFee(request), error =>
      error.message === 'kraken_cashleg:contract_quantity_unit_unproven' && error.conflict === false);
    await projectAccountLogMoney(item.trade.account);
    const event = await getMoneyEvent(item.trade.eventId);
    assert.equal(event.valuationStatus, 'unresolved');
    assert.equal(event.reportingAmount, null);
    assert.equal((await getDatabase().get('SELECT COUNT(*) AS n FROM trading_money_conflicts WHERE event_id=?', [item.trade.eventId])).n, 0);
    assert.deepEqual(await getDatabase().get('SELECT raw_json,accounting_json,quantity FROM trading_fills WHERE id=?', [item.trade.fillId]), item.originals);
    preserved.push(item);
  }
  await closeDb(); await initDb(filename);
  for (const item of preserved) {
    assert.equal((await getMoneyEvent(item.trade.eventId)).reportingAmount, null);
    assert.deepEqual(await getDatabase().get('SELECT raw_json,accounting_json,quantity FROM trading_fills WHERE id=?', [item.trade.fillId]), item.originals);
    assert.equal((await getDatabase().get('SELECT content_json FROM trading_money_events WHERE id=?', [item.trade.eventId])).content_json,
      item.trade.original.content_json);
  }
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  console.log('Quantity provenance controls: unit-1 native valuation, two non-1 unresolved cases, no false conflict, originals/restart/FKs passed.');
} finally {
  await closeDb();
  // Only the exact newly created temporary directory is removed.
  assert.equal(path.dirname(directory), os.tmpdir());
  assert.ok(path.basename(directory).startsWith('tsx-quantity-original-probe-'));
  await rm(directory, { recursive: true, force: true });
}
