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
  const { token } = await createMcpAgent({
    name: 'Protocol test agent',
    permissions: ['system.read', 'trading.kill_switch'],
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

  client = new Client({ name: 'tsx-core-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  );
  await client.connect(transport);
  const tools = await client.listTools();
  assert.ok(tools.tools.some(tool => tool.name === 'tsx_system_status'));
  assert.ok(tools.tools.some(tool => tool.name === 'tsx_emergency_flatten'));
  const status = await client.callTool({ name: 'tsx_system_status', arguments: {} });
  assert.equal(status.isError, undefined);
  const content = status.content;
  assert.ok(Array.isArray(content));
  const parsed = JSON.parse(content[0].text);
  assert.equal(parsed.overview.openPositionCount, 0);
  const denied = await client.callTool({ name: 'tsx_risk_status', arguments: {} });
  assert.equal(denied.isError, true, 'Tool calls without a permanent grant must fail inside MCP');
  const killSwitch = await client.callTool({
    name: 'tsx_set_kill_switch',
    arguments: { active: true, reason: 'protocol test' },
  });
  assert.equal(killSwitch.isError, undefined);
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
  await client.close();
  client = null;
  await bridge.stop();
  bridge = null;
  await closeDb();
  const maintenance = await beginMcpSharedMaintenance('protocol test', databasePath);
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('MCP server ignored maintenance marker.')), 5_000)),
  ]);
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
