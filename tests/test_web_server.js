import assert from 'assert';
import { once } from 'events';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { closeDb, initDb } from '../src/db.js';
import { startWebServer, stopWebServer } from '../src/web_server.js';

const ADMIN_TOKEN = 'admin-token-0123456789abcdef0123456789abcdef';
const VIEWER_TOKEN = 'viewer-token-0123456789abcdef0123456789abcdef';

function headers(token, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    ...extra
  };
}

async function runTests() {
  const previousAdminToken = process.env.DASHBOARD_ADMIN_TOKEN;
  const previousViewerToken = process.env.DASHBOARD_VIEWER_TOKEN;
  const previousWebHost = process.env.WEB_HOST;
  const previousAuthMode = process.env.DASHBOARD_AUTH_MODE;
  const testDir = await mkdtemp(path.join(os.tmpdir(), 'forwarder-web-test-'));
  let stopped = false;

  try {
    await initDb(path.join(testDir, 'forwarder.db'));
    delete process.env.DASHBOARD_ADMIN_TOKEN;
    delete process.env.DASHBOARD_VIEWER_TOKEN;
    delete process.env.WEB_HOST;
    process.env.DASHBOARD_AUTH_MODE = 'token';

    let stopCalls = 0;
    let retryCalls = 0;
    let acknowledgeCalls = 0;
    let auditShouldFail = false;
    const auditEvents = [];
    const appState = {
      config: {
        apiId: 123,
        apiHash: 'must-never-be-returned',
        sourceChannels: [],
        targetChannel: '',
        forwardOptions: {},
        filters: {},
        sourceFilters: {},
        sourceAliases: {},
        xmlParsing: {},
        dupeBlocker: {},
        nested: {
          OPENROUTER_API_KEY: 'must-also-be-redacted',
          AUDIT_WEBHOOK_TOKEN: 'must-also-be-redacted'
        }
      },
      state: {
        isRunning: true,
        connectionState: 'connected',
        resolvedSourceChatIds: new Set(),
        startupTime: Math.floor(Date.now() / 1000)
      },
      getQueueState: () => ({ running: 0, queued: 0, maxConcurrency: 2, paused: false }),
      startForwarding: async () => {},
      stopForwarding: async () => { stopCalls += 1; appState.state.isRunning = false; },
      reloadConfig: () => {},
      applyRuntimeConfig: () => {},
      getMetricsHistory: () => [],
      getOutboxTasks: async statuses => [{ id: 'unknown-task', status: statuses?.[0] || 'unknown' }],
      retryOutboxTask: async id => { retryCalls += 1; return id === 'unknown-task'; },
      acknowledgeOutboxTask: async id => { acknowledgeCalls += 1; return id === 'unknown-task'; },
      auditTrail: {
        record: async event => {
          auditEvents.push(event);
          if (auditShouldFail) throw new Error('audit unavailable');
        }
      }
    };

    const server = startWebServer(0, appState);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    assert.strictEqual(address.address, '127.0.0.1', 'Control plane must bind to loopback by default');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    let response = await fetch(`${baseUrl}/api/status`);
    assert.strictEqual(response.status, 503, 'Missing server token must fail closed');

    process.env.DASHBOARD_ADMIN_TOKEN = ADMIN_TOKEN;
    process.env.DASHBOARD_VIEWER_TOKEN = VIEWER_TOKEN;

    response = await fetch(`${baseUrl}/api/status`);
    assert.strictEqual(response.status, 401, 'Anonymous API access must be rejected');
    assert.match(response.headers.get('www-authenticate') || '', /^Bearer/);

    response = await fetch(`${baseUrl}/api/status`, { headers: headers('invalid-token-that-is-long-enough-000000') });
    assert.strictEqual(response.status, 401, 'Invalid bearer token must be rejected');

    response = await fetch(`${baseUrl}/api/config`, { headers: headers(VIEWER_TOKEN) });
    assert.strictEqual(response.status, 200, 'Viewer must be able to read configuration');
    assert.strictEqual(response.headers.get('x-authenticated-role'), 'viewer');
    assert.match(response.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
    const publicConfig = await response.json();
    assert.strictEqual(publicConfig.apiHash, undefined, 'Telegram secret must be redacted');
    assert.strictEqual(publicConfig.nested.OPENROUTER_API_KEY, undefined, 'Nested secrets must be redacted');
    assert.strictEqual(publicConfig.nested.AUDIT_WEBHOOK_TOKEN, undefined, 'Audit credentials must be redacted');

    response = await fetch(`${baseUrl}/api/outbox?status=unknown`, { headers: headers(VIEWER_TOKEN) });
    assert.strictEqual(response.status, 200, 'Viewer must be able to inspect unresolved outbox work');
    assert.strictEqual((await response.json()).tasks[0].status, 'unknown');

    response = await fetch(`${baseUrl}/api/control`, {
      method: 'POST',
      headers: headers(VIEWER_TOKEN, { 'Content-Type': 'application/json', 'X-Requested-With': 'forwarder-dashboard' }),
      body: JSON.stringify({ action: 'stop' })
    });
    assert.strictEqual(response.status, 403, 'Viewer must not mutate control state');

    response = await fetch(`${baseUrl}/api/control`, {
      method: 'POST',
      headers: headers(ADMIN_TOKEN, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ action: 'stop' })
    });
    assert.strictEqual(response.status, 400, 'Admin mutation without dashboard request header must be rejected');

    response = await fetch(`${baseUrl}/api/control`, {
      method: 'POST',
      headers: headers(ADMIN_TOKEN, { 'Content-Type': 'application/json', 'X-Requested-With': 'forwarder-dashboard' }),
      body: JSON.stringify({ action: 'stop' })
    });
    assert.strictEqual(response.status, 200, 'Authenticated administrator must be able to stop routing');
    assert.strictEqual(stopCalls, 1);
    assert.ok(auditEvents.some(event => event.phase === 'authorized' && event.path === '/api/control'));

    auditShouldFail = true;
    response = await fetch(`${baseUrl}/api/control`, {
      method: 'POST',
      headers: headers(ADMIN_TOKEN, { 'Content-Type': 'application/json', 'X-Requested-With': 'forwarder-dashboard' }),
      body: JSON.stringify({ action: 'stop' })
    });
    assert.strictEqual(response.status, 503, 'Mutation must fail closed when the audit precondition cannot be persisted');
    assert.strictEqual(stopCalls, 1, 'Blocked mutation must not reach its side effect');
    auditShouldFail = false;

    response = await fetch(`${baseUrl}/api/control`, {
      method: 'POST',
      headers: headers(ADMIN_TOKEN, { 'Content-Type': 'application/json', 'X-Requested-With': 'forwarder-dashboard' }),
      body: JSON.stringify({ action: 'start', padding: 'x'.repeat(300 * 1024) })
    });
    assert.strictEqual(response.status, 413, 'Oversized request bodies must be rejected');

    response = await fetch(`${baseUrl}/api/config`, {
      method: 'POST',
      headers: headers(ADMIN_TOKEN, { 'Content-Type': 'application/json', 'X-Requested-With': 'forwarder-dashboard' }),
      body: JSON.stringify({ apiHash: 'attempted-secret-persistence' })
    });
    assert.strictEqual(response.status, 400, 'Dashboard configuration must reject secret fields');

    response = await fetch(`${baseUrl}/api/env`, {
      method: 'POST',
      headers: headers(ADMIN_TOKEN, { 'Content-Type': 'application/json', 'X-Requested-With': 'forwarder-dashboard' }),
      body: JSON.stringify({ OPENROUTER_API_KEY: 'attempted-secret-write' })
    });
    assert.strictEqual(response.status, 405, 'Environment variables must not be web-editable');

    response = await fetch(`${baseUrl}/api/outbox/retry`, {
      method: 'POST',
      headers: headers(ADMIN_TOKEN, { 'Content-Type': 'application/json', 'X-Requested-With': 'forwarder-dashboard' }),
      body: JSON.stringify({ id: 'unknown-task' })
    });
    assert.strictEqual(response.status, 412, 'Unknown delivery retry must require explicit duplicate-risk confirmation');

    response = await fetch(`${baseUrl}/api/outbox/retry`, {
      method: 'POST',
      headers: headers(ADMIN_TOKEN, {
        'Content-Type': 'application/json',
        'X-Requested-With': 'forwarder-dashboard',
        'X-Destructive-Confirmation': 'retry-unknown-delivery'
      }),
      body: JSON.stringify({ id: 'unknown-task' })
    });
    assert.strictEqual(response.status, 202);
    assert.strictEqual(retryCalls, 1);

    response = await fetch(`${baseUrl}/api/outbox/acknowledge`, {
      method: 'POST',
      headers: headers(ADMIN_TOKEN, {
        'Content-Type': 'application/json',
        'X-Requested-With': 'forwarder-dashboard',
        'X-Destructive-Confirmation': 'acknowledge-unknown-delivery'
      }),
      body: JSON.stringify({ id: 'unknown-task', reason: 'Verified in the target Telegram channel.' })
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(acknowledgeCalls, 1);

    response = await fetch(`${baseUrl}/api/status`, {
      headers: headers(ADMIN_TOKEN, { Origin: 'https://attacker.example' })
    });
    assert.strictEqual(response.status, 403, 'Untrusted browser origins must be rejected');

    response = await fetch(`${baseUrl}/api/status`, {
      method: 'OPTIONS',
      headers: { Origin: baseUrl, 'Access-Control-Request-Method': 'GET' }
    });
    assert.strictEqual(response.status, 204, 'Loopback CORS preflight must be accepted');
    assert.strictEqual(response.headers.get('access-control-allow-origin'), baseUrl);

    response = await fetch(`${baseUrl}/api/clear-database`, {
      method: 'POST',
      headers: headers(ADMIN_TOKEN, { 'X-Requested-With': 'forwarder-dashboard' })
    });
    assert.strictEqual(response.status, 412, 'Destructive operation must require action-specific confirmation');

    appState.state.isRunning = true;
    response = await fetch(`${baseUrl}/api/clear-database`, {
      method: 'POST',
      headers: headers(ADMIN_TOKEN, {
        'X-Requested-With': 'forwarder-dashboard',
        'X-Destructive-Confirmation': 'clear-database'
      })
    });
    assert.strictEqual(response.status, 409, 'Database clear must be rejected while routing is active');
    appState.state.isRunning = false;

    response = await fetch(`${baseUrl}/api/clear-database`, {
      method: 'POST',
      headers: headers(ADMIN_TOKEN, {
        'X-Requested-With': 'forwarder-dashboard',
        'X-Destructive-Confirmation': 'clear-database'
      })
    });
    assert.strictEqual(response.status, 200, 'Confirmed administrator database clear must succeed against the isolated test database');

    response = await fetch(`${baseUrl}/api/does-not-exist`, { headers: headers(ADMIN_TOKEN) });
    assert.strictEqual(response.status, 404, 'Unknown API routes must not fall through to the SPA');

    await stopWebServer();
    stopped = true;
    console.log('ALL WEB CONTROL SECURITY TESTS PASSED!');
  } finally {
    if (!stopped) await stopWebServer();
    await closeDb();
    await rm(testDir, { recursive: true, force: true });
    if (previousAdminToken === undefined) delete process.env.DASHBOARD_ADMIN_TOKEN;
    else process.env.DASHBOARD_ADMIN_TOKEN = previousAdminToken;
    if (previousViewerToken === undefined) delete process.env.DASHBOARD_VIEWER_TOKEN;
    else process.env.DASHBOARD_VIEWER_TOKEN = previousViewerToken;
    if (previousWebHost === undefined) delete process.env.WEB_HOST;
    else process.env.WEB_HOST = previousWebHost;
    if (previousAuthMode === undefined) delete process.env.DASHBOARD_AUTH_MODE;
    else process.env.DASHBOARD_AUTH_MODE = previousAuthMode;
  }
}

await runTests().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
