import assert from 'assert';
import { once } from 'events';
import { mkdir, mkdtemp, readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { closeDb, initDb } from '../src/db.js';
import { startWebServer, stopWebServer } from '../src/web_server.js';
import { ManagedSecretStore } from '../src/secret_store.js';
import { ManagedRuntimeSettingsStore } from '../src/runtime_settings.js';

const ADMIN_TOKEN = 'admin-token-0123456789abcdef0123456789abcdef';
const VIEWER_TOKEN = 'viewer-token-0123456789abcdef0123456789abcdef';

function headers(token, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    ...extra
  };
}

function mutationHeaders(extra = {}) {
  return headers(ADMIN_TOKEN, { 'X-Requested-With': 'forwarder-dashboard', ...extra });
}

async function testAuthenticationAndReads(baseUrl) {
  let response = await fetch(`${baseUrl}/api/bootstrap/status`);
  assert.strictEqual(response.status, 200, 'Bootstrap status must be available before authentication');
  assert.deepStrictEqual(await response.json(), { mode: 'token', required: true, available: true });
  response = await fetch(`${baseUrl}/api/status`);
  assert.strictEqual(response.status, 503, 'Missing server token must fail closed');
  process.env.DASHBOARD_ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.DASHBOARD_VIEWER_TOKEN = VIEWER_TOKEN;
  process.env.DASHBOARD_LOCAL_TRUST = 'true';
  response = await fetch(`${baseUrl}/api/local-session`, {
    method: 'POST', headers: { 'X-Requested-With': 'forwarder-dashboard' }
  });
  assert.strictEqual(response.status, 403, 'Integrated startup must reject requests without a trusted browser origin');
  response = await fetch(`${baseUrl}/api/local-session`, {
    method: 'POST',
    headers: { Origin: baseUrl, 'X-Requested-With': 'forwarder-dashboard' }
  });
  assert.strictEqual(response.status, 200, 'Trusted loopback startup must restore dashboard access without a bearer prompt');
  assert.strictEqual((await response.json()).token, ADMIN_TOKEN);
  const previousAllowedOrigin = process.env.DASHBOARD_ALLOWED_ORIGIN;
  try {
    process.env.DASHBOARD_ALLOWED_ORIGIN = 'https://dashboard.example.test';
    response = await fetch(`${baseUrl}/api/local-session`, {
      method: 'POST',
      headers: { Origin: 'https://dashboard.example.test', 'X-Requested-With': 'forwarder-dashboard' }
    });
    assert.strictEqual(response.status, 403, 'Local-session startup must never extend to a configured remote dashboard origin');
  } finally {
    if (previousAllowedOrigin === undefined) delete process.env.DASHBOARD_ALLOWED_ORIGIN;
    else process.env.DASHBOARD_ALLOWED_ORIGIN = previousAllowedOrigin;
  }
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
  assert.strictEqual(publicConfig.nested.backupEncryptionKey, undefined, 'Managed enterprise secrets must be redacted');
  for (const route of ['/api/logs', '/api/metrics-history', '/api/incoming-messages', '/api/processed-signals', '/api/templates']) {
    response = await fetch(`${baseUrl}${route}`, { headers: headers(VIEWER_TOKEN) });
    assert.strictEqual(response.status, 200, `${route} must satisfy its authenticated read contract`);
  }
}

async function testRequestValidation(baseUrl) {
  const rejectedRouteCases = [
    ['/api/incoming-messages', { method: 'DELETE', headers: mutationHeaders() }, 400],
    ['/api/processed-signals', { method: 'DELETE', headers: mutationHeaders() }, 400],
    ['/api/config', { method: 'POST', headers: mutationHeaders({ 'Content-Type': 'application/json' }), body: '[]' }, 400],
    ['/api/import', { method: 'POST', headers: mutationHeaders({ 'Content-Type': 'application/json' }), body: '{}' }, 400],
    ['/api/templates', { method: 'POST', headers: mutationHeaders({ 'Content-Type': 'application/json' }), body: '{"name":"../escape","content":"x"}' }, 400],
    ['/api/access-tokens', { method: 'POST', headers: mutationHeaders({ 'Content-Type': 'application/json' }), body: '{"role":"owner"}' }, 400],
    ['/api/access-tokens/viewer', { method: 'DELETE', headers: mutationHeaders() }, 412],
    ['/api/operations/audit-replay', { method: 'POST', headers: mutationHeaders() }, 412],
    ['/api/backups/recover-offsite', { method: 'POST', headers: mutationHeaders({ 'Content-Type': 'application/json' }), body: '{"objectName":"backup-2026-test.tgfb"}' }, 412],
    ['/api/backups/restore', { method: 'POST', headers: mutationHeaders({ 'Content-Type': 'application/json' }), body: '{"name":"backup-2026-test"}' }, 412],
    ['/api/restart', { method: 'POST', headers: mutationHeaders() }, 412],
    ['/api/factory-reset', { method: 'POST', headers: mutationHeaders() }, 412]
  ];
  for (const [route, options, expectedStatus] of rejectedRouteCases) {
    const response = await fetch(`${baseUrl}${route}`, options);
    assert.strictEqual(response.status, expectedStatus, `${route} must reject an invalid request`);
  }
  let response = await fetch(`${baseUrl}/api/config`, {
    method: 'POST', headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: '{"forwardOptions":{"forwardToTarget":true}}'
  });
  assert.strictEqual(response.status, 200, 'A valid non-secret configuration update must apply');
  response = await fetch(`${baseUrl}/api/outbox?status=unknown`, { headers: headers(VIEWER_TOKEN) });
  assert.strictEqual(response.status, 200, 'Viewer must be able to inspect unresolved outbox work');
  assert.strictEqual((await response.json()).tasks[0].status, 'unknown');
  response = await fetch(`${baseUrl}/api/backups/verify?name=../escape`, { headers: headers(VIEWER_TOKEN) });
  assert.strictEqual(response.status, 400, 'Backup inventory must reject path traversal names');
  response = await fetch(`${baseUrl}/api/incoming-messages?id=1`, { method: 'DELETE', headers: mutationHeaders() });
  assert.strictEqual(response.status, 412, 'Single-message deletion must require explicit confirmation');
  response = await fetch(`${baseUrl}/api/incoming-messages?id=1`, {
    method: 'DELETE', headers: mutationHeaders({ 'X-Destructive-Confirmation': 'delete-incoming-message' })
  });
  assert.strictEqual(response.status, 200);
  response = await fetch(`${baseUrl}/api/processed-signals?id=missing-signal`, {
    method: 'DELETE', headers: mutationHeaders({ 'X-Destructive-Confirmation': 'delete-processed-signal' })
  });
  assert.strictEqual(response.status, 200);
}

async function testAuditedControl(baseUrl, controls) {
  let response = await fetch(`${baseUrl}/api/control`, {
    method: 'POST', headers: headers(VIEWER_TOKEN, { 'Content-Type': 'application/json', 'X-Requested-With': 'forwarder-dashboard' }),
    body: JSON.stringify({ action: 'stop' })
  });
  assert.strictEqual(response.status, 403, 'Viewer must not mutate control state');
  response = await fetch(`${baseUrl}/api/control`, {
    method: 'POST', headers: headers(ADMIN_TOKEN, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ action: 'stop' })
  });
  assert.strictEqual(response.status, 400, 'Admin mutation without dashboard request header must be rejected');
  response = await fetch(`${baseUrl}/api/control`, {
    method: 'POST', headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ action: 'stop' })
  });
  assert.strictEqual(response.status, 200, 'Authenticated administrator must be able to stop routing');
  assert.strictEqual(controls.stopCalls, 1);
  assert.ok(controls.auditEvents.some(event => event.phase === 'authorized' && event.path === '/api/control'));
  controls.auditShouldFail = true;
  response = await fetch(`${baseUrl}/api/control`, {
    method: 'POST', headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ action: 'stop' })
  });
  assert.strictEqual(response.status, 503, 'Mutation must fail closed when the audit precondition cannot be persisted');
  assert.strictEqual(controls.stopCalls, 1, 'Blocked mutation must not reach its side effect');
  controls.auditShouldFail = false;
  response = await fetch(`${baseUrl}/api/control`, {
    method: 'POST', headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ action: 'start', padding: 'x'.repeat(300 * 1024) })
  });
  assert.strictEqual(response.status, 413, 'Oversized request bodies must be rejected');
}

async function testMissingAuditFailsClosed(baseUrl, appState) {
  const auditTrail = appState.auditTrail;
  appState.auditTrail = undefined;
  try {
    const response = await fetch(`${baseUrl}/api/config`, {
      method: 'POST',
      headers: mutationHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ forwardOptions: { forwardToTarget: true } })
    });
    assert.strictEqual(response.status, 503, 'Mutations must fail closed when no audit trail is available');
  } finally {
    appState.auditTrail = auditTrail;
  }
}

async function testSensitiveMutations(baseUrl, controls) {
  let response = await fetch(`${baseUrl}/api/config`, {
    method: 'POST', headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ apiHash: 'attempted-secret-persistence' })
  });
  assert.strictEqual(response.status, 400, 'Dashboard configuration must reject secret fields');
  response = await fetch(`${baseUrl}/api/secrets`, {
    method: 'POST', headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ OPENROUTER_API_KEY: 'attempted-secret-write' })
  });
  assert.strictEqual(response.status, 400, 'Environment-style secret names must be rejected');
  response = await fetch(`${baseUrl}/api/secrets`, {
    method: 'POST', headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ openRouterApiKey: 'sk-or-v1-dashboard-managed-key-1234567890' })
  });
  assert.strictEqual(response.status, 200, 'Allowed secrets must be editable by an authenticated administrator');
  const secretResponse = await response.json();
  assert.strictEqual(secretResponse.openRouterApiKey, undefined, 'Secret values must never be returned');
  assert.strictEqual(secretResponse.secrets.openRouterApiKey.configured, true);
  response = await fetch(`${baseUrl}/api/outbox/retry`, {
    method: 'POST', headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: 'unknown-task' })
  });
  assert.strictEqual(response.status, 412, 'Unknown delivery retry must require explicit duplicate-risk confirmation');
  response = await fetch(`${baseUrl}/api/outbox/retry`, {
    method: 'POST', headers: mutationHeaders({
      'Content-Type': 'application/json', 'X-Destructive-Confirmation': 'retry-unknown-delivery'
    }), body: JSON.stringify({ id: 'unknown-task' })
  });
  assert.strictEqual(response.status, 202);
  assert.strictEqual(controls.retryCalls, 1);
  response = await fetch(`${baseUrl}/api/outbox/acknowledge`, {
    method: 'POST', headers: mutationHeaders({
      'Content-Type': 'application/json', 'X-Destructive-Confirmation': 'acknowledge-unknown-delivery'
    }), body: JSON.stringify({ id: 'unknown-task', reason: 'Verified in the target Telegram channel.' })
  });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(controls.acknowledgeCalls, 1);
}

async function testEditableDefaultTemplate(baseUrl, templatesDirectory) {
  const customDefault = 'Return the configured signal schema and preserve source values exactly.';
  let response = await fetch(`${baseUrl}/api/templates`, {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name: 'default', content: customDefault })
  });
  assert.strictEqual(response.status, 200, 'Administrator must be able to override the default prompt');
  assert.strictEqual(await readFile(path.join(templatesDirectory, 'default.txt'), 'utf8'), customDefault);
  response = await fetch(`${baseUrl}/api/templates`, { headers: headers(VIEWER_TOKEN) });
  assert.strictEqual((await response.json()).templates.default, customDefault);
  response = await fetch(`${baseUrl}/api/templates?name=default`, {
    method: 'DELETE', headers: mutationHeaders()
  });
  assert.strictEqual(response.status, 200, 'Deleting the override must restore the built-in default prompt');
  response = await fetch(`${baseUrl}/api/templates`, { headers: headers(VIEWER_TOKEN) });
  assert.notStrictEqual((await response.json()).templates.default, customDefault);
}

async function testAccessTokenManagement(baseUrl) {
  let response = await fetch(`${baseUrl}/api/access-tokens`, {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ role: 'viewer' })
  });
  assert.strictEqual(response.status, 201);
  const viewerToken = (await response.json()).token;
  assert.match(viewerToken, /^[a-f0-9]{64}$/);
  response = await fetch(`${baseUrl}/api/status`, { headers: headers(viewerToken) });
  assert.strictEqual(response.headers.get('x-authenticated-role'), 'viewer');
  response = await fetch(`${baseUrl}/api/access-tokens/viewer`, {
    method: 'DELETE',
    headers: mutationHeaders({ 'X-Destructive-Confirmation': 'disable-viewer-token' })
  });
  assert.strictEqual(response.status, 200);
  response = await fetch(`${baseUrl}/api/status`, { headers: headers(viewerToken) });
  assert.strictEqual(response.status, 401, 'Disabled viewer token must stop authenticating immediately');

  response = await fetch(`${baseUrl}/api/access-tokens`, {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ role: 'admin' })
  });
  assert.strictEqual(response.status, 201);
  const adminToken = (await response.json()).token;
  assert.match(adminToken, /^[a-f0-9]{64}$/);
  response = await fetch(`${baseUrl}/api/status`, { headers: headers(adminToken) });
  assert.strictEqual(response.status, 200, 'Rotated administrator token must authenticate immediately');
  return adminToken;
}

async function testOperationsControl(baseUrl, controls) {
  let response = await fetch(`${baseUrl}/api/operations`, { headers: headers(VIEWER_TOKEN) });
  assert.strictEqual(response.status, 200);
  assert.strictEqual((await response.json()).operations.backup.healthy, true);
  response = await fetch(`${baseUrl}/api/operations/backup`, { method: 'POST', headers: mutationHeaders() });
  assert.strictEqual(response.status, 201);
  assert.strictEqual(controls.backupCalls, 1);
  response = await fetch(`${baseUrl}/api/operations/audit-replay`, {
    method: 'POST', headers: mutationHeaders({ 'X-Destructive-Confirmation': 'replay-audit' })
  });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(controls.auditReplayCalls, 1);
  response = await fetch(`${baseUrl}/api/backups`, { headers: headers(VIEWER_TOKEN) });
  assert.deepEqual((await response.json()).backups, ['backup-2026-test']);
  response = await fetch(`${baseUrl}/api/backups/verify?name=backup-2026-test`, { headers: headers(VIEWER_TOKEN) });
  assert.strictEqual((await response.json()).manifest.schemaVersion, 1);
  response = await fetch(`${baseUrl}/api/backups/recover-offsite`, {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json', 'X-Destructive-Confirmation': 'recover-offsite-backup' }),
    body: JSON.stringify({ objectName: 'backup-2026-test.tgfb' })
  });
  assert.strictEqual(response.status, 201);
  assert.strictEqual((await response.json()).artifactName, 'backup-2026-recovered');
  assert.strictEqual(controls.offsiteRecoveryCalls, 1);
  response = await fetch(`${baseUrl}/api/backups/restore`, {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json', 'X-Destructive-Confirmation': 'restore-backup' }),
    body: JSON.stringify({ name: 'backup-2026-test' })
  });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(controls.restoreCalls, 1);
  assert.strictEqual(controls.restartCalls, 1);
}

async function testMutationSerialization(baseUrl, controls) {
  let releaseBackup;
  controls.backupBarrier = new Promise(resolve => { releaseBackup = resolve; });
  const backupRequest = fetch(`${baseUrl}/api/operations/backup`, { method: 'POST', headers: mutationHeaders() });
  const deadline = Date.now() + 1000;
  while (controls.backupCalls < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  const conflicting = await fetch(`${baseUrl}/api/control`, {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ action: 'stop' })
  });
  assert.strictEqual(conflicting.status, 409, 'Concurrent control-plane mutations must be rejected.');
  releaseBackup();
  assert.strictEqual((await backupRequest).status, 201);
  controls.backupBarrier = null;
}

async function testRuntimeSettingsControl(baseUrl, controls) {
  let response = await fetch(`${baseUrl}/api/runtime-settings`, { headers: headers(VIEWER_TOKEN) });
  assert.strictEqual(response.status, 200);
  const settings = (await response.json()).settings;
  const incompleteEnterprise = {
    ...settings,
    enterpriseMode: true,
    dashboardAuthMode: 'oidc',
    dashboardLocalTrust: false,
    oidcIssuer: 'https://identity.example.com',
    oidcAudience: 'forwarder',
    oidcJwksUrl: 'https://identity.example.com/jwks',
    auditWebhookUrl: 'https://audit.example.com/events',
    auditRemoteRequired: true,
    backupOffsiteUrlTemplate: 'https://backup.example.com/{artifact}',
    backupOffsiteRequired: true
  };
  response = await fetch(`${baseUrl}/api/runtime-settings`, {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(incompleteEnterprise)
  });
  assert.strictEqual(response.status, 409, 'Enterprise activation must reject missing write-only integration secrets');
  settings.shutdownGraceMs = 45_000;
  response = await fetch(`${baseUrl}/api/runtime-settings`, {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(settings)
  });
  assert.strictEqual(response.status, 200);
  assert.strictEqual((await response.json()).restartRequired, true);
  response = await fetch(`${baseUrl}/api/restart`, {
    method: 'POST',
    headers: mutationHeaders({ 'X-Destructive-Confirmation': 'restart-service' })
  });
  assert.strictEqual(response.status, 202);
  assert.strictEqual(controls.restartCalls, 3, 'Restore, factory reset and explicit restart must schedule container restarts');
}

async function testUnavailableControlContracts(baseUrl, appState) {
  const checks = [
    ['runtimeSettings', '/api/runtime-settings', { method: 'GET', headers: headers(ADMIN_TOKEN) }],
    ['runBackupNow', '/api/operations/backup', { method: 'POST', headers: mutationHeaders() }],
    ['listBackups', '/api/backups', { method: 'GET', headers: headers(ADMIN_TOKEN) }],
    ['verifyBackup', '/api/backups/verify?name=backup-2026-test', { method: 'GET', headers: headers(ADMIN_TOKEN) }],
    ['recoverOffsiteBackup', '/api/backups/recover-offsite', {
      method: 'POST',
      headers: mutationHeaders({ 'Content-Type': 'application/json', 'X-Destructive-Confirmation': 'recover-offsite-backup' }),
      body: JSON.stringify({ objectName: 'backup-2026-test.tgfb' })
    }],
    ['restoreBackup', '/api/backups/restore', {
      method: 'POST',
      headers: mutationHeaders({ 'Content-Type': 'application/json', 'X-Destructive-Confirmation': 'restore-backup' }),
      body: JSON.stringify({ name: 'backup-2026-test' })
    }],
    ['performFactoryReset', '/api/factory-reset', {
      method: 'POST', headers: mutationHeaders({ 'X-Destructive-Confirmation': 'factory-reset' })
    }],
  ];
  for (const [property, route, options] of checks) {
    const original = appState[property];
    appState[property] = undefined;
    const response = await fetch(`${baseUrl}${route}`, options);
    assert.strictEqual(response.status, 503, `${route} must report an unavailable runtime capability`);
    appState[property] = original;
  }
}

async function testBrowserAndDestructiveContracts(baseUrl, appState) {
  let response = await fetch(`${baseUrl}/api/status`, { headers: headers(ADMIN_TOKEN, { Origin: 'https://attacker.example' }) });
  assert.strictEqual(response.status, 403, 'Untrusted browser origins must be rejected');
  response = await fetch(`${baseUrl}/api/status`, {
    method: 'OPTIONS', headers: { Origin: baseUrl, 'Access-Control-Request-Method': 'GET' }
  });
  assert.strictEqual(response.status, 204, 'Loopback CORS preflight must be accepted');
  assert.strictEqual(response.headers.get('access-control-allow-origin'), baseUrl);
  response = await fetch(`${baseUrl}/api/clear-database`, { method: 'POST', headers: mutationHeaders() });
  assert.strictEqual(response.status, 412, 'Destructive operation must require action-specific confirmation');
  appState.state.isRunning = true;
  const destructiveHeaders = mutationHeaders({ 'X-Destructive-Confirmation': 'clear-database' });
  response = await fetch(`${baseUrl}/api/clear-database`, { method: 'POST', headers: destructiveHeaders });
  assert.strictEqual(response.status, 409, 'Database clear must be rejected while routing is active');
  appState.state.isRunning = false;
  response = await fetch(`${baseUrl}/api/clear-database`, { method: 'POST', headers: destructiveHeaders });
  assert.strictEqual(response.status, 200, 'Confirmed administrator database clear must succeed against the isolated test database');
  appState.state.isRunning = true;
  response = await fetch(`${baseUrl}/api/factory-reset`, {
    method: 'POST',
    headers: mutationHeaders({ 'X-Destructive-Confirmation': 'factory-reset' })
  });
  assert.strictEqual(response.status, 200, 'Factory reset must stop active routing and execute the complete reset service');
  assert.strictEqual((await response.json()).restartScheduled, true);
  assert.strictEqual(appState.controls.factoryResetCalls, 1);
  assert.strictEqual(appState.controls.restartCalls, 2);
  response = await fetch(`${baseUrl}/api/does-not-exist`, { headers: headers(ADMIN_TOKEN) });
  assert.strictEqual(response.status, 404, 'Unknown API routes must not fall through to the SPA');
  response = await fetch(`${baseUrl}/.directory-response-test`, { signal: AbortSignal.timeout(2000) });
  assert.strictEqual(response.status, 200, 'A static directory path must receive a bounded SPA response');
  assert.match(await response.text(), /<html(?:\s|>)/i);
}

async function createAppState(testDir, controls) {
  const runtimeSettings = new ManagedRuntimeSettingsStore(path.join(testDir, 'runtime-settings.json'), process.env);
  await runtimeSettings.initialize();
  const appState = {
    controls,
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
        AUDIT_WEBHOOK_TOKEN: 'must-also-be-redacted',
        backupEncryptionKey: 'must-also-be-redacted'
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
    stopForwarding: async () => { controls.stopCalls += 1; appState.state.isRunning = false; },
    reloadConfig: () => {},
    applyRuntimeConfig: () => {},
    persistConfig: () => {},
    getMetricsHistory: () => [],
    getOutboxTasks: async statuses => [{ id: 'unknown-task', status: statuses?.[0] || 'unknown' }],
    retryOutboxTask: async id => { controls.retryCalls += 1; return id === 'unknown-task'; },
    acknowledgeOutboxTask: async id => { controls.acknowledgeCalls += 1; return id === 'unknown-task'; },
    getTelegramLoginState: () => ({
      state: 'waiting',
      prompt: { kind: 'authCode', label: 'Telegram verification code' }
    }),
    submitTelegramLogin: payload => {
      assert.deepEqual(payload, { value: '12345' });
      return { state: 'authenticating' };
    },
    auditTrail: {
      record: async event => {
        controls.auditEvents.push(event);
        if (controls.auditShouldFail) throw new Error('audit unavailable');
      },
      snapshot: () => ({ healthy: true, remoteRequired: false, lastRemoteSuccessAt: null, recordCount: controls.auditEvents.length }),
      replayRemote: async () => { controls.auditReplayCalls += 1; return controls.auditEvents.length; }
    },
    secretStore: new ManagedSecretStore(path.join(testDir, 'secrets')),
    getOperationsStatus: () => ({ backup: { healthy: true }, audit: { healthy: true } }),
    runBackupNow: async () => {
      controls.backupCalls += 1;
      if (controls.backupBarrier) await controls.backupBarrier;
      return path.join(testDir, 'backups', 'backup-test');
    },
    listBackups: async () => ['backup-2026-test'],
    verifyBackup: async () => ({ schemaVersion: 1 }),
    recoverOffsiteBackup: async () => {
      controls.offsiteRecoveryCalls += 1;
      return 'backup-2026-recovered';
    },
    restoreBackup: async () => {
      controls.restoreCalls += 1;
      return { previousDatabase: path.join(testDir, 'previous.db'), previousConfig: null };
    },
    performFactoryReset: async () => {
      controls.factoryResetCalls += 1;
      await appState.stopForwarding();
    },
    requestRestart: () => { controls.restartCalls += 1; },
    runtimeSettings
  };
  await appState.secretStore.initialize();
  return appState;
}

async function testBootstrap(baseUrl) {
  let disabledLocal = await fetch(`${baseUrl}/api/local-session`, {
    method: 'POST', headers: { Origin: baseUrl, 'X-Requested-With': 'forwarder-dashboard' }
  });
  assert.strictEqual(disabledLocal.status, 409, 'Integrated startup must be explicitly enabled by the standalone runtime profile');
  const missingOrigin = await fetch(`${baseUrl}/api/bootstrap`, {
    method: 'POST',
    headers: { 'X-Requested-With': 'forwarder-dashboard' }
  });
  assert.strictEqual(missingOrigin.status, 403, 'Bootstrap must require an allowed browser origin');
  const response = await fetch(`${baseUrl}/api/bootstrap`, {
    method: 'POST',
    headers: { Origin: baseUrl, 'X-Requested-With': 'forwarder-dashboard' }
  });
  assert.strictEqual(response.status, 201, 'Allowed first-run browser must be able to bootstrap authentication');
  const bootstrap = await response.json();
  assert.match(bootstrap.token, /^[a-f0-9]{64}$/, 'Bootstrap must return a strong one-time token');
  assert.strictEqual(bootstrap.recoveryLocation, 'secrets/dashboard_admin_token');
  const authenticated = await fetch(`${baseUrl}/api/status`, { headers: headers(bootstrap.token) });
  assert.strictEqual(authenticated.status, 200, 'Generated bootstrap token must authenticate immediately');
  delete process.env.DASHBOARD_ADMIN_TOKEN;
}

async function testLocalStartupFirstRun(testDir, appState) {
  const previousAdminToken = process.env.DASHBOARD_ADMIN_TOKEN;
  const previousViewerToken = process.env.DASHBOARD_VIEWER_TOKEN;
  const previousLocalTrust = process.env.DASHBOARD_LOCAL_TRUST;
  const previousAuthMode = process.env.DASHBOARD_AUTH_MODE;
  const secretStore = new ManagedSecretStore(path.join(testDir, 'first-run-local-secrets'));
  try {
    delete process.env.DASHBOARD_ADMIN_TOKEN;
    delete process.env.DASHBOARD_VIEWER_TOKEN;
    process.env.DASHBOARD_AUTH_MODE = 'token';
    process.env.DASHBOARD_LOCAL_TRUST = 'true';
    await secretStore.initialize();
    const firstRunServer = startWebServer(0, { ...appState, secretStore });
    await once(firstRunServer, 'listening');
    const address = firstRunServer.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${baseUrl}/api/local-session`, {
      method: 'POST',
      headers: { Origin: baseUrl, 'X-Requested-With': 'forwarder-dashboard' }
    });
    const localStartup = await response.json();
    assert.strictEqual(response.status, 201, 'First local startup must issue a browser session without requiring a bearer token');
    assert.match(localStartup.token, /^[a-f0-9]{64}$/);
    const authenticated = await fetch(`${baseUrl}/api/status`, { headers: headers(localStartup.token) });
    assert.strictEqual(authenticated.status, 200, 'The first-run local session must authenticate immediately');
  } finally {
    await stopWebServer();
    if (previousAdminToken === undefined) delete process.env.DASHBOARD_ADMIN_TOKEN;
    else process.env.DASHBOARD_ADMIN_TOKEN = previousAdminToken;
    if (previousViewerToken === undefined) delete process.env.DASHBOARD_VIEWER_TOKEN;
    else process.env.DASHBOARD_VIEWER_TOKEN = previousViewerToken;
    if (previousLocalTrust === undefined) delete process.env.DASHBOARD_LOCAL_TRUST;
    else process.env.DASHBOARD_LOCAL_TRUST = previousLocalTrust;
    if (previousAuthMode === undefined) delete process.env.DASHBOARD_AUTH_MODE;
    else process.env.DASHBOARD_AUTH_MODE = previousAuthMode;
  }
}

async function testTelegramWebLogin(baseUrl) {
  let response = await fetch(`${baseUrl}/api/telegram-login`, { headers: headers(VIEWER_TOKEN) });
  assert.strictEqual(response.status, 200, 'Viewer may inspect the active Telegram login prompt');
  assert.equal((await response.json()).telegramLogin.prompt.kind, 'authCode');
  response = await fetch(`${baseUrl}/api/telegram-login`, {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ value: '12345' })
  });
  assert.strictEqual(response.status, 202, 'Administrator may answer the Telegram login prompt');
}

async function testRecoveryMode(baseUrl, appState, controls) {
  appState.recovery = {
    active: true,
    allowLoopbackLocalSession: false,
    issues: [{ component: 'configuration', reason: 'Configuration is invalid.' }]
  };
  const stopCallsBeforeRecovery = controls.stopCalls;
  let response = await fetch(`${baseUrl}/api/recovery`, { headers: headers(ADMIN_TOKEN) });
  assert.strictEqual(response.status, 200, 'Authenticated operators must be able to inspect recovery status.');
  const recovery = await response.json();
  assert.strictEqual(recovery.active, true);
  assert.strictEqual(recovery.restartRequired, true);
  response = await fetch(`${baseUrl}/api/config`, { headers: headers(ADMIN_TOKEN) });
  assert.strictEqual(response.status, 200, 'Recovery mode must expose a safe configuration baseline for repair.');
  response = await fetch(`${baseUrl}/api/config`, {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ forwardOptions: { forwardToTarget: true } })
  });
  assert.strictEqual(response.status, 200, 'Recovery mode must allow a valid configuration replacement.');
  response = await fetch(`${baseUrl}/api/control`, {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ action: 'stop' })
  });
  assert.strictEqual(response.status, 503, 'Recovery mode must block routing control side effects.');
  const currentSettings = await (await fetch(`${baseUrl}/api/runtime-settings`, { headers: headers(ADMIN_TOKEN) })).json();
  response = await fetch(`${baseUrl}/api/runtime-settings`, {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(currentSettings.settings)
  });
  assert.strictEqual(response.status, 200, 'Recovery mode must allow runtime-settings repair.');
  assert.strictEqual(controls.stopCalls, stopCallsBeforeRecovery, 'Recovery requests must not start or stop routing.');
  appState.recovery = undefined;
}

async function testRecoveryLocalStartup(testDir, appState) {
  const previousAdminToken = process.env.DASHBOARD_ADMIN_TOKEN;
  const previousViewerToken = process.env.DASHBOARD_VIEWER_TOKEN;
  const previousLocalTrust = process.env.DASHBOARD_LOCAL_TRUST;
  const previousAuthMode = process.env.DASHBOARD_AUTH_MODE;
  const previousAllowedOrigin = process.env.DASHBOARD_ALLOWED_ORIGIN;
  const secretStore = new ManagedSecretStore(path.join(testDir, 'recovery-secrets'));
  let recoveryServer;
  try {
    delete process.env.DASHBOARD_ADMIN_TOKEN;
    delete process.env.DASHBOARD_VIEWER_TOKEN;
    delete process.env.DASHBOARD_ALLOWED_ORIGIN;
    process.env.DASHBOARD_AUTH_MODE = 'token';
    process.env.DASHBOARD_LOCAL_TRUST = 'false';
    await secretStore.initialize();
    const recoveryAppState = {
      ...appState,
      auditTrail: undefined,
      secretStore,
      recovery: {
        active: true,
        allowLoopbackLocalSession: true,
        issues: [{ component: 'managedSecret', reason: 'Managed secret file is invalid.' }]
      }
    };
    recoveryServer = startWebServer(0, recoveryAppState);
    await once(recoveryServer, 'listening');
    const address = recoveryServer.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${baseUrl}/api/local-session`, {
      method: 'POST',
      headers: { Origin: baseUrl, 'X-Requested-With': 'forwarder-dashboard' }
    });
    const recoveryPayload = await response.json();
    assert.strictEqual(response.status, 201, `Recovery mode must provide a loopback-only session without a bearer prompt: ${recoveryPayload.error || 'unknown error'}`);
    const { token } = recoveryPayload;
    assert.match(token, /^[a-f0-9]{64}$/);
    const status = await fetch(`${baseUrl}/api/recovery`, { headers: headers(token) });
    assert.strictEqual(status.status, 200, 'The recovery session must authenticate to the repair-only API');
    const repair = await fetch(`${baseUrl}/api/config`, {
      method: 'POST',
      headers: headers(token, { 'Content-Type': 'application/json', 'X-Requested-With': 'forwarder-dashboard' }),
      body: JSON.stringify({ forwardOptions: { forwardToTarget: true } })
    });
    assert.strictEqual(repair.status, 200, 'Loopback recovery must permit a repair mutation when the audit trail itself is unavailable');
    const blocked = await fetch(`${baseUrl}/api/control`, {
      method: 'POST',
      headers: headers(token, { 'Content-Type': 'application/json', 'X-Requested-With': 'forwarder-dashboard' }),
      body: JSON.stringify({ action: 'start' })
    });
    assert.strictEqual(blocked.status, 503, 'Recovery startup must not enable routing controls');
  } finally {
    await stopWebServer();
    if (previousAdminToken === undefined) delete process.env.DASHBOARD_ADMIN_TOKEN;
    else process.env.DASHBOARD_ADMIN_TOKEN = previousAdminToken;
    if (previousViewerToken === undefined) delete process.env.DASHBOARD_VIEWER_TOKEN;
    else process.env.DASHBOARD_VIEWER_TOKEN = previousViewerToken;
    if (previousLocalTrust === undefined) delete process.env.DASHBOARD_LOCAL_TRUST;
    else process.env.DASHBOARD_LOCAL_TRUST = previousLocalTrust;
    if (previousAuthMode === undefined) delete process.env.DASHBOARD_AUTH_MODE;
    else process.env.DASHBOARD_AUTH_MODE = previousAuthMode;
    if (previousAllowedOrigin === undefined) delete process.env.DASHBOARD_ALLOWED_ORIGIN;
    else process.env.DASHBOARD_ALLOWED_ORIGIN = previousAllowedOrigin;
  }
}

async function runTests() {
  const previousAdminToken = process.env.DASHBOARD_ADMIN_TOKEN;
  const previousViewerToken = process.env.DASHBOARD_VIEWER_TOKEN;
  const previousWebHost = process.env.WEB_HOST;
  const previousAuthMode = process.env.DASHBOARD_AUTH_MODE;
  const previousLocalTrust = process.env.DASHBOARD_LOCAL_TRUST;
  const previousTemplatesDirectory = process.env.TEMPLATES_DIR;
  const testDir = await mkdtemp(path.join(os.tmpdir(), 'forwarder-web-test-'));
  const staticDirectory = path.resolve('frontend/dist/.directory-response-test');
  let stopped = false;

  try {
    await initDb(path.join(testDir, 'forwarder.db'));
    await mkdir(staticDirectory, { recursive: true });
    delete process.env.DASHBOARD_ADMIN_TOKEN;
    delete process.env.DASHBOARD_VIEWER_TOKEN;
    delete process.env.WEB_HOST;
    process.env.DASHBOARD_AUTH_MODE = 'token';
    process.env.TEMPLATES_DIR = path.join(testDir, 'templates');

    const controls = {
      stopCalls: 0,
      retryCalls: 0,
      acknowledgeCalls: 0,
      backupCalls: 0,
      auditReplayCalls: 0,
      factoryResetCalls: 0,
      restoreCalls: 0,
      offsiteRecoveryCalls: 0,
      restartCalls: 0,
      auditShouldFail: false,
      auditEvents: [],
      backupBarrier: null
    };
    const appState = await createAppState(testDir, controls);
    await testLocalStartupFirstRun(testDir, appState);

    const server = startWebServer(0, appState);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    assert.strictEqual(address.address, '127.0.0.1', 'Control plane must bind to loopback by default');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    await testBootstrap(baseUrl);
    await testAuthenticationAndReads(baseUrl);
    await testTelegramWebLogin(baseUrl);
    await testRequestValidation(baseUrl);

    await testAuditedControl(baseUrl, controls);
    await testMissingAuditFailsClosed(baseUrl, appState);
    await testSensitiveMutations(baseUrl, controls);
    await testEditableDefaultTemplate(baseUrl, process.env.TEMPLATES_DIR);
    await testOperationsControl(baseUrl, controls);
    await testMutationSerialization(baseUrl, controls);
    await testUnavailableControlContracts(baseUrl, appState);
    await testBrowserAndDestructiveContracts(baseUrl, appState);
    await testRuntimeSettingsControl(baseUrl, controls);
    await testRecoveryMode(baseUrl, appState, controls);
    await testAccessTokenManagement(baseUrl);

    await stopWebServer();
    await testRecoveryLocalStartup(testDir, appState);
    stopped = true;
    console.log('ALL WEB CONTROL SECURITY TESTS PASSED!');
  } finally {
    if (!stopped) await stopWebServer();
    await closeDb();
    await rm(testDir, { recursive: true, force: true });
    await rm(staticDirectory, { recursive: true, force: true });
    if (previousAdminToken === undefined) delete process.env.DASHBOARD_ADMIN_TOKEN;
    else process.env.DASHBOARD_ADMIN_TOKEN = previousAdminToken;
    if (previousViewerToken === undefined) delete process.env.DASHBOARD_VIEWER_TOKEN;
    else process.env.DASHBOARD_VIEWER_TOKEN = previousViewerToken;
    if (previousWebHost === undefined) delete process.env.WEB_HOST;
    else process.env.WEB_HOST = previousWebHost;
    if (previousAuthMode === undefined) delete process.env.DASHBOARD_AUTH_MODE;
    else process.env.DASHBOARD_AUTH_MODE = previousAuthMode;
    if (previousLocalTrust === undefined) delete process.env.DASHBOARD_LOCAL_TRUST;
    else process.env.DASHBOARD_LOCAL_TRUST = previousLocalTrust;
    if (previousTemplatesDirectory === undefined) delete process.env.TEMPLATES_DIR;
    else process.env.TEMPLATES_DIR = previousTemplatesDirectory;
  }
}

await runTests().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
