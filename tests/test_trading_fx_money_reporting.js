import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import * as reporting from '../src/trading_money_reporting.js';
import { moneyValueFromRational, negateMoneyValue } from '../src/trading_money_value.js';
import { bindAccountReportingCurrency, recordMoneyEvent } from '../src/trading_money_ledger.js';
import { captureFxReceipts } from '../src/trading_fx_repository.js';
import { valueFxMoneyEvent } from '../src/trading_fx_valuation.js';
import { getTradingAccount, listTradingStrategies } from '../src/trading_repository.js';
import { fxReceipt, sealFxReceipt, FX_CONTEXT } from './fixtures/fx_receipts.js';
import { seedTradingFixtures } from './trading_fixtures.js';

const third = moneyValueFromRational({ numerator: '1', denominator: '3' });
const moneyRow = (value, currency = 'USD', status = 'complete') => ({ realizedPnl: value?.decimal ?? null,
  realizedPnlValue: value, reportingCurrency: currency, accountingStatus: status });
const legacyRow = (amount, currency = 'USD') => ({ realizedPnl: amount, reportingCurrency: currency, accountingStatus: 'complete' });
function rationalSummaries() {
  const result = reporting.summarizeMoneyRows([moneyRow(third)]);
  assert.deepEqual(result.realizedPnlValue, third, 'A fully valued rational amount is not unresolved because decimal is null.');
  assert.equal(result.realizedPnl, null); assert.equal(result.accountingStatus, 'complete');
  assert.deepEqual(result.valuedSubtotalValuesByCurrency, { USD: third });
  assert.deepEqual(result.valuedSubtotalByCurrency, { USD: null });
  const cancellation = reporting.summarizeMoneyRows([moneyRow(third), moneyRow(negateMoneyValue(third))]);
  assert.equal(cancellation.realizedPnl, '0'); assert.equal(cancellation.realizedPnlValue.terms, 2);
  assert.deepEqual(cancellation.realizedPnlValue.exact, { numerator: '0', denominator: '1' });
  const three = reporting.summarizeMoneyRows([moneyRow(third), moneyRow(third), moneyRow(third)]);
  assert.equal(three.realizedPnl, '1');
  assert.equal(reporting.summarizeMoneyRows([legacyRow('1.00'), legacyRow('-0.5')]).realizedPnl, '0.5');
  for (const patch of [{ realizedPnl: '0' }, { realizedPnlValue: null },
    { realizedPnlValue: { ...third, lower: '0' } }, { accountingStatus: 'unresolved' }, { reportingCurrency: null }]) {
    const bad = reporting.summarizeMoneyRows([{ ...moneyRow(third), ...patch }]);
    assert.equal(bad.accountingStatus, 'unresolved'); assert.equal(bad.realizedPnlValue, null);
  }
  assert.equal(reporting.summarizeMoneyRows([legacyRow(null)]).realizedPnlValue, null);
}
function separatedCurrencies() {
  const rows = [moneyRow(third), moneyRow(negateMoneyValue(third), 'USDC')];
  for (const result of [reporting.summarizeMoneyRows(rows), reporting.closedMoneyStatistics(rows)]) {
    assert.equal(result.realizedPnl, null); assert.equal(result.realizedPnlValue, null);
    assert.equal(result.reportingCurrency, null);
    assert.deepEqual(result.valuedSubtotalValuesByCurrency, { USD: third, USDC: negateMoneyValue(third) });
  }
  const summary = reporting.summarizeMoneyRows([...rows, { ...legacyRow('2'), accountingStatus: 'unresolved' }]);
  assert.equal(summary.accountingStatus, 'unresolved');
  assert.deepEqual(summary.valuedSubtotalValuesByCurrency.USD, third, 'Known subtotals survive but do not mask unresolved rows.');
}
function outcomes() {
  const tiny = moneyValueFromRational({ numerator: '-1', denominator: '9'.repeat(256) });
  const result = reporting.closedMoneyStatistics([moneyRow(third), moneyRow(negateMoneyValue(third)),
    moneyRow(tiny), legacyRow('0')]);
  assert.equal(result.wins, 1); assert.equal(result.losses, 2); assert.equal(result.breakeven, 1);
  assert.equal(result.uncertainOutcomeCount, 0);
  assert.deepEqual(result.grossProfitValue, third); assert.equal(result.grossLoss, null);
  assert.equal(result.accountingStatus, 'complete');
  const interval = { lower: '-0.000000000000000001', upper: '0.000000000000000001', exact: null,
    decimal: null, precision: 'bounded', terms: 2 };
  const uncertain = reporting.closedMoneyStatistics([moneyRow(interval)]);
  assert.equal(uncertain.uncertainOutcomeCount, 1);
  assert.equal(uncertain.wins + uncertain.losses + uncertain.breakeven, 0);
  assert.equal(uncertain.accountingStatus, 'complete', 'Precision uncertainty is distinct from missing monetary evidence.');
  assert.deepEqual(uncertain.realizedPnlValue, interval);
  assert.equal(uncertain.grossProfitValue, null); assert.equal(uncertain.grossLossValue, null);
  for (const edge of [{ ...interval, lower: '0' }, { ...interval, upper: '0' }]) {
    assert.equal(reporting.closedMoneyStatistics([moneyRow(edge)]).uncertainOutcomeCount, 1);
  }
  const positive = { ...interval, lower: '1', upper: '1.000000000000000001' };
  const negative = negateMoneyValue(positive);
  const decided = reporting.closedMoneyStatistics([moneyRow(positive), moneyRow(negative)]);
  assert.equal(decided.uncertainOutcomeCount, 0); assert.equal(decided.wins, 1); assert.equal(decided.losses, 1);
  assert.deepEqual(decided.grossProfitValue, positive); assert.deepEqual(decided.grossLossValue, positive);
  assert.equal(decided.realizedPnl, null, 'Opposite bounded intervals cannot recover already lost exact correlation.');
  const empty = reporting.closedMoneyStatistics([]);
  assert.equal(empty.realizedPnl, '0'); assert.equal(empty.realizedPnlValue.terms, 0);
  assert.equal(reporting.summarizeMoneyRows([]).realizedPnl, null, 'An empty report has no inferred reporting currency.');
}

const at = Date.now() - 1000;
async function fxAccount() {
  const id = 'reporting-fx';
  await getDatabase().run(`INSERT INTO trading_accounts (id,name,exchange,mode,status,enabled,credential_ref,
    external_account_id,credential_generation,capabilities_json,last_verified_at,created_at,updated_at)
    VALUES (?,?,'bybit','testnet','ready',1,'fixture',?,?,?,?,?,?)`, [id, id, createHash('sha256').update(id).digest('hex'),
  'c'.repeat(64), JSON.stringify({ executionProfileHash: FX_CONTEXT.profileHash, profileVersion: 1,
    executionCapabilities: { provider_api_version: 'bybit-v5' } }), at - 2000, at - 3000, at]);
  const account = await getTradingAccount(id);
  await bindAccountReportingCurrency({ accountId: id, accountFingerprint: account.externalAccountId, profile: 'bybit',
    reportingCurrency: 'USD', settlementAssets: ['USDT', 'USDC'], source: 'bybit-wallet-balance-v1', verifiedAt: at });
  return account;
}
async function eventRows(filename) {
  const account = await fxAccount();
  const event = await recordMoneyEvent({ accountId: account.id, accountFingerprint: account.externalAccountId, providerEventId: 'funding',
    kind: 'funding', basis: 'provider', source: 'synthetic-local-fixture', occurredAt: at, amount: '-10', asset: 'USDT' });
  const receipts = [fxReceipt('usd', at - 20), fxReceipt('usdt', at)];
  await captureFxReceipts(account, receipts, { startedAt: at - 100, completedAt: at + 100 });
  const valuation = await valueFxMoneyEvent(account, event.id);
  assert.equal((await getDatabase().get('SELECT COUNT(*) n FROM trading_money_valuations')).n, 0);
  const [row] = await reporting.moneyPerformanceRows(at, at + 1);
  assert.equal(row.accountId, account.id); assert.equal(row.channelId, null); assert.equal(row.kind, 'funding');
  assert.equal(row.realizedPnl, null); assert.deepEqual(row.realizedPnlValue, valuation.value);
  assert.equal(row.accountingStatus, 'complete');
  assert.equal(reporting.summarizeMoneyRows([row]).accountingStatus, 'complete');
  assert.deepEqual(await reporting.moneyPerformanceRows(at + 1, at + 2), []);
  await closeDb(); await initDb(filename);
  assert.deepEqual(await reporting.moneyPerformanceRows(at, at + 1), [row]);
  const conflict = structuredClone(receipts[0]);
  conflict.value = '61000'; conflict.envelope.result.list[0].indexPrice = '61000';
  await captureFxReceipts(account, [sealFxReceipt(conflict)], { startedAt: at - 100, completedAt: at + 100 });
  const [unresolved] = await reporting.moneyPerformanceRows(at, at + 1);
  assert.equal(unresolved.accountingStatus, 'unresolved'); assert.equal(unresolved.realizedPnlValue, null);
  assert.equal(reporting.summarizeMoneyRows([unresolved]).realizedPnlValue, null);
}
async function closedPositionReader() {
  await seedTradingFixtures();
  const [strategy] = await listTradingStrategies();
  await saveSignal('projection-signal', '-projection', 1, '<signal/>', '<signal/>');
  await getDatabase().run(`INSERT INTO trading_trade_intents (id,source_signal_id,root_source_signal_id,channel_id,
    strategy_version_id,account_id,exchange,mode,symbol,side,status,signal_json,created_at,updated_at)
    VALUES ('projection','projection-signal','projection-signal','-projection',?,'paper-default','paper','paper','BTCUSDT','LONG','completed','{}',?,?)`,
  [strategy.id, at - 100, at]);
  // An isolated derived-projection reader fixture, not a claim about upstream fill/FX authorization.
  await getDatabase().run(`INSERT INTO trading_positions (id,intent_id,account_id,channel_id,strategy_version_id,symbol,side,status,quantity,
    average_entry_price,stop_price,realized_pnl,ledger_realized_pnl,ledger_realized_value_json,accounting_status,reporting_currency,opened_at,closed_at,updated_at)
    VALUES ('projection','projection','paper-default','-projection',?,'BTCUSDT','LONG','closed','0','100','90','0',NULL,?,'complete','USD',?,?,?)`,
  [strategy.id, JSON.stringify(third), at - 100, at, at]);
  await getDatabase().run("DELETE FROM trading_accounting_pending WHERE intent_id='projection'");
  const complete = await reporting.channelClosedMoneyValuePerformance('-projection', 'paper-default', at, at + 1);
  assert.equal(complete.accountingStatus, 'complete'); assert.deepEqual(complete.realizedPnlValue, third);
  assert.equal(complete.wins, 1);
  await assert.rejects(reporting.channelClosedMoneyPerformance('-projection', 'paper-default', at, at + 1), /unresolved|decimal|scalar/i,
    'Do not implicitly migrate the existing adaptive scalar policy boundary.');
  await getDatabase().run("UPDATE trading_positions SET ledger_realized_value_json='{}' WHERE id='projection'");
  const invalid = await reporting.channelClosedMoneyValuePerformance('-projection', 'paper-default', at, at + 1);
  assert.equal(invalid.accountingStatus, 'unresolved'); assert.equal(invalid.realizedPnlValue, null);
}

rationalSummaries(); separatedCurrencies(); outcomes();
const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-fx-reporting-'));
const filename = path.join(directory, 'reporting.db');
try {
  await initDb(filename);
  await eventRows(filename);
  await closedPositionReader();
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  console.log('Exact monetary summaries, currency separation, uncertain outcomes, canonical FX reads and explicit scalar policy boundary passed.');
} finally {
  await closeDb(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  await rm(directory, { recursive: true, force: true });
}
