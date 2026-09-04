import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { TradingEngine } from '../src/trading_engine.js';
import { createTradingIntent, getTradingIntent, listTradingAccounts, listTradingStrategies,
  setTradingRoute, updateTradingRuntimeState } from '../src/trading_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';

async function fixture(file) {
  await initDb(file);
  await seedTradingFixtures();
  const [account] = await listTradingAccounts();
  const [strategy] = await listTradingStrategies();
  await setTradingRoute({ channelId: '-tier-fence', accountId: account.id, strategyVersionId: strategy.id, enabled: true });
  await updateTradingRuntimeState({ executionEnabled: true });
  await saveSignal('tier-fence', '-tier-fence', 1, '<signal/>', '<signal/>');
  const signal = { schema: 'standard', action: 'LONG', symbol: 'BTCUSDT', entry: { type: 'market', min: '100', max: '100' },
    targets: [{ min: '110', max: '110' }, { min: '120', max: '120' }], stopLoss: '90' };
  const intent = await createTradingIntent({ sourceSignalId: 'tier-fence', channelId: '-tier-fence', signal });
  const paper = new PaperExchangeAdapter();
  await paper.setMarket(account.id, { symbol: 'BTCUSDT', markPrice: '100', priceTick: '0.1', quantityStep: '0.01',
    minimumQuantity: '0.01', minimumNotional: '1', maxLeverage: 10 });
  return { account, intent, paper, signal, engine: new TradingEngine([paper]) };
}

async function finalReadDrift(file, change) {
  const { intent, paper, engine } = await fixture(file);
  const read = paper.marketSnapshot.bind(paper);
  let reads = 0;
  paper.marketSnapshot = async (...args) => {
    const snapshot = await read(...args);
    if (++reads === 2) change(snapshot);
    return snapshot;
  };
  await engine.processIntent(intent.id);
  const stored = await getTradingIntent(intent.id);
  assert.equal(reads, 2, stored.error);
  assert.equal(stored.status, 'blocked', stored.error);
  assert.equal(stored.blockReason, 'LEVERAGE_TIERS_UNPROVEN', stored.error);
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS count FROM trading_paper_orders')).count, 0);
}

async function localReservation(file) {
  const { account, intent, signal, engine } = await fixture(file);
  await saveSignal('tier-other', '-tier-fence', 2, '<signal/>', '<signal/>');
  const other = await createTradingIntent({ sourceSignalId: 'tier-other', channelId: '-tier-fence', signal });
  await getDatabase().run(`INSERT INTO trading_orders (id,intent_id,account_id,client_order_id,role,side,order_type,status,
    quantity,filled_quantity,reduce_only,request_json,created_at,updated_at)
    VALUES ('tier-orphan',?,?, 'tier-orphan-client','entry','buy','limit','created','1','0',0,'{}',?,?)`,
  [other.id, account.id, Date.now(), Date.now()]);
  await engine.processIntent(intent.id);
  const stored = await getTradingIntent(intent.id);
  assert.equal(stored.blockReason, 'ENTRY_SAFETY_UNPROVEN', stored.error);
  assert.match(stored.error, /TRADE_SCOPE_UNPROVED/, 'Account-wide protection now rejects the orphan before symbol-tier sizing.');
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS count FROM trading_paper_orders')).count, 0);
}

async function postJournalDecisionChange(file) {
  const { intent, engine } = await fixture(file);
  const prepare = engine.preparePendingIntent.bind(engine);
  let prepared;
  engine.preparePendingIntent = async (...args) => { prepared = await prepare(...args); return prepared; };
  const database = getDatabase();
  const run = database.run.bind(database);
  let reached = false;
  database.run = async (...args) => {
    const result = await run(...args);
    if (String(args[0]).includes('UPDATE trading_operations SET phase = ?') && args[1][0] === 'dispatching') {
      reached = true;
      prepared.plan.leverageTierDecision.quantity = '999';
    }
    return result;
  };
  try { await engine.processIntent(intent.id); } finally { database.run = run; }
  assert.equal(reached, true);
  assert.equal((await getTradingIntent(intent.id)).blockReason, 'LEVERAGE_TIERS_UNPROVEN');
  assert.equal((await database.get('SELECT phase FROM trading_operations WHERE intent_id = ?', [intent.id])).phase, 'abandoned');
  assert.equal((await database.get('SELECT COUNT(*) AS count FROM trading_paper_orders')).count, 0);
}

const directory = await mkdtemp(path.join(os.tmpdir(), 'tier-fence-'));
try {
  const changes = [market => { delete market.leverageTiers; },
    market => { market.markPrice = market.leverageTiers.markPrice = '1000000'; },
    market => { market.maxLeverage = market.leverageTiers.tiers[0].maxLeverage = 9; },
    market => { market.leverageTiers.scope.positionQuantity = '1'; }];
  for (const [index, change] of changes.entries()) {
    await finalReadDrift(path.join(directory, `read-${index}.db`), change);
    await closeDb();
  }
  await localReservation(path.join(directory, 'reservation.db'));
  await closeDb();
  await postJournalDecisionChange(path.join(directory, 'journal.db'));
} finally { await closeDb(); await rm(directory, { recursive: true, force: true }); }
console.log('Final fresh tier/mark/margin, local reservation and post-journal tier fences passed.');
