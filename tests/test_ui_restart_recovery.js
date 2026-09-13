import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay, setImmediate } from 'node:timers/promises';
import { startWebServer, stopWebServer } from '../src/web_server.js';
import { UiOperationStore } from '../src/ui_operation_store.js';
import { assertRestartReceiptsPreserved, RESTART_RESPONSE_GRACE_MS, UiRestartCoordinator } from '../src/ui_restart_coordinator.js';
import { ADMIN, VIEWER, COMMANDS, commandRequest, createRestartFixture, deferred } from './fixtures/ui_restart_fixture.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tsx-restart-recovery-'));
if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('tsx-restart-recovery-')) throw new Error('Unsafe fixture cleanup.');
const oldEnvironment = { ...process.env };
const originalRename = fs.rename;
const bounded = promise => Promise.race([promise, delay(5_000, null, { ref: false }).then(() => { throw new Error('Restart fixture timed out.'); })]);
let server = null;
let fixtureIndex = 0;

async function fixture() {
  if (server) { await stopWebServer(); server = null; }
  const directory = path.join(root, String(fixtureIndex++));
  await fs.mkdir(directory);
  const fixture = await createRestartFixture(directory, 'http-generation');
  server = startWebServer(0, fixture.app);
  await once(server, 'listening');
  return { ...fixture, directory, base: `http://127.0.0.1:${server.address().port}` };
}

async function request(fixture, command, id, overrides = {}) {
  const response = await fetch(fixture.base + command.route, { ...commandRequest(command, id), ...overrides });
  return { status: response.status, body: await response.json() };
}

async function disconnectedCommand(fixture, command, id) {
  const done = deferred(); fixture.controls.barrier = done.promise;
  const closed = deferred();
  server.once('request', (_request, response) => response.once('close', closed.resolve));
  const options = commandRequest(command, id);
  const client = http.request(fixture.base + command.route, options);
  client.on('error', () => undefined);
  client.end(options.body);
  await bounded(fixture.controls.entered.promise);
  client.destroy();
  await bounded(closed.promise);
  done.resolve();
  await bounded(fixture.controls.restarted.promise);
  await setImmediate();
}

async function assertReceipt(fixture, command, id) {
  const receipt = JSON.parse(await fs.readFile(path.join(fixture.directory, 'jobs', `${id}.json`), 'utf8'));
  assert.equal(receipt.kind, command.kind);
  assert.equal(receipt.state, 'awaiting-restart');
  assert.equal(receipt.restart.sourceInstanceId, 'http-generation');
  assert.equal(receipt.restart.receipt, 'durable');
  assert.equal((await request(fixture, command, id)).status, 202);
  assert.equal(fixture.controls.work, 1, 'Bound replay must not repeat stopped/destructive work, including during maintenance.');
  assert.equal(fixture.controls.restart, 1);
  const diskStore = new UiOperationStore(path.join(fixture.directory, 'jobs'), 'next-generation');
  const observed = await diskStore.get(id);
  assert.equal(observed.state, 'succeeded');
  assert.equal(observed.restart.observedInstanceId, 'next-generation');
  let unexpectedRestart = 0;
  await new UiRestartCoordinator(diskStore, () => { unexpectedRestart++; }).reconcile();
  assert.equal(unexpectedRestart, 0, 'The prior generation intent cannot restart the replacement process.');
}

async function testDisconnectMatrix() {
  for (const command of COMMANDS) {
    for (const disconnect of [false, true]) {
      const current = await fixture();
      const id = `recovery-${command.kind}-${disconnect}`;
      if (disconnect) await disconnectedCommand(current, command, id);
      else assert.equal((await request(current, command, id)).status, command.status);
      await assertReceipt(current, command, id);
    }
  }
}

async function testBindingAndGates() {
  const command = COMMANDS[1];
  const current = await fixture(); const id = 'recovery-binding-job';
  const valid = commandRequest(command, id);
  for (const [headers, status] of [
    [{ ...valid.headers, Authorization: `Bearer ${VIEWER}` }, 403],
    [{ ...valid.headers, Origin: 'https://untrusted.example' }, 403],
    [{ ...valid.headers, 'X-Destructive-Confirmation': '' }, 412],
    [{ ...valid.headers, 'X-Requested-With': '' }, 400],
  ]) assert.equal((await request(current, command, id, { headers })).status, status);
  current.controls.blockAudit = async () => { throw new Error('audit unavailable'); };
  assert.equal((await request(current, command, id)).status, 503);
  current.controls.blockAudit = null;
  const release = current.authority.holdMutations('existing maintenance');
  assert.equal((await request(current, command, id)).status, 503);
  assert.equal(await current.store.get(id), null);
  release();
  assert.equal((await request(current, command, id)).status, 200);
  assert.equal((await request(current, command, id, { body: JSON.stringify({ jobId: id, name: 'backup-2026-different' }) })).status, 409);
  process.env.DASHBOARD_ADMIN_TOKEN = `${ADMIN}rotated`;
  assert.equal((await request(current, command, id, { headers: { ...valid.headers, Authorization: `Bearer ${ADMIN}rotated` } })).status, 409);
  process.env.DASHBOARD_ADMIN_TOKEN = ADMIN;
  assert.equal((await request(current, COMMANDS[2], id)).status, 409, 'Kind is bound along with actor and request.');
  assert.equal(current.controls.work, 1);
  const reset = await fixture();
  reset.app.getOperationsStatus = () => ({ backup: { healthy: false } });
  assert.equal((await request(reset, COMMANDS[2], 'recovery-backup-block')).status, 409);
  assert.equal(reset.controls.work, 0);
  assert.equal(reset.controls.restart, 0);
  const unavailable = await fixture(); unavailable.app.uiOperations = undefined;
  assert.equal((await request(unavailable, COMMANDS[2], 'recovery-no-store')).status, 503);
  assert.equal(unavailable.controls.work, 0);
}

async function testReceiptFailure() {
  for (const command of COMMANDS) {
    const current = await fixture(); const id = `recovery-receipt-${command.kind}`;
    let failedWrites = 0;
    fs.rename = async (from, to) => {
      if (to === path.join(current.directory, 'jobs', `${id}.json`)) {
        const pending = JSON.parse(await fs.readFile(from, 'utf8'));
        if (pending.restart) { failedWrites++; throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' }); }
      }
      return originalRename(from, to);
    };
    const response = await request(current, command, id);
    fs.rename = originalRename;
    assert.equal(response.status, command.status);
    assert.equal(response.body.receiptUncertain, true);
    assert.equal(response.body.job.state, 'unknown', 'Successful work plus failed receipt is never reported as a failed operation.');
    assert.equal(response.body.job.restart.receipt, 'uncertain');
    assert.equal(failedWrites, 2);
    assert.equal(current.controls.restart, 1);
    assert.equal((await request(current, command, id)).body.job.state, 'unknown');
    assert.equal(current.controls.work, 1);
    const disk = new UiOperationStore(path.join(current.directory, 'jobs'), 'replacement-generation');
    assert.equal((await disk.get(id)).state, 'unknown', 'A surviving running receipt never invents a committed result after a crash.');
  }
}

async function testTransientReceiptFailure() {
  const current = await fixture(); const id = 'recovery-transient-receipt';
  let failed = false;
  fs.rename = async (from, to) => {
    if (!failed && to.endsWith(`${id}.json`) && JSON.parse(await fs.readFile(from, 'utf8')).restart) {
      failed = true; throw new Error('Transient receipt failure.');
    }
    return originalRename(from, to);
  };
  const response = await request(current, COMMANDS[2], id);
  fs.rename = originalRename;
  assert.equal(response.body.job.state, 'unknown');
  const onDisk = JSON.parse(await fs.readFile(path.join(current.directory, 'jobs', `${id}.json`), 'utf8'));
  assert.equal(onDisk.restart.receipt, 'uncertain');
  const observed = await new UiOperationStore(path.join(current.directory, 'jobs'), 'new-generation').get(id);
  assert.equal(observed.state, 'unknown', 'A new generation preserves uncertainty even when the fallback receipt was saved.');
  assert.equal(observed.restart.observedInstanceId, 'new-generation');
}

async function testWorkFailureAndFallback() {
  const failed = await fixture(); failed.controls.failWork = true;
  const command = COMMANDS[1]; const id = 'recovery-failed-command';
  assert.equal((await request(failed, command, id)).status, 409);
  assert.equal((await request(failed, command, id)).body.job.state, 'failed');
  assert.equal(failed.controls.restart, 0);
  assert.equal(failed.controls.work, 1);
  const uncertain = await fixture(); uncertain.controls.failWork = true;
  fs.rename = async (from, to) => {
    if (to.endsWith('recovery-failed-receipt.json') && JSON.parse(await fs.readFile(from, 'utf8')).state === 'failed') throw new Error('Failure receipt unavailable.');
    return originalRename(from, to);
  };
  assert.equal((await request(uncertain, command, 'recovery-failed-receipt')).status, 409);
  fs.rename = originalRename;
  assert.equal((await request(uncertain, command, 'recovery-failed-receipt')).body.job.state, 'unknown');
  assert.equal(uncertain.controls.work, 1);
  assert.equal(uncertain.controls.restart, 0, 'An uncertain failure receipt cannot authorize a restart for unconfirmed work.');
  const stalled = await fixture(); const barrier = deferred();
  stalled.controls.blockAudit = async event => { if (event.phase === 'completed') await barrier.promise; };
  const pending = request(stalled, command, 'recovery-stalled-response');
  await bounded(stalled.controls.restarted.promise);
  assert.equal(stalled.controls.restart, 1, 'A stalled audit/response finish cannot strand confirmed work.');
  barrier.resolve(); await pending;
  await delay(RESTART_RESPONSE_GRACE_MS + 50);
  assert.equal(stalled.controls.restart, 1, 'Fallback, finish and close share the same once-only action.');
}

async function testCoordinatorEdges() {
  const current = await fixture(); const id = 'recovery-autonomous-intent';
  await current.store.accept({ id, kind: 'restart', actorId: 'fixture:admin', scope: {}, request: {} });
  const job = await current.store.runRestart(id, () => Promise.resolve(({})));
  let restarts = 0;
  const coordinator = new UiRestartCoordinator(current.store, () => { restarts++; });
  const response = new EventEmitter(); response.writableFinished = true;
  assert.equal(coordinator.schedule(job, response), true, 'A response already finished before registration completes the restart.');
  response.emit('finish'); response.emit('close');
  assert.equal(coordinator.schedule(job, response), false);
  assert.equal(restarts, 1);
  const reloaded = new UiOperationStore(path.join(current.directory, 'jobs'), 'http-generation');
  let resumed = 0;
  await new UiRestartCoordinator(reloaded, () => { resumed++; }).reconcile();
  assert.equal(resumed, 1, 'A persisted same-generation intent completes without an HTTP response.');
  assert.equal(coordinator.schedule({ ...job, id: 'different-job', state: 'failed' }), false);
  assert.equal(coordinator.schedule({ ...job, id: 'different-job', restart: { ...job.restart, sourceInstanceId: 'wrong-generation' } }), false);
  const receipts = path.join(root, 'configuration', '.ui-operations');
  assert.doesNotThrow(() => assertRestartReceiptsPreserved(receipts, [path.join(root, 'session_data'), path.join(root, 'configuration', '.ui-operations-old')]));
  assert.throws(() => assertRestartReceiptsPreserved(receipts, [receipts]), /outside every erased directory/);
  assert.throws(() => assertRestartReceiptsPreserved(receipts, [root]), /outside every erased directory/);
}

try {
  process.env.DASHBOARD_AUTH_MODE = 'token'; process.env.DASHBOARD_ADMIN_TOKEN = ADMIN; process.env.DASHBOARD_VIEWER_TOKEN = VIEWER;
  await testDisconnectMatrix();
  await testBindingAndGates();
  await testReceiptFailure();
  await testTransientReceiptFailure();
  await testWorkFailureAndFallback();
  await testCoordinatorEdges();
  console.log('Restart/restore/reset: real HTTP disconnect/replay, durable receipts, I/O uncertainty, generation/auth/maintenance gates and bounded completion passed.');
} finally {
  fs.rename = originalRename;
  if (server) await stopWebServer();
  await fs.rm(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in oldEnvironment)) delete process.env[key];
  Object.assign(process.env, oldEnvironment);
}
