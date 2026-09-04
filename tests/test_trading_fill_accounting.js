import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { getTradingAnalytics, listTradingStrategies } from '../src/trading_repository.js';
import { getFilteredTradingAnalytics } from '../src/trading_telemetry.js';
import { projectAccountFillAccounting } from '../src/trading_fill_accounting.js';
import { moneyLedgerSnapshot, valueMoneyEvent } from '../src/trading_money_ledger.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { insertAccountedFill } from './fixtures/accounted_trades.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-fill-accounting-'));
const dbPath = path.join(directory, 'test.db');
const today = Date.UTC(2026, 8, 2);
async function intent(id) {
  const [strategy] = await listTradingStrategies();
  await saveSignal(id, '-accounting', 1, '<signal/>', `<signal>${id}</signal>`);
  await getDatabase().run(`INSERT INTO trading_trade_intents (id, source_signal_id, root_source_signal_id, channel_id,
    strategy_version_id, account_id, exchange, mode, symbol, side, status, signal_json, created_at, updated_at)
    VALUES (?, ?, ?, '-accounting', ?, 'paper-default', 'paper', 'paper', 'BTCUSDT', 'LONG', 'monitoring', '{}', ?, ?)`,
  [id, id, id, strategy.id, today - 100, today]);
}
async function snapshot(since = today, until = today + 86400000) {
  await projectAccountFillAccounting('paper-default');
  return moneyLedgerSnapshot('paper-default', since, until);
}
try {
  await initDb(dbPath);
  await seedTradingFixtures();
  await intent('partial');
  await insertAccountedFill({ intentId: 'partial', id: 'entry', price: '100', quantity: '2', fee: '1', filledAt: today - 100 });
  await insertAccountedFill({ intentId: 'partial', id: 'tp', role: 'take_profit', price: '120', fee: '-0.25', filledAt: today + 100 });
  let result = await snapshot();
  assert.equal(result.amount, '20.25', 'Today includes partial price PnL and rebate, but not yesterday’s entry fee.');
  assert.equal(result.pricePnl, '20');
  assert.equal(result.fees, '0.25');
  assert.equal((await getDatabase().get("SELECT status FROM trading_trade_intents WHERE id = 'partial'")).status, 'monitoring');
  assert.equal((await snapshot(0)).amount, '19.25');
  const count = (await getDatabase().get('SELECT COUNT(*) AS n FROM trading_money_events')).n;
  await closeDb();
  await initDb(dbPath);
  assert.equal((await snapshot()).amount, '20.25');
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS n FROM trading_money_events')).n, count);
  // A later entry cannot rewrite the first exit's cost basis.
  await insertAccountedFill({ intentId: 'partial', id: 'late-entry', price: '200', filledAt: today + 200 });
  await insertAccountedFill({ intentId: 'partial', id: 'exit', role: 'flatten', price: '175', quantity: '2', filledAt: today + 300 });
  assert.equal((await snapshot()).amount, '70.25');
  const analytics = await getFilteredTradingAnalytics({ since: today, until: today + 1000,
    channelIds: [], accountIds: [], exchanges: [], modes: [], statuses: [] });
  assert.equal(analytics.performance.channels[0].realizedPnl, '70.25');
  assert.equal(analytics.performance.total.realizedPnl, '70.25');
  assert.equal((await getTradingAnalytics(today + 1000)).accounts.find(account => account.accountId === 'paper-default').windows.all.realizedPnl, '69.25');
  assert.equal((await getDatabase().get("SELECT amount FROM trading_money_events WHERE provider_event_id = 'remote-fill-tp' AND kind = 'realized_price_pnl'")).amount, '20');
  // A foreign fee remains unknown until an evidenced event-time valuation is appended.
  await intent('foreign');
  await insertAccountedFill({ intentId: 'foreign', id: 'foreign', price: '100', fee: '0.01', feeAsset: 'BNB', filledAt: today + 400 });
  assert.equal((await snapshot()).amount, null);
  const foreign = await getDatabase().get("SELECT id FROM trading_money_events WHERE provider_event_id = 'remote-fill-foreign'");
  await valueMoneyEvent({ eventId: foreign.id, route: 'paper:event-time-rate:v1', baseAsset: 'BNB', quoteAsset: 'USDT',
    rate: '300', observedAt: today + 400, evidenceId: 'fixture-event-time-rate' });
  assert.equal((await snapshot()).amount, '67.25');
  // Contradictory old data is retained and invalidates totals, never deleted or quietly recalculated.
  await getDatabase().run("UPDATE trading_fills SET price = '99' WHERE id = 'fill-entry'");
  assert.equal((await snapshot()).amount, null);
  assert.ok((await getDatabase().get('SELECT COUNT(*) AS n FROM trading_money_conflicts')).n > 0);
  assert.equal((await getDatabase().get("SELECT amount FROM trading_money_events WHERE provider_event_id = 'remote-fill-tp' AND kind = 'realized_price_pnl'")).amount, '20');
  console.log('Owned fill cashflows: partial UTC realization, moving basis, replay, FX evidence and retained conflicts passed.');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
