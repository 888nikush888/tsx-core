import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { closeDb, getDatabase, initDb } from '../src/db.js';
import { McpControlBridge } from '../src/mcp_control_bridge.js';
import { createMcpAgent } from '../src/mcp_repository.js';
import { beginMcpSharedMaintenance } from '../src/mcp_maintenance.js';
import { seedTradingFixtures } from './trading_fixtures.js';

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`MCP server exited with code ${child.exitCode}.`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Startup is still in progress.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('MCP server did not become healthy.');
}

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-mcp-server-'));
const databasePath = path.join(directory, 'forwarder.db');
const port = await availablePort();
let child;
let client;
let bridge;
let serverOutput = '';
try {
  await initDb(databasePath);
  await seedTradingFixtures();
  const { token } = await createMcpAgent({
    name: 'Protocol test agent',
    permissions: [
      'system.read', 'contracts.read', 'positions.read', 'signals.read', 'risk.read',
      'strategies.read', 'routes.read', 'analytics.read', 'journal.read',
      'contracts.write', 'risk.write', 'trading.reconcile', 'trading.kill_switch',
    ],
    eventSubscriptions: ['signal_received'],
  });
  await closeDb();

  child = spawn(process.execPath, ['--import', 'tsx', 'src/mcp_server.ts'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      FORWARDER_DB_PATH: databasePath,
      MCP_HOST: '127.0.0.1',
      MCP_PORT: String(port),
      MCP_ALLOWED_ORIGINS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', chunk => { serverOutput += chunk.toString(); });
  child.stderr.on('data', chunk => { serverOutput += chunk.toString(); });
  await waitForHealth(`http://127.0.0.1:${port}/healthz`, child);
  await initDb(databasePath);
  bridge = new McpControlBridge(
    {
      setRuntime(payload) {
        return { killSwitchActive: payload.enabled, reason: payload.reason };
      },
      createSignalSchema(payload) {
        return { ...payload, created: true };
      },
      reconcile(accountId) {
        if (accountId === 'fail-account') throw new Error('simulated reconcile failure');
        return { accountId: accountId || null, reconciled: true };
      },
    },
    { record: async () => undefined },
    () => undefined,
    50,
  );
  await bridge.start();

  const rejected = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tsx_mcp_invalid' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'invalid', version: '1' } },
    }),
  });
  assert.equal(rejected.status, 401);
  const missingAuthentication = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(missingAuthentication.status, 401);
  const rejectedOrigin = await fetch(`http://127.0.0.1:${port}/healthz`, {
    headers: { Origin: 'https://untrusted.example' },
  });
  assert.equal(rejectedOrigin.status, 403);

  client = new Client({ name: 'tsx-core-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  );
  await client.connect(transport);
  const tools = await client.listTools();
  assert.ok(tools.tools.some(tool => tool.name === 'tsx_system_status'));
  assert.ok(tools.tools.some(tool => tool.name === 'tsx_emergency_flatten'));
  for (const toolName of [
    'tsx_contract_validate',
    'tsx_signal_schemas_list',
    'tsx_strategies_list',
    'tsx_routes_list',
    'tsx_analytics',
    'tsx_trade_journal',
    'tsx_preflight',
    'tsx_proposals_list',
    'tsx_contract_publish',
    'tsx_signal_schema_delete',
    'tsx_strategy_publish',
    'tsx_route_set',
  ]) {
    assert.ok(tools.tools.some(tool => tool.name === toolName), `${toolName} must be registered`);
  }
  const status = await client.callTool({ name: 'tsx_system_status', arguments: {} });
  assert.equal(status.isError, undefined);
  const content = status.content;
  assert.ok(Array.isArray(content));
  const parsed = JSON.parse(content[0].text);
  assert.equal(parsed.overview.openPositionCount, 0);
  const contractsResult = await client.callTool({ name: 'tsx_contracts_list', arguments: {} });
  assert.equal(contractsResult.isError, undefined);
  const contracts = JSON.parse(contractsResult.content[0].text);
  const standardDefinition = contracts.find(contract => contract.id === 'standard').versions[0].definition;
  const validated = await client.callTool({
    name: 'tsx_contract_validate',
    arguments: {
      definition: standardDefinition,
      xml: '<signal><action>LONG</action><pair>BTCUSDT</pair><entry_range><min>60000</min><max>61000</max></entry_range><targets><target id="1">62000</target></targets><stoploss>59000</stoploss></signal>',
      sourceText: 'LONG BTCUSDT entry 60000 to 61000 target 62000 stoploss 59000',
    },
  });
  assert.equal(validated.isError, undefined);
  const preflight = await client.callTool({
    name: 'tsx_preflight',
    arguments: { action: 'risk.update', payload: { channelId: '-protocol-channel' } },
  });
  assert.equal(preflight.isError, undefined);
  const preflightPayload = JSON.parse(preflight.content[0].text);
  assert.equal(preflightPayload.allowed, true);
  assert.equal(preflightPayload.requiresApproval, true);
  for (const [toolName, argumentsValue] of [
    ['tsx_positions_list', { limit: 10 }],
    ['tsx_signals_list', { limit: 10 }],
    ['tsx_risk_status', {}],
    ['tsx_signal_schemas_list', {}],
    ['tsx_strategies_list', {}],
    ['tsx_routes_list', {}],
    ['tsx_analytics', {}],
    ['tsx_trade_journal', { limit: 10 }],
    ['tsx_proposals_list', { limit: 10 }],
  ]) {
    const result = await client.callTool({ name: toolName, arguments: argumentsValue });
    assert.equal(result.isError, undefined, `${toolName} must satisfy its read contract`);
  }
  const schemaProposal = await client.callTool({
    name: 'tsx_signal_schema_create',
    arguments: {
      id: 'protocol-schema',
      name: 'Protocol schema',
      description: '',
      parserSchema: 'standard',
      contractVersionId: 'standard:v1',
      templateName: 'default',
      enabled: false,
    },
  });
  assert.equal(schemaProposal.isError, undefined);
  const schemaProposalPayload = JSON.parse(schemaProposal.content[0].text);
  assert.equal(schemaProposalPayload.status, 'completed');
  const proposalStatus = await client.callTool({
    name: 'tsx_proposal_status',
    arguments: { proposalId: schemaProposalPayload.proposalId },
  });
  assert.equal(proposalStatus.isError, undefined);
  const missingProposal = await client.callTool({
    name: 'tsx_proposal_status',
    arguments: { proposalId: 'missing-proposal' },
  });
  assert.equal(missingProposal.isError, true);
  const reconcile = await client.callTool({ name: 'tsx_reconcile', arguments: {} });
  assert.equal(reconcile.isError, undefined);
  const failedReconcile = await client.callTool({
    name: 'tsx_reconcile', arguments: { accountId: 'fail-account' },
  });
  assert.equal(failedReconcile.isError, true);
  const pendingRisk = await client.callTool({
    name: 'tsx_risk_policy_delete', arguments: { channelId: '-pending-risk' },
  });
  assert.equal(JSON.parse(pendingRisk.content[0].text).status, 'pending');
  const denied = await client.callTool({ name: 'tsx_contract_create', arguments: {} });
  assert.equal(denied.isError, true, 'Tool calls without a permanent grant must fail inside MCP');
  const killSwitch = await client.callTool({
    name: 'tsx_set_kill_switch',
    arguments: { active: true, reason: 'protocol test' },
  });
  assert.equal(killSwitch.isError, undefined);
  const missingReason = await client.callTool({
    name: 'tsx_set_kill_switch', arguments: { active: true },
  });
  assert.equal(missingReason.isError, true);
  const releaseKillSwitch = await client.callTool({
    name: 'tsx_set_kill_switch', arguments: { active: false },
  });
  assert.equal(releaseKillSwitch.isError, true, 'Inactive persisted kill switch must block release preflight');
  await getDatabase().run(
    `INSERT INTO trading_execution_events (
       id, event_type, occurred_at, details_json, correlation_id
     ) VALUES ('protocol-event', 'signal_received', ?, '{}', 'protocol-correlation')`,
    [Date.now()],
  );
  await new Promise(resolve => setTimeout(resolve, 1_300));
  const delivered = await getDatabase().get(
    `SELECT status FROM mcp_event_deliveries
     WHERE source_event_id = 'protocol-event' AND status = 'delivered'`,
  );
  assert.equal(delivered?.status, 'delivered', 'Subscribed MCP events must be pushed to the active session');
  const activeSessionId = transport.sessionId;
  assert.ok(activeSessionId, 'The MCP transport must expose its negotiated session identifier.');
  const terminatedSession = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
      'mcp-session-id': activeSessionId,
    },
  });
  assert.equal(terminatedSession.status, 200);
  await terminatedSession.text();
  await client.close();
  client = null;
  const invalidSession = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} }),
  });
  assert.equal(invalidSession.status, 400);
  let rateLimitedStatus = 0;
  for (let attempt = 0; attempt < 22; attempt += 1) {
    const rateLimitedResponse = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer invalid-token-value',
        Connection: 'close',
      },
      body: '{}',
    });
    rateLimitedStatus = rateLimitedResponse.status;
    await rateLimitedResponse.text();
  }
  assert.equal(rateLimitedStatus, 429);
  await bridge.stop();
  bridge = null;
  await closeDb();
  const maintenance = await beginMcpSharedMaintenance('protocol test', databasePath);
  if (child.exitCode === null) {
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('MCP server ignored maintenance marker.')), 5_000)),
    ]);
  }
  assert.equal(child.exitCode, 1);
  await maintenance.release();
  console.log('MCP Streamable HTTP protocol tests passed.');
} catch (error) {
  if (child) console.error(`MCP child output:\n${serverOutput}`);
  throw error;
} finally {
  await client?.close().catch(() => undefined);
  await bridge?.stop().catch(() => undefined);
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
  }
  await closeDb().catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}
