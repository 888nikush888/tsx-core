import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { TradingEngine } from '../src/trading_engine.js';
import { hasUndispatchedPlanProof, prepareTradingOperation } from '../src/trading_recovery.js';
import { requestFromOrder } from '../src/trading_order_request.js';
import { createTradingIntent, getTradingAccount, getTradingIntent, listTradingStrategies,
  setTradingRoute, updateTradingRuntimeState } from '../src/trading_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'preparation-recovery-'));
async function setup(name) {
  await initDb(path.join(directory, `${name}.db`));
  await seedTradingFixtures();
  await updateTradingRuntimeState({ executionEnabled: true });
  const account = await getTradingAccount('paper-default');
  const [strategy] = await listTradingStrategies();
  await setTradingRoute({ channelId: name, strategyVersionId: strategy.id, accountId: account.id, enabled: true });
  const paper = new PaperExchangeAdapter();
  await paper.setMarket(account.id, { symbol: 'ETHUSDT', markPrice: '3000', priceTick: '0.1', quantityStep: '0.001',
    minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 25 });
  await saveSignal(name, name, 1, '<signal/>', '<signal/>');
  const intent = await createTradingIntent({ sourceSignalId: name, channelId: name, signal: { schema: 'standard', action: 'LONG',
    symbol: 'ETHUSDT', entry: { type: 'market' }, targets: [{ min: '3200', max: '3200' }, { min: '3300', max: '3300' }], stopLoss: '2900' } });
  const engine = new TradingEngine([paper]);
  await engine.mutations.run(account.id, () => engine.preparePendingIntent(intent, engine.mutations.entryEpoch(account.id)));
  const prepared = await getTradingIntent(intent.id);
  assert.equal(await hasUndispatchedPlanProof(prepared, false), true);
  await updateTradingRuntimeState({ executionEnabled: false });
  for (const method of ['openState', 'accountSnapshot', 'marketSnapshot', 'submitOrder', 'submitProtectedEntry', 'cancelOrder']) {
    paper[method] = async () => { assert.fail(`Local retirement must not call an adapter: ${method}`); };
  }
  return { engine, account, intent, originalPlan: prepared.plan };
}

async function addUnprovedLegacyIntent(fixture, index, planJson = null) {
  const id = `legacy-${index}`;
  await saveSignal(id, fixture.intent.channelId, index + 10, '<legacy/>', '<legacy/>');
  // Explicit incomplete imported legacy state, not a claimed successfully prepared or accepted trade.
  await getDatabase().run(`INSERT INTO trading_trade_intents (id,source_signal_id,root_source_signal_id,channel_id,
    strategy_version_id,account_id,exchange,mode,symbol,side,status,signal_json,plan_json,created_at,updated_at)
    SELECT ?,?,?,channel_id,strategy_version_id,account_id,exchange,mode,symbol,side,'submitting',signal_json,?,created_at-?,updated_at
    FROM trading_trade_intents WHERE id=?`, [id, id, id, planJson, index + 1, fixture.intent.id]);
  return id;
}

async function assertRetired(fixture) {
  const current = await getTradingIntent(fixture.intent.id);
  assert.equal(current.status, 'blocked');
  assert.equal(current.blockReason, 'EXECUTION_DISABLED');
  assert.deepEqual(current.plan, fixture.originalPlan);
  assert.equal((await getDatabase().get('SELECT status FROM trading_positions WHERE intent_id=?', [fixture.intent.id])).status, 'closed');
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS count FROM trading_paper_orders')).count, 0);
}

async function fairBoundedRecovery() {
  const fixture = await setup('fair-selection');
  for (let index = 0; index < 100; index += 1) await addUnprovedLegacyIntent(fixture, index);
  assert.equal(await fixture.engine.retireUnauthorizedPreparations(fixture.account.id), 0,
    'One cycle performs only its bounded first page; unproved legacy rows cannot be locally discarded.');
  assert.equal(await fixture.engine.retireUnauthorizedPreparations(fixture.account.id), 1,
    'An unprovable early page must not permanently starve a later valid revoked preparation.');
  await assertRetired(fixture);
  assert.equal((await getDatabase().get("SELECT COUNT(*) AS count FROM trading_trade_intents WHERE id LIKE 'legacy-%' AND status='submitting'")).count, 100);
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  await closeDb();
}

async function corruptNeighborCannotSuppressRetirement() {
  const fixture = await setup('corrupt-neighbor');
  const legacyId = await addUnprovedLegacyIntent(fixture, 0, '{');
  await assert.rejects(fixture.engine.retireUnauthorizedPreparations(fixture.account.id), AggregateError,
    'The corrupt original remains visible, but independent safe local work must still run.');
  await assertRetired(fixture);
  assert.deepEqual(await getDatabase().get('SELECT status,plan_json FROM trading_trade_intents WHERE id=?', [legacyId]),
    { status: 'submitting', plan_json: '{' });
  await closeDb();
}

async function originalEntryDeadlineCompatibility() {
  for (const variant of ['legacy-absent', 'bound-matching', 'bound-wrong', 'present-null']) {
    const name = `deadline-${variant}`;
    const fixture = await setup(name);
    const plan = fixture.originalPlan;
    assert.ok(Number.isSafeInteger(plan.entryExpiresAt));
    const entry = requestFromOrder(fixture.account, plan, plan.orders.find(order => order.role === 'entry'));
    const protectiveStop = requestFromOrder(fixture.account, plan, plan.orders.find(order => order.role === 'stop_loss'));
    delete entry.entryExpiresAt;
    if (variant === 'bound-matching') entry.entryExpiresAt = plan.entryExpiresAt;
    if (variant === 'bound-wrong') entry.entryExpiresAt = plan.entryExpiresAt + 1;
    if (variant === 'present-null') entry.entryExpiresAt = null;
    const id = await prepareTradingOperation({ account: fixture.account, intentId: fixture.intent.id,
      kind: 'protected_entry', clientOrderIds: [entry.clientOrderId, protectiveStop.clientOrderId], request: { entry, protectiveStop } });
    const original = await getDatabase().get('SELECT request_json,request_hash,expected_orders_json FROM trading_operations WHERE id=?', [id]);
    const allowed = variant === 'legacy-absent' || variant === 'bound-matching';
    assert.equal(await hasUndispatchedPlanProof(await getTradingIntent(fixture.intent.id), false), allowed, variant);
    await closeDb();
    await initDb(path.join(directory, `${name}.db`));
    assert.equal(await hasUndispatchedPlanProof(await getTradingIntent(fixture.intent.id), false), allowed, `${variant} after restart`);
    assert.equal(await fixture.engine.retireUnauthorizedPreparations(fixture.account.id), allowed ? 1 : 0);
    if (allowed) {
      await assertRetired(fixture);
      assert.equal((await getDatabase().get('SELECT phase FROM trading_operations WHERE id=?', [id])).phase, 'abandoned');
    } else {
      assert.equal((await getDatabase().get('SELECT phase FROM trading_operations WHERE id=?', [id])).phase, 'prepared');
    }
    assert.deepEqual(await getDatabase().get('SELECT request_json,request_hash,expected_orders_json FROM trading_operations WHERE id=?', [id]),
      original, 'Read-only legacy recognition cannot upgrade or repair any original journal request.');
    await closeDb();
  }
}

try {
  await fairBoundedRecovery();
  await corruptNeighborCannotSuppressRetirement();
  await originalEntryDeadlineCompatibility();
  console.log('Bounded local preparation recovery is fair, isolates corrupt originals and never invokes an exchange.');
} finally { await closeDb(); await rm(directory, { recursive: true, force: true }); }
