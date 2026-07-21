import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { closeDb, getDatabase, getSignalDashboardAnalytics, initDb } from '../src/db.js';
import { ensureTradingDefaults, getTradingAnalytics, listTradingAccounts, listTradingStrategies } from '../src/trading_repository.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'dashboard-analytics-'));
const now = 2_000_000_000_000;
const recent = now - 60 * 60 * 1_000;
const old = now - 40 * 24 * 60 * 60 * 1_000;

try {
  await initDb(path.join(directory, 'forwarder.db'));
  await ensureTradingDefaults(now - 1_000);
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
         id, source_signal_id, channel_id, strategy_version_id, account_id, exchange, mode,
         symbol, side, status, signal_json, created_at, updated_at
       ) VALUES (?, ?, '-1001', ?, ?, 'paper', 'paper', 'BTCUSDT', 'LONG', 'completed', '{}', ?, ?)`,
      [`intent-${suffix}`, signalId, strategy.id, account.id, createdAt, createdAt],
    );
    await database.run(
      `INSERT INTO trading_orders (
         id, intent_id, account_id, client_order_id, role, side, order_type, status,
         price, quantity, filled_quantity, reduce_only, request_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'entry', 'buy', 'limit', 'filled', ?, ?, ?, 0, '{}', ?, ?)`,
      [`order-${suffix}`, `intent-${suffix}`, account.id, `client-${suffix}`, suffix === 'recent' ? '100' : '50', suffix === 'recent' ? '2' : '1', suffix === 'recent' ? '2' : '1', createdAt, createdAt],
    );
    await database.run(
      `INSERT INTO trading_fills (
         id, order_id, account_id, exchange_fill_id, price, quantity, fee, fee_asset, filled_at, raw_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'USDC', ?, '{}')`,
      [`fill-${suffix}`, `order-${suffix}`, account.id, `exchange-fill-${suffix}`, suffix === 'recent' ? '100' : '50', suffix === 'recent' ? '2' : '1', suffix === 'recent' ? '1' : '0.5', createdAt],
    );
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

  const trading = await getTradingAnalytics(now);
  const metrics = trading.accounts.find(value => value.accountId === account.id)?.windows;
  assert.deepEqual(metrics?.['24h'], {
    realizedPnl: '25', grossProfit: '25', grossLoss: '0', closedTrades: 1,
    wins: 1, losses: 0, breakeven: 0, fills: 1, volume: '200', fees: { USDC: '1' },
    intents: 1, completedIntents: 1, rejectedIntents: 0, riskEvents: 1, criticalRiskEvents: 1,
  });
  assert.deepEqual(metrics?.all, {
    realizedPnl: '15', grossProfit: '25', grossLoss: '10', closedTrades: 2,
    wins: 1, losses: 1, breakeven: 0, fills: 2, volume: '250', fees: { USDC: '1.5' },
    intents: 2, completedIntents: 2, rejectedIntents: 0, riskEvents: 2, criticalRiskEvents: 1,
  });
  await assert.rejects(getTradingAnalytics(Number.NaN), /timestamp is invalid/);
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}

console.log('Dashboard analytics tests passed.');
