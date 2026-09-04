import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { backupDatabase, closeDb, getDatabase, initDb, LATEST_SCHEMA_VERSION } from '../src/db.js';
import { getTradingAccount } from '../src/trading_repository.js';
import { bindAccountReportingCurrency, recordMoneyEvent } from '../src/trading_money_ledger.js';
import { captureFxReceipts, persistFxConversion } from '../src/trading_fx_repository.ts';
import { readFxMoneyValuation, valueFxAccountMoney, valueFxMoneyEvent } from '../src/trading_fx_valuation.ts';
import { failScheduledRecovery, reserveScheduledRecovery } from '../src/trading_recovery_schedule_repository.ts';
import { cashlegAccount, cashlegFill } from './fixtures/kraken_cashleg.js';
import { fxReceipt, FX_CONTEXT } from './fixtures/fx_receipts.js';
import { dropFxMoneySchema } from './fixtures/fx_schema.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-fx-money-migration-'));
const projectionColumns = 'intent_id,account_id,evidence_hash,status,reason,reporting_currency,realized_pnl,updated_at';
const positionColumns = `id,intent_id,account_id,strategy_version_id,channel_id,symbol,side,status,quantity,
  average_entry_price,stop_price,realized_pnl,opened_at,closed_at,updated_at,emergency_requested_at,
  emergency_reason,ledger_realized_pnl,accounting_status,reporting_currency`;
const originalTables = ['trading_accounts', 'trading_trade_intents', 'trading_orders', 'trading_fills',
  'trading_money_events', 'trading_money_valuations', 'trading_money_bindings', 'trading_fx_receipts',
  'trading_fx_conversions', 'trading_fx_conversion_receipts', 'trading_recovery_schedules', 'trading_recovery_schedule_attempts'];
async function originals(database) {
  const result = {};
  for (const table of originalTables) result[table] = await database.all(`SELECT * FROM ${table} ORDER BY rowid`);
  result.projections = await database.all(`SELECT ${projectionColumns} FROM trading_accounting_projections ORDER BY intent_id`);
  result.positions = await database.all(`SELECT ${positionColumns} FROM trading_positions ORDER BY id`);
  result.migrations = await database.all('SELECT * FROM schema_migrations WHERE version<=44 ORDER BY version');
  return result;
}
async function schema(database) {
  return database.all('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name');
}
async function version(expected, database = getDatabase()) {
  assert.equal((await database.get('SELECT MAX(version) n FROM schema_migrations')).n, expected);
  assert.deepEqual(await database.all('PRAGMA foreign_key_check'), []);
}
async function fxAccount(id, at) {
  await getDatabase().run(`INSERT INTO trading_accounts(id,name,exchange,mode,status,enabled,credential_ref,
    external_account_id,credential_generation,capabilities_json,last_verified_at,created_at,updated_at)
    VALUES (?,?,'bybit','testnet','ready',1,'fixture',?,?,?,?,?,?)`, [id, id, createHash('sha256').update(id).digest('hex'),
  'b'.repeat(64), JSON.stringify({ executionProfileHash: FX_CONTEXT.profileHash, profileVersion: 1,
    executionCapabilities: { provider_api_version: 'bybit-v5' } }), at - 2000, at - 3000, at]);
  const account = await getTradingAccount(id);
  await bindAccountReportingCurrency({ accountId: id, accountFingerprint: account.externalAccountId, profile: 'bybit',
    reportingCurrency: 'USD', settlementAssets: ['USDT', 'USDC'], source: 'bybit-wallet-balance-v1', verifiedAt: at });
  await captureFxReceipts(account, [fxReceipt('usd', at), fxReceipt('usdt', at)], { startedAt: at - 20, completedAt: at + 20 });
  return { account, conversion: await persistFxConversion(account, 'USDT', 'USD', at) };
}
function event(account, id, at, asset = 'USDT', intentId = null) {
  return recordMoneyEvent({ accountId: account.id, accountFingerprint: account.externalAccountId,
    providerEventId: id, amount: '-10', asset, occurredAt: at, kind: 'funding', basis: 'provider',
    source: 'synthetic-migration-fixture', intentId });
}
async function schema44(filename) {
  await initDb(filename);
  const trade = await cashlegFill(await cashlegAccount('fx-money-original-fill'), { feeAsset: 'USD' });
  await getDatabase().run(`INSERT INTO trading_positions(id,intent_id,account_id,strategy_version_id,channel_id,
    symbol,side,status,quantity,average_entry_price,stop_price,realized_pnl,updated_at)
    VALUES ('original-position',?,?,?,'-cashleg','BTCUSD','LONG','open','1.000','100.000','90.00','0.000',?)`,
  [trade.intentId, trade.account.id, trade.strategyId, trade.now]);
  const at = Date.now() - 1000, first = await fxAccount('fx-money-a', at), other = await fxAccount('fx-money-b', at);
  const intentId = 'fx-money-intent';
  await getDatabase().run(`INSERT INTO trading_trade_intents(id,source_signal_id,root_source_signal_id,channel_id,
    strategy_version_id,account_id,exchange,mode,symbol,side,status,signal_json,created_at,updated_at)
    VALUES (?,?,?,'-cashleg',?,?,'bybit','testnet','BTCUSDT','LONG','monitoring','{}',?,?)`,
  [intentId, trade.account.id, trade.account.id, trade.strategyId, first.account.id, at - 100, at]);
  const pending = await event(first.account, 'unvalued-before-upgrade', at, 'USDT', intentId);
  const additional = await event(first.account, 'second-unvalued', at);
  const native = await event(first.account, 'original-native', at, 'USD');
  const unavailable = await event(other.account, 'missing-historical-quote', at - 10001);
  const request = await reserveScheduledRecovery(first.account, { since: at - 100, orders: [], history: [] }, at);
  await failScheduledRecovery(first.account, request.recoverySchedule.attemptId, 'transport_unresolved', at + 1);
  await getDatabase().exec(dropFxMoneySchema);
  await version(44);
  const before = await originals(getDatabase());
  for (const table of originalTables) assert.ok(before[table].length > 0, `Preservation requires nonempty ${table}.`);
  assert.equal(before.positions.length, 1); assert.ok(before.projections.length > 0);
  const queued = await getDatabase().all('SELECT * FROM trading_accounting_pending ORDER BY intent_id');
  return { first, other, pending, additional, native, unavailable, intentId, before, queued };
}
async function assertUpgraded(fixture) {
  await version(LATEST_SCHEMA_VERSION);
  assert.deepEqual(await originals(getDatabase()), fixture.before, 'Migration preserves original byte strings, IDs, values, FX references and scheduling evidence.');
  assert.deepEqual(await getDatabase().all('SELECT * FROM trading_accounting_pending ORDER BY intent_id'), fixture.queued);
  assert.deepEqual(await getDatabase().all('SELECT * FROM trading_fx_money_valuations'), []);
  assert.deepEqual(await getDatabase().all('SELECT * FROM trading_fx_valuation_work'), []);
  assert.ok((await getDatabase().all('SELECT value_json FROM trading_accounting_projections')).every(row => row.value_json === null));
  assert.deepEqual(await getDatabase().all('SELECT ledger_realized_value_json FROM trading_positions'), [{ ledger_realized_value_json: null }]);
}
async function insertFx(eventId, accountId, conversionId, template) {
  return getDatabase().run(`INSERT INTO trading_fx_money_valuations
    (event_id,account_id,conversion_id,reporting_currency,payload_json,content_hash,recorded_at) VALUES (?,?,?,?,?,?,?)`,
  [eventId, accountId, conversionId, template.reporting_currency, template.payload_json, template.content_hash, template.recorded_at]);
}
async function constraints(fixture, proof) {
  const template = await getDatabase().get('SELECT * FROM trading_fx_money_valuations WHERE event_id=?', [proof.eventId]);
  await assert.rejects(insertFx(fixture.native.id, fixture.first.account.id, proof.conversionId, template), /already has a decimal valuation/);
  await assert.rejects(getDatabase().run(`INSERT INTO trading_money_valuations
    (event_id,reporting_currency,reporting_amount,rate,source,valued_at,evidence_id,content_json,recorded_at)
    SELECT ?,reporting_currency,reporting_amount,rate,source,valued_at,evidence_id,content_json,recorded_at
      FROM trading_money_valuations WHERE event_id=?`, [proof.eventId, fixture.native.id]), /already has an FX valuation/);
  await assert.rejects(insertFx(fixture.unavailable.id, fixture.first.account.id, proof.conversionId, template), /FOREIGN KEY/);
  await assert.rejects(insertFx(fixture.additional.id, fixture.first.account.id, fixture.other.conversion.id, template), /FOREIGN KEY/);
  await assert.rejects(getDatabase().run(`INSERT INTO trading_fx_valuation_work(event_id,account_id,last_attempt_at)
    VALUES (?,?,0)`, [fixture.additional.id, fixture.other.account.id]), /FOREIGN KEY/);
  await assert.rejects(getDatabase().run(`INSERT INTO trading_fx_valuation_work(event_id,account_id,last_attempt_at)
    VALUES ('missing-original',?,0)`, [fixture.first.account.id]), /FOREIGN KEY/);
  await assert.rejects(getDatabase().run('UPDATE trading_fx_money_valuations SET recorded_at=recorded_at WHERE event_id=?', [proof.eventId]), /immutable/);
  await assert.rejects(getDatabase().run('DELETE FROM trading_fx_money_valuations WHERE event_id=?', [proof.eventId]), /retained/);
  assert.deepEqual(await getDatabase().all('SELECT * FROM trading_fx_money_valuations'), [template]);
  await version(LATEST_SCHEMA_VERSION);
}
async function moneyState() {
  return { valuations: await getDatabase().all('SELECT * FROM trading_fx_money_valuations ORDER BY event_id'),
    work: await getDatabase().all('SELECT * FROM trading_fx_valuation_work ORDER BY event_id'),
    pending: await getDatabase().all('SELECT * FROM trading_accounting_pending ORDER BY intent_id'),
    projections: await getDatabase().all('SELECT * FROM trading_accounting_projections ORDER BY intent_id'),
    positions: await getDatabase().all('SELECT * FROM trading_positions ORDER BY id') };
}
async function upgradeAndBackup() {
  const filename = path.join(directory, 'upgrade.db'), fixture = await schema44(filename);
  const oldBackup = path.join(directory, 'schema44-backup.db'); await backupDatabase(oldBackup);
  await closeDb(); await initDb(filename); await assertUpgraded(fixture);
  const priorRevision = fixture.queued.find(row => row.intent_id === fixture.intentId)?.revision ?? 0;
  const proof = await valueFxMoneyEvent(fixture.first.account, fixture.pending.id);
  assert.deepEqual(proof.value.exact, { numerator: '-4000', denominator: '401' });
  assert.equal((await getDatabase().get('SELECT revision FROM trading_accounting_pending WHERE intent_id=?', [fixture.intentId])).revision, priorRevision + 1);
  assert.deepEqual(await valueFxAccountMoney(fixture.other.account, 1), { processed: 1, unresolved: 1 });
  await constraints(fixture, proof);
  assert.deepEqual(await originals(getDatabase()), fixture.before, 'New valuation and pending work do not rewrite pre-M45 originals.');
  const saved = await moneyState(), snapshot = path.join(directory, 'current-schema-backup.db');
  assert.equal(saved.work[0].event_id, fixture.unavailable.id); assert.ok(saved.work[0].reason);
  await backupDatabase(snapshot); await closeDb(); await initDb(snapshot);
  assert.deepEqual(await moneyState(), saved);
  assert.deepEqual(await readFxMoneyValuation(proof.eventId), proof);
  assert.deepEqual(await originals(getDatabase()), fixture.before);
  await constraints(fixture, proof);
  await closeDb(); await initDb(oldBackup); await assertUpgraded(fixture);
  await closeDb(); await initDb(oldBackup); await assertUpgraded(fixture); await closeDb();
}
async function rollback(kind, obstruction, remove) {
  const filename = path.join(directory, `rollback-${kind}.db`), fixture = await schema44(filename);
  await getDatabase().exec(obstruction); const beforeSchema = await schema(getDatabase());
  await closeDb(); await assert.rejects(initDb(filename), error => /migration 45/.test(error.message) && /already exists/.test(error.cause?.message));
  await closeDb();
  // Only this closed temporary failure fixture uses a direct SQLite handle.
  const database = await open({ filename, driver: sqlite3.Database });
  try {
    await version(44, database);
    assert.deepEqual(await originals(database), fixture.before);
    assert.deepEqual(await schema(database), beforeSchema, 'Rollback includes both added columns, indexes, tables and all cross-table triggers.');
    if (kind === 'table') assert.deepEqual(await database.all('SELECT * FROM trading_fx_money_valuations'), [{ original_marker: 'preserve-original' }]);
    await database.exec(remove); // Precisely the obstruction created above, never user data.
  } finally { await database.close(); }
  await initDb(filename); await assertUpgraded(fixture); await closeDb();
}

try {
  await upgradeAndBackup();
  await rollback('table', `CREATE TABLE trading_fx_money_valuations(original_marker TEXT);
    INSERT INTO trading_fx_money_valuations VALUES ('preserve-original');`, 'DROP TABLE trading_fx_money_valuations');
  await rollback('last-index', 'CREATE INDEX idx_fx_valuation_work_due ON trading_accounts(created_at)', 'DROP INDEX idx_fx_valuation_work_due');
  console.log('Migration45: schema44 originals/null additions, exact FX/native exclusivity, account FKs, projection pending, backup restore and complete DDL rollback passed.');
} finally {
  await closeDb(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  assert.match(path.basename(directory), /^tsx-fx-money-migration-/);
  await rm(directory, { recursive: true, force: true });
}
