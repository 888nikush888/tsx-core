import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { getTradingAccount, getTradingAnalytics, listTradingStrategies, createTradingAccount } from '../src/trading_repository.js';
import { getFilteredTradingAnalytics } from '../src/trading_telemetry.js';
import { projectAllFillAccounting } from '../src/trading_fill_accounting.js';
import { bindAccountReportingCurrency, moneyLedgerSnapshot, recordMoneyEvent } from '../src/trading_money_ledger.js';
import { captureFxReceipts } from '../src/trading_fx_repository.js';
import { valueFxMoneyEvent } from '../src/trading_fx_valuation.js';
import { moneyValueFromDecimal, moneyValueFromRational } from '../src/trading_money_value.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { insertAccountedFill } from './fixtures/accounted_trades.js';
import { fxReceipt, FX_CONTEXT } from './fixtures/fx_receipts.js';

const now = Date.now() - 1000, since = now - 86400000;
const filters = patch => ({ since, until: now, channelIds: [], accountIds: [], exchanges: [], modes: [], statuses: [], ...patch });
async function intent(id, channel, accountId = 'paper-default', status = 'monitoring') {
  const account = await getTradingAccount(accountId), [strategy] = await listTradingStrategies();
  await saveSignal(id, channel, 1, '<signal/>', `<signal>${id}</signal>`);
  await getDatabase().run(`INSERT INTO trading_trade_intents (id,source_signal_id,root_source_signal_id,channel_id,strategy_version_id,
    account_id,exchange,mode,symbol,side,status,signal_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'BTCUSDT','LONG',?,'{}',?,?)`,
  [id, id, id, channel, strategy.id, accountId, account.exchange, account.mode, status, now - 2000, now]);
  return strategy.id;
}
async function position(id, channel, strategyId, quantity, closedAt = null, accountId = 'paper-default') {
  await getDatabase().run(`INSERT INTO trading_positions (id,intent_id,account_id,strategy_version_id,channel_id,symbol,side,status,
    quantity,average_entry_price,stop_price,realized_pnl,opened_at,closed_at,updated_at)
    VALUES (?,?,?,?,?,'BTCUSDT','LONG',?,?,'100','90','0',?,?,?)`,
  [id, id, accountId, strategyId, channel, closedAt === null ? 'open' : 'closed', quantity, since - 100, closedAt, now]);
}
async function nativeKernel() {
  const openStrategy = await intent('open', '-open');
  await insertAccountedFill({ intentId: 'open', id: 'open-entry', price: '100', quantity: '2', fee: '1', filledAt: since - 100 });
  await insertAccountedFill({ intentId: 'open', id: 'partial', role: 'take_profit', price: '120', filledAt: now - 900 });
  await position('open', '-open', openStrategy, '1');
  const closedStrategy = await intent('closed', '-closed', 'paper-default', 'completed');
  await insertAccountedFill({ intentId: 'closed', id: 'closed-entry', price: '100', filledAt: now - 800 });
  await insertAccountedFill({ intentId: 'closed', id: 'closed-exit', role: 'flatten', price: '110', filledAt: now - 700 });
  await position('closed', '-closed', closedStrategy, '0', now - 700);
  await recordMoneyEvent({ accountId: 'paper-default', accountFingerprint: 'paper:paper-default', providerEventId: 'funding-native',
    kind: 'funding', basis: 'provider', source: 'paper-contract-v1', occurredAt: now - 600, amount: '-2', asset: 'USDT' });
  const ledger = await moneyLedgerSnapshot('paper-default', since, now + 1); // Projector is applied by analytics below.
  assert.equal(ledger.pendingProjections > 0, true);
  const result = await getTradingAnalytics(now), window = result.accounts.find(row => row.accountId === 'paper-default').windows['24h'];
  assert.equal(window.realizedPnl, '28');
  assert.deepEqual(window.realizedPnlValue, (await moneyLedgerSnapshot('paper-default', since, now + 1)).value,
    'Open partial realization and funding must be included in the same Value as the event-time decimal alias, not closed-only PnL.');
  assert.equal(window.valuedSubtotalByCurrency.USDT, '28');
  assert.deepEqual(window.valuedSubtotalValuesByCurrency.USDT, window.realizedPnlValue);
  assert.equal(window.closedTrades, 1); assert.equal(window.grossProfit, '10');
  assert.equal(window.pricePnlValue.decimal, '30'); assert.equal(window.fundingValue.decimal, '-2');
  assert.equal(window.signedFeesValue.decimal, '0');
  assert.equal(result.accounts.find(row => row.accountId === 'paper-default').windows.all.realizedPnl, '27');
  const filtered = (await getFilteredTradingAnalytics(filters({ accountIds: ['paper-default'] }))).performance;
  assert.equal(filtered.total.realizedPnl, '28'); assert.deepEqual(filtered.total.realizedPnlValue, window.realizedPnlValue);
  assert.equal(filtered.channels.find(row => row.id === '-open').realizedPnlValue.decimal, '20');
  assert.equal(filtered.channels.find(row => row.id === '-open').closedTrades, 0);
  assert.equal(filtered.exchanges[0].realizedPnlValue.decimal, '28'); assert.equal(filtered.exchanges[0].closedTrades, 1);
  assert.equal((await getFilteredTradingAnalytics(filters({ channelIds: ['-closed'] }))).performance.total.realizedPnl, '10');
  assert.equal((await getFilteredTradingAnalytics(filters({ statuses: ['monitoring'] }))).performance.total.realizedPnl, '20');
}
async function currencyAndEmpty() {
  const account = await createTradingAccount({ name: 'USD report', exchange: 'paper', mode: 'paper', initialBalance: '1000' });
  await bindAccountReportingCurrency({ accountId: account.id, accountFingerprint: `paper:${account.id}`, profile: 'paper',
    reportingCurrency: 'USD', settlementAssets: ['USD'], source: 'paper-contract-v1', verifiedAt: now });
  await recordMoneyEvent({ accountId: account.id, accountFingerprint: `paper:${account.id}`, providerEventId: 'usd-funding',
    kind: 'funding', basis: 'provider', source: 'paper-contract-v1', occurredAt: now, amount: '3', asset: 'USD' });
  const mixed = (await getFilteredTradingAnalytics(filters())).performance;
  assert.equal(mixed.total.realizedPnl, null); assert.equal(mixed.total.realizedPnlValue, null);
  assert.deepEqual(mixed.total.valuedSubtotalByCurrency, { USDT: '28', USD: '3' });
  assert.equal(mixed.exchanges[0].realizedPnl, null, 'Same exchange does not imply the same reporting unit.');
  assert.equal(mixed.exchanges[0].valuedSubtotalValuesByCurrency.USD.decimal, '3');
  const selected = (await getFilteredTradingAnalytics(filters({ accountIds: [account.id] }))).performance;
  assert.equal(selected.total.realizedPnlValue.decimal, '3'); assert.deepEqual(selected.total.valuedSubtotalByCurrency, { USD: '3' });
  const empty = (await getFilteredTradingAnalytics(filters({ channelIds: ['-does-not-exist'] }))).performance;
  assert.equal(empty.total.realizedPnl, null); assert.equal(empty.total.realizedPnlValue, null);
  assert.deepEqual(empty.total.valuedSubtotalValuesByCurrency, {}); assert.deepEqual(empty.channels, []);
  const outside = (await getFilteredTradingAnalytics(filters({ since: now + 1, until: now + 2 }))).performance;
  assert.equal(outside.total.realizedPnlValue, null);
}
async function fxAccount() {
  const id = 'analytics-fx';
  await getDatabase().run(`INSERT INTO trading_accounts (id,name,exchange,mode,status,enabled,credential_ref,external_account_id,
    credential_generation,capabilities_json,last_verified_at,created_at,updated_at) VALUES (?,?,'bybit','testnet','ready',1,'fixture',?,?,?,?,?,?)`,
  [id, id, createHash('sha256').update(id).digest('hex'), 'c'.repeat(64), JSON.stringify({ executionProfileHash: FX_CONTEXT.profileHash,
    profileVersion: 1, executionCapabilities: { provider_api_version: 'bybit-v5' } }), now - 3000, now - 4000, now]);
  const account = await getTradingAccount(id);
  await bindAccountReportingCurrency({ accountId: id, accountFingerprint: account.externalAccountId, profile: 'bybit',
    reportingCurrency: 'USD', settlementAssets: ['USDT', 'USDC'], source: 'bybit-wallet-balance-v1', verifiedAt: now });
  await captureFxReceipts(account, [fxReceipt('usd', now - 20), fxReceipt('usdt', now)], { startedAt: now - 100, completedAt: now + 100 });
  return account;
}
async function fxRankAndOutcomes(filename) {
  const account = await fxAccount();
  for (const [id, channel, amount, closed] of [['low', 'aa-lower', '1', false], ['high', 'zz-higher', '2', false],
    ['win', 'ratio', '1', true], ['loss', 'ratio', '-3', true]]) {
    const strategy = await intent(id, channel, account.id, closed ? 'completed' : 'monitoring');
    const event = await recordMoneyEvent({ accountId: account.id, accountFingerprint: account.externalAccountId, providerEventId: id,
      kind: 'funding', basis: 'provider', source: 'synthetic-local-fixture', occurredAt: now, amount, asset: 'USDT', intentId: id });
    const valuation = await valueFxMoneyEvent(account, event.id);
    await projectAllFillAccounting();
    if (closed) {
      // Dedicated stored-projection consumer fixture; upstream fill/FX derivation has separate integration tests.
      await position(id, channel, strategy, '0', now, account.id);
      await getDatabase().run(`UPDATE trading_positions SET ledger_realized_pnl=?,ledger_realized_value_json=?,reporting_currency='USD',
        accounting_status='complete' WHERE id=?`, [valuation.value.decimal, JSON.stringify(valuation.value), id]);
      await getDatabase().run('DELETE FROM trading_accounting_pending WHERE intent_id=?', [id]);
    }
  }
  const response = await getFilteredTradingAnalytics(filters({ accountIds: [account.id] }));
  const channels = response.performance.channels;
  assert.ok(channels.findIndex(row => row.id === 'zz-higher') < channels.findIndex(row => row.id === 'aa-lower'),
    'Rational amounts with null decimal aliases retain their exact same-currency ranking.');
  const ratio = channels.find(row => row.id === 'ratio');
  assert.equal(ratio.wins, 1); assert.equal(ratio.losses, 1); assert.equal(ratio.breakeven, 0);
  assert.deepEqual(ratio.payoffRatioValue, moneyValueFromRational({ numerator: '1', denominator: '3' }));
  assert.equal(ratio.payoffRatioExact, null); assert.equal(ratio.payoffRatioPrecision, 'display_approximation');
  assert.equal(typeof ratio.payoffRatio, 'number');
  const originalTotal = response.performance.total;
  for (const selected of [filters({ exchanges: ['bybit'] }), filters({ modes: ['testnet'] })]) {
    assert.deepEqual((await getFilteredTradingAnalytics(selected)).performance.total, originalTotal);
  }
  const excluded = (await getFilteredTradingAnalytics(filters({ modes: ['live'] }))).performance;
  assert.equal(excluded.total.realizedPnlValue, null); assert.deepEqual(excluded.channels, []);
  await closeDb(); await initDb(filename);
  assert.deepEqual((await getFilteredTradingAnalytics(filters({ accountIds: [account.id] }))).performance.total, originalTotal);
  const interval = { lower: '-0.000000000000000001', upper: '0.000000000000000001', exact: null,
    decimal: null, precision: 'bounded', terms: 2 };
  await getDatabase().run("UPDATE trading_positions SET ledger_realized_value_json=? WHERE id='win'", [JSON.stringify(interval)]);
  const uncertain = (await getFilteredTradingAnalytics(filters({ channelIds: ['ratio'] }))).performance.channels[0];
  assert.equal(uncertain.uncertainOutcomeCount, 1); assert.equal(uncertain.breakeven, 0);
  assert.equal(uncertain.payoffRatio, null); assert.equal(uncertain.payoffRatioValue, null); assert.equal(uncertain.winRatePercent, null);
  assert.equal(uncertain.accountingStatus, 'complete', 'Closed outcome precision cannot rewrite complete event-time cashflow coverage.');
  const huge = moneyValueFromDecimal('1' + '0'.repeat(35));
  const tiny = moneyValueFromRational({ numerator: '-1', denominator: '9'.repeat(100) });
  for (const [id, value] of [['win', huge], ['loss', tiny]]) {
    await getDatabase().run('UPDATE trading_positions SET ledger_realized_pnl=?,ledger_realized_value_json=? WHERE id=?',
      [value.decimal, JSON.stringify(value), id]);
  }
  const limited = (await getFilteredTradingAnalytics(filters({ channelIds: ['ratio'] }))).performance.channels[0];
  assert.equal(limited.payoffRatio, null); assert.equal(limited.payoffRatioValue, null);
  assert.equal(limited.payoffRatioPrecision, 'not_representable');
  assert.deepEqual(limited.grossProfitValue, huge); assert.equal(limited.grossLossValue.exact.numerator, '1');
  assert.equal(limited.closedAccountingStatus, 'complete'); assert.equal(limited.accountingStatus, 'complete');
}

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-fx-analytics-')), filename = path.join(directory, 'analytics.db');
try {
  await initDb(filename); await seedTradingFixtures();
  await nativeKernel(); await currencyAndEmpty(); await fxRankAndOutcomes(filename);
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  console.log('Event-time Value/scalar analytics, partial PnL, funding, filters, exact ranking, payoff and uncertain outcomes passed.');
} finally { await closeDb(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); await rm(directory, { recursive: true, force: true }); }
