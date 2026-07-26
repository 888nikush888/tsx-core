import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb } from '../src/db.js';
import { McpControlBridge } from '../src/mcp_control_bridge.js';
import {
  authenticateMcpToken,
  claimNextMcpControlRequest,
  completeMcpControlRequest,
  connectMcpSession,
  createMcpAgent,
  disconnectMcpSession,
  enqueueMcpControlRequest,
  getMcpControlRequest,
  listMcpAgentActions,
  listMcpAgents,
  listMcpSessions,
  listPendingMcpEvents,
  recordMcpAgentAction,
  recordMcpEventDelivery,
  recoverInterruptedMcpControlRequests,
  rotateMcpAgentToken,
  touchMcpSession,
  updateMcpAgent,
  waitForMcpControlRequest,
} from '../src/mcp_repository.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-mcp-control-'));
try {
  await initDb(path.join(directory, 'forwarder.db'));
  await assert.rejects(
    createMcpAgent({ name: '', permissions: [] }),
    /name is invalid/,
  );
  await assert.rejects(
    createMcpAgent({ name: 'Invalid permissions', permissions: 'system.read' }),
    /must be an array/,
  );
  await assert.rejects(
    createMcpAgent({ name: 'Unknown permission', permissions: ['root'] }),
    /unsupported value/,
  );
  const created = await createMcpAgent({
    name: 'Test operator',
    permissions: ['system.read', 'contracts.write', 'trading.flatten'],
    eventSubscriptions: ['signal_received', 'position_closed'],
  });
  assert.match(created.token, /^tsx_mcp_[A-Za-z0-9_-]{40,}$/);
  assert.equal(created.agent.tokenPrefix, created.token.slice(0, 16));
  assert.equal('tokenSha256' in created.agent, false);
  assert.equal((await authenticateMcpToken(created.token))?.id, created.agent.id);
  assert.equal(await authenticateMcpToken('tsx_mcp_invalid'), null);
  assert.equal(await authenticateMcpToken(42), null);
  assert.equal(await authenticateMcpToken(`tsx_mcp_${'x'.repeat(200)}`), null);
  const defaultAgent = await createMcpAgent({
    name: 'Default subscriptions',
    permissions: [],
  });
  assert.deepEqual(defaultAgent.agent.eventSubscriptions, []);

  const session = await connectMcpSession({
    id: 'mcp-session-test',
    agentId: created.agent.id,
    clientName: 'test-client',
    clientVersion: '1.0.0',
  });
  assert.equal((await listMcpSessions())[0].clientName, 'test-client');
  const defaultSession = await connectMcpSession({
    id: 'mcp-default-session',
    agentId: defaultAgent.agent.id,
  });
  assert.equal(defaultSession.clientName, 'unknown-client');
  assert.equal(defaultSession.clientVersion, 'unknown');
  assert.equal(await touchMcpSession('missing-session', created.agent.id), false);
  await disconnectMcpSession(defaultSession.id);
  await assert.rejects(listMcpSessions(0), /limit is invalid/);
  await assert.rejects(listMcpAgentActions(1_001), /limit is invalid/);

  await getDatabase().run(
    `INSERT INTO trading_execution_events (
       id, event_type, occurred_at, details_json, correlation_id
     ) VALUES (?, 'signal_received', ?, '{}', ?)`,
    ['event-1', Date.now() + 1, 'correlation-1'],
  );
  let events = await listPendingMcpEvents(created.agent, session);
  assert.deepEqual(events.map(event => event.id), ['event-1']);
  await recordMcpEventDelivery({
    eventId: 'event-1',
    agentId: created.agent.id,
    sessionId: session.id,
    eventType: 'signal_received',
    status: 'failed',
    error: 'temporary transport failure',
  });
  events = await listPendingMcpEvents(created.agent, session);
  assert.equal(events.length, 1, 'Failed notifications remain retryable.');
  await recordMcpEventDelivery({
    eventId: 'event-1',
    agentId: created.agent.id,
    sessionId: session.id,
    eventType: 'signal_received',
    status: 'delivered',
  });
  assert.equal((await listPendingMcpEvents(created.agent, session)).length, 0);
  assert.deepEqual(await listPendingMcpEvents(defaultAgent.agent, defaultSession), []);
  await assert.rejects(listPendingMcpEvents(created.agent, session, 0), /event limit is invalid/);
  await getDatabase().run(
    `INSERT INTO trading_execution_events (
       id, channel_id, exchange, mode, event_type, occurred_at, details_json, correlation_id
     ) VALUES ('event-invalid-json', 'channel-1', 'paper', 'paper', 'position_closed', ?, '{', 'correlation-2')`,
    [Date.now() + 2],
  );
  const mappedEvent = (await listPendingMcpEvents(created.agent, session))
    .find(event => event.id === 'event-invalid-json');
  assert.deepEqual(mappedEvent?.details, {});
  assert.equal(mappedEvent?.channelId, 'channel-1');

  const calls = [];
  const fakeControl = {
    createSignalContract(payload) {
      calls.push(['create', payload]);
      return { id: payload.id || 'generated-contract' };
    },
    updateSignalContract() { throw new Error('contract update rejected'); },
    publishSignalContract() {},
    archiveSignalContract() {},
    removeSignalContractDraft() {},
    setChannelRiskPolicy() {},
    removeChannelRiskPolicy() {},
    reconcile() {},
    cancelEntries() {},
    setRuntime() {},
    emergencyFlatten(payload) {
      calls.push(['flatten', payload]);
      return 2;
    },
  };
  const auditEvents = [];
  const bridge = new McpControlBridge(
    fakeControl,
    { record: async event => { auditEvents.push(event); } },
    () => undefined,
    50,
  );
  await bridge.start();
  const controlRequest = await enqueueMcpControlRequest({
    agentId: created.agent.id,
    sessionId: session.id,
    action: 'contracts.create',
    payload: { id: 'agent-contract', name: 'Agent contract', definition: {} },
  });
  const completed = await waitForMcpControlRequest(controlRequest.id, 5_000);
  assert.equal(completed.status, 'succeeded');
  assert.deepEqual(calls[0], ['create', { id: 'agent-contract', name: 'Agent contract', definition: {} }]);
  assert.deepEqual(auditEvents.map(event => event.phase), ['authorized', 'completed']);

  const failedRequest = await enqueueMcpControlRequest({
    agentId: created.agent.id,
    sessionId: session.id,
    action: 'contracts.update',
    payload: { contractId: 'missing-contract', versionId: 'missing-version' },
  });
  const failed = await waitForMcpControlRequest(failedRequest.id, 5_000);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /contract update rejected/);

  const flattenRequest = await enqueueMcpControlRequest({
    agentId: created.agent.id,
    sessionId: session.id,
    action: 'trading.flatten',
    payload: {},
  });
  assert.equal((await waitForMcpControlRequest(flattenRequest.id, 5_000)).status, 'succeeded');
  assert.equal(calls[1][1].confirmation, 'FLATTEN MANAGED POSITIONS');
  await bridge.stop();

  const circular = {};
  circular.self = circular;
  await assert.rejects(recordMcpAgentAction({
    agentId: created.agent.id,
    toolName: 'tsx_bad_json',
    permission: 'system.read',
    outcome: 'failed',
    request: circular,
    error: null,
    startedAt: Date.now(),
  }), /JSON-serializable/);
  await assert.rejects(recordMcpAgentAction({
    agentId: created.agent.id,
    toolName: 'tsx_large_json',
    permission: 'system.read',
    outcome: 'failed',
    request: { text: 'x'.repeat(70 * 1024) },
    startedAt: Date.now(),
  }), /64 KiB/);
  await recordMcpAgentAction({
    agentId: created.agent.id,
    sessionId: session.id,
    toolName: 'tsx_system_status',
    permission: 'system.read',
    outcome: 'succeeded',
    request: {},
    result: { type: 'object' },
    startedAt: Date.now() - 5,
  });
  assert.equal((await listMcpAgentActions())[0].agentName, 'Test operator');
  await recordMcpAgentAction({
    agentId: created.agent.id,
    toolName: 'tsx_no_session',
    permission: 'system.read',
    outcome: 'rejected',
    request: null,
    startedAt: Date.now(),
  });
  assert.equal((await listMcpAgentActions())[0].sessionId, null);

  await assert.rejects(
    enqueueMcpControlRequest({ agentId: created.agent.id, action: 'invalid-action' }),
    /action is invalid/,
  );
  const recoverable = await enqueueMcpControlRequest({
    agentId: created.agent.id,
    action: 'trading.kill_switch',
  });
  assert.equal(recoverable.sessionId, null);
  assert.deepEqual(recoverable.payload, {});
  assert.equal((await claimNextMcpControlRequest())?.id, recoverable.id);
  assert.equal(await recoverInterruptedMcpControlRequests(), 1);
  assert.equal((await getMcpControlRequest(recoverable.id))?.status, 'failed');
  assert.equal(await getMcpControlRequest('missing-request'), null);
  await assert.rejects(waitForMcpControlRequest('missing-request', 1_000), /disappeared/);
  await assert.rejects(waitForMcpControlRequest(recoverable.id, 10), /timeout is invalid/);
  assert.equal(await claimNextMcpControlRequest(), null);
  await assert.rejects(
    completeMcpControlRequest(recoverable.id, { result: null }),
    /not running/,
  );

  const rotated = await rotateMcpAgentToken(created.agent.id);
  assert.equal(await authenticateMcpToken(created.token), null);
  assert.equal((await authenticateMcpToken(rotated.token))?.id, created.agent.id);
  assert.notEqual(rotated.token, created.token);
  assert.ok((await listMcpSessions()).find(item => item.id === session.id)?.disconnectedAt);
  await assert.rejects(rotateMcpAgentToken('missing-agent'), /does not exist/);
  await assert.rejects(updateMcpAgent({
    id: created.agent.id,
    name: 'Test operator',
    permissions: [],
    eventSubscriptions: [],
    enabled: 'yes',
  }), /must be boolean/);
  await assert.rejects(updateMcpAgent({
    id: 'missing-agent',
    name: 'Missing',
    permissions: [],
    eventSubscriptions: [],
    enabled: true,
  }), /does not exist/);

  const disabled = await updateMcpAgent({
    id: created.agent.id,
    name: 'Test operator',
    permissions: [],
    eventSubscriptions: [],
    enabled: false,
  });
  assert.equal(disabled.enabled, false);
  assert.equal(await authenticateMcpToken(rotated.token), null);
  assert.equal((await listMcpAgents()).length, 2, 'Disabled agents are retained for audit history.');
  console.log('MCP control-plane tests passed.');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
