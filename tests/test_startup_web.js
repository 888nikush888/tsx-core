import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb } from '../src/db.js';
import { StartupAuthority, STARTUP_GATES, waitForStartupListener } from '../src/startup_authority.js';
import { startWebServer, stopWebServer } from '../src/web_server.js';

let changes = 0;
let revokeDuringAudit = false;
const authority = new StartupAuthority();
const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-startup-web-'));
await initDb(path.join(directory, 'test.db'));
const state = {
  config: {}, state: {}, startupAuthority: authority,
  getQueueState: () => ({ running: 0, queued: 0, maxConcurrency: 1, paused: true }),
  startForwarding: async () => {}, stopForwarding: async () => {}, reloadConfig: () => {}, applyRuntimeConfig: () => {},
  authenticator: { mode: 'token', isConfigured: () => true,
    authenticate: async () => ({ id: 'local-fake-admin', role: 'admin' }) },
  auditTrail: { record: async event => {
    if (event.phase === 'authorized' && revokeDuringAudit) authority.block('revoked during audit');
  } },
  secretStore: { status: () => ({}) },
  runtimeSettings: { snapshot: () => ({}), set: async () => { changes += 1; return {}; } },
};
const listener = startWebServer(0, state, '127.0.0.1');
try {
  await waitForStartupListener(listener);
  const base = `http://127.0.0.1:${listener.address().port}`;
  const mutate = () => fetch(`${base}/api/runtime-settings`, {
    method: 'POST', headers: { 'X-Requested-With': 'forwarder-dashboard', 'Content-Type': 'application/json' }, body: '{}',
  });
  let response = await mutate();
  assert.equal(response.status, 503, 'An authenticated admin cannot mutate while startup gates are incomplete.');
  assert.equal(changes, 0);
  response = await fetch(`${base}/api/status`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).startup.phase, 'initial');
  authority.beginRecovery();
  for (const gate of STARTUP_GATES) authority.completeGate(gate);
  authority.release();
  response = await mutate();
  assert.equal(response.status, 200, 'An empty Telegram setup remains editable once infrastructure is ready.');
  assert.equal(changes, 1);
  revokeDuringAudit = true;
  response = await mutate();
  assert.equal(response.status, 503, 'Readiness must be checked after awaited mutation authorization.');
  assert.equal(changes, 1);
  revokeDuringAudit = false;
  state.recovery = { active: true, allowLoopbackLocalSession: false, issues: [] };
  response = await mutate();
  assert.equal(response.status, 200, 'Explicit managed-setting repair remains available in configuration recovery.');
  response = await fetch(`${base}/api/workflow/history/reset`, {
    method: 'POST', headers: { 'X-Requested-With': 'forwarder-dashboard', 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(response.status, 503, 'Recovery does not bypass startup to perform unrelated domain resets.');
  console.log('Startup HTTP authority, readable status, audit race and restricted configuration recovery passed.');
} finally {
  await stopWebServer();
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
