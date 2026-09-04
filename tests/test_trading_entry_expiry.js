import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { createTradingPlan } from '../src/trading_risk.js';
import { captureEntryDeadline } from '../src/exchange_entry_deadline.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { TradingEngine } from '../src/trading_engine.js';
import { DEFAULT_STRATEGY_CONFIGURATION } from '../src/trading_strategy.js';
import {
  createTradingIntent, getTradingIntent, listTradingAccounts, listTradingStrategies,
  setTradingRoute, updateTradingRuntimeState
} from '../src/trading_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';

const signal = {
  schema: 'standard', action: 'LONG', symbol: 'BTCUSDT', entry: { type: 'range', min: '100', max: '100' },
  targets: [{ min: '110', max: '110' }, { min: '120', max: '120' }], stopLoss: '90'
};
const market = { symbol: 'BTCUSDT', markPrice: '105', priceTick: '0.1', quantityStep: '0.01', minimumQuantity: '0.01', minimumNotional: '1', maxLeverage: 10 };
const ttl = DEFAULT_STRATEGY_CONFIGURATION.safety.entryOrderTtlSeconds * 1_000;

function assertPlanTiming() {
  const origin = 1_700_000_000_000;
  const input = {
    intentId: 'timing', signal, strategy: structuredClone(DEFAULT_STRATEGY_CONFIGURATION),
    account: { equity: '10000', availableBalance: '10000' }, market,
    entryOriginAt: origin, now: origin + ttl * 0.9
  };
  const plan = createTradingPlan(input);
  assert.equal(plan.entryExpiresAt, origin + ttl, 'Plan construction must not restart the original entry clock.');
  assert.equal(plan.createdAt, input.now, 'Plan creation time remains distinct from signal origin.');
  assert.equal(createTradingPlan({ ...input, entryExpiresAt: origin + ttl / 2 }).entryExpiresAt, origin + ttl / 2);
  assert.equal(createTradingPlan({ ...input, entryExpiresAt: origin + ttl * 2 }).entryExpiresAt, origin + ttl);
  for (const entryOriginAt of [0, Number.NaN, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => createTradingPlan({ ...input, entryOriginAt }), /deadline|origin/i);
  }
}

async function fixture(file) {
  await initDb(file);
  await seedTradingFixtures();
  const [account] = await listTradingAccounts();
  const [strategy] = await listTradingStrategies();
  await setTradingRoute({ channelId: '-entry-expiry', strategyVersionId: strategy.id, accountId: account.id, enabled: true });
  await updateTradingRuntimeState({ executionEnabled: true });
  const paper = new PaperExchangeAdapter();
  await paper.setMarket(account.id, market);
  await saveSignal('entry-expiry', '-entry-expiry', 1, '<signal/>', '<signal/>');
  const intent = await createTradingIntent({ sourceSignalId: 'entry-expiry', channelId: '-entry-expiry', signal });
  const origin = intent.createdAt - ttl * 0.9;
  await getDatabase().run('UPDATE trading_trade_intents SET created_at = ? WHERE id = ?', [origin, intent.id]);
  return { account, paper, intent: await getTradingIntent(intent.id), origin };
}

async function assertRemainingLifetime(file) {
  const { paper, account, intent, origin } = await fixture(file);
  const cancellations = [];
  const cancel = paper.cancelOrder.bind(paper);
  paper.cancelOrder = async (...args) => { cancellations.push(args[1]); return cancel(...args); };
  const engine = new TradingEngine([paper]);
  await engine.processIntent(intent.id);
  const stored = await getTradingIntent(intent.id);
  assert.equal(stored.plan.entryExpiresAt, origin + ttl);
  assert.equal(await engine.cancelExpiredEntries(origin + ttl - 1), 0);
  await closeDb();
  await initDb(file);
  const restarted = new TradingEngine([paper]);
  assert.equal(await restarted.cancelExpiredEntries(origin + ttl), 1);
  const orders = await getDatabase().all('SELECT client_order_id, role, status FROM trading_orders WHERE intent_id = ?', [intent.id]);
  const entryId = orders.find(order => order.role === 'entry').client_order_id;
  assert.equal(cancellations.filter(id => id === entryId).length, 1, 'Restart cancels the entry once at its original deadline.');
  assert.equal(orders.find(order => order.role === 'entry').status, 'cancelled');
  assert.equal(orders.find(order => order.role === 'stop_loss').status, 'cancelled', 'The subsequent proved flat/zero-fill closure cleans its unused exit sibling.');
  assert.equal((await paper.openState(account)).positions.length, 0);
  assert.equal((await getDatabase().get('SELECT status FROM trading_positions WHERE intent_id = ?', [intent.id])).status, 'closed');
}

async function assertLegacyPlanRecovery(file) {
  const { paper, intent, origin } = await fixture(file);
  const prepared = await new TradingEngine([paper]).preparePendingIntent(intent);
  const legacy = { ...prepared.plan };
  delete legacy.entryExpiresAt;
  await getDatabase().run('UPDATE trading_trade_intents SET plan_json = ? WHERE id = ?', [JSON.stringify(legacy), intent.id]);
  await closeDb();
  await initDb(file);
  await new TradingEngine([paper]).processIntent(intent.id);
  const recovered = await getTradingIntent(intent.id);
  assert.equal(recovered.status, 'monitoring', recovered.error);
  assert.equal(recovered.plan.entryExpiresAt, origin + ttl);
  assert.equal(recovered.plan.createdAt, legacy.createdAt);
}

async function assertExpiredPreparedNeverSubmits(file) {
  const { paper, intent } = await fixture(file);
  const prepared = await new TradingEngine([paper]).preparePendingIntent(intent);
  const expired = { ...prepared.plan, entryExpiresAt: Date.now() - 1 };
  await getDatabase().run('UPDATE trading_trade_intents SET plan_json = ? WHERE id = ?', [JSON.stringify(expired), intent.id]);
  let submissions = 0;
  paper.submitProtectedEntry = async () => { submissions += 1; throw new Error('Expired entry must never submit'); };
  await new TradingEngine([paper]).processIntent(intent.id);
  assert.equal(submissions, 0);
  assert.equal((await getTradingIntent(intent.id)).blockReason, 'ENTRY_INTENT_EXPIRED');
  assert.equal((await getDatabase().get('SELECT status FROM trading_positions WHERE intent_id = ?', [intent.id])).status, 'closed');
}

async function assertFinalDispatchDeadline(file) {
  const { paper, intent, origin } = await fixture(file);
  const database = getDatabase();
  const run = database.run.bind(database);
  const actualNow = Date.now;
  let reachedLastAwait = false;
  let submissions = 0;
  paper.submitProtectedEntry = async () => { submissions += 1; throw new Error('Expired dispatch must not be sent.'); };
  database.run = async (...args) => {
    const result = await run(...args);
    if (String(args[0]).includes('UPDATE trading_operations SET phase = ?') && args[1][0] === 'dispatching') {
      reachedLastAwait = true;
      Date.now = () => origin + ttl;
    }
    return result;
  };
  try {
    await new TradingEngine([paper]).processIntent(intent.id);
  } finally {
    database.run = run;
    Date.now = actualNow;
  }
  assert.equal(reachedLastAwait, true, 'Fixture must cross the deadline after the final asynchronous admission checks.');
  assert.equal(submissions, 0, 'The synchronous dispatch fence must use the same absolute deadline.');
  assert.equal((await getTradingIntent(intent.id)).blockReason, 'ENTRY_INTENT_EXPIRED');
  assert.equal((await database.get('SELECT phase FROM trading_operations WHERE intent_id = ?', [intent.id])).phase, 'abandoned');
  assert.equal((await database.get('SELECT status FROM trading_positions WHERE intent_id = ?', [intent.id])).status, 'closed');
}

async function assertAdapterDeadlineRetainsUncertainty(file) {
  const { paper, intent } = await fixture(file);
  const actualNow = Date.now;
  let adapterCalls = 0;
  paper.submitProtectedEntry = async (_account, entry, protectiveStop) => {
    adapterCalls += 1;
    const fence = captureEntryDeadline('/v1/submit-protected-entry', { entry, protectiveStop });
    await Promise.resolve();
    Date.now = () => entry.entryExpiresAt;
    fence.assertCurrent();
    assert.fail('An expired entry may not continue to the simulated exchange.');
  };
  const engine = new TradingEngine([paper]);
  try { await engine.processIntent(intent.id); }
  finally { Date.now = actualNow; }
  assert.equal(adapterCalls, 1, 'The deadline crosses after handing the durable operation to the adapter.');
  const operation = await getDatabase().get('SELECT phase FROM trading_operations WHERE intent_id = ?', [intent.id]);
  assert.equal(operation.phase, 'unresolved', 'A risk error name is not a journal-bound proof of no dispatch.');
  const current = await getTradingIntent(intent.id);
  assert.equal(current.status, 'unknown', 'A durable unresolved operation must not become a terminal blocked intent.');
  assert.match(current.error, /ENTRY_INTENT_EXPIRED/);
  const [account] = await listTradingAccounts();
  assert.equal(account.killSwitchActive, true, 'The unresolved submission must use the common account isolation path.');
  assert.equal((await getDatabase().get('SELECT status FROM trading_positions WHERE intent_id = ?', [intent.id])).status, 'opening');
  await closeDb();
  await initDb(file);
  await new TradingEngine([paper]).processIntent(intent.id);
  assert.equal(adapterCalls, 1, 'Restart must neither resubmit nor promote an unresolved deadline failure.');
  assert.equal((await getTradingIntent(intent.id)).status, 'unknown');
}

async function assertLegacyActiveDeadline(file) {
  const { paper, intent, origin } = await fixture(file);
  await new TradingEngine([paper]).processIntent(intent.id);
  const legacy = { ...(await getTradingIntent(intent.id)).plan };
  delete legacy.entryExpiresAt;
  await getDatabase().run('UPDATE trading_trade_intents SET plan_json = ? WHERE id = ?', [JSON.stringify(legacy), intent.id]);
  await getDatabase().run('UPDATE trading_orders SET created_at = ? WHERE intent_id = ?', [origin + ttl * 2, intent.id]);
  await closeDb();
  await initDb(file);
  const engine = new TradingEngine([paper]);
  assert.equal(await engine.cancelExpiredEntries(origin + ttl - 1), 0);
  assert.equal(await engine.cancelExpiredEntries(origin + ttl), 1, 'A legacy plan must derive its deadline from original intent provenance, not newer orders.');
}

async function assertUnknownLegacyOriginDrains(file) {
  const { paper, intent } = await fixture(file);
  await new TradingEngine([paper]).processIntent(intent.id);
  const legacy = { ...(await getTradingIntent(intent.id)).plan, entryExpiresAt: null };
  await getDatabase().run('UPDATE trading_trade_intents SET plan_json = ?, created_at = 0 WHERE id = ?', [JSON.stringify(legacy), intent.id]);
  assert.equal(await new TradingEngine([paper]).cancelExpiredEntries(), 1, 'Unknown provenance must not give an active entry a fresh lifetime.');
  assert.ok(await getDatabase().get("SELECT id FROM trading_risk_events WHERE intent_id = ? AND code = 'ENTRY_DEADLINE_UNPROVEN'", [intent.id]));
}

async function assertExpiredPreparedDrainsLocally(file) {
  const { paper, intent, origin } = await fixture(file);
  const engine = new TradingEngine([paper]);
  await engine.preparePendingIntent(intent);
  let remoteWrites = 0;
  paper.submitProtectedEntry = paper.cancelOrder = async () => { remoteWrites += 1; throw new Error('Unsent expiry is local only.'); };
  assert.equal(await engine.cancelExpiredEntries(origin + ttl), 1);
  assert.equal(remoteWrites, 0);
  assert.equal((await getTradingIntent(intent.id)).status, 'failed');
  assert.equal((await getDatabase().get('SELECT status FROM trading_positions WHERE intent_id = ?', [intent.id])).status, 'closed');
}

async function assertFilledProtectionSurvives(file) {
  const { paper, account, intent, origin } = await fixture(file);
  await paper.setMarket(account.id, { ...market, markPrice: '100' });
  const engine = new TradingEngine([paper]);
  await engine.processIntent(intent.id);
  const position = await getDatabase().get('SELECT status, quantity FROM trading_positions WHERE intent_id = ?', [intent.id]);
  assert.equal(position.status, 'open');
  assert.notEqual(position.quantity, '0');
  const before = (await paper.openState(account)).orders.filter(order => order.role === 'stop_loss');
  assert.equal(before.length, 1);
  assert.equal(before[0].status, 'open');
  assert.equal(await engine.cancelExpiredEntries(origin + ttl), 0, 'A filled entry is not an outstanding entry commitment.');
  assert.deepEqual((await paper.openState(account)).orders.filter(order => order.role === 'stop_loss'), before);
  assert.equal((await getDatabase().get("SELECT status FROM trading_orders WHERE intent_id = ? AND role = 'stop_loss'", [intent.id])).status, 'open');
}

const directory = await mkdtemp(path.join(os.tmpdir(), 'trading-entry-expiry-'));
try {
  assertPlanTiming();
  for (const [name, test] of [
    ['remaining', assertRemainingLifetime], ['legacy', assertLegacyPlanRecovery], ['expired', assertExpiredPreparedNeverSubmits],
    ['dispatch', assertFinalDispatchDeadline], ['adapter-deadline', assertAdapterDeadlineRetainsUncertainty],
    ['legacy-active', assertLegacyActiveDeadline],
    ['unknown-origin', assertUnknownLegacyOriginDrains], ['local-drain', assertExpiredPreparedDrainsLocally],
    ['filled-protection', assertFilledProtectionSurvives]
  ]) {
    await test(path.join(directory, `${name}.db`));
    await closeDb();
  }
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
console.log('Absolute original entry deadline tests passed.');
