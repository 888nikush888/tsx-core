import assert from 'node:assert/strict';
import { appendFile, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { PaperExchangeAdapter } from '../src/paper_exchange.js';
import { TradingEngine } from '../src/trading_engine.js';
import { TradingRuntime } from '../src/trading_runtime.js';
import { hasUndispatchedPlanProof } from '../src/trading_recovery.js';
import { assessRestoreEligibility, requireRestoreEligibility } from '../src/backup_evidence.js';
import { createTradingAccount, createTradingIntent, getTradingAccount, getTradingIntent, listTradingStrategies,
  setTradingRoute, updateTradingRuntimeState } from '../src/trading_repository.js';
import { seedTradingFixtures } from './trading_fixtures.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'protected-entry-crash-'));
const originalNow = Date.now;
const signal = { schema: 'standard', action: 'LONG', symbol: 'ETHUSDT', entry: { type: 'market' },
  targets: [{ min: '3200', max: '3200' }, { min: '3300', max: '3300' }], stopLoss: '2900' };
const market = { symbol: 'ETHUSDT', markPrice: '3000', priceTick: '0.1', quantityStep: '0.001',
  minimumQuantity: '0.001', minimumNotional: '10', maxLeverage: 25 };

async function seedIntent(account, paper, name, requestedSignal = signal) {
  const [strategy] = await listTradingStrategies();
  await setTradingRoute({ channelId: name, strategyVersionId: strategy.id, accountId: account.id, enabled: true });
  await paper.setMarket(account.id, { ...market, symbol: requestedSignal.symbol });
  await saveSignal(name, name, 1, '<signal/>', '<signal/>');
  return createTradingIntent({ sourceSignalId: name, channelId: name, signal: requestedSignal });
}

async function crash(phase, databasePath, intentId, callsPath) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/protected_entry_crash_child.js',
    databasePath, intentId, phase, callsPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  await new Promise((resolve, reject) => {
    let output = '', errors = '', killed = false;
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Crash marker missing: ${phase}: ${errors}`)); }, 15_000);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (!killed && output.includes(`PROTECTED_ENTRY_CRASH:${phase}`)) { killed = true; child.kill('SIGKILL'); }
    });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', (code, termination) => {
      clearTimeout(timeout);
      if (killed && (code !== 0 || termination)) resolve();
      else reject(new Error(`Child did not die at ${phase}: ${errors || output}`));
    });
  });
}

class CountedPaper extends PaperExchangeAdapter {
  constructor(callsPath) { super(); this.callsPath = callsPath; }
  async submitProtectedEntry(account, entry, stop) {
    await appendFile(this.callsPath, `${JSON.stringify({ event: 'attempt', entry: entry.clientOrderId,
      stop: stop.clientOrderId, expiresAt: entry.entryExpiresAt })}\n`);
    const result = await super.submitProtectedEntry(account, entry, stop);
    await appendFile(this.callsPath, `${JSON.stringify({ event: 'accepted', entry: entry.clientOrderId, stop: stop.clientOrderId })}\n`);
    return result;
  }
}

async function calls(file) {
  try { return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function prepareCase(name, options = {}) {
  const databasePath = path.join(directory, `${name}.db`), callsPath = path.join(directory, `${name}.ndjson`);
  await initDb(databasePath);
  await seedTradingFixtures();
  await updateTradingRuntimeState({ executionEnabled: true });
  const account = await getTradingAccount('paper-default');
  const paper = new CountedPaper(callsPath);
  let neighbor = null;
  if (options.neighbor) {
    neighbor = await seedIntent(account, paper, `${name}-neighbor`, { ...signal, symbol: 'BTCUSDT' });
    await new TradingEngine([paper]).processIntent(neighbor.id);
    assert.equal((await getTradingIntent(neighbor.id)).status, 'monitoring');
  }
  const intent = await seedIntent(account, paper, name, options.signal ?? signal);
  const origin = (await getTradingIntent(intent.id)).createdAt;
  await closeDb();
  return { databasePath, callsPath, account, intent, origin, paper, neighbor };
}

async function persistedCrashState(fixture, phase) {
  const intent = await getTradingIntent(fixture.intent.id);
  const operation = await getDatabase().get("SELECT * FROM trading_operations WHERE intent_id = ? AND kind = 'protected_entry'", [intent.id]);
  const orders = await getDatabase().all('SELECT * FROM trading_orders WHERE intent_id = ? ORDER BY client_order_id', [intent.id]);
  const position = await getDatabase().get('SELECT * FROM trading_positions WHERE intent_id = ?', [intent.id]);
  const economicCount = await getDatabase().get("SELECT COUNT(*) AS count FROM trading_paper_orders WHERE account_id = ? AND role = 'entry'", [fixture.account.id]);
  const expectedEntries = Number(['accepted', 'ack-before-commit', 'acknowledged', 'roundtrip'].includes(phase)) + Number(Boolean(fixture.neighbor));
  assert.equal(economicCount.count, expectedEntries,
    'The child marker distinguishes actual durable Paper acceptance from intent/journal state.');
  if (phase === 'plan-before-commit') {
    assert.equal(intent.plan, null); assert.equal(intent.status, 'pending'); assert.equal(orders.length, 0); assert.equal(position, undefined);
  } else {
    assert.equal(intent.plan.entryExpiresAt, fixture.origin + intent.plan.entryOrderTtlSeconds * 1_000);
    assert.equal(position.status, 'opening'); assert.equal(position.quantity, '0'); assert.equal(position.opened_at, null);
    assert.equal(operation?.phase ?? null, phase === 'planned' ? null : phase === 'prepared' ? 'prepared' : phase === 'acknowledged' ? 'acknowledged' : 'dispatching');
    if (phase === 'ack-before-commit') {
      assert.ok(orders.filter(order => ['entry', 'stop_loss'].includes(order.role)).every(order => order.status === 'submitting' && order.exchange_order_id === null),
        'The killed ACK transaction rolls back both leg persistence and its acknowledged journal phase.');
    }
  }
  return { plan: intent.plan, operationId: operation?.id, ids: orders.map(order => order.client_order_id) };
}

async function wake(runtime) { runtime.wake(); await runtime.active; }

async function recoverCase(fixture, phase, before) {
  const uncertain = ['dispatching', 'provider-before-accept'].includes(phase);
  let independent = null;
  if (phase === 'provider-before-accept') {
    const healthy = await createTradingAccount({ name: 'Healthy during unresolved recovery', exchange: 'paper', mode: 'paper', initialBalance: '10000' });
    independent = await seedIntent(healthy, fixture.paper, 'healthy-during-crash-recovery');
  }
  const engine = new TradingEngine([fixture.paper]);
  const runtime = new TradingRuntime(engine, 60_000);
  try {
    const beforeStartup = await calls(fixture.callsPath);
    await runtime.startProtectionOnly();
    assert.equal((await calls(fixture.callsPath)).filter(row => row.event === 'attempt').length,
      beforeStartup.filter(row => row.event === 'attempt').length, 'Protection-only startup never submits a new entry.');
    await runtime.enableEntries();
    await wake(runtime);
    const after = await getTradingIntent(fixture.intent.id);
    const entryId = after.plan?.orders.find(order => order.role === 'entry')?.clientOrderId;
    if (uncertain) {
      assert.ok(['submitting', 'unknown'].includes(after.status), after.error);
      assert.equal((await getDatabase().get('SELECT phase FROM trading_operations WHERE id = ?', [before.operationId])).phase, 'dispatching');
    } else assert.equal(after.status, phase === 'roundtrip' ? 'completed' : 'monitoring', after.error);
    if (before.plan) assert.deepEqual(after.plan, before.plan, 'Restart preserves original plan, deadline, price/tier decision and IDs.');
    if (before.ids.length) assert.deepEqual((await getDatabase().all('SELECT client_order_id FROM trading_orders WHERE intent_id = ? ORDER BY client_order_id',
      [fixture.intent.id])).map(row => row.client_order_id), before.ids);
    const attempts = (await calls(fixture.callsPath)).filter(row => row.event === 'attempt' && row.entry === entryId);
    assert.equal(attempts.length, phase === 'dispatching' ? 0 : 1, 'No blind second adapter submit, even if Paper would deduplicate the same ID.');
    await wake(runtime);
    assert.equal((await calls(fixture.callsPath)).filter(row => row.event === 'attempt' && row.entry === entryId).length, attempts.length);
    if (before.operationId) assert.equal((await getDatabase().get("SELECT COUNT(*) AS count FROM trading_operations WHERE intent_id = ? AND kind = 'protected_entry'", [fixture.intent.id])).count, 1);
    if (before.operationId) assert.equal((await getDatabase().get('SELECT generation FROM trading_operations WHERE id = ?', [before.operationId])).generation, 1);
    if (independent) assert.equal((await getTradingIntent(independent.id)).status, 'monitoring', 'An unresolved crashed account does not suppress independent authorized recovery/entries.');
  } finally { await runtime.stop(); }
}

async function hardCrashCases() {
  for (const phase of ['plan-before-commit', 'planned', 'prepared', 'dispatching', 'provider-before-accept',
    'accepted', 'ack-before-commit', 'acknowledged', 'roundtrip']) {
    const fixture = await prepareCase(phase);
    await crash(phase, fixture.databasePath, fixture.intent.id, fixture.callsPath);
    await initDb(fixture.databasePath);
    const before = await persistedCrashState(fixture, phase);
    await recoverCase(fixture, phase, before);
    assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
    await closeDb();
  }
}

async function expiredHardPreparation() {
  for (const phase of ['planned', 'prepared']) {
    const fixture = await prepareCase(`expired-${phase}`);
    await crash(phase, fixture.databasePath, fixture.intent.id, fixture.callsPath);
    await initDb(fixture.databasePath);
    const before = await persistedCrashState(fixture, phase);
    const expiredAt = before.plan.entryExpiresAt + 1;
    Date.now = () => expiredAt;
    const runtime = new TradingRuntime(new TradingEngine([fixture.paper]), 60_000);
    try {
      await runtime.startProtectionOnly();
      assert.equal((await getDatabase().get('SELECT status FROM trading_positions WHERE intent_id = ?', [fixture.intent.id])).status, 'closed',
        `${phase}: expired positively never-sent preparation must retire during recovery, without enabling entries.`);
      assert.equal((await calls(fixture.callsPath)).length, 0);
      assert.deepEqual((await getTradingIntent(fixture.intent.id)).plan, before.plan, 'Expiry never restarts or rewrites the original deadline.');
    } finally { await runtime.stop(); Date.now = originalNow; }
    await closeDb();
  }
}

async function importedOldCheckpointStaysStopped() {
  const fixture = await prepareCase('old-checkpoint');
  await crash('prepared', fixture.databasePath, fixture.intent.id, fixture.callsPath);
  await initDb(fixture.databasePath);
  const before = await persistedCrashState(fixture, 'prepared');
  const eligibility = await assessRestoreEligibility(getDatabase());
  assert.equal(eligibility.status, 'blocked');
  assert.throws(() => requireRestoreEligibility(eligibility), /Restore refused/,
    'The actual supported restore gate rejects an artifact containing this unresolved preparation.');
  // This is an explicitly imported old-checkpoint fixture, NOT a successful run of the forbidden restore workflow.
  await updateTradingRuntimeState({ executionEnabled: false, liveTradingEnabled: false, killSwitchActive: true,
    killSwitchReason: 'Imported checkpoint fixture; no restore certification' });
  await closeDb();
  const imported = path.join(directory, 'imported-old-checkpoint.db');
  await copyFile(fixture.databasePath, imported);
  await initDb(imported);
  const runtime = new TradingRuntime(new TradingEngine([fixture.paper]), 60_000);
  try {
    await runtime.startProtectionOnly();
    await wake(runtime);
    await assert.rejects(runtime.enableEntries(), /execution is disabled|kill switch/);
    assert.equal((await calls(fixture.callsPath)).length, 0, 'Import/reopen cannot activate or repeat economic entry dispatch.');
    assert.deepEqual((await getTradingIntent(fixture.intent.id)).plan, before.plan);
    const state = await getDatabase().get('SELECT execution_enabled, live_trading_enabled, kill_switch_active FROM trading_runtime_state');
    assert.deepEqual(state, { execution_enabled: 0, live_trading_enabled: 0, kill_switch_active: 1 });
  } finally { await runtime.stop(); }
  await closeDb();
}

async function expiredAcceptedStillProtected() {
  const fixture = await prepareCase('expired-accepted');
  await crash('accepted', fixture.databasePath, fixture.intent.id, fixture.callsPath);
  await initDb(fixture.databasePath);
  const before = await persistedCrashState(fixture, 'accepted');
  Date.now = () => before.plan.entryExpiresAt + 1;
  const runtime = new TradingRuntime(new TradingEngine([fixture.paper]), 60_000);
  try {
    await runtime.startProtectionOnly();
    assert.equal((await getTradingIntent(fixture.intent.id)).status, 'monitoring');
    const remote = await fixture.paper.openState(fixture.account);
    assert.equal(remote.positions.length, 1, 'Expired entry authority is not authority to erase an already accepted own position.');
    assert.equal(remote.orders.filter(order => order.role === 'stop_loss' && order.status === 'open').length, 1);
    assert.equal((await calls(fixture.callsPath)).filter(row => row.event === 'attempt').length, 1);
  } finally { await runtime.stop(); Date.now = originalNow; }
  await closeDb();
}

async function expiredUncertainCannotAbandon() {
  for (const phase of ['dispatching', 'provider-before-accept', 'ack-bearing-prepared']) {
    const fixture = await prepareCase(`expired-uncertain-${phase}`);
    const crashPhase = phase === 'ack-bearing-prepared' ? 'prepared' : phase;
    await crash(crashPhase, fixture.databasePath, fixture.intent.id, fixture.callsPath);
    await initDb(fixture.databasePath);
    const before = await persistedCrashState(fixture, crashPhase);
    if (phase === 'ack-bearing-prepared') {
      // Explicit contradictory legacy/corruption fixture after a genuine prepared hard crash; never evidence of no send.
      await getDatabase().run('UPDATE trading_operations SET evidence_json = ? WHERE id = ?',
        [JSON.stringify({ contradictoryAcknowledgement: true }), before.operationId]);
    }
    const initialAttempts = (await calls(fixture.callsPath)).filter(row => row.event === 'attempt').length;
    Date.now = () => before.plan.entryExpiresAt + 1;
    const runtime = new TradingRuntime(new TradingEngine([fixture.paper]), 60_000);
    try {
      await runtime.startProtectionOnly();
      await wake(runtime);
      await wake(runtime);
      const position = await getDatabase().get('SELECT status, quantity, closed_at FROM trading_positions WHERE intent_id = ?', [fixture.intent.id]);
      assert.deepEqual(position, { status: 'opening', quantity: '0', closed_at: null }, `${phase}: expiry cannot fabricate local closure.`);
      const operation = await getDatabase().get('SELECT phase, evidence_json, generation FROM trading_operations WHERE id = ?', [before.operationId]);
      assert.equal(operation.phase, crashPhase === 'prepared' ? 'prepared' : 'dispatching');
      assert.equal(operation.generation, 1);
      if (phase === 'ack-bearing-prepared') assert.deepEqual(JSON.parse(operation.evidence_json), { contradictoryAcknowledgement: true });
      assert.ok((await getDatabase().all('SELECT status FROM trading_orders WHERE intent_id = ?', [fixture.intent.id]))
        .every(order => !['cancelled', 'rejected', 'filled'].includes(order.status)), 'No invented terminal order outcome.');
      assert.equal((await calls(fixture.callsPath)).filter(row => row.event === 'attempt').length, initialAttempts);
      assert.equal((await getDatabase().get('SELECT COUNT(*) AS count FROM trading_paper_orders')).count, 0);
      assert.deepEqual((await getTradingIntent(fixture.intent.id)).plan, before.plan);
    } finally { await runtime.stop(); Date.now = originalNow; }
    await closeDb();
  }
}

async function tamperPreparedJournal(operationId, field) {
  if (field === 'request_json') {
    const row = await getDatabase().get('SELECT request_json FROM trading_operations WHERE id = ?', [operationId]);
    const request = JSON.parse(row.request_json);
    const originalQuantity = request.entry.quantity;
    request.entry.quantity = originalQuantity === '1' ? '2' : '1';
    assert.notEqual(request.entry.quantity, originalQuantity);
    const json = JSON.stringify(request), hash = createHash('sha256').update(json).digest('hex');
    await getDatabase().run('UPDATE trading_operations SET request_json = ?, request_hash = ? WHERE id = ?', [json, hash, operationId]);
  } else {
    // Fixed adversarial fixture columns only; no runtime/user-controlled identifier reaches this SQL.
    await getDatabase().run(`UPDATE trading_operations SET ${field} = ? WHERE id = ?`, [field === 'generation' ? 2 : 'f'.repeat(64), operationId]);
  }
  return getDatabase().get('SELECT * FROM trading_operations WHERE id = ?', [operationId]);
}

async function corruptPreparedIdentityCannotRetire() {
  const outcomes = [];
  const fields = ['request_hash', 'account_fingerprint', 'credential_generation', 'logical_key', 'generation', 'request_json'];
  for (const field of fields) {
    const fixture = await prepareCase(`corrupt-prepared-${field}`);
    await crash('prepared', fixture.databasePath, fixture.intent.id, fixture.callsPath);
    await initDb(fixture.databasePath);
    const before = await persistedCrashState(fixture, 'prepared');
    const corrupted = await tamperPreparedJournal(before.operationId, field);
    if (field === 'request_json') assert.equal(createHash('sha256').update(corrupted.request_json).digest('hex'), corrupted.request_hash,
      'A self-consistent request checksum is still not proof that its changed quantity matches the original plan.');
    Date.now = () => before.plan.entryExpiresAt + 1;
    const runtime = new TradingRuntime(new TradingEngine([fixture.paper]), 60_000);
    try {
      await runtime.startProtectionOnly();
      outcomes.push({ field,
        position: (await getDatabase().get('SELECT status FROM trading_positions WHERE intent_id = ?', [fixture.intent.id])).status,
        operation: (await getDatabase().get('SELECT phase FROM trading_operations WHERE id = ?', [before.operationId])).phase });
      assert.equal((await calls(fixture.callsPath)).length, 0);
      assert.deepEqual((await getTradingIntent(fixture.intent.id)).plan, before.plan);
      assert.deepEqual(await getDatabase().get('SELECT * FROM trading_operations WHERE id = ?', [before.operationId]), corrupted,
        'Recovery cannot silently repair or relabel a contradictory original journal.');
    } finally { await runtime.stop(); Date.now = originalNow; }
    await closeDb();
  }
  assert.deepEqual(outcomes, fields.map(field => ({ field, position: 'opening', operation: 'prepared' })),
    'Request, account, credential, logical-key and generation bindings are mandatory positive no-send authority.');
}

async function revokeOriginalAuthority(fixture, reason) {
  if (reason === 'execution') await updateTradingRuntimeState({ executionEnabled: false });
  else if (reason === 'account') await getDatabase().run('UPDATE trading_accounts SET enabled = 0 WHERE id = ?', [fixture.account.id]);
  else await setTradingRoute({ channelId: fixture.intent.channelId, strategyVersionId: fixture.intent.strategyVersionId,
    accountId: fixture.account.id, enabled: false });
}

async function assertNeighborProtection(fixture, originalStops) {
  const remote = await fixture.paper.openState(fixture.account);
  assert.ok(remote.positions.some(position => position.symbol === 'BTCUSDT' && position.quantity !== '0'),
    'Revoking unsent entry authority cannot erase neighboring actual own exposure.');
  assert.deepEqual(remote.orders.filter(order => originalStops.includes(order.clientOrderId) && order.status === 'open')
    .map(order => order.clientOrderId).sort(), originalStops, 'Existing own stops remain active without cancellation/replacement.');
}

async function revokedPreparationCase(phase, reason) {
  const fixture = await prepareCase(`revoked-${phase}-${reason}`, { neighbor: true });
  await crash(phase, fixture.databasePath, fixture.intent.id, fixture.callsPath);
  await initDb(fixture.databasePath);
  const before = await persistedCrashState(fixture, phase);
  const originalStops = (await fixture.paper.openState(fixture.account)).orders
    .filter(order => order.symbol === 'BTCUSDT' && order.role === 'stop_loss' && order.status === 'open').map(order => order.clientOrderId).sort();
  assert.equal(originalStops.length, 1);
  await revokeOriginalAuthority(fixture, reason);
  assert.equal(await hasUndispatchedPlanProof(await getTradingIntent(fixture.intent.id), false), true,
    'The actual original-request/account/leg journal still positively proves no dispatch; remote absence is not the basis.');
  const initialAttempts = (await calls(fixture.callsPath)).length;
  const now = originalNow();
  assert.ok(now + 10_001 < before.plan.entryExpiresAt, 'Both startup and periodic observation are inside the original TTL.');
  const runtime = new TradingRuntime(new TradingEngine([fixture.paper]), 60_000);
  const snapshots = [];
  try {
    await runtime.startProtectionOnly();
    for (const stage of ['startup', 'periodic']) {
      if (stage === 'periodic') { Date.now = () => now + 10_001; await wake(runtime); }
      await assertNeighborProtection(fixture, originalStops);
      const position = await getDatabase().get('SELECT status FROM trading_positions WHERE intent_id = ?', [fixture.intent.id]);
      const operation = await getDatabase().get('SELECT phase FROM trading_operations WHERE id = ?', [before.operationId ?? 'none']);
      const current = await getTradingIntent(fixture.intent.id);
      const orders = await getDatabase().all('SELECT status FROM trading_orders WHERE intent_id = ?', [fixture.intent.id]);
      snapshots.push({ phase, reason, stage, position: position.status, operation: operation?.phase ?? null,
        terminalIntent: ['blocked', 'failed', 'cancelled'].includes(current.status), cancelledLegs: orders.every(order => order.status === 'cancelled') });
      assert.equal((await calls(fixture.callsPath)).length, initialAttempts, 'Protection-only runtime never creates an entry after revocation.');
      assert.deepEqual((await getTradingIntent(fixture.intent.id)).plan, before.plan);
      assert.equal((await getDatabase().get('SELECT kill_switch_active FROM trading_runtime_state')).kill_switch_active, 0,
        'The fixture uses execution/account/route revocation, never a global kill or artificial runtime release.');
    }
  } finally { await runtime.stop(); Date.now = originalNow; }
  await closeDb();
  return snapshots;
}

async function revokedPreparedAuthorityCannotRevive() {
  const observations = [], expected = [];
  for (const phase of ['planned', 'prepared']) for (const reason of ['execution', 'account', 'route']) {
    observations.push(...await revokedPreparationCase(phase, reason));
    for (const stage of ['startup', 'periodic']) expected.push({ phase, reason, stage,
      position: 'closed', operation: phase === 'prepared' ? 'abandoned' : null, terminalIntent: true, cancelledLegs: true });
  }
  assert.deepEqual(observations, expected,
    'A positively unsent original plan that loses authority must retire locally during actual startup/periodic recovery, even before TTL.');
}

try {
  await revokedPreparedAuthorityCannotRevive();
  await hardCrashCases();
  await expiredHardPreparation();
  await importedOldCheckpointStaysStopped();
  await expiredAcceptedStillProtected();
  await expiredUncertainCannotAbandon();
  await corruptPreparedIdentityCannotRetire();
  console.log('Protected-entry hard process crashes preserve journal phases, original intent and conservative runtime recovery.');
} finally {
  Date.now = originalNow;
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
