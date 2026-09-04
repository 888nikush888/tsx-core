import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { closeDb, getDatabase, getSignalDashboardAnalytics, initDb } from '../src/db.js';
import { getTradingAnalytics, listTradingAccounts, listTradingStrategies } from '../src/trading_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { insertAccountedFill } from './fixtures/accounted_trades.js';
import { valueMoneyEvent } from '../src/trading_money_ledger.js';
import { moneyValueFromDecimal } from '../src/trading_money_value.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'dashboard-analytics-'));
const now = 2_000_000_000_000;
const recent = now - 60 * 60 * 1_000;
const old = now - 40 * 24 * 60 * 60 * 1_000;

function exactWindowFields(net, price, fees, tradeCount) {
  const value = (amount, terms) => ({ ...moneyValueFromDecimal(amount), terms });
  const total = value(net, 3 * tradeCount);
  return { realizedPnlValue: total, closedRealizedPnl: net, closedRealizedPnlValue: total,
    closedReportingCurrency: 'USDT', closedAccountingStatus: 'complete', uncertainOutcomeCount: 0,
    grossProfitValue: value('25', 3), grossLossValue: value(tradeCount === 1 ? '0' : '10', tradeCount === 1 ? 0 : 3),
    pricePnlValue: value(price, tradeCount), signedFeesValue: value(fees, 2 * tradeCount), fundingValue: value('0', 0),
    valuedSubtotalByCurrency: { USDT: net }, valuedSubtotalValuesByCurrency: { USDT: total } };
}

try {
  await initDb(path.join(directory, 'forwarder.db'));
  await seedTradingFixtures(now - 1_000);
  const database = getDatabase();
  const [account] = await listTradingAccounts();
  const [strategy] = await listTradingStrategies();

  for (const [messageId, status, createdAt] of [
    [1, 'processed', recent], [2, 'filtered', recent], [3, 'duplicate', recent],
    [4, 'failed', recent], [5, 'processed', old],
  ]) {
    await database.run(
      `INSERT INTO incoming_messages (chat_id, message_id, sender, text, type, status, created_at)
       VALUES ('-1001', ?, 'source', 'message', 'text', ?, ?)`,
      [messageId, status, createdAt],
    );
  }
  await database.run(
    `INSERT INTO signals (id, chat_id, message_id, xml_content, normalized_content, created_at)
     VALUES ('signal-recent', '-1001', 1, '<signal/>', '<signal/>', ?),
            ('signal-old', '-1001', 5, '<signal/>', '<signal/>', ?)`,
    [recent, old],
  );

  for (const [suffix, signalId, createdAt] of [
    ['recent', 'signal-recent', recent], ['old', 'signal-old', old],
  ]) {
    await database.run(
      `INSERT INTO trading_trade_intents (
         id, source_signal_id, root_source_signal_id, channel_id, strategy_version_id, account_id, exchange, mode,
         symbol, side, status, signal_json, created_at, updated_at
       ) VALUES (?, ?, ?, '-1001', ?, ?, 'paper', 'paper', 'BTCUSDT', 'LONG', 'completed', '{}', ?, ?)`,
      [`intent-${suffix}`, signalId, signalId, strategy.id, account.id, createdAt, createdAt],
    );
    await insertAccountedFill({ intentId: `intent-${suffix}`, accountId: account.id, id: suffix,
      price: suffix === 'recent' ? '100' : '50', quantity: suffix === 'recent' ? '2' : '1',
      fee: suffix === 'recent' ? '1' : '0.5', feeAsset: 'USDC', filledAt: createdAt - 1 });
    await insertAccountedFill({ intentId: `intent-${suffix}`, accountId: account.id, id: `exit-${suffix}`, role: 'flatten',
      price: suffix === 'recent' ? '113.01' : '40.51', quantity: suffix === 'recent' ? '2' : '1', feeAsset: 'USDC', filledAt: createdAt });
    await database.run(
      `INSERT INTO trading_positions (
         id, intent_id, account_id, strategy_version_id, channel_id, symbol, side,
         status, quantity, average_entry_price, stop_price, realized_pnl, opened_at, closed_at, updated_at
       ) VALUES (?, ?, ?, ?, '-1001', 'BTCUSDT', 'LONG', 'closed', '1', '100', '90', ?, ?, ?, ?)`,
      [`position-${suffix}`, `intent-${suffix}`, account.id, strategy.id, suffix === 'recent' ? '25' : '-10', createdAt, createdAt, createdAt],
    );
  }
  await database.run(
    `INSERT INTO trading_risk_events (id, severity, code, account_id, details_json, created_at)
     VALUES ('risk-recent', 'critical', 'TEST_RECENT', ?, '{}', ?),
            ('risk-old', 'warning', 'TEST_OLD', ?, '{}', ?)`,
    [account.id, recent, account.id, old],
  );

  const signals = await getSignalDashboardAnalytics(now);
  assert.deepEqual(signals.windows['24h'], {
    messages: 4, processed: 1, filtered: 1, duplicates: 1, failed: 1, signals: 1,
  });
  assert.deepEqual(signals.windows.all, {
    messages: 5, processed: 2, filtered: 1, duplicates: 1, failed: 1, signals: 2,
  });
  await assert.rejects(getSignalDashboardAnalytics(0), /timestamp is invalid/);

  assert.equal((await getTradingAnalytics(now)).accounts.find(value => value.accountId === account.id).windows.all.realizedPnl, null,
    'Neither old position totals nor stablecoin parity may replace a missing fee valuation.');
  for (const event of await database.all("SELECT id, occurred_at FROM trading_money_events WHERE kind = 'fee' AND amount <> '0'")) {
    await valueMoneyEvent({ eventId: event.id, route: 'paper:event-time-rate:v1', baseAsset: 'USDC', quoteAsset: 'USDT',
      rate: '1.02', observedAt: event.occurred_at, evidenceId: `fixture-rate-${event.id}` });
  }
  const trading = await getTradingAnalytics(now);
  const metrics = trading.accounts.find(value => value.accountId === account.id)?.windows;
  assert.deepEqual(metrics?.['24h'], {
    ...exactWindowFields('25', '26.02', '-1.02', 1),
    realizedPnl: '25', grossProfit: '25', grossLoss: '0', closedTrades: 1,
    reportingCurrency: 'USDT', accountingStatus: 'complete', pricePnl: '26.02', signedFees: '-1.02', funding: '0',
    wins: 1, losses: 0, breakeven: 0, fills: 2, volume: '426.02', volumeByAsset: { USDT: '426.02' }, fees: { USDC: '1' },
    intents: 1, completedIntents: 1, rejectedIntents: 0, riskEvents: 1, criticalRiskEvents: 1,
  });
  assert.deepEqual(metrics?.all, {
    ...exactWindowFields('15', '16.53', '-1.53', 2),
    realizedPnl: '15', grossProfit: '25', grossLoss: '10', closedTrades: 2,
    reportingCurrency: 'USDT', accountingStatus: 'complete', pricePnl: '16.53', signedFees: '-1.53', funding: '0',
    wins: 1, losses: 1, breakeven: 0, fills: 4, volume: '516.53', volumeByAsset: { USDT: '516.53' }, fees: { USDC: '1.5' },
    intents: 2, completedIntents: 2, rejectedIntents: 0, riskEvents: 2, criticalRiskEvents: 1,
  });
  await assert.rejects(getTradingAnalytics(Number.NaN), /timestamp is invalid/);
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}

console.log('Dashboard analytics tests passed.');
