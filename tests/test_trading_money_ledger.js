import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { listTradingStrategies } from '../src/trading_repository.js';
import * as decimals from '../src/trading_decimal.js';

assert.equal(typeof decimals.negateSignedDecimal, 'function', 'A fee rebate needs signed negation, not a second minus prefix.');
assert.equal(decimals.negateSignedDecimal('-0.002500'), '0.0025');
assert.equal(decimals.negateSignedDecimal('0.002500'), '-0.0025');
assert.equal(decimals.negateSignedDecimal('-0'), '0');
assert.equal(decimals.subtractSignedDecimal('-2', '-3.000000000000000001'), '1.000000000000000001');
assert.equal(decimals.multiplySignedDecimal('-2', '-0.123456789123456789'), '0.246913578246913578');

const ledger = await import('../src/trading_money_ledger.js');
const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-money-ledger-'));
const databasePath = path.join(directory, 'test.db');
const eventTime = Date.UTC(2026, 8, 2, 1);
try {
  await initDb(databasePath);
  await getDatabase().run(`INSERT INTO trading_accounts
    (id, name, exchange, mode, status, enabled, created_at, updated_at)
    VALUES ('paper', 'Ledger fixture', 'paper', 'paper', 'ready', 1, ?, ?)`, [eventTime, eventTime]);
  await seedTradingFixtures();
  const [strategy] = await listTradingStrategies();
  await saveSignal('ledger-signal', '-ledger', 1, '<signal/>', '<signal/>');
  await getDatabase().run(`INSERT INTO trading_trade_intents(id,source_signal_id,root_source_signal_id,channel_id,strategy_version_id,
    account_id,exchange,mode,symbol,side,status,signal_json,created_at,updated_at)
    VALUES('ledger-intent','ledger-signal','ledger-signal','-ledger',?,'paper','paper','paper','BTCUSDT','LONG','monitoring','{}',1,1)`, [strategy.id]);
  await getDatabase().run(`INSERT INTO trading_orders(id,intent_id,account_id,client_order_id,role,side,order_type,status,quantity,
    filled_quantity,reduce_only,request_json,created_at,updated_at) VALUES('ledger-order','ledger-intent','paper','ledger-client',
    'entry','buy','limit','filled','10','10',0,'{}',1,1)`);
  for (const fillId of ['fill-1', 'fill-2', 'fill-3', 'foreign-fee', 'stable-fee', 'missing-asset', 'tiny-foreign-fee']) {
    await getDatabase().run(`INSERT INTO trading_fills(id,order_id,account_id,exchange_fill_id,price,quantity,fee,fee_asset,filled_at,
      raw_json,account_fingerprint) VALUES(?,'ledger-order','paper',?,'1','1','0','USDT',?,'{}','paper:paper')`, [fillId, fillId, eventTime]);
  }
  const binding = { accountId: 'paper', accountFingerprint: 'paper:paper', profile: 'paper',
    reportingCurrency: 'USDT', settlementAssets: ['USDT'], source: 'paper-contract-v1', verifiedAt: eventTime };
  await ledger.bindAccountReportingCurrency(binding);
  await ledger.bindAccountReportingCurrency(binding);
  // This isolated ledger unit fixture supplies immutable fills directly; accounting projection has separate integration tests.
  await getDatabase().run("DELETE FROM trading_accounting_pending WHERE account_id='paper'");
  await assert.rejects(ledger.bindAccountReportingCurrency({ ...binding, reportingCurrency: 'USDC', settlementAssets: ['USDC'] }), /conflict/i);
  const event = (providerEventId, amount, asset, kind = 'fee') => ({
    accountId: 'paper', accountFingerprint: 'paper:paper', providerEventId, kind,
    occurredAt: eventTime, amount, asset, source: 'paper-fills-v1', basis: kind === 'funding' ? 'provider' : 'fill',
    ...(kind === 'funding' ? {} : { fillId: providerEventId }),
  });
  const cost = await ledger.recordFeeEvent({ ...event('fill-1', '1.1', 'USDT'), fee: '1.1' });
  await assert.rejects(ledger.recordFeeEvent({ ...event('fill-1', '1.1', 'USDT'), fillId: null, fee: '1.1' }), /persisted fill identity/i);
  assert.equal(cost.amount, '-1.1');
  assert.equal(cost.reportingAmount, '-1.1');
  const rebate = await ledger.recordFeeEvent({ ...event('fill-2', '-0.025', 'USDT'), fee: '-0.025' });
  assert.equal(rebate.reportingAmount, '0.025');
  assert.equal((await ledger.recordFeeEvent({ ...event('fill-3', '-0', null), fee: '-0' })).reportingAmount, '0');
  assert.equal((await ledger.recordMoneyEvent(event('funding-1', '-0.25', 'USDT', 'funding'))).reportingAmount, '-0.25');
  assert.equal((await ledger.recordMoneyEvent(event('funding-2', '0.125', 'USDT', 'funding'))).reportingAmount, '0.125');
  assert.equal((await ledger.recordFeeEvent({ ...event('fill-1', '1.100', 'USDT'), fee: '1.100' })).id, cost.id);
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS n FROM trading_money_events')).n, 5);
  let result = await ledger.moneyLedgerSnapshot('paper', eventTime, eventTime + 1);
  assert.equal(result.amount, '-1.2');
  assert.equal(result.valuationStatus, 'valued');
  assert.equal(result.historyCompleteness, 'unproven', 'An empty or fully valued ledger never proves provider history coverage.');

  const foreign = await ledger.recordMoneyEvent(event('foreign-fee', '-0.01', 'BNB'));
  assert.equal(foreign.valuationStatus, 'unresolved');
  assert.equal(foreign.reportingAmount, null);
  const stable = await ledger.recordMoneyEvent(event('stable-fee', '-1', 'USDC'));
  assert.equal(stable.valuationStatus, 'unresolved', 'Stablecoins are different assets; no blanket parity.');
  const missing = await ledger.recordMoneyEvent(event('missing-asset', '-2', null));
  assert.equal(missing.valuationStatus, 'unresolved');
  result = await ledger.moneyLedgerSnapshot('paper', eventTime, eventTime + 1);
  assert.equal(result.amount, null, 'A partial valued subtotal is not an account PnL.');
  assert.equal(result.valuedSubtotal, '-1.2');
  assert.equal(result.unresolvedEventIds.length, 3);
  const quote = { eventId: foreign.id, route: 'paper:event-time-rate:v1', baseAsset: 'BNB',
    quoteAsset: 'USDT', rate: '300.125', observedAt: eventTime, evidenceId: 'simulated-historical-quote-1' };
  await ledger.valueMoneyEvent(quote);
  await ledger.valueMoneyEvent(quote);
  assert.equal((await ledger.getMoneyEvent(foreign.id)).reportingAmount, '-3.00125');
  await assert.rejects(ledger.valueMoneyEvent({ ...quote, rate: '301' }), /conflict/i);
  await assert.rejects(ledger.valueMoneyEvent({ ...quote, eventId: stable.id, baseAsset: 'USDC', observedAt: eventTime + 1 }), /event time/i);
  await assert.rejects(ledger.recordMoneyEvent({ ...event('provider-pnl', '9', 'USDT', 'realized_price_pnl'), basis: 'provider' }), /derived.*fills/i);
  await assert.rejects(ledger.recordMoneyEvent({ ...event('bad-binding', '1', 'USDT'), accountFingerprint: 'different-account' }), /binding/i);
  await assert.rejects(ledger.recordFeeEvent({ ...event('fill-1', '2', 'USDT'), fee: '2' }), /conflict/i);
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS n FROM trading_money_events')).n, 8);
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS n FROM trading_money_conflicts')).n, 2, 'Both contradictory valuation and contradictory event evidence remain durable.');
  const tiny = await ledger.recordMoneyEvent(event('tiny-foreign-fee', '-0.000000000000000001', 'BNB'));
  await assert.rejects(ledger.valueMoneyEvent({ ...quote, eventId: tiny.id, rate: '0.000000000000000001' }), /precision/i,
    'A nonzero monetary value must not silently truncate to zero.');
  assert.equal((await ledger.getMoneyEvent(tiny.id)).reportingAmount, null);
  await closeDb();
  await initDb(databasePath);
  assert.equal((await ledger.getMoneyEvent(cost.id)).reportingAmount, '-1.1');
  assert.equal((await ledger.getMoneyEvent(foreign.id)).reportingAmount, '-3.00125');
  assert.equal((await ledger.moneyLedgerSnapshot('paper', eventTime, eventTime + 1)).amount, null);
  assert.equal((await getDatabase().all('PRAGMA foreign_key_check')).length, 0);
  console.log('Exact signed monetary events, currency provenance, idempotence, unresolved costs and restart passed.');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
