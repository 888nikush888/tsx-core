import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { getTradingAccount, listTradingStrategies } from '../src/trading_repository.js';
import { bindAccountReportingCurrency, recordMoneyEvent } from '../src/trading_money_ledger.js';
import { captureFillAccounting, projectAccountFillAccounting } from '../src/trading_fill_accounting.js';
import { captureFxReceipts } from '../src/trading_fx_repository.js';
import { valueFxAccountMoney } from '../src/trading_fx_valuation.js';
import { provenFillIdentity } from '../src/trading_fill_identity.js';
import { moneyValueFromDecimal, moneyValueFromRational, addMoneyValues } from '../src/trading_money_value.js';
import { journalProjectedMoney, listTradeJournal, tradeJournalCsv } from '../src/trade_journal.js';
import { viewerPositions, viewerTrades, viewerPerformance } from '../src/viewer_projection.js';
import { formatPositions, formatTrades, formatPerformance, formatTelegramViewerEvent } from '../src/telegram_viewer/formatters.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { insertAccountedFill } from './fixtures/accounted_trades.js';
import { nativeFillFixture } from './fixtures/native_fill_identity.js';
import { fxReceipt, FX_CONTEXT, sealFxReceipt } from './fixtures/fx_receipts.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-fx-journal-viewer-'));
const filename = path.join(directory, 'journal.db');
const at = Date.now() - 2000;
const providerSymbol = 'BTC/USDT:USDT';
let strategyId;

async function accountFixture(id = 'fx-journal') {
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

async function intentFixture(account, id, quantity = '1') {
  await saveSignal(id, '-journal-fx', 1, '<signal/>', `<signal>${id}</signal>`);
  await getDatabase().run(`INSERT INTO trading_trade_intents(id,source_signal_id,root_source_signal_id,channel_id,
    strategy_version_id,account_id,exchange,mode,symbol,side,status,signal_json,created_at,updated_at)
    VALUES (?,?,?,'-journal-fx',?,?,?,?,'BTCUSDT','LONG',?,'{}',?,?)`,
  [id, id, id, strategyId, account.id, account.exchange, account.mode, quantity === '0' ? 'completed' : 'monitoring', at, at]);
  await getDatabase().run(`INSERT INTO trading_positions(id,intent_id,account_id,strategy_version_id,channel_id,symbol,
    side,status,quantity,average_entry_price,stop_price,realized_pnl,opened_at,closed_at,updated_at)
    VALUES (?,?,?,?,'-journal-fx','BTCUSDT','LONG',?,?,'100','90','777',?,?,?)`,
  [`position-${id}`, id, account.id, strategyId, quantity === '0' ? 'closed' : 'open', quantity,
    at, quantity === '0' ? at + 100 : null, at + 100]);
}

async function bybitFill(account, intentId, id, { role = 'entry', quantity = '1', price = '100', fee = '0', filledAt = at } = {}) {
  const raw = nativeFillFixture('bybit', { exchangeFillId: `execution-${id}`, exchangeOrderId: `remote-${id}`,
    clientOrderId: `client-${id}`, symbol: 'BTCUSDT', providerSymbol, price, quantity, fee, feeAsset: 'USDT', filledAt });
  raw.accounting = { version: 1, source: 'ccxt-market-v1', providerSymbol, settlementAsset: 'USDT', linear: true, quantityUnit: 'base' };
  const proof = provenFillIdentity(account, raw);
  assert.ok(proof);
  await getDatabase().run(`INSERT INTO trading_orders(id,intent_id,account_id,client_order_id,exchange_order_id,
    provider_symbol,role,side,order_type,status,price,quantity,filled_quantity,reduce_only,request_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,'limit','filled',?,?,?,?,'{}',?,?)`, [`order-${id}`, intentId, account.id, raw.clientOrderId,
    raw.exchangeOrderId, providerSymbol, role, role === 'entry' ? 'buy' : 'sell', price, quantity, quantity,
    role === 'entry' ? 0 : 1, filledAt - 1, filledAt]);
  await getDatabase().run(`INSERT INTO trading_fills(id,order_id,account_id,exchange_fill_id,price,quantity,fee,fee_asset,
    filled_at,raw_json,remote_fill_key,provider_symbol,identity_status,identity_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'proven',?)`, [`fill-${id}`, `order-${id}`, account.id, raw.exchangeFillId,
    price, quantity, fee, 'USDT', filledAt, JSON.stringify(raw.raw), proof.key, providerSymbol, JSON.stringify(proof.identity)]);
  await captureFillAccounting(account, raw, `fill-${id}`);
}

async function positiveFx(account) {
  const id = 'journal-tiny';
  await intentFixture(account, id);
  await bybitFill(account, id, 'tiny', { fee: '0.000000000000000001' });
  await projectAccountFillAccounting(account.id);
  await captureFxReceipts(account, [fxReceipt('usd', at - 100), fxReceipt('usdt', at - 100)],
    { startedAt: at - 200, completedAt: at + 1000 });
  await valueFxAccountMoney(account);
  const [entry] = await listTradeJournal({ intentId: id });
  const tiny = moneyValueFromRational({ numerator: '-1', denominator: '1002500000000000000' });
  assert.deepEqual(entry.position.realizedPnlValue, tiny, 'A fully valued negative rational fee must survive journal projection.');
  assert.equal(entry.position.accountingStatus, 'complete');
  assert.equal(entry.position.realizedPnl, null);
  assert.deepEqual(entry.money.realizedPnlValue, tiny);
  assert.deepEqual(entry.money.signedFees.realizedPnlValue, tiny);
  assert.equal(entry.fees.USDT, '0.000000000000000001', 'Original native fee totals remain unchanged.');
  const { position } = await viewerPositions({ id: `position-${id}` });
  const { trade } = await viewerTrades({ id });
  assert.deepEqual(position.realizedPnlValue, tiny);
  assert.equal(trade.accountingStatus, 'complete');
  assert.equal(trade.fee, null);
  assert.deepEqual(trade.feeValue.exact, { numerator: '1', denominator: '1002500000000000000' });
  for (const text of [formatPositions({ position }), formatTrades({ trade })]) {
    assert.match(text, /-1\/1002500000000000000 USD/);
    assert.match(text, /vollständig/);
    assert.doesNotMatch(text, /^PnL (?:0|ungeklärt)/m);
  }
  const csv = tradeJournalCsv([entry]);
  assert.match(csv, /realized_pnl_value/);
  assert.match(csv, /1002500000000000000/);
  assert.match(csv, /accounting_status/);
  assert.match(csv, /signed_fees_value/);
  assert.deepEqual(JSON.parse(JSON.stringify(entry)).money.realizedPnlValue, tiny);
  const absentLegacyValues = await getDatabase().get(`SELECT COUNT(*) AS count FROM trading_money_valuations valuation
    JOIN trading_money_events event ON event.id=valuation.event_id WHERE event.account_id=?`, [account.id]);
  assert.equal(absentLegacyValues.count, 0, 'The positive reader must use the real FX valuation, not a legacy scalar row.');
  projectionBoundaryAndCsv(entry);
  return id;
}

function projectionBoundaryAndCsv(entry) {
  // Exercise the persisted projection/serialization contract, without authorizing synthetic valuation evidence.
  const bounded = { lower: '-0.000000000000000001', upper: '0.000000000000000001', exact: null,
    decimal: null, precision: 'bounded', terms: 2 };
  const source = { realized_pnl: null, value_json: JSON.stringify(bounded), accounting_status: 'complete', reporting_currency: 'USD' };
  const projected = journalProjectedMoney(source);
  assert.deepEqual(projected.realizedPnlValue, bounded); assert.equal(projected.accountingStatus, 'complete');
  assert.equal(journalProjectedMoney({ ...source, realized_pnl: '0' }).accountingStatus, 'unresolved');
  assert.equal(journalProjectedMoney({ ...source, value_json: '{bad' }).realizedPnlValue, null);
  assert.equal(journalProjectedMoney({ ...source, accounting_status: 'unresolved' }).realizedPnlValue, null);
  const copy = structuredClone(entry);
  Object.assign(copy.money, projected);
  assert.match(tradeJournalCsv([copy]), /bounded/);
  assert.match(tradeJournalCsv([copy]), /-0\.000000000000000001/);
  assert.deepEqual(JSON.parse(JSON.stringify(copy)).money.realizedPnlValue, bounded);
  copy.money.accountingStatus = 'unresolved'; copy.money.realizedPnlValue = null; copy.money.reportingCurrency = null;
  copy.money.valuedSubtotalValuesByCurrency = { USD: bounded, USDT: moneyValueFromDecimal('2') };
  const csv = tradeJournalCsv([copy]);
  assert.match(csv, /unresolved/); assert.match(csv, /USDT/); assert.match(csv, /USD/);
}

async function partialFundingAndNative(account) {
  const id = 'journal-partial';
  await intentFixture(account, id);
  await bybitFill(account, id, 'entry', { quantity: '2', fee: '1' });
  await bybitFill(account, id, 'tp', { role: 'take_profit', price: '120', fee: '-0.25', filledAt: at + 100 });
  await recordMoneyEvent({ accountId: account.id, accountFingerprint: account.externalAccountId, providerEventId: 'journal-funding',
    kind: 'funding', basis: 'provider', source: 'synthetic-local-fixture', occurredAt: at + 100, amount: '-2', asset: 'USDT', intentId: id });
  await projectAccountFillAccounting(account.id);
  await captureFxReceipts(account, [fxReceipt('usd', at - 100), fxReceipt('usdt', at - 100)],
    { startedAt: at - 200, completedAt: at + 1000 });
  await valueFxAccountMoney(account);
  const [entry] = await listTradeJournal({ intentId: id });
  assert.equal(entry.position.status, 'open');
  assert.deepEqual(entry.money.realizedPnlValue.exact, { numerator: '6900', denominator: '401' });
  assert.deepEqual(entry.money.pricePnl.realizedPnlValue.exact, { numerator: '8000', denominator: '401' });
  assert.deepEqual(entry.money.funding.realizedPnlValue.exact, { numerator: '-800', denominator: '401' });
  assert.deepEqual(entry.money.signedFees.realizedPnlValue.exact, { numerator: '-300', denominator: '401' });
  const paper = await getTradingAccount('paper-default');
  await intentFixture(paper, 'journal-native', '0');
  await insertAccountedFill({ intentId: 'journal-native', id: 'journal-native-entry', quantity: '1', price: '100', fee: '1', filledAt: at });
  await insertAccountedFill({ intentId: 'journal-native', id: 'journal-native-exit', role: 'flatten', price: '110', fee: '0.25', filledAt: at + 100 });
  const { trade } = await viewerTrades({ id: 'journal-native' });
  assert.equal(trade.realizedPnl, '8.75'); assert.equal(trade.fee, '1.25');
  assert.equal(trade.realizedPnlValue.decimal, trade.realizedPnl);
  const performance = await viewerPerformance({ days: 1 });
  assert.deepEqual(new Set(performance.groups.map(group => group.reportingCurrency)), new Set(['USD', 'USDT']));
  const text = formatPerformance(performance);
  assert.match(text, /USD/); assert.match(text, /USDT/); assert.match(text, /Funding/); assert.match(text, /Gebühren/);
  const usd = performance.groups.filter(group => group.reportingCurrency === 'USD');
  assert.ok(usd.every(group => group.realizedPnl === null));
  assert.deepEqual(usd.map(group => group.realizedPnlValue).reduce(addMoneyValues), addMoneyValues(entry.money.realizedPnlValue,
    moneyValueFromRational({ numerator: '-1', denominator: '1002500000000000000' })));
}

function boundedMixedAndForgedPresentation() {
  // Presentation-only fixtures: no claim that a forged DTO can authorize ledger valuation.
  const value = { lower: '-0.000000000000000001', upper: '0.000000000000000001', exact: null, decimal: null, precision: 'bounded', terms: 2 };
  const dto = { id: 'bounded', realizedPnl: null, realizedPnlValue: value, reportingCurrency: 'USD', accountingStatus: 'complete' };
  const text = formatTrades({ trade: dto });
  assert.match(text, /konservative Grenzen/); assert.match(text, /vollständig/); assert.doesNotMatch(text, /Breakeven|PnL 0/);
  const mixed = formatPerformance({ groups: [{ ...dto, accountingStatus: 'unresolved', reportingCurrency: null, realizedPnlValue: null,
    valuedSubtotalValuesByCurrency: { USD: value, USDT: moneyValueFromDecimal('2') } }] });
  assert.match(mixed, /ungeklärt/); assert.match(mixed, /bewertete Teilsumme.*USD/); assert.match(mixed, /bewertete Teilsumme.*USDT/);
  assert.match(formatTrades({ trade: { ...dto, realizedPnl: '0' } }), /ungeklärt/, 'Contradictory scalar aliases must not hide bounded money.');
  assert.match(formatTrades({ trade: { realizedPnl: '2', reportingCurrency: 'USD' } }), /PnL 2 USD/, 'Native legacy display stays compatible.');
  const event = { id: 'notice', eventType: 'trade_completed', occurredAt: at, details: dto };
  assert.match(formatTelegramViewerEvent(event, { locale: 'de-DE', timezone: 'UTC' }), /konservative Grenzen/);
  assert.match(formatTelegramViewerEvent({ ...event, details: { reportingCurrency: 'USD', funding: '-1' } },
    { locale: 'de-DE', timezone: 'UTC' }), /reportingCurrency: USD/, 'Unrelated legacy details retain their unit.');
  assert.match(formatTrades({ trade: { ...dto, realizedPnlValue: { ...value, lower: '1' } } }), /ungeklärt/);
  const rational = moneyValueFromRational({ numerator: '1', denominator: '7' });
  const items = Array.from({ length: 100 }, (_, i) => ({ ...dto, id: `trade-${i}-long-identifier`, realizedPnlValue: rational }));
  const long = formatTrades({ trades: items });
  assert.ok(long.length <= 4096); assert.match(long, /Weitere Einträge/);
  assert.ok(long.split('\n').filter(row => row.startsWith('PnL')).every(row => row === 'PnL 1/7 USD (vollständig)'),
    'Message truncation never emits a partial fraction as an apparently complete amount.');
}

async function restartAndConflict(account, id) {
  const before = (await viewerTrades({ id })).trade;
  await closeDb(); await initDb(filename);
  assert.deepEqual((await viewerTrades({ id })).trade, before);
  const conflict = fxReceipt('usd', at - 100);
  conflict.value = '61000'; conflict.envelope.result.list[0].indexPrice = '61000';
  await captureFxReceipts(account, [sealFxReceipt(conflict)], { startedAt: at - 200, completedAt: at + 1000 });
  const [entry] = await listTradeJournal({ intentId: id });
  assert.equal(entry.money.accountingStatus, 'unresolved'); assert.equal(entry.money.realizedPnlValue, null);
  assert.equal((await viewerPositions({ id: `position-${id}` })).position.accountingStatus, 'unresolved');
  const { trade } = await viewerTrades({ id });
  assert.equal(trade.accountingStatus, 'unresolved'); assert.equal(trade.fee, null);
  assert.match(formatTrades({ trade }), /ungeklärt/);
}

try {
  await initDb(filename); await seedTradingFixtures(); strategyId = (await listTradingStrategies())[0].id;
  const account = await accountFixture(), id = await positiveFx(account);
  await partialFundingAndNative(await accountFixture('fx-journal-partial'));
  boundedMixedAndForgedPresentation(); await restartAndConflict(account, id);
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  console.log('FX journal/viewer: original fees, fractions, tiny losses, funding, native aliases, bounded/mixed display and restart/conflict passed.');
} finally {
  await closeDb(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  await rm(directory, { recursive: true, force: true });
}
