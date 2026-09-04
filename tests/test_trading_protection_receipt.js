import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { TradingEngine } from '../src/trading_engine.js';
import { createTradingAccount, createTradingIntent, getTradingAccount, getTradingIntent, getTradingOperationalSnapshot,
  listTradingStrategies, setTradingRoute, updateTradingRuntimeState } from '../src/trading_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { validateSignalXml } from '../src/signal_schema.js';
import { readProtectionProjection } from '../src/trading_protection_projection.js';
import { prepareTradingOperation } from '../src/trading_recovery.js';
import { requestFromOrder } from '../src/trading_order_request.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'protection-receipt-'));
const clock = Date.now;
const xml = '<signal><action>LONG</action><pair>ETHUSDT</pair><entry_range><min>3000</min><max>3100</max></entry_range><targets><target id="1">3200</target><target id="2">3300</target></targets><stoploss>2900</stoploss></signal>';

async function setup(name, prepareOnly = false) {
  await initDb(path.join(directory, `${name}.db`));
  await seedTradingFixtures();
  const account = await getTradingAccount('paper-default');
  const [strategy] = await listTradingStrategies();
  await setTradingRoute({ channelId: '-receipt', strategyVersionId: strategy.id, accountId: account.id, enabled: true });
  await updateTradingRuntimeState({ executionEnabled: true });
  const paper = new PaperExchangeAdapter();
  await paper.setMarket(account.id, { symbol: 'ETHUSDT', markPrice: '3000', priceTick: '0.1', quantityStep: '0.001',
    minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 25 });
  await saveSignal(name, '-receipt', 1, xml, xml);
  const intent = await createTradingIntent({ sourceSignalId: name, channelId: '-receipt', signal: validateSignalXml(xml).execution });
  const engine = new TradingEngine([paper]);
  if (prepareOnly) return { account, paper, engine, intent };
  await engine.processIntent(intent.id);
  assert.equal((await getTradingIntent(intent.id)).status, 'monitoring');
  await engine.reconcileAccount(account.id);
  return { account, paper, engine, intent };
}

async function freshnessAndPersistedVerdict() {
  const { account, engine } = await setup('freshness');
  assert.equal((await getTradingOperationalSnapshot()).unprotectedPositions, 0);
  const now = clock();
  Date.now = () => now + 30_001;
  assert.equal((await getTradingOperationalSnapshot()).unprotectedPositions, 1,
    'A local open stop cannot keep monitoring green after its authoritative protection proof expires.');
  Date.now = clock;
  await engine.reconcileAccount(account.id);
  const row = await getDatabase().get(`SELECT local_snapshot_json FROM trading_reconciliation_runs
    WHERE account_id = ? AND status = 'succeeded' ORDER BY completed_at DESC LIMIT 1`, [account.id]);
  const receipt = JSON.parse(row.local_snapshot_json);
  assert.equal(receipt.version, 1);
  assert.equal(receipt.proofs.length, 1);
  assert.equal(receipt.proofs[0].purpose, 'positionProtected');
  assert.equal(receipt.proofs[0].safe, true);
  assert.deepEqual((await readProtectionProjection())[0].proof, receipt.proofs[0],
    'Monitoring consumes the identical original production verdict and evidence hash.');
  assert.equal(receipt.commit.accountVersion, receipt.proofs[0].binding.accountVersion + 1,
    'The metadata commit is separate: never relabel the original observation/proof account version.');
  assert.equal((await getTradingOperationalSnapshot()).unprotectedPositions, 0);
  await closeDb();
}

async function localDriftCannotRevive() {
  const { account, engine, intent } = await setup('local-drift');
  const database = getDatabase();
  await database.run("UPDATE trading_positions SET realized_pnl = 'unknown', updated_at = updated_at + 1 WHERE account_id = ?", [account.id]);
  assert.equal((await getTradingOperationalSnapshot()).unprotectedPositions, 0,
    'Money projection changes are not a new stop/ownership decision or an excuse to hide a still-current protection proof.');
  const stop = await database.get("SELECT * FROM trading_orders WHERE intent_id = ? AND role = 'stop_loss'", [intent.id]);
  const cases = [
    ["UPDATE trading_orders SET side = 'buy' WHERE id = ?", "UPDATE trading_orders SET side = 'sell' WHERE id = ?", [stop.id]],
    ["UPDATE trading_positions SET stop_price = '2800' WHERE intent_id = ?", "UPDATE trading_positions SET stop_price = '2900' WHERE intent_id = ?", [intent.id]],
    ["UPDATE trading_operations SET last_error = 'drift' WHERE intent_id = ?", 'UPDATE trading_operations SET last_error = NULL WHERE intent_id = ?', [intent.id]],
    ["UPDATE trading_fills SET identity_status = 'conflict' WHERE account_id = ?", "UPDATE trading_fills SET identity_status = 'proven' WHERE account_id = ?", [account.id]],
    ["UPDATE trading_fills SET quantity = '0.001' WHERE account_id = ?", null, [account.id]],
  ];
  for (const [change, restore, params] of cases) {
    const fills = await database.all('SELECT id, quantity FROM trading_fills WHERE account_id = ?', [account.id]);
    await database.run(change, params);
    assert.equal((await getTradingOperationalSnapshot()).unprotectedPositions, 1);
    if (restore) await database.run(restore, params);
    else for (const fill of fills) await database.run('UPDATE trading_fills SET quantity = ? WHERE id = ?', [fill.quantity, fill.id]);
    assert.equal((await getTradingOperationalSnapshot()).unprotectedPositions, 1, 'Restoring local fields cannot resurrect an invalidated receipt.');
    await engine.reconcileAccount(account.id);
    assert.equal((await getTradingOperationalSnapshot()).unprotectedPositions, 0);
  }
  await database.run('UPDATE trading_accounts SET max_concurrent_positions = max_concurrent_positions - 1 WHERE id = ?', [account.id]);
  assert.equal((await getTradingOperationalSnapshot()).unprotectedPositions, 1);
  await engine.reconcileAccount(account.id);
  engine.mutations.fenceEntries(account.id);
  assert.equal((await getTradingOperationalSnapshot()).unprotectedPositions, 1);
  await updateTradingRuntimeState({ executionEnabled: false });
  await engine.reconcileAccount(account.id);
  assert.equal((await getTradingOperationalSnapshot()).unprotectedPositions, 0, 'Execution OFF does not remove independent stop management/proof.');
  await closeDb();
}

async function timeoutReopenAndCorruption() {
  const { account, paper, engine } = await setup('reopen');
  const read = paper.openState.bind(paper);
  let entered;
  const reading = new Promise(resolve => { entered = resolve; });
  let rejectRead;
  paper.openState = async () => { entered(); return new Promise((_resolve, reject) => { rejectRead = reject; }); };
  const attempt = engine.reconcileAccount(account.id);
  await reading;
  assert.equal((await getTradingOperationalSnapshot()).unprotectedPositions, 1, 'Invalidation occurs before the pending provider read returns.');
  rejectRead(new Error('read timeout'));
  await assert.rejects(attempt, /timeout/);
  paper.openState = read;
  await engine.reconcileAccount(account.id);
  await closeDb();
  await initDb(path.join(directory, 'reopen.db'));
  assert.equal((await getTradingOperationalSnapshot()).unprotectedPositions, 1, 'Persisted JSON cannot revive a receipt after DB reopen.');
  const restarted = new TradingEngine([paper]);
  await restarted.reconcileAccount(account.id);
  assert.equal((await getTradingOperationalSnapshot()).unprotectedPositions, 0);
  for (const json of ['{', '{}', '{"version":1,"proofs":[{"safe":true}]}']) {
    await getDatabase().run("UPDATE trading_reconciliation_runs SET local_snapshot_json = ? WHERE status = 'succeeded'", [json]);
    assert.equal((await getTradingOperationalSnapshot()).unprotectedPositions, 1);
    await restarted.reconcileAccount(account.id);
  }
  await closeDb();
}

async function historyDoesNotRemoveProtection() {
  const { account, paper, engine } = await setup('history');
  const read = paper.openState.bind(paper);
  const oldStop = (await read(account)).orders.find(order => order.role === 'stop_loss');
  await paper.cancelOrder(account, oldStop.clientOrderId);
  paper.accountSnapshot = async () => { throw new Error('unknown money'); };
  paper.openState = async bound => {
    const remote = await read(bound);
    remote.acquisition.sources.find(source => source.source === 'fills').completeness = 'partial';
    return remote;
  };
  await assert.rejects(engine.reconcileAccount(account.id), /SOURCE_FILLS_INCOMPLETE/);
  const active = (await read(account)).orders.filter(order => order.status === 'open');
  assert.equal(active.filter(order => order.role === 'stop_loss').length, 1,
    'A fresh own replacement is installed before unknown history/money reject final protection health.');
  assert.equal(active.some(order => order.role === 'flatten'), false);
  const failed = await getDatabase().get("SELECT local_snapshot_json FROM trading_reconciliation_runs WHERE status <> 'succeeded' ORDER BY completed_at DESC LIMIT 1");
  const negative = JSON.parse(failed.local_snapshot_json);
  assert.equal(negative.commit, null);
  assert.equal(negative.proofs[0].safe, false);
  assert.ok(negative.proofs[0].reasons.some(reason => reason.code === 'SOURCE_FILLS_INCOMPLETE'));
  assert.equal((await getTradingOperationalSnapshot()).unprotectedPositions, 1);
  await closeDb();
}

async function noDutyRequiresPositiveNoSend() {
  for (const phase of ['planned', 'prepared', 'ack-corrupt', 'dispatching']) {
    const { account, engine, intent } = await setup(`no-duty-${phase}`, true);
    const { plan } = await engine.mutations.run(account.id, () => engine.preparePendingIntent(intent, engine.mutations.entryEpoch(account.id)));
    if (phase !== 'planned') {
      const entry = plan.orders.find(order => order.role === 'entry');
      const stop = plan.orders.find(order => order.role === 'stop_loss');
      await prepareTradingOperation({ account, intentId: intent.id, kind: 'protected_entry', clientOrderIds: [entry.clientOrderId, stop.clientOrderId],
        request: { entry: requestFromOrder(account, plan, entry), protectiveStop: requestFromOrder(account, plan, stop) } });
      if (phase === 'ack-corrupt') await getDatabase().run("UPDATE trading_operations SET evidence_json = '{}' WHERE intent_id = ?", [intent.id]);
      if (phase === 'dispatching') await getDatabase().run("UPDATE trading_operations SET phase = 'dispatching' WHERE intent_id = ?", [intent.id]);
    }
    if (['planned', 'prepared'].includes(phase)) {
      await engine.reconcileAccount(account.id);
      const [projection] = await readProtectionProjection();
      assert.equal(projection.protected, true);
      assert.equal(projection.proof, null, 'No existing duty is not an invented positive protection proof.');
      assert.equal(projection.noDuty.noSendBasis, 'local_prepared');
      assert.match(projection.noDuty.noSendEvidenceHash, /^[a-f0-9]{64}$/);
    } else {
      await assert.rejects(engine.reconcileAccount(account.id), /POSITION_NOT_PROTECTED|unresolved/i);
      assert.equal((await getTradingOperationalSnapshot()).unprotectedPositions, 1);
    }
    assert.equal((await getDatabase().get('SELECT COUNT(*) AS count FROM trading_paper_orders')).count, 0);
    await closeDb();
  }
}

async function unresolvedHistoryStillProtectsKnownQuantity() {
  const { account, paper, engine } = await setup('unresolved-history');
  const read = paper.openState.bind(paper);
  const oldStop = (await read(account)).orders.find(order => order.role === 'stop_loss');
  await paper.cancelOrder(account, oldStop.clientOrderId);
  paper.openState = async bound => ({ ...await read(bound), unresolvedEvents: [{ kind: 'fill', source: 'fetchMyTrades',
    reason: 'unmapped_historical_fill', providerId: 'unowned-history', providerSymbol: 'SOLUSDT',
    evidence: { exchangeFillId: 'unowned-history', exchangeOrderId: 'unowned-order', quantity: '1', side: 'buy' } }] });
  await assert.rejects(engine.reconcileAccount(account.id), /unresolved remote execution evidence/);
  assert.equal((await read(account)).orders.filter(order => order.role === 'stop_loss' && order.status === 'open').length, 1,
    'An unrelated unclassified historical event cannot skip fresh protection of exact owned quantity.');
  assert.equal((await getTradingOperationalSnapshot()).unprotectedPositions, 1, 'Independent stop installation is not a green complete-history proof.');
  await closeDb();
}

async function finalCommitDriftRollsBack() {
  const { account, engine } = await setup('final-fence');
  const previous = await getDatabase().get("SELECT local_snapshot_json FROM trading_reconciliation_runs WHERE status = 'succeeded' ORDER BY completed_at DESC LIMIT 1");
  const store = engine.storeReconciliationSuccess.bind(engine);
  engine.storeReconciliationSuccess = async (...args) => {
    await store(...args);
    await getDatabase().run("UPDATE trading_positions SET stop_price = '2800' WHERE account_id = ?", [account.id]);
  };
  await assert.rejects(engine.reconcileAccount(account.id), /PROTECTION_SOURCE_CHANGED/);
  assert.equal((await getDatabase().get('SELECT stop_price FROM trading_positions WHERE account_id = ?', [account.id])).stop_price, '2900');
  const current = await getDatabase().get("SELECT local_snapshot_json FROM trading_reconciliation_runs WHERE status = 'succeeded' ORDER BY completed_at DESC LIMIT 1");
  assert.equal(current.local_snapshot_json, previous.local_snapshot_json, 'The coalesced successful row is restored by the same rollback.');
  assert.equal((await getTradingOperationalSnapshot()).unprotectedPositions, 1, 'Failure invalidates old green even though its original row is retained for audit.');
  await closeDb();
}

async function localClosureDoesNotEraseDuty() {
  const { account, engine } = await setup('false-close');
  await getDatabase().run("UPDATE trading_positions SET status = 'closed', quantity = '0' WHERE account_id = ?", [account.id]);
  await getDatabase().run("UPDATE trading_orders SET status = 'cancelled' WHERE account_id = ? AND role <> 'entry'", [account.id]);
  assert.equal((await getTradingOperationalSnapshot()).unprotectedPositions, 1,
    'A local closed flag does not erase the last actual protection obligation without a fresh lifecycle decision.');
  engine.mutations.fenceEntries(account.id);
  assert.equal((await getTradingOperationalSnapshot()).unprotectedPositions, 1);
  await closeDb();
}

async function sourceGenerationInvalidation() {
  const { account, engine } = await setup('generations');
  const database = getDatabase();
  await database.run(`INSERT INTO trading_history_checkpoints
    (account_id, account_fingerprint, source, provider_symbol, revision, checkpoint_json, updated_at)
    VALUES (?, ?, 'fills', 'ETHUSDT', 1, '{}', ?)`, [account.id, 'a'.repeat(64), Date.now()]);
  assert.equal((await getTradingOperationalSnapshot()).unprotectedPositions, 1, 'History generation drift invalidates the decision.');
  await engine.reconcileAccount(account.id);
  await database.run(`INSERT INTO trading_account_baselines
    (id, account_id, account_fingerprint, credential_generation, status, boundary_at, first_completed_at, last_observed_at, first_evidence_json)
    VALUES ('receipt-baseline', ?, ?, 'generation', 'candidate', 1, 1, 1, '{}')`, [account.id, 'a'.repeat(64)]);
  assert.equal((await getTradingOperationalSnapshot()).unprotectedPositions, 1, 'A new baseline is not silently accepted into an old proof.');
  await engine.reconcileAccount(account.id);
  await database.run("UPDATE trading_accounts SET credential_generation = 'changed' WHERE id = ?", [account.id]);
  assert.equal((await getTradingOperationalSnapshot()).unprotectedPositions, 1);
  await database.run('UPDATE trading_accounts SET credential_generation = NULL WHERE id = ?', [account.id]);
  await engine.reconcileAccount(account.id);
  const now = clock();
  Date.now = () => now - 1_000;
  assert.equal((await getTradingOperationalSnapshot()).unprotectedPositions, 1, 'A future-dated receipt cannot be trusted.');
  Date.now = clock;
  assert.equal((await getTradingOperationalSnapshot()).unprotectedPositions, 1, 'Clock correction cannot revive an invalidated observation.');
  await closeDb();
}

async function accountIsolation() {
  const { account, paper, engine } = await setup('isolation');
  const second = await createTradingAccount({ name: 'Receipt second', exchange: 'paper', mode: 'paper', initialBalance: '10000' });
  const [strategy] = await listTradingStrategies();
  await setTradingRoute({ channelId: '-receipt-second', strategyVersionId: strategy.id, accountId: second.id, enabled: true });
  await paper.setMarket(second.id, { symbol: 'ETHUSDT', markPrice: '3000', priceTick: '0.1', quantityStep: '0.001',
    minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 25 });
  await saveSignal('isolation-second', '-receipt-second', 1, xml, xml);
  const intent = await createTradingIntent({ sourceSignalId: 'isolation-second', channelId: '-receipt-second', signal: validateSignalXml(xml).execution });
  await engine.processIntent(intent.id);
  await engine.reconcileAccount(second.id);
  assert.equal((await getTradingOperationalSnapshot()).unprotectedPositions, 0);
  engine.mutations.fenceEntries(second.id);
  const projection = await readProtectionProjection();
  assert.equal(projection.find(row => row.accountId === account.id).protected, true);
  assert.equal(projection.find(row => row.accountId === second.id).protected, false, 'One account epoch cannot impersonate/invalidate another account receipt.');
  await closeDb();
}

try {
  await freshnessAndPersistedVerdict();
  await localDriftCannotRevive();
  await timeoutReopenAndCorruption();
  await historyDoesNotRemoveProtection();
  await noDutyRequiresPositiveNoSend();
  await unresolvedHistoryStillProtectsKnownQuantity();
  await finalCommitDriftRollsBack();
  await localClosureDoesNotEraseDuty();
  await sourceGenerationInvalidation();
  await accountIsolation();
  console.log('Fresh persisted protection receipt tests passed.');
} finally {
  Date.now = clock;
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
