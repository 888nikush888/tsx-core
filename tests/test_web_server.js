import assert from 'assert';
import { once } from 'events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { closeDb, initDb } from '../src/db.js';
import { authenticateMcpToken, createMcpProposal } from '../src/mcp_repository.js';
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
  assert.deepStrictEqual(await response.json(), {
    mode: 'token',
    required: true,
    available: true,
    localSessionAvailable: false,
  });
  response = await fetch(`${baseUrl}/api/status`);
  assert.strictEqual(response.status, 503, 'Missing server token must fail closed');
  process.env.DASHBOARD_ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.DASHBOARD_VIEWER_TOKEN = VIEWER_TOKEN;
  process.env.DASHBOARD_LOCAL_TRUST = 'true';
  response = await fetch(`${baseUrl}/api/bootstrap/status`);
  assert.strictEqual(response.status, 200);
  assert.deepStrictEqual(await response.json(), {
    mode: 'token',
    required: false,
    available: false,
    localSessionAvailable: true,
  });
  response = await fetch(`${baseUrl}/api/local-session`, {
    method: 'POST', headers: { 'X-Requested-With': 'forwarder-dashboard' }
  });
  assert.strictEqual(response.status, 403, 'Integrated startup must reject requests without a trusted browser origin');
  response = await fetch(`${baseUrl}/api/local-session`, {
    method: 'POST',
    headers: { Origin: baseUrl, 'X-Requested-With': 'forwarder-dashboard' }
  });
  assert.strictEqual(response.status, 201, 'Trusted loopback startup must issue a short-lived local session');
  const localSession = await response.json();
  assert.match(localSession.token, /^tsx_local_[A-Za-z0-9_-]{40,}$/);
  assert.strictEqual(localSession.generatedAdminToken, false);
  assert.notStrictEqual(localSession.token, ADMIN_TOKEN, 'Local startup must not disclose the durable administrator token');
  response = await fetch(`${baseUrl}/api/status`, { headers: headers(localSession.token) });
  assert.strictEqual(response.status, 200, 'The ephemeral local session must authenticate immediately');
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
  for (const route of ['/api/logs', '/api/metrics-history', '/api/incoming-messages', '/api/processed-signals', '/api/dashboard-analytics', '/api/templates']) {
    response = await fetch(`${baseUrl}${route}`, { headers: headers(VIEWER_TOKEN) });
    assert.strictEqual(response.status, 200, `${route} must satisfy its authenticated read contract`);
  }
}

async function testOperatorReadContracts(baseUrl, appState) {
  let response = await fetch(`${baseUrl}/api/access`, { headers: headers(VIEWER_TOKEN) });
  assert.strictEqual(response.status, 200);
  const access = await response.json();
  assert.strictEqual(access.mode, 'bearer');
  assert.strictEqual(access.role, 'viewer');
  assert.deepStrictEqual(access.remoteAccess, { provider: null, connected: false, origin: null });

  response = await fetch(`${baseUrl}/api/secrets`, { headers: headers(VIEWER_TOKEN) });
  assert.strictEqual(response.status, 200);
  assert.ok(response.headers.get('cache-control')?.includes('no-store'));
  assert.ok((await response.json()).secrets, 'Secret inventory must expose status metadata without secret values.');

  const originalChannels = appState.config.sourceChannels;
  const originalTradingControl = appState.tradingControl;
  appState.config.sourceChannels = [
    { id: '-1001', name: 'Desk One' },
    { channelId: '-1002', title: 'Desk Two' },
    '-1003',
  ];
  appState.tradingControl = {
    snapshot: async () => ({ strategies: [], positions: [] }),
    portfolioSnapshot: async refresh => ({ refresh, positions: [] }),
  };
  try {
    response = await fetch(`${baseUrl}/api/trading`, { headers: headers(VIEWER_TOKEN) });
    assert.strictEqual(response.status, 200);
    const trading = await response.json();
    assert.deepStrictEqual(trading.configuredChannels, [
      { id: '-1001', name: 'Desk One' },
      { id: '-1002', name: 'Desk Two' },
      { id: '-1003', name: '-1003' },
    ]);
    response = await fetch(`${baseUrl}/api/trading/portfolio?refresh=true`, { headers: headers(VIEWER_TOKEN) });
    assert.strictEqual(response.status, 200);
    assert.strictEqual((await response.json()).refresh, true);
  } finally {
    appState.config.sourceChannels = originalChannels;
    appState.tradingControl = originalTradingControl;
  }

  response = await fetch(`${baseUrl}/api/outbox?status=not-a-status`, { headers: headers(VIEWER_TOKEN) });
  assert.strictEqual(response.status, 400, 'Unknown outbox filters must be rejected.');
  const originalOutboxReader = appState.getOutboxTasks;
  appState.getOutboxTasks = undefined;
  try {
    response = await fetch(`${baseUrl}/api/outbox`, { headers: headers(VIEWER_TOKEN) });
    assert.strictEqual(response.status, 503, 'Unavailable outbox inspection must fail explicitly.');
  } finally {
    appState.getOutboxTasks = originalOutboxReader;
  }
}

async function testWorkflowResourceApi(baseUrl) {
  let response = await fetch(`${baseUrl}/api/workflow`, { headers: headers(VIEWER_TOKEN) });
  assert.strictEqual(response.status, 200);
  assert.strictEqual((await response.json()).workflow, null);

  response = await fetch(`${baseUrl}/api/exchanges/catalog`, { headers: headers(VIEWER_TOKEN) });
  assert.strictEqual(response.status, 200);
  const catalog = await response.json();
  assert.deepStrictEqual(catalog.implementation, {
    library: 'ccxt', version: '4.5.75', streaming: 'ccxt-pro', orderAuthority: 'rest',
  });
  assert.deepStrictEqual(catalog.exchanges.map(exchange => exchange.id), [
    'paper', 'hyperliquid', 'bybit', 'krakenfutures',
  ]);

  response = await fetch(`${baseUrl}/api/workflow/resources`, {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ kind: 'channel', name: 'Draft channel', configuration: { channelId: '-100-test' } }),
  });
  assert.strictEqual(response.status, 201);
  const draft = (await response.json()).resource;
  assert.strictEqual(draft.status, 'draft');

  response = await fetch(`${baseUrl}/api/workflow/resources/update`, {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      id: draft.id, name: 'Updated channel', description: 'Versioned workflow input',
      configuration: { channelId: '-100-test' },
    }),
  });
  assert.strictEqual(response.status, 200);
  assert.strictEqual((await response.json()).resource.name, 'Updated channel');

  response = await fetch(`${baseUrl}/api/workflow/resources/publish`, {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: draft.id }),
  });
  assert.strictEqual(response.status, 200);
  assert.strictEqual((await response.json()).resource.status, 'published');

  response = await fetch(`${baseUrl}/api/workflow/resources`, {
    method: 'DELETE',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: draft.id }),
  });
  assert.strictEqual(response.status, 412, 'Workflow resource removal must require exact confirmation.');
  response = await fetch(`${baseUrl}/api/workflow/resources`, {
    method: 'DELETE',
    headers: mutationHeaders({
      'Content-Type': 'application/json',
      'X-Destructive-Confirmation': 'delete-workflow-resource',
    }),
    body: JSON.stringify({ id: draft.id }),
  });
  assert.strictEqual(response.status, 200);
  assert.strictEqual((await response.json()).result.archived.status, 'archived');

  response = await fetch(`${baseUrl}/api/workflow/resources`, {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ kind: 'channel', name: 'Disposable draft', configuration: { channelId: '-100-delete' } }),
  });
  const disposable = (await response.json()).resource;
  response = await fetch(`${baseUrl}/api/workflow/resources`, {
    method: 'DELETE',
    headers: mutationHeaders({
      'Content-Type': 'application/json',
      'X-Destructive-Confirmation': 'delete-workflow-resource',
    }),
    body: JSON.stringify({ id: disposable.id }),
  });
  assert.strictEqual(response.status, 200);
  assert.strictEqual((await response.json()).result.deleted, true);

  response = await fetch(`${baseUrl}/api/workflow/resources`, {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ kind: 'unknown', name: 'Invalid', configuration: {} }),
  });
  assert.strictEqual(response.status, 409);
  response = await fetch(`${baseUrl}/api/workflow/resources`, {
    method: 'DELETE',
    headers: mutationHeaders({
      'Content-Type': 'application/json',
      'X-Destructive-Confirmation': 'delete-workflow-resource',
    }),
    body: JSON.stringify({ id: 'missing-resource' }),
  });
  assert.strictEqual(response.status, 409);

}

async function testWorkflowResourceFamilyArchiveApi(baseUrl) {
  let response = await fetch(`${baseUrl}/api/workflow/resources`, {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ kind: 'output', name: 'Family v1', configuration: { mode: 'none' } }),
  });
  const familyV1Draft = (await response.json()).resource;
  response = await fetch(`${baseUrl}/api/workflow/resources/publish`, {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: familyV1Draft.id }),
  });
  const familyV1 = (await response.json()).resource;
  response = await fetch(`${baseUrl}/api/workflow/resources`, {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      resourceId: familyV1.resourceId, kind: 'output', name: 'Family v2', configuration: { mode: 'audit_only' },
    }),
  });
  const familyV2Draft = (await response.json()).resource;
  await fetch(`${baseUrl}/api/workflow/resources/publish`, {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: familyV2Draft.id }),
  });
  response = await fetch(`${baseUrl}/api/workflow/resources`, {
    method: 'DELETE',
    headers: mutationHeaders({
      'Content-Type': 'application/json',
      'X-Destructive-Confirmation': 'delete-workflow-resource',
    }),
    body: JSON.stringify({ resourceId: familyV1.resourceId }),
  });
  assert.strictEqual(response.status, 200);
  assert.strictEqual((await response.json()).result.archived.length, 2);
}

async function testWorkflowRevisionApi(baseUrl) {
  const graph = { schemaVersion: 1, nodes: [], edges: [] };
  let response = await fetch(`${baseUrl}/api/workflow/impact`, {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ baseRevisionId: null, graph }),
  });
  assert.strictEqual(response.status, 200);
  assert.strictEqual((await response.json()).impact.destructive, false);
  response = await fetch(`${baseUrl}/api/workflow/mutate`, {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ baseRevisionId: null, graph }),
  });
  assert.strictEqual(response.status, 201);
  const workflow = (await response.json()).workflow;
  assert.strictEqual(workflow.revision, 1);

  response = await fetch(`${baseUrl}/api/workflow/simulate`, {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ channelId: '-100-test', text: 'BTCUSDT LONG' }),
  });
  assert.strictEqual(response.status, 200);
  assert.strictEqual((await response.json()).result.active, true);
  response = await fetch(`${baseUrl}/api/workflow/simulate`, {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: '{}',
  });
  assert.strictEqual(response.status, 400);
  response = await fetch(`${baseUrl}/api/workflow/mutate`, {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ baseRevisionId: workflow.id, graph: {} }),
  });
  assert.strictEqual(response.status, 409);

  response = await fetch(`${baseUrl}/api/workflow`, { headers: headers(VIEWER_TOKEN) });
  assert.strictEqual(response.status, 200);
  assert.strictEqual((await response.json()).workflow.id, workflow.id);
}

async function testWorkflowControlPlane(baseUrl) {
  await testWorkflowResourceApi(baseUrl);
  await testWorkflowResourceFamilyArchiveApi(baseUrl);
  await testWorkflowRevisionApi(baseUrl);
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
    ['/api/trading/strategies', { method: 'DELETE', headers: mutationHeaders({ 'Content-Type': 'application/json' }), body: '{"id":"strategy"}' }, 412],
    ['/api/trading/signal-schemas', { method: 'DELETE', headers: mutationHeaders({ 'Content-Type': 'application/json' }), body: '{"id":"schema"}' }, 412],
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

async function testTradingStrategyDeletion(baseUrl, appState) {
  const removed = [];
  const original = appState.tradingControl;
  appState.tradingControl = {
    removeStrategy: async id => {
      removed.push(id);
      return true;
    }
  };
  try {
    const response = await fetch(`${baseUrl}/api/trading/strategies`, {
      method: 'DELETE',
      headers: mutationHeaders({
        'Content-Type': 'application/json',
        'X-Destructive-Confirmation': 'delete-trading-strategy'
      }),
      body: JSON.stringify({ id: 'strategy-delete' })
    });
    assert.strictEqual(response.status, 200, 'Confirmed strategy deletion must reach the trading control plane');
    assert.strictEqual((await response.json()).result, true);
    assert.deepStrictEqual(removed, ['strategy-delete']);
  } finally {
    appState.tradingControl = original;
  }
}

async function testTradingSignalSchemaControl(baseUrl, appState) {
  const calls = [];
  const original = appState.tradingControl;
  appState.tradingControl = {
    createSignalSchema: async payload => { calls.push(['create', payload.id]); return payload; },
    updateSignalSchema: async payload => { calls.push(['update', payload.id]); return payload; },
    removeSignalSchema: async id => { calls.push(['delete', id]); return true; },
  };
  try {
    let response = await fetch(`${baseUrl}/api/trading/signal-schemas`, {
      method: 'POST',
      headers: mutationHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ id: 'desk-alpha' }),
    });
    assert.strictEqual(response.status, 201);
    response = await fetch(`${baseUrl}/api/trading/signal-schemas/update`, {
      method: 'POST',
      headers: mutationHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ id: 'desk-alpha' }),
    });
    assert.strictEqual(response.status, 200);
    response = await fetch(`${baseUrl}/api/trading/signal-schemas`, {
      method: 'DELETE',
      headers: mutationHeaders({
        'Content-Type': 'application/json',
        'X-Destructive-Confirmation': 'delete-trading-signal-schema',
      }),
      body: JSON.stringify({ id: 'desk-alpha' }),
    });
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(calls, [
      ['create', 'desk-alpha'], ['update', 'desk-alpha'], ['delete', 'desk-alpha'],
    ]);
  } finally {
    appState.tradingControl = original;
  }
}

async function testPublishedSignalContractDeletion(baseUrl, appState) {
  const removed = [];
  const original = appState.tradingControl;
  appState.tradingControl = {
    removeSignalContractVersion: async versionId => {
      removed.push(versionId);
      return true;
    },
  };
  try {
    let response = await fetch(`${baseUrl}/api/trading/signal-contracts/versions`, {
      method: 'DELETE',
      headers: mutationHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ versionId: 'desk-alpha:v1' }),
    });
    assert.strictEqual(response.status, 412, 'Published contract deletion must require explicit confirmation');
    response = await fetch(`${baseUrl}/api/trading/signal-contracts/versions`, {
      method: 'DELETE',
      headers: mutationHeaders({
        'Content-Type': 'application/json',
        'X-Destructive-Confirmation': 'delete-signal-contract-version',
      }),
      body: JSON.stringify({ versionId: 'desk-alpha:v1' }),
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual((await response.json()).result, true);
    assert.deepStrictEqual(removed, ['desk-alpha:v1']);
  } finally {
    appState.tradingControl = original;
  }
}

async function activateMcpRuntime(baseUrl) {
  let response = await fetch(`${baseUrl}/api/mcp`, { headers: headers(VIEWER_TOKEN) });
  assert.strictEqual(response.status, 403, 'MCP agent inventory must be restricted to administrators');

  response = await fetch(`${baseUrl}/api/mcp`, { headers: headers(ADMIN_TOKEN) });
  assert.strictEqual(response.status, 200);
  assert.strictEqual((await response.json()).runtime.mode, 'disabled', 'MCP must ship disabled by default');

  response = await fetch(`${baseUrl}/api/mcp/runtime`, {
    method: 'POST',
    headers: headers(VIEWER_TOKEN, {
      'Content-Type': 'application/json',
      'X-Requested-With': 'forwarder-dashboard',
    }),
    body: JSON.stringify({ mode: 'active' }),
  });
  assert.strictEqual(response.status, 403, 'Viewer must not change the MCP runtime mode');

  response = await fetch(`${baseUrl}/api/mcp/runtime`, {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ mode: 'active' }),
  });
  assert.strictEqual(response.status, 412, 'MCP activation must require explicit confirmation');

  response = await fetch(`${baseUrl}/api/mcp/runtime`, {
    method: 'POST',
    headers: mutationHeaders({
      'Content-Type': 'application/json',
      'X-Destructive-Confirmation': 'set-mcp-runtime-active',
    }),
    body: JSON.stringify({ mode: 'active' }),
  });
  assert.strictEqual(response.status, 200, 'Administrator must be able to activate MCP explicitly');
  assert.strictEqual((await response.json()).state.mode, 'active');
}

async function createAndConfigureMcpAgent(baseUrl) {
  let response = await fetch(`${baseUrl}/api/mcp/agents`, {
    method: 'POST',
    headers: headers(VIEWER_TOKEN, {
      'Content-Type': 'application/json',
      'X-Requested-With': 'forwarder-dashboard',
    }),
    body: JSON.stringify({ name: 'viewer-agent', permissions: ['system.read'] }),
  });
  assert.strictEqual(response.status, 403, 'Viewer must not provision MCP credentials');

  response = await fetch(`${baseUrl}/api/mcp/agents`, {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      name: 'operator-agent',
      permissions: ['system.read', 'positions.read'],
      eventSubscriptions: ['signal_received'],
    }),
  });
  assert.strictEqual(response.status, 201, 'Administrator must be able to provision an MCP agent');
  const created = await response.json();
  assert.match(created.token, /^tsx_mcp_[A-Za-z0-9_-]{40,}$/);
  assert.equal(Object.hasOwn(created.agent, 'tokenSha256'), false, 'MCP token digest must not reach the dashboard');
  assert.ok(await authenticateMcpToken(created.token), 'The one-time token must authenticate until rotated');

  response = await fetch(`${baseUrl}/api/mcp`, { headers: headers(ADMIN_TOKEN) });
  assert.strictEqual(response.status, 200);
  const snapshot = await response.json();
  assert.ok(snapshot.agents.some(agent => agent.id === created.agent.id));
  assert.equal(JSON.stringify(snapshot).includes(created.token), false, 'MCP snapshot must not redisclose a token');
  assert.equal(JSON.stringify(snapshot).includes('tokenSha256'), false, 'MCP snapshot must not expose token digests');

  response = await fetch(`${baseUrl}/api/mcp/agents/update`, {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      id: created.agent.id,
      name: 'operator-agent',
      permissions: ['system.read'],
      eventSubscriptions: [],
      enabled: true,
    }),
  });
  assert.strictEqual(response.status, 200, 'Administrator must be able to replace permanent MCP permissions');
  assert.deepStrictEqual((await response.json()).agent.permissions, ['system.read']);

  await testMcpProposalAdministration(baseUrl, created.agent.id);
  return created;
}

async function rotateMcpAgentCredential(baseUrl, created) {
  let response = await fetch(`${baseUrl}/api/mcp/agents/rotate`, {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: created.agent.id }),
  });
  assert.strictEqual(response.status, 412, 'MCP token rotation must require explicit confirmation');

  response = await fetch(`${baseUrl}/api/mcp/agents/rotate`, {
    method: 'POST',
    headers: mutationHeaders({
      'Content-Type': 'application/json',
      'X-Destructive-Confirmation': 'rotate-mcp-agent-token',
    }),
    body: JSON.stringify({ id: created.agent.id }),
  });
  assert.strictEqual(response.status, 200);
  const rotated = await response.json();
  assert.notStrictEqual(rotated.token, created.token);
  assert.strictEqual(await authenticateMcpToken(created.token), null, 'Rotation must revoke the old MCP token immediately');
  assert.ok(await authenticateMcpToken(rotated.token), 'The replacement MCP token must authenticate');
  return rotated;
}

async function removeMcpAgent(baseUrl, created, rotated) {
  let response = await fetch(`${baseUrl}/api/mcp/agents`, {
    method: 'DELETE',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: created.agent.id }),
  });
  assert.strictEqual(response.status, 412, 'MCP agent deletion must require explicit confirmation');

  response = await fetch(`${baseUrl}/api/mcp/agents`, {
    method: 'DELETE',
    headers: mutationHeaders({
      'Content-Type': 'application/json',
      'X-Destructive-Confirmation': 'delete-mcp-agent',
    }),
    body: JSON.stringify({ id: created.agent.id }),
  });
  assert.strictEqual(response.status, 200, 'Administrator must be able to delete an MCP agent');
  assert.strictEqual((await response.json()).deleted, true);
  assert.strictEqual(await authenticateMcpToken(rotated.token), null, 'Deleting an MCP agent must revoke its token immediately');
  response = await fetch(`${baseUrl}/api/mcp`, { headers: headers(ADMIN_TOKEN) });
  assert.strictEqual((await response.json()).agents.some(agent => agent.id === created.agent.id), false);
}

async function disableMcpRuntime(baseUrl) {
  let response = await fetch(`${baseUrl}/api/mcp/runtime`, {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ mode: 'standby' }),
  });
  assert.strictEqual(response.status, 200, 'Administrator must be able to place MCP in standby');
  assert.strictEqual((await response.json()).state.mode, 'standby');

  response = await fetch(`${baseUrl}/api/mcp/runtime`, {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ mode: 'disabled' }),
  });
  assert.strictEqual(response.status, 412, 'Disabling MCP must require explicit confirmation');

  response = await fetch(`${baseUrl}/api/mcp/runtime`, {
    method: 'POST',
    headers: mutationHeaders({
      'Content-Type': 'application/json',
      'X-Destructive-Confirmation': 'set-mcp-runtime-disabled',
    }),
    body: JSON.stringify({ mode: 'disabled' }),
  });
  assert.strictEqual(response.status, 200, 'Administrator must be able to disable MCP explicitly');
  assert.strictEqual((await response.json()).state.mode, 'disabled');
}

async function testMcpAgentAdministration(baseUrl) {
  await activateMcpRuntime(baseUrl);
  const created = await createAndConfigureMcpAgent(baseUrl);
  const rotated = await rotateMcpAgentCredential(baseUrl, created);
  await removeMcpAgent(baseUrl, created, rotated);
  await disableMcpRuntime(baseUrl);
}

async function testMcpProposalAdministration(baseUrl, agentId) {
  const approvedProposal = await createMcpProposal({
    agentId,
    action: 'risk.update',
    payload: { channelId: '-web-approved' },
  });
  let response = await fetch(`${baseUrl}/api/mcp/proposals/approve`, {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: approvedProposal.id }),
  });
  assert.strictEqual(response.status, 412, 'MCP proposal approval must require explicit confirmation');
  response = await fetch(`${baseUrl}/api/mcp/proposals/approve`, {
    method: 'POST',
    headers: mutationHeaders({
      'Content-Type': 'application/json',
      'X-Destructive-Confirmation': 'approve-mcp-proposal',
    }),
    body: JSON.stringify({ id: approvedProposal.id }),
  });
  assert.strictEqual(response.status, 200);
  assert.strictEqual((await response.json()).proposal.status, 'approved');

  const rejectedProposal = await createMcpProposal({
    agentId,
    action: 'risk.delete',
    payload: { channelId: '-web-rejected' },
  });
  response = await fetch(`${baseUrl}/api/mcp/proposals/reject`, {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: rejectedProposal.id, reason: 'Operator test rejection' }),
  });
  assert.strictEqual(response.status, 200);
  assert.strictEqual((await response.json()).proposal.status, 'rejected');
}

async function testTradeJournalApi(baseUrl) {
  let response = await fetch(`${baseUrl}/api/trading/journal`, { headers: headers(VIEWER_TOKEN) });
  assert.strictEqual(response.status, 200);
  assert.deepStrictEqual((await response.json()).entries, []);

  response = await fetch(`${baseUrl}/api/trading/journal/export?format=csv`, {
    headers: headers(VIEWER_TOKEN),
  });
  assert.strictEqual(response.status, 200);
  assert.match(response.headers.get('content-disposition') || '', /attachment; filename="tsx-core-trade-journal-/);
  assert.strictEqual(response.headers.get('cache-control'), 'no-store');
  assert.strictEqual(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await response.text(), /intent_id/);

  response = await fetch(`${baseUrl}/api/trading/journal/export?format=xml`, {
    headers: headers(VIEWER_TOKEN),
  });
  assert.strictEqual(response.status, 400);

  response = await fetch(`${baseUrl}/api/trading/journal`, {
    method: 'POST',
    headers: mutationHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ intentId: 'missing', tags: [], reviewed: true }),
  });
  assert.strictEqual(response.status, 503, 'Failed audited journal mutations must fail closed');
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
  const controlEvents = controls.auditEvents.filter(event => event.path === '/api/control');
  assert.ok(controlEvents.some(event => event.phase === 'authorized' && event.action === 'routing.control'));
  assert.ok(controlEvents.some(event => event.phase === 'completed'
    && event.action === 'routing.control' && event.outcome === 'succeeded' && event.statusCode === 200));
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
  const stopCallsBeforeClear = appState.controls.stopCalls;
  const originalTradingControl = appState.tradingControl;
  appState.tradingControl = {};
  response = await fetch(`${baseUrl}/api/clear-database`, { method: 'POST', headers: destructiveHeaders });
  assert.strictEqual(response.status, 200, 'Confirmed operational data clear must stop routing and support installed trading');
  const clearResult = await response.json();
  assert.strictEqual(clearResult.routingStopped, true);
  assert.strictEqual(typeof clearResult.cleared.retainedTradingSignals, 'number');
  assert.strictEqual(appState.state.isRunning, false);
  assert.strictEqual(appState.controls.stopCalls, stopCallsBeforeClear + 1);
  appState.tradingControl = originalTradingControl;
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
  assert.ok(Number(response.headers.get('content-length')) > 0, 'SPA responses must declare their exact size');
  assert.strictEqual(response.headers.get('cache-control'), 'no-cache');
  assert.match(await response.text(), /<html(?:\s|>)/i);
  response = await fetch(`${baseUrl}/assets/.static-response-test.js`, {
    headers: { 'Accept-Encoding': 'gzip' }, signal: AbortSignal.timeout(2000)
  });
  assert.strictEqual(response.status, 200);
  assert.ok(Number(response.headers.get('content-length')) > 0, 'Static assets must declare their transmitted size');
  assert.strictEqual(response.headers.get('content-encoding'), 'gzip');
  assert.strictEqual(response.headers.get('vary'), 'Accept-Encoding');
  assert.strictEqual(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.match(await response.text(), /import|function|const|var/);
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
    const bootstrapStatus = await fetch(`${baseUrl}/api/bootstrap/status`);
    assert.strictEqual(bootstrapStatus.status, 200);
    assert.deepStrictEqual(await bootstrapStatus.json(), {
      mode: 'token',
      required: true,
      available: true,
      localSessionAvailable: false,
    });
    let response = await fetch(`${baseUrl}/api/local-session`, {
      method: 'POST',
      headers: { Origin: baseUrl, 'X-Requested-With': 'forwarder-dashboard' }
    });
    assert.strictEqual(response.status, 409, 'First local startup must not bypass the visible administrator-token bootstrap');
    response = await fetch(`${baseUrl}/api/bootstrap`, {
      method: 'POST',
      headers: { Origin: baseUrl, 'X-Requested-With': 'forwarder-dashboard' }
    });
    const localStartup = await response.json();
    assert.strictEqual(response.status, 201, 'First local startup must visibly issue a one-time administrator token');
    assert.match(localStartup.token, /^[a-f0-9]{64}$/);
    const authenticated = await fetch(`${baseUrl}/api/status`, { headers: headers(localStartup.token) });
    assert.strictEqual(authenticated.status, 200, 'The displayed first-run token must authenticate immediately');
    response = await fetch(`${baseUrl}/api/local-session`, {
      method: 'POST',
      headers: { Origin: baseUrl, 'X-Requested-With': 'forwarder-dashboard' }
    });
    const session = await response.json();
    assert.strictEqual(response.status, 201, 'Local convenience sessions may start only after visible bootstrap');
    assert.strictEqual(session.generatedAdminToken, false);
    assert.notStrictEqual(session.token, localStartup.token, 'A local session must not redisclose the durable token');
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
    assert.strictEqual(recoveryPayload.generatedAdminToken, true);
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
  const staticAsset = path.resolve('frontend/dist/assets/.static-response-test.js');
  let stopped = false;

  try {
    await initDb(path.join(testDir, 'forwarder.db'));
    await mkdir(staticDirectory, { recursive: true });
    await mkdir(path.dirname(staticAsset), { recursive: true });
    await writeFile(staticAsset, `const staticResponseTest = ${JSON.stringify('x'.repeat(2048))};\n`);
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
    await testOperatorReadContracts(baseUrl, appState);
    await testWorkflowControlPlane(baseUrl);
    await testTelegramWebLogin(baseUrl);
    await testRequestValidation(baseUrl);
    await testTradingStrategyDeletion(baseUrl, appState);
    await testTradingSignalSchemaControl(baseUrl, appState);
    await testPublishedSignalContractDeletion(baseUrl, appState);
    await testMcpAgentAdministration(baseUrl);
    await testTradeJournalApi(baseUrl);

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
    await rm(staticAsset, { force: true });
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
