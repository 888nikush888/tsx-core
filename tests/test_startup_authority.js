import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import { StartupAuthority, STARTUP_GATES, runStartupGate, waitForStartupListener } from '../src/startup_authority.js';
import { closeDb, initDb } from '../src/db.js';
import { McpControlBridge } from '../src/mcp_control_bridge.js';
import { createMcpAgent, enqueueMcpControlRequest, getMcpControlRequest, setMcpRuntimeMode,
  waitForMcpControlRequest } from '../src/mcp_repository.js';

const ready = authority => {
  authority.beginRecovery();
  for (const gate of STARTUP_GATES) authority.completeGate(gate);
  authority.release();
};
const authority = new StartupAuthority();
assert.equal(authority.snapshot().phase, 'initial');
assert.equal(authority.canMutate(), false);
assert.equal(authority.canProtect(), false);
authority.beginRecovery();
assert.equal(authority.canProtect(), true);
for (const gate of STARTUP_GATES.slice(0, -1)) authority.completeGate(gate);
assert.throws(() => authority.release(), /gate/i);
assert.equal(authority.canMutate(), false, 'Finishing earlier gates must never produce a brief ready window.');
authority.failGate(STARTUP_GATES.at(-1), 'late backup failure');
assert.equal(authority.snapshot().phase, 'blocked');
assert.throws(() => authority.completeGate(STARTUP_GATES.at(-1)), /blocked/i);
assert.throws(() => authority.release(), /blocked/i);

const suspended = new StartupAuthority();
ready(suspended);
assert.equal(suspended.canEnter(), false, 'An editable empty setup must not imply that Telegram routing is ready.');
suspended.completeGate('routing');
assert.equal(suspended.canEnter(), true);
const releaseFirst = suspended.holdMutations('backup restore');
const releaseSecond = suspended.holdMutations('second participant');
assert.equal(suspended.canProtect(), true, 'Administrative suspension must not disable existing exposure protection.');
assert.equal(suspended.canMutate(), false);
releaseFirst();
releaseFirst();
assert.equal(suspended.canMutate(), false, 'Releasing one capability must not release another owner.');
releaseSecond();
assert.equal(suspended.canEnter(), true);
const obsoleteRelease = suspended.holdMutations('shutdown in progress');
suspended.block('fatal startup failure');
obsoleteRelease();
assert.equal(suspended.canMutate(), false, 'A late maintenance release cannot resurrect a blocked process.');
assert.equal(suspended.canProtect(), true, 'A later gate failure must not revoke already authorized protection.');

const gateFailure = new StartupAuthority();
gateFailure.beginRecovery();
await assert.rejects(runStartupGate(gateFailure, 'dashboard', async () => { throw new Error('EADDRINUSE fixture'); }), /EADDRINUSE/);
assert.equal(gateFailure.snapshot().phase, 'blocked');
assert.match(gateFailure.snapshot().reason, /dashboard.*EADDRINUSE/);
await runStartupGate(gateFailure, 'backup', async () => undefined);
assert.equal(gateFailure.canMutate(), false, 'A later successful infrastructure operation must not unlock a failed startup.');
const listener = createServer();
listener.listen(0, '127.0.0.1');
await waitForStartupListener(listener);
await waitForStartupListener(listener);
const occupied = createServer();
const rejectedListener = assert.rejects(waitForStartupListener(occupied), /EADDRINUSE/);
occupied.listen(listener.address().port, '127.0.0.1');
await rejectedListener;
await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-startup-authority-'));
let bridge;
try {
  await initDb(path.join(directory, 'test.db'));
  await setMcpRuntimeMode('active', 'test:local');
  const { agent } = await createMcpAgent({ name: 'Fake operator', permissions: ['contracts.write'] });
  const request = await enqueueMcpControlRequest({ agentId: agent.id, sessionId: null,
    action: 'contracts.create', payload: { name: 'Local fake only' } });
  let mutations = 0;
  const control = { createSignalContract: () => { mutations += 1; return { id: 'fixture' }; } };
  bridge = new McpControlBridge(control, { record: async () => undefined }, () => undefined, 50, authority);
  await bridge.start();
  await delay(130);
  assert.equal(mutations, 0, 'A persisted MCP request must not bypass a blocked startup.');
  assert.equal((await getMcpControlRequest(request.id)).status, 'pending');
  await bridge.stop();

  const nextStartup = new StartupAuthority();
  nextStartup.beginRecovery();
  bridge = new McpControlBridge(control, { record: async () => undefined }, () => undefined, 50, nextStartup);
  await bridge.start();
  await delay(130);
  assert.equal(mutations, 0, 'Recovery-only cannot claim general MCP mutations.');
  assert.equal((await getMcpControlRequest(request.id)).status, 'pending');
  for (const gate of STARTUP_GATES) nextStartup.completeGate(gate);
  nextStartup.release();
  assert.equal((await waitForMcpControlRequest(request.id, 3000)).status, 'succeeded');
  assert.equal(mutations, 1);
  await delay(130);
  assert.equal(mutations, 1);
  nextStartup.block('maintenance');
  const pending = await enqueueMcpControlRequest({ agentId: agent.id, sessionId: null,
    action: 'contracts.create', payload: { name: 'Still pending' } });
  await delay(130);
  assert.equal((await getMcpControlRequest(pending.id)).status, 'pending');
  assert.equal(mutations, 1);
  await bridge.stop();

  // Revocation during an awaited authorization audit must also stop actual execution.
  const auditRace = new StartupAuthority();
  ready(auditRace);
  bridge = new McpControlBridge(control, { record: async event => {
    if (event.phase === 'authorized') auditRace.block('shutdown during audit');
  } }, () => undefined, 50, auditRace);
  await bridge.start();
  assert.equal((await waitForMcpControlRequest(pending.id, 3000)).status, 'failed');
  assert.equal(mutations, 1);
  console.log('Startup authority: fail-closed phases, deferred MCP claim, release and revocation race passed.');
} finally {
  await bridge?.stop();
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
