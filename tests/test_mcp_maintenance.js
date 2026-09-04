import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { acquireProcessLock } from '../src/process_lock.js';
import { assertMcpMaintenanceLease, beginMcpOfflineMaintenance, beginMcpSharedMaintenance, clearMcpMaintenanceMarker, createMaintenanceWorkTracker,
  databaseFileIdentity, mcpMaintenanceActive, mcpMaintenanceMarkerPath, readMcpMaintenanceRequest,
  registerDatabaseMaintenanceParticipant } from '../src/mcp_maintenance.js';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function fixture(test) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-mcp-maintenance-'));
  const databasePath = path.join(directory, 'forwarder.db');
  const seed = await open({ filename: databasePath, driver: sqlite3.Database });
  await seed.exec('CREATE TABLE proof (value TEXT); INSERT INTO proof VALUES (\'untouched\');');
  await seed.close();
  const owner = await acquireProcessLock(path.join(directory, '.process_active'));
  try { await test({ directory, databasePath, owner }); } finally { await owner.release(); await rm(directory, { recursive: true, force: true }); }
}

async function member(databasePath) {
  const participant = await registerDatabaseMaintenanceParticipant(databasePath);
  const database = await open({ filename: databasePath, driver: sqlite3.Database });
  await participant.afterOpen();
  return { participant, database, closed: false, async close() {
    if (this.closed) return;
    await participant.closeStarted();
    await database.close();
    this.closed = true;
    await participant.closeSucceeded();
  } };
}

await fixture(async ({ databasePath, owner }) => {
  assert.equal(await mcpMaintenanceActive(databasePath), false);
  assert.match(await databaseFileIdentity(databasePath), /^\d+:\d+$/);
  await assert.rejects(beginMcpSharedMaintenance('bad\nreason', databasePath, owner), /reason is invalid/);
  await assert.rejects(beginMcpSharedMaintenance('owner missing', databasePath), /ownership capability/);
  const before = Date.now();
  const lease = await beginMcpSharedMaintenance('bounded maintenance', databasePath, owner);
  assert.ok(Date.now() - before < 500, 'Begin must publish a request, not pretend a fixed sleep proves closure.');
  assert.equal(lease.markerPath, mcpMaintenanceMarkerPath(databasePath));
  assert.equal(await mcpMaintenanceActive(databasePath), true);
  assert.deepEqual(await readMcpMaintenanceRequest(databasePath), lease.request);
  assert.ok(lease.protectedEntries.includes('.mcp-participants'));
  await assert.rejects(lease.assertQuiescent(), /not acknowledged/);
  await assert.rejects(assertMcpMaintenanceLease({ ...lease, assertQuiescent: async () => {} }, databasePath), /genuine.*lease/i);
  await assert.rejects(assertMcpMaintenanceLease(lease, `${databasePath}.different`), /database scope/i);
  await assert.rejects(assertMcpMaintenanceLease(lease, databasePath), /not acknowledged/);
  await assert.rejects(clearMcpMaintenanceMarker(databasePath), /owning lease/);
  await assert.rejects(beginMcpSharedMaintenance('second owner', databasePath, owner), /already active/);
  await assert.rejects(registerDatabaseMaintenanceParticipant(databasePath), /before SQLite open/);
  await lease.waitForQuiescence();
  await lease.assertQuiescent();
  await assertMcpMaintenanceLease(lease, databasePath);
  await lease.release();
  await lease.release();
  await assert.rejects(assertMcpMaintenanceLease(lease, databasePath), /released/);
  assert.equal(await mcpMaintenanceActive(databasePath), false);
});

await fixture(async ({ databasePath, owner }) => {
  const active = await member(databasePath);
  const lease = await beginMcpSharedMaintenance('slow handle close', databasePath, owner, { timeoutMs: 4000 });
  let quiescent = false;
  const waiting = lease.waitForQuiescence().then(() => { quiescent = true; });
  const closing = delay(1250).then(() => active.close());
  try {
    await delay(1050);
    assert.equal(quiescent, false, 'The old one-second sleep would release while the real SQLite handle is still open.');
    await Promise.all([waiting, closing]);
    await lease.assertQuiescent();
    assert.equal(active.closed, true);
    await rename(databasePath, `${databasePath}.preserved`); // Test-owned file replacement only after genuine close.
    await writeFile(databasePath, 'replacement fixture');
    await assert.rejects(lease.assertQuiescent(), /Database changed/);
  } finally { await active.close(); await lease.release(); }
});

await fixture(async ({ databasePath, owner }) => {
  const active = await member(databasePath);
  const original = await readFile(databasePath);
  const lease = await beginMcpSharedMaintenance('missing acknowledgement', databasePath, owner, { timeoutMs: 100 });
  try {
    await assert.rejects(lease.waitForQuiescence(), /deadline expired/);
    assert.deepEqual(await readFile(databasePath), original, 'Timeout must not replace or mutate the database.');
    await assert.rejects(lease.assertQuiescent(), /not acknowledged/);
  } finally { await active.close(); await lease.release(); }
});

await fixture(async ({ databasePath, directory, owner }) => {
  const first = await member(databasePath);
  const oldLease = await beginMcpSharedMaintenance('old request', databasePath, owner);
  await first.close();
  const oldAck = JSON.parse(await readFile(path.join(directory, '.mcp-maintenance-acks', `${oldLease.request.nonce}.${first.participant.id}.json`), 'utf8'));
  await oldLease.waitForQuiescence();
  await oldLease.release();
  const active = await member(databasePath);
  const lease = await beginMcpSharedMaintenance('new generation', databasePath, owner, { timeoutMs: 150 });
  try {
    assert.equal(lease.request.generation, oldLease.request.generation + 1);
    assert.notEqual(lease.request.nonce, oldLease.request.nonce);
    await active.close();
    const ackPath = path.join(directory, '.mcp-maintenance-acks', `${lease.request.nonce}.${active.participant.id}.json`);
    const correct = JSON.parse(await readFile(ackPath, 'utf8'));
    await writeFile(ackPath, JSON.stringify({ ...correct, nonce: oldAck.nonce, generation: oldAck.generation }));
    await assert.rejects(lease.waitForQuiescence(), /deadline expired/, 'Old nonce/generation acknowledgements cannot authorize a new replacement.');
  } finally { await active.close(); await lease.release(); }
});

await fixture(async ({ databasePath, owner }) => {
  const lease = await beginMcpSharedMaintenance('owner identity', databasePath, owner);
  const original = await readFile(lease.markerPath, 'utf8');
  const changed = { ...lease.request, ownerInstance: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' };
  await writeFile(lease.markerPath, JSON.stringify(changed));
  await assert.rejects(lease.release(), /ownership.*changed/);
  assert.deepEqual(JSON.parse(await readFile(lease.markerPath, 'utf8')), changed);
  await writeFile(lease.markerPath, original);
  await lease.release();
});

await fixture(async ({ databasePath, owner }) => {
  const participant = await registerDatabaseMaintenanceParticipant(databasePath);
  const lease = await beginMcpSharedMaintenance('opening race', databasePath, owner);
  const database = await open({ filename: databasePath, driver: sqlite3.Database });
  try {
    await assert.rejects(participant.afterOpen(), /started during SQLite open/);
    await assert.rejects(lease.assertQuiescent(), /not acknowledged/);
  } finally { await database.close(); await participant.closeSucceeded(); }
  await lease.waitForQuiescence();
  await lease.release();
});

await fixture(async ({ databasePath, owner }) => {
  const active = await member(databasePath);
  const lease = await beginMcpSharedMaintenance('failed close', databasePath, owner, { timeoutMs: 100 });
  await active.participant.closeStarted();
  await active.participant.closeFailed();
  try { await assert.rejects(lease.waitForQuiescence(), /deadline expired/); }
  finally { await active.close(); await lease.release(); }
});

await fixture(async ({ databasePath, owner }) => {
  const active = await member(databasePath);
  const lease = await beginMcpSharedMaintenance('uncertain process status', databasePath, owner, { timeoutMs: 100 });
  const originalKill = process.kill;
  process.kill = () => { throw Object.assign(new Error('Fixture cannot inspect process'), { code: 'EPERM' }); };
  try {
    await assert.rejects(lease.waitForQuiescence(), /deadline expired/, 'An uninspectable process is not evidence of native handle closure.');
  } finally { process.kill = originalKill; await active.close(); await lease.release(); }
});

await fixture(async ({ databasePath, owner, directory }) => {
  const first = await member(databasePath);
  const second = await member(databasePath);
  const lease = await beginMcpSharedMaintenance('two native handles in the same process', databasePath, owner);
  await first.close();
  let quiescent = false;
  const waiting = lease.waitForQuiescence().then(() => { quiescent = true; });
  try {
    await delay(100);
    assert.equal(quiescent, false, 'One closed handle must not acknowledge another generation in the same PID.');
    await second.close();
    await waiting;
    const firstAck = JSON.parse(await readFile(path.join(directory, '.mcp-maintenance-acks', `${lease.request.nonce}.${first.participant.id}.json`), 'utf8'));
    const secondAck = JSON.parse(await readFile(path.join(directory, '.mcp-maintenance-acks', `${lease.request.nonce}.${second.participant.id}.json`), 'utf8'));
    assert.equal(firstAck.pid, secondAck.pid);
    assert.notEqual(firstAck.participantGeneration, secondAck.participantGeneration);
    await lease.assertQuiescent();
  } finally { await first.close(); await second.close(); await waiting; await lease.release(); }
});

await fixture(async ({ databasePath, owner }) => {
  const fixturePath = fileURLToPath(new URL('./fixtures/maintenance_participant_child.js', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', fixturePath, databasePath], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  let lease;
  try {
    const [ready] = await once(child, 'message');
    assert.equal(ready.state, 'opened');
    lease = await beginMcpSharedMaintenance('dead participant', databasePath, owner, { timeoutMs: 3000 });
    await assert.rejects(lease.assertQuiescent(), /not acknowledged/);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    await lease.waitForQuiescence();
    await lease.assertQuiescent();
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    await lease?.release();
  }
});

const tracker = createMaintenanceWorkTracker();
let finish;
const pending = tracker.run(() => new Promise(resolve => { finish = resolve; }));
await delay(0);
const draining = tracker.stopAndDrain(Date.now() + 1000);
await assert.rejects(tracker.run(async () => 'new mutation'), /new database work is blocked/);
finish('old work finished');
await Promise.all([pending, draining]);

const blockedTracker = createMaintenanceWorkTracker();
let finishBlocked;
const blocked = blockedTracker.run(() => new Promise(resolve => { finishBlocked = resolve; }));
await delay(0);
await assert.rejects(blockedTracker.stopAndDrain(Date.now() + 30), /did not drain/);
await assert.rejects(blockedTracker.run(async () => 'late mutation'), /new database work is blocked/);
finishBlocked();
await blocked;

await fixture(async ({ databasePath, owner }) => {
  await rename(databasePath, `${databasePath}.preserved`);
  await assert.rejects(beginMcpSharedMaintenance('present only', databasePath, owner), /ENOENT/);
  const lease = await beginMcpOfflineMaintenance('absent destination', databasePath, owner);
  try {
    assert.equal(lease.request.databaseState, 'absent');
    assert.equal(lease.request.databaseIdentity, null);
    await lease.waitForQuiescence();
    await assertMcpMaintenanceLease(lease, databasePath);
    await assert.rejects(registerDatabaseMaintenanceParticipant(databasePath), /before SQLite open/);
    await writeFile(`${databasePath}-wal`, 'unexpected WAL fixture');
    await assert.rejects(assertMcpMaintenanceLease(lease, databasePath), /existing DB, WAL or SHM/);
  } finally { await lease.release(); }
});

await fixture(async ({ databasePath, owner }) => {
  await rename(databasePath, `${databasePath}.preserved`);
  await writeFile(`${databasePath}-shm`, 'unresolved sidecar fixture');
  await assert.rejects(beginMcpOfflineMaintenance('unproved absence', databasePath, owner), /existing DB, WAL or SHM/);
  assert.equal(await mcpMaintenanceActive(databasePath), false);
});

await fixture(async ({ databasePath, owner }) => {
  await rename(databasePath, `${databasePath}.preserved`);
  const opening = await registerDatabaseMaintenanceParticipant(databasePath);
  const lease = await beginMcpOfflineMaintenance('opening participant in absent scope', databasePath, owner, { timeoutMs: 100 });
  try {
    await assert.rejects(lease.waitForQuiescence(), /deadline expired/, 'Absent DB bytes do not prove an already registered participant is quiescent.');
  } finally { await opening.closeSucceeded(); await lease.release(); }
});

console.log('MCP maintenance: real closure acknowledgements, generations, ownership, entry fence, timeout and hard process death passed.');
