import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { listTradingStrategies } from '../src/trading_repository.js';
import { projectAccountFillAccounting } from '../src/trading_fill_accounting.js';
import { moneyLedgerSnapshot, recordMoneyEvent } from '../src/trading_money_ledger.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { insertAccountedFill } from './fixtures/accounted_trades.js';
import { dropFxSchema } from './fixtures/fx_schema.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-money-migration-'));
const filename = path.join(directory, 'legacy.db');
const now = Date.UTC(2026, 8, 2);
async function legacyIntent(id, strategyId) {
  await saveSignal(id, '-legacy-money', 1, '<signal/>', `<signal>${id}</signal>`);
  await getDatabase().run(`INSERT INTO trading_trade_intents (id, source_signal_id, root_source_signal_id, channel_id,
    strategy_version_id, account_id, exchange, mode, symbol, side, status, signal_json, created_at, updated_at)
    VALUES (?, ?, ?, '-legacy-money', ?, 'paper-default', 'paper', 'paper', 'BTCUSDT', 'LONG', 'monitoring', '{}', ?, ?)`,
  [id, id, id, strategyId, now, now]);
}
async function originalPaperEvidence(id) {
  await getDatabase().run(`INSERT INTO trading_paper_orders (exchange_order_id, account_id, client_order_id, symbol,
    role, side, order_type, status, quantity, filled_quantity, average_price, price, reduce_only, leverage, created_at, updated_at)
    SELECT exchange_order_id, account_id, client_order_id, provider_symbol, role, side, order_type, status,
      quantity, filled_quantity, price, price, reduce_only, 1, created_at, updated_at FROM trading_orders WHERE id = ?`, [`order-${id}`]);
  await getDatabase().run(`INSERT INTO trading_paper_fills (exchange_fill_id, exchange_order_id, account_id, client_order_id,
    price, quantity, fee, fee_asset, filled_at, raw_json)
    SELECT fills.exchange_fill_id, orders.exchange_order_id, fills.account_id, orders.client_order_id,
      fills.price, fills.quantity, fills.fee, fills.fee_asset, fills.filled_at, '{}' FROM trading_fills fills
    JOIN trading_orders orders ON orders.id = fills.order_id WHERE fills.id = ?`, [`fill-${id}`]);
}
try {
  await initDb(filename);
  await seedTradingFixtures();
  const [strategy] = await listTradingStrategies();
  for (const id of ['rebate', 'missing-asset', 'unproven']) {
    await legacyIntent(id, strategy.id);
    await insertAccountedFill({ intentId: id, id, price: '100', fee: id === 'rebate' ? '-0.25' : '0.1',
      feeAsset: id === 'missing-asset' ? null : 'USDT', filledAt: now, legacy: true });
    if (id !== 'unproven') await originalPaperEvidence(id);
  }
  await getDatabase().run(`INSERT INTO trading_positions (id, intent_id, account_id, strategy_version_id, channel_id, symbol,
    side, status, quantity, average_entry_price, stop_price, realized_pnl, opened_at, updated_at)
    VALUES ('legacy-rebate-position', 'rebate', 'paper-default', ?, '-legacy-money', 'BTCUSDT', 'LONG', 'open', '1', '100', '90', '999', ?, ?)`,
  [strategy.id, now, now]);
  await recordMoneyEvent({ accountId: 'paper-default', accountFingerprint: 'paper:paper-default', providerEventId: 'existing-funding',
    kind: 'funding', source: 'paper-funding-v1', basis: 'provider', occurredAt: now, amount: '-0.5', asset: 'USDT' });
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
    DROP TRIGGER trading_accounting_fill_insert; DROP TRIGGER trading_accounting_fill_update;
    DROP TRIGGER trading_accounting_order_update; DROP TRIGGER trading_accounting_position_insert;
    DROP TRIGGER trading_accounting_binding_insert; DROP TRIGGER trading_accounting_valuation_insert;
    DROP TRIGGER trading_accounting_conflict_insert;
    DROP TABLE trading_accounting_projection_evidence; DROP TABLE trading_accounting_projections; DROP TABLE trading_accounting_pending;
    DROP INDEX idx_money_events_intent;
    ALTER TABLE trading_fills DROP COLUMN account_fingerprint; ALTER TABLE trading_fills DROP COLUMN accounting_json;
    ALTER TABLE trading_fills DROP COLUMN accounting_conflict;
    ALTER TABLE trading_positions DROP COLUMN ledger_realized_pnl; ALTER TABLE trading_positions DROP COLUMN accounting_status;
    ALTER TABLE trading_positions DROP COLUMN reporting_currency;
    DELETE FROM schema_migrations WHERE version >= 36;
  `);
  await closeDb();
  await initDb(filename);
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS n FROM trading_accounting_pending')).n, 3);
  assert.deepEqual(await projectAccountFillAccounting('paper-default', 1), { processed: 1, pending: 2 });
  assert.equal((await moneyLedgerSnapshot('paper-default', 0, now + 1)).amount, null, 'A bounded unfinished backfill is never complete.');
  await projectAccountFillAccounting('paper-default');
  const projections = await getDatabase().all('SELECT intent_id, status FROM trading_accounting_projections ORDER BY intent_id');
  assert.deepEqual(projections, [{ intent_id: 'missing-asset', status: 'unresolved' }, { intent_id: 'rebate', status: 'complete' },
    { intent_id: 'unproven', status: 'unresolved' }]);
  assert.equal((await getDatabase().get("SELECT amount FROM trading_money_events WHERE provider_event_id = 'remote-fill-rebate'")).amount, '0.25');
  assert.equal((await getDatabase().get(`SELECT json_extract(evidence_json, '$.source.position.realized_pnl') AS original
    FROM trading_accounting_projection_evidence WHERE intent_id = 'rebate' ORDER BY created_at LIMIT 1`)).original, '999',
  'The obsolete position total is preserved in immutable provenance, never silently discarded when ledger values replace it.');
  assert.equal((await getDatabase().get("SELECT COUNT(*) AS n FROM trading_money_events WHERE kind = 'funding'")).n, 1);
  assert.equal((await getDatabase().get("SELECT account_fingerprint FROM trading_fills WHERE id = 'fill-unproven'")).account_fingerprint, null);
  assert.equal((await getDatabase().get("SELECT fee_asset FROM trading_fills WHERE id = 'fill-missing-asset'")).fee_asset, null);
  const counts = await getDatabase().get('SELECT (SELECT COUNT(*) FROM trading_money_events) AS events, (SELECT COUNT(*) FROM trading_fills) AS fills');
  await closeDb();
  await initDb(filename);
  assert.deepEqual(await projectAccountFillAccounting('paper-default'), { processed: 0, pending: 0 });
  assert.deepEqual(await getDatabase().get('SELECT (SELECT COUNT(*) FROM trading_money_events) AS events, (SELECT COUNT(*) FROM trading_fills) AS fills'), counts);
  for (let index = 0; index < 105; index += 1) {
    await legacyIntent(`queued-${index}`, strategy.id);
    await getDatabase().run("INSERT INTO trading_accounting_pending (intent_id, account_id) VALUES (?, 'paper-default')", [`queued-${index}`]);
  }
  assert.deepEqual(await projectAccountFillAccounting('paper-default'), { processed: 100, pending: 5 });
  await closeDb();
  await initDb(filename);
  assert.deepEqual(await projectAccountFillAccounting('paper-default'), { processed: 5, pending: 0 });
  assert.equal((await getDatabase().all('PRAGMA foreign_key_check')).length, 0);
  console.log('Migration36: proven legacy rebate, missing asset, unverifiable original, funding preservation and bounded restart passed.');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
