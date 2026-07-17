import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { TradingEngine } from '../src/trading_engine.js';
import {
  createTradingIntent,
  ensureTradingDefaults,
  getTradingIntent,
  listTradingAccounts,
  listTradingStrategies,
  setTradingRoute,
  updateTradingRuntimeState,
} from '../src/trading_repository.js';
import { validateSignalXml } from '../src/signal_schema.js';

const SIGNAL = '<signal><action>LONG</action><pair>ETHUSDT</pair><entry_range><min>3000</min><max>3100</max></entry_range><targets><target id="1">3200</target><target id="2">3300</target></targets><stoploss>2900</stoploss></signal>';

async function setup(databasePath) {
  await initDb(databasePath);
  await ensureTradingDefaults();
  const paper = new PaperExchangeAdapter();
  const [account] = await listTradingAccounts();
  const [strategy] = await listTradingStrategies();
  await setTradingRoute({ channelId: '-200001', strategyVersionId: strategy.id, accountId: account.id, enabled: true });
  await updateTradingRuntimeState({ executionEnabled: true });
  await paper.setMarket(account.id, {
    symbol: 'ETHUSDT', markPrice: '3000', priceTick: '0.1', quantityStep: '0.001',
    minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 25,
  });
  const signal = validateSignalXml(SIGNAL).execution;
  await saveSignal('failure-signal', '-200001', 1, SIGNAL, SIGNAL);
  const intent = await createTradingIntent({ sourceSignalId: 'failure-signal', channelId: '-200001', signal });
  return { paper, account, intent };
}

function wrappedAdapter(paper, submit) {
  return {
    exchange: 'paper',
    accountSnapshot: (...args) => paper.accountSnapshot(...args),
    marketSnapshot: (...args) => paper.marketSnapshot(...args),
    submitOrder: submit,
    cancelOrder: (...args) => paper.cancelOrder(...args),
    openState: (...args) => paper.openState(...args),
  };
}

async function testUnknownEntry(directory) {
  const { paper, account, intent } = await setup(path.join(directory, 'unknown-entry.db'));
  let submissions = 0;
  const adapter = wrappedAdapter(paper, async () => {
    submissions += 1;
    throw new Error('simulated submit timeout');
  });
  const engine = new TradingEngine([adapter]);
  await engine.processIntent(intent.id);
  assert.equal((await getTradingIntent(intent.id)).status, 'unknown');
  assert.equal((await getDatabase().get(
    `SELECT status FROM trading_orders WHERE intent_id = ? AND role = 'entry'`,
    [intent.id],
  )).status, 'unknown');
  await engine.processIntent(intent.id);
  assert.equal(submissions, 1, 'Unknown submit outcome must never be retried blindly.');
  assert.equal((await paper.openState(account)).positions.length, 0);
  await closeDb();
}

async function testProtectiveStopFailure(directory) {
  const { paper, account, intent } = await setup(path.join(directory, 'stop-failure.db'));
  const adapter = wrappedAdapter(paper, async (targetAccount, request) => {
    if (request.role === 'stop_loss') throw new Error('simulated protective stop timeout');
    return paper.submitOrder(targetAccount, request);
  });
  const engine = new TradingEngine([adapter]);
  await engine.processIntent(intent.id);
  assert.equal((await paper.openState(account)).positions.length, 0, 'Unprotected exposure must be flattened automatically.');
  const position = await getDatabase().get('SELECT * FROM trading_positions WHERE intent_id = ?', [intent.id]);
  assert.equal(position.status, 'closed');
  assert.equal(position.quantity, '0');
  assert.equal((await getTradingIntent(intent.id)).status, 'unknown');
  const event = await getDatabase().get(
    `SELECT code FROM trading_risk_events WHERE intent_id = ? AND code = 'EMERGENCY_FLATTENED'`,
    [intent.id],
  );
  assert.equal(event.code, 'EMERGENCY_FLATTENED');
  await closeDb();
}

async function run() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'trading-failures-'));
  try {
    await testUnknownEntry(directory);
    await testProtectiveStopFailure(directory);
  } finally {
    await closeDb();
    await rm(directory, { recursive: true, force: true });
  }
  console.log('Trading failure-policy tests passed.');
}

await run();
