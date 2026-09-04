import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { getTradingAccount, listTradingStrategies, listTradingActivity } from '../src/trading_repository.js';
import { captureFillAccounting, intentMoneyTotals, projectAccountFillAccounting } from '../src/trading_fill_accounting.ts';
import { bindAccountReportingCurrency, moneyEventsForIntent } from '../src/trading_money_ledger.js';
import { captureFxReceipts } from '../src/trading_fx_repository.ts';
import { valueFxAccountMoney } from '../src/trading_fx_valuation.ts';
import { provenFillIdentity } from '../src/trading_fill_identity.ts';
import { seedTradingFixtures } from './trading_fixtures.js';
import { insertAccountedFill } from './fixtures/accounted_trades.js';
import { nativeFillFixture } from './fixtures/native_fill_identity.js';
import { fxReceipt, sealFxReceipt, FX_CONTEXT } from './fixtures/fx_receipts.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-fx-fill-accounting-'));
const filename = path.join(directory, 'accounting.db');
const at = Date.now() - 2000;
const providerSymbol = 'BTC/USDT:USDT';
const read = { startedAt: at - 200, completedAt: at + 1000 };
let strategyId;

async function bybitAccount(id) {
  await getDatabase().run(`INSERT INTO trading_accounts(id,name,exchange,mode,status,enabled,credential_ref,
    external_account_id,credential_generation,capabilities_json,last_verified_at,created_at,updated_at)
    VALUES (?,?,'bybit','testnet','ready',1,'fixture-only',?,?,?,?,?,?)`, [id, id,
  createHash('sha256').update(id).digest('hex'), 'c'.repeat(64), JSON.stringify({ profileVersion: 1,
    executionProfileHash: FX_CONTEXT.profileHash, executionCapabilities: { provider_api_version: 'bybit-v5' } }), at - 1000, at - 1000, at]);
  const account = await getTradingAccount(id);
  await bindAccountReportingCurrency({ accountId: id, accountFingerprint: account.externalAccountId, profile: 'bybit',
    reportingCurrency: 'USD', settlementAssets: ['USDT', 'USDC'], source: 'bybit-wallet-balance-v1', verifiedAt: at });
  return account;
}

async function intent(account, id) {
  await saveSignal(id, '-fx-accounting', 1, '<signal/>', `<signal>${id}</signal>`);
  await getDatabase().run(`INSERT INTO trading_trade_intents(id,source_signal_id,root_source_signal_id,channel_id,
    strategy_version_id,account_id,exchange,mode,symbol,side,status,signal_json,created_at,updated_at)
    VALUES (?,?,?,'-fx-accounting',?,?,?,?,'BTCUSDT','LONG','monitoring','{}',?,?)`,
  [id, id, id, strategyId, account.id, account.exchange, account.mode, at, at]);
}

async function position(account, intentId, quantity = '1') {
  await getDatabase().run(`INSERT INTO trading_positions(id,intent_id,account_id,strategy_version_id,channel_id,symbol,
    side,status,quantity,average_entry_price,stop_price,realized_pnl,opened_at,closed_at,updated_at)
    VALUES (?,?,?,?,'-fx-accounting','BTCUSDT','LONG',?,?,'100','90','777',?,?,?)`,
  [`position-${intentId}`, intentId, account.id, strategyId, quantity === '0' ? 'closed' : 'open', quantity,
    at, quantity === '0' ? at + 100 : null, at + 100]);
}

async function fill(account, intentId, id, options = {}) {
  const role = options.role ?? 'entry', quantity = options.quantity ?? '1', price = options.price ?? '100';
  const raw = nativeFillFixture('bybit', { exchangeFillId: `execution-${id}`, exchangeOrderId: `remote-${id}`,
    clientOrderId: `client-${id}`, symbol: 'BTCUSDT', providerSymbol, price, quantity, fee: options.fee ?? '0',
    feeAsset: 'USDT', filledAt: options.filledAt ?? at });
  raw.accounting = { version: 1, source: 'ccxt-market-v1', providerSymbol, settlementAsset: 'USDT', linear: true, quantityUnit: 'base' };
  const proof = provenFillIdentity(account, raw);
  assert.ok(proof, 'Synthetic native originals must pass the actual native fill identity contract.');
  await getDatabase().run(`INSERT INTO trading_orders(id,intent_id,account_id,client_order_id,exchange_order_id,
    provider_symbol,role,side,order_type,status,price,quantity,filled_quantity,reduce_only,request_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,'limit','filled',?,?,?,?,'{}',?,?)`, [`order-${id}`, intentId, account.id, raw.clientOrderId,
    raw.exchangeOrderId, providerSymbol, role, role === 'entry' ? 'buy' : 'sell', price, quantity, quantity,
    role === 'entry' ? 0 : 1, raw.filledAt - 1, raw.filledAt]);
  await getDatabase().run(`INSERT INTO trading_fills(id,order_id,account_id,exchange_fill_id,price,quantity,fee,fee_asset,
    filled_at,raw_json,remote_fill_key,provider_symbol,identity_status,identity_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'proven',?)`, [`fill-${id}`, `order-${id}`, account.id, raw.exchangeFillId,
    price, quantity, raw.fee, raw.feeAsset, raw.filledAt, JSON.stringify(raw.raw), proof.key, providerSymbol, JSON.stringify(proof.identity)]);
  await captureFillAccounting(account, raw, `fill-${id}`);
}

const projection = intentId => getDatabase().get('SELECT * FROM trading_accounting_projections WHERE intent_id=?', [intentId]);
const positionRow = intentId => getDatabase().get('SELECT * FROM trading_positions WHERE intent_id=?', [intentId]);
const pending = intentId => getDatabase().get('SELECT * FROM trading_accounting_pending WHERE intent_id=?', [intentId]);
const quotes = () => [fxReceipt('usd', at - 100), fxReceipt('usdt', at - 100)];
async function replay(account, intentId) {
  // Emulate durable consumer work surviving an interrupted previous pass, without changing originals.
  await getDatabase().run(`INSERT INTO trading_accounting_pending(intent_id,account_id) VALUES (?,?)
    ON CONFLICT(intent_id) DO UPDATE SET revision=revision+1`, [intentId, account.id]);
  await projectAccountFillAccounting(account.id);
}
async function originals(account) {
  return { events: await getDatabase().all('SELECT * FROM trading_money_events WHERE account_id=? ORDER BY id', [account.id]),
    valuations: await getDatabase().all('SELECT * FROM trading_fx_money_valuations WHERE account_id=? ORDER BY event_id', [account.id]) };
}

async function testLaterFxRepairsPartialProjection() {
  const account = await bybitAccount('fx-partial'), id = 'fx-partial-intent';
  await intent(account, id);
  await fill(account, id, 'partial-entry', { quantity: '2', fee: '1' });
  await fill(account, id, 'partial-tp', { role: 'take_profit', price: '120', fee: '-0.25', filledAt: at + 100 });
  await position(account, id);
  await projectAccountFillAccounting(account.id);
  const prior = await projection(id), priorTotals = await intentMoneyTotals(id);
  assert.equal(prior.status, 'unresolved');
  assert.equal(prior.value_json, null);
  assert.equal(priorTotals.eventCount, 3);
  const events = await moneyEventsForIntent(id);
  assert.deepEqual(events.map(event => [event.kind, event.amount]).sort(), [
    ['fee', '-1'], ['fee', '0.25'], ['realized_price_pnl', '20'],
  ].sort());
  await captureFxReceipts(account, quotes(), read);
  assert.deepEqual(await valueFxAccountMoney(account), { processed: 3, unresolved: 0 });
  assert.ok(await pending(id), 'Actual FX valuation insertion must enqueue the existing projection.');
  await projectAccountFillAccounting(account.id);
  const current = await projection(id), totals = await intentMoneyTotals(id), positionValue = await positionRow(id);
  assert.equal(current.status, 'complete');
  assert.equal(priorTotals.value, null);
  assert.equal(current.realized_pnl, null);
  assert.equal(totals.amount, null);
  assert.equal(totals.currency, 'USD');
  assert.deepEqual(totals.value.exact, { numerator: '7700', denominator: '401' });
  assert.equal(totals.value.precision, 'exact_rational');
  assert.deepEqual(JSON.parse(current.value_json), totals.value);
  assert.deepEqual(JSON.parse(positionValue.ledger_realized_value_json), totals.value);
  assert.equal(positionValue.ledger_realized_pnl, null);
  assert.equal(positionValue.realized_pnl, '777', 'An unavailable exact scalar must not overwrite legacy audit data.');
  assert.equal(positionValue.accounting_status, 'complete');
  const activity = (await listTradingActivity()).positions.find(row => row.intentId === id);
  assert.equal(activity.realizedPnl, null);
  assert.deepEqual(activity.realizedPnlValue, totals.value);
  assert.equal(activity.accountingStatus, 'complete');
  assert.equal(Object.hasOwn(activity, 'realizedPnlValueJson'), false);
  assert.notEqual(current.evidence_hash, prior.evidence_hash);
  assert.notEqual(totals.valuationHash, priorTotals.valuationHash);
  const storedEvidence = await getDatabase().all('SELECT evidence_json FROM trading_accounting_projection_evidence WHERE intent_id=?', [id]);
  const evidence = storedEvidence.map(row => JSON.parse(row.evidence_json)).find(row => row.valuation?.totals?.valuationHash === totals.valuationHash);
  assert.ok(evidence);
  assert.equal(evidence.source.position.realized_pnl, '777', 'The original compatibility total remains immutable audit provenance.');
  assert.equal(evidence.source.compatibilityTotalBasis, 'first_retained_position_snapshot');
  assert.deepEqual(evidence.valuation.events.map(event => event.valuationEvidenceId), (await moneyEventsForIntent(id)).map(event => event.valuationEvidenceId));
  assert.ok(evidence.valuation.events.every(event => /^[a-f0-9]{64}$/.test(event.valuationEvidenceId)));
  assert.equal(totals.valuationHash, createHash('sha256').update(JSON.stringify({ version: 1, intentId: id,
    events: evidence.valuation.events })).digest('hex'));
  assert.equal(current.evidence_hash, createHash('sha256').update(JSON.stringify(evidence)).digest('hex'));
  assert.deepEqual(evidence.projection.value, totals.value);
  return { account, id, totals, current };
}

async function testTinyNegativeAndExactCancellation() {
  const account = await bybitAccount('fx-tiny'), tinyId = 'fx-tiny-intent', cancelId = 'fx-cancel-intent';
  await intent(account, tinyId);
  await fill(account, tinyId, 'tiny', { fee: '0.000000000000000001' });
  await position(account, tinyId);
  await intent(account, cancelId);
  await fill(account, cancelId, 'cancel-entry', { fee: '1' });
  await fill(account, cancelId, 'cancel-exit', { role: 'flatten', fee: '-1', filledAt: at + 100 });
  await position(account, cancelId, '0');
  await projectAccountFillAccounting(account.id);
  await captureFxReceipts(account, quotes(), read);
  await valueFxAccountMoney(account);
  await projectAccountFillAccounting(account.id);
  const tiny = await intentMoneyTotals(tinyId);
  assert.deepEqual(tiny.value.exact, { numerator: '-1', denominator: '1002500000000000000' });
  assert.equal(tiny.value.lower, '-0.000000000000000001');
  assert.equal(tiny.value.upper, '0');
  assert.equal(tiny.amount, null);
  assert.equal((await projection(tinyId)).status, 'complete');
  const cancelled = await intentMoneyTotals(cancelId);
  assert.equal(cancelled.amount, '0');
  assert.deepEqual(cancelled.value.exact, { numerator: '0', denominator: '1' });
  assert.equal(cancelled.value.terms, 3);
  assert.equal((await projection(cancelId)).realized_pnl, '0');
  assert.equal((await positionRow(cancelId)).ledger_realized_pnl, '0');
}

async function testNativeParityAndFirstReplayHash() {
  const account = await getTradingAccount('paper-default'), id = 'fx-native-intent';
  await intent(account, id);
  await insertAccountedFill({ intentId: id, id: 'fx-native-entry', quantity: '2', price: '100', fee: '1', filledAt: at });
  await insertAccountedFill({ intentId: id, id: 'fx-native-tp', role: 'take_profit', price: '120', fee: '-0.25', filledAt: at + 100 });
  await position(account, id);
  await projectAccountFillAccounting(account.id);
  const before = await projection(id), totals = await intentMoneyTotals(id);
  assert.equal(totals.amount, '19.25');
  assert.equal(totals.currency, 'USDT');
  assert.deepEqual(totals.value.exact, { numerator: '77', denominator: '4' });
  assert.equal((await positionRow(id)).realized_pnl, '19.25');
  const native = await getDatabase().all('SELECT * FROM trading_money_valuations ORDER BY event_id');
  await replay(account, id);
  assert.equal((await projection(id)).evidence_hash, before.evidence_hash,
    'The newly written compatibility scalar must not change its own economic source hash.');
  assert.deepEqual(await getDatabase().all('SELECT * FROM trading_money_valuations ORDER BY event_id'), native);
}

async function testRestartReplayAndLaterConflict(partial) {
  const { account, id, current, totals } = partial;
  const preserved = await originals(account);
  await closeDb(); await initDb(filename);
  await replay(account, id);
  assert.deepEqual(await originals(account), preserved);
  assert.deepEqual(await intentMoneyTotals(id), totals);
  assert.equal((await projection(id)).evidence_hash, current.evidence_hash);
  await captureFxReceipts(account, [fxReceipt('usd', at + 200)], read);
  assert.equal(await pending(id), undefined, 'A later quote never reprices or invalidates the pinned historical observation.');
  assert.equal((await projection(id)).evidence_hash, current.evidence_hash);
  const conflicting = quotes()[0];
  conflicting.value = '61000'; conflicting.envelope.result.list[0].indexPrice = '61000';
  await captureFxReceipts(account, [sealFxReceipt(conflicting)], read);
  assert.ok(await pending(id), 'Actual contradictory originals must enqueue their affected projection.');
  assert.equal((await listTradingActivity()).positions.find(row => row.intentId === id).accountingStatus, 'unresolved',
    'The dashboard cannot present a stale completed projection while an actual quote conflict is pending.');
  assert.equal((await intentMoneyTotals(id)).value, null);
  await projectAccountFillAccounting(account.id);
  const failed = await projection(id), positionValue = await positionRow(id);
  assert.equal(failed.status, 'unresolved');
  assert.equal(failed.value_json, null);
  assert.equal(failed.realized_pnl, null);
  assert.equal(positionValue.ledger_realized_value_json, null);
  assert.equal(positionValue.ledger_realized_pnl, null);
  assert.notEqual(failed.evidence_hash, current.evidence_hash);
  assert.deepEqual(await originals(account), preserved, 'Conflicts invalidate use without deleting or repricing originals.');
}

try {
  await initDb(filename); await seedTradingFixtures();
  strategyId = (await listTradingStrategies())[0].id;
  const partial = await testLaterFxRepairsPartialProjection();
  await testTinyNegativeAndExactCancellation();
  await testNativeParityAndFirstReplayHash();
  await testRestartReplayAndLaterConflict(partial);
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  console.log('FX fill/partial-PnL projections: exact fractions, tiny costs, cancellation, provenance hashes, native parity and conflict replay passed.');
} finally {
  await closeDb(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  await rm(directory, { recursive: true, force: true });
}
