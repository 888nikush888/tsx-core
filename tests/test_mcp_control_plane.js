import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb } from '../src/db.js';
import { McpControlBridge } from '../src/mcp_control_bridge.js';
import { STARTUP_GATES, StartupAuthority } from '../src/startup_authority.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import {
  approveMcpProposal,
  authenticateMcpToken,
  claimNextMcpControlRequest,
  completeMcpControlRequest,
  connectMcpSession,
  createMcpAgent,
  createMcpProposal,
  deleteMcpAgent,
  disconnectMcpSession,
  enqueueMcpControlRequest,
  getMcpRuntimeState,
  getMcpControlRequest,
  listMcpProposals,
  listMcpAgentActions,
  listMcpAgents,
  listMcpSessions,
  listPendingMcpEvents,
  preflightMcpAction,
  recordMcpAgentAction,
  recordMcpEventDelivery,
  recoverInterruptedMcpControlRequests,
  rejectMcpProposal,
  rotateMcpAgentToken,
  setMcpRuntimeMode,
  touchMcpSession,
  updateMcpAgent,
  waitForMcpControlRequest,
  waitForMcpProposal,
} from '../src/mcp_repository.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-mcp-control-'));
const databasePath = path.join(directory, 'forwarder.db');
try {
  await initDb(databasePath);
  await seedTradingFixtures();
  assert.equal((await getMcpRuntimeState()).mode, 'disabled', 'Factory-default MCP runtime must be disabled.');
  await assert.rejects(
    connectMcpSession({ id: 'disabled-session', agentId: 'missing-agent' }),
    /runtime is not active/,
  );
  await setMcpRuntimeMode('active', 'test:setup');
  await closeDb();
  await initDb(databasePath);
  assert.equal((await getMcpRuntimeState()).mode, 'active', 'MCP runtime mode must survive database restarts.');
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
    permissions: ['system.read', 'contracts.write', 'risk.write', 'trading.flatten'],
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
  const updatedDefaultAgent = await updateMcpAgent({
    id: defaultAgent.agent.id,
    name: 'Default subscriptions',
    permissions: [],
    enabled: true,
  });
  assert.deepEqual(updatedDefaultAgent.eventSubscriptions, []);

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
  await getDatabase().run(
    `INSERT INTO trading_signal_contracts (
       id, name, description, archived, created_at, updated_at
     ) VALUES ('agent-contract', 'Agent contract', '', 0, ?, ?)`,
    [Date.now(), Date.now()],
  );
  await getDatabase().run(
    `INSERT INTO trading_signal_contract_versions (
       id, contract_id, version, status, definition_json, definition_sha256,
       created_at
     ) VALUES ('agent-contract:v1', 'agent-contract', 1, 'draft', '{}', ?, ?)`,
    ['a'.repeat(64), Date.now()],
  );
  const fakeControl = {
    createSignalContract(payload) {
      calls.push(['create', payload]);
      return { id: payload.id || 'generated-contract' };
    },
    updateSignalContract() { throw new Error('contract update rejected'); },
    publishSignalContract(versionId) {
      calls.push(['publish', versionId]);
      return { id: versionId, status: 'published' };
    },
    archiveSignalContract() {},
    removeSignalContractDraft() {},
    removeSignalContractVersion() {},
    createSignalContractVersion() {},
    duplicateSignalContract() {},
    createSignalSchema(payload) {
      calls.push(['schema', payload]);
      return { id: payload.id };
    },
    updateSignalSchema() {},
    removeSignalSchema() {},
    createStrategy() {},
    updateStrategy() {},
    publishStrategy() {},
    archiveStrategy() {},
    removeStrategy() {},
    setRoute() {},
    removeRoute() {},
    setChannelRiskPolicy() {},
    removeChannelRiskPolicy(channelId) {
      if (channelId === '-failing-risk') throw new Error('risk deletion rejected');
    },
    reconcile() {},
    cancelEntries() {},
    setRuntime() {},
    emergencyFlatten(payload) {
      calls.push(['flatten', payload]);
      return 2;
    },
  };
  const auditEvents = [];
  const startup = new StartupAuthority();
  startup.beginRecovery();
  for (const gate of STARTUP_GATES) startup.completeGate(gate);
  startup.release();
  const bridge = new McpControlBridge(
    fakeControl,
    { record: async event => { auditEvents.push(event); } },
    () => undefined,
    50,
    startup,
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

  const blockedPreflight = await preflightMcpAction('contracts.publish', { versionId: 'missing:v1' });
  assert.equal(blockedPreflight.allowed, false);
  const paperAccount = await getDatabase().get(
    "SELECT id FROM trading_accounts WHERE exchange = 'paper' LIMIT 1",
  );
  const publishedStrategy = await getDatabase().get(
    "SELECT id FROM trading_strategy_versions WHERE status = 'published' LIMIT 1",
  );
  await getDatabase().run(
    `INSERT OR REPLACE INTO trading_routes (
       channel_id, strategy_version_id, account_id, enabled, created_at, updated_at
     ) VALUES ('-mcp-preflight', ?, ?, 1, ?, ?)`,
    [publishedStrategy.id, paperAccount.id, Date.now(), Date.now()],
  );
  const preflightCases = [
    ['contracts.duplicate', { sourceVersionId: 'standard:v1', id: 'fresh-contract' }, true],
    ['contracts.duplicate', { sourceVersionId: 'missing:v1', id: 'agent-contract' }, false],
    ['contracts.create_version', { sourceVersionId: 'agent-contract:v1' }, false],
    ['contracts.publish', { versionId: 'agent-contract:v1' }, true],
    ['contracts.archive', { versionId: 'agent-contract:v1' }, false],
    ['contracts.delete_draft', { versionId: 'agent-contract:v1' }, true],
    ['contracts.delete_version', { versionId: 'agent-contract:v1' }, false],
    ['contracts.publish', { versionId: 'standard:v1' }, false],
    ['contracts.archive', { versionId: 'standard:v1' }, false],
    ['schemas.create', { id: 'standard' }, false],
    ['schemas.update', { id: 'missing-schema' }, false],
    ['schemas.delete', { id: 'standard' }, false],
    ['strategies.create', { name: 'Preflight draft' }, true],
    ['strategies.update', { id: publishedStrategy.id }, false],
    ['strategies.publish', { id: publishedStrategy.id }, false],
    ['strategies.archive', { id: publishedStrategy.id }, false],
    ['strategies.delete', { id: publishedStrategy.id }, false],
    ['routes.delete', { channelId: '-mcp-preflight' }, true],
    ['routes.set', {
      channelId: '-mcp-route', strategyVersionId: publishedStrategy.id,
      accountId: paperAccount.id, enabled: true,
    }, true],
    ['routes.set', {
      channelId: '-mcp-missing-route', strategyVersionId: 'missing-strategy',
      accountId: 'missing-account', enabled: true,
    }, false],
    ['risk.update', { channelId: '-mcp-risk' }, true],
    ['risk.delete', { channelId: '-mcp-risk' }, true],
    ['workflow.resource_create', { kind: 'channel', name: 'MCP channel', configuration: { channelId: '-100' } }, true],
    ['workflow.resource_publish', { id: 'missing-resource' }, false],
    ['workflow.activate', { baseRevisionId: null, graph: { schemaVersion: 1, nodes: [], edges: [] } }, true],
    ['trading.release_kill_switch', {}, false],
  ];
  for (const [action, payload, allowed] of preflightCases) {
    assert.equal((await preflightMcpAction(action, payload)).allowed, allowed, `${action} preflight`);
  }
  assert.equal(
    (await preflightMcpAction('workflow.activate', {
      baseRevisionId: null,
      graph: { schemaVersion: 1, nodes: [], edges: [] },
    })).requiresApproval,
    true,
  );
  await getDatabase().run(
    "UPDATE trading_runtime_state SET kill_switch_active = 1 WHERE singleton_id = 1",
  );
  assert.equal((await preflightMcpAction('trading.release_kill_switch', {})).allowed, true);
  await assert.rejects(preflightMcpAction('invalid-proposal', {}), /action is invalid/);
  await assert.rejects(preflightMcpAction('risk.update', null), /payload must be an object/);
  const proposal = await createMcpProposal({
    agentId: created.agent.id,
    sessionId: session.id,
    action: 'contracts.publish',
    payload: { versionId: 'agent-contract:v1' },
    autoApprove: true,
  });
  assert.equal(proposal.status, 'pending', 'Publishing always requires a human decision.');
  assert.equal(proposal.preflight.requiresApproval, true);
  await approveMcpProposal(proposal.id, 'dashboard:test-admin');
  assert.equal((await waitForMcpProposal(proposal.id, 5_000)).status, 'completed');
  assert.deepEqual(calls.find(call => call[0] === 'publish'), ['publish', 'agent-contract:v1']);

  const rejectedProposal = await createMcpProposal({
    agentId: created.agent.id,
    action: 'contracts.publish',
    payload: { versionId: 'agent-contract:v1' },
  });
  await rejectMcpProposal(rejectedProposal.id, 'dashboard:test-admin', 'Not in this release.');
  assert.equal((await waitForMcpProposal(rejectedProposal.id, 1_000)).status, 'rejected');
  assert.ok((await listMcpProposals()).some(item => item.id === rejectedProposal.id));

  const automaticDraft = await createMcpProposal({
    agentId: created.agent.id,
    action: 'schemas.create',
    payload: { id: 'agent-schema' },
    autoApprove: true,
  });
  assert.equal(automaticDraft.status, 'approved');
  assert.equal((await waitForMcpProposal(automaticDraft.id, 5_000)).status, 'completed');
  assert.deepEqual(calls.find(call => call[0] === 'schema'), ['schema', { id: 'agent-schema' }]);

  const failedProposal = await createMcpProposal({
    agentId: created.agent.id,
    action: 'risk.delete',
    payload: { channelId: '-failing-risk' },
  });
  assert.equal(failedProposal.status, 'pending');
  await approveMcpProposal(failedProposal.id, 'dashboard:test-admin');
  const failedProposalResult = await waitForMcpProposal(failedProposal.id, 5_000);
  assert.equal(failedProposalResult.status, 'failed');
  assert.match(failedProposalResult.error, /risk deletion rejected/);
  assert.ok(auditEvents.some(event => event.requestId === failedProposal.id && event.outcome === 'failed'));
  await bridge.stop();

  const pausedSession = await connectMcpSession({
    id: 'mcp-paused-session',
    agentId: defaultAgent.agent.id,
  });
  const pausedRequest = await enqueueMcpControlRequest({
    agentId: defaultAgent.agent.id,
    action: 'trading.reconcile',
    payload: {},
  });
  const pausedProposal = await createMcpProposal({
    agentId: defaultAgent.agent.id,
    action: 'schemas.create',
    payload: { id: 'paused-schema' },
    autoApprove: true,
  });
  assert.equal(pausedProposal.status, 'approved');
  const standby = await setMcpRuntimeMode('standby', 'dashboard:test-admin');
  assert.equal(standby.previousMode, 'active');
  assert.ok(standby.disconnectedSessions >= 1);
  assert.ok((await listMcpSessions()).find(item => item.id === pausedSession.id)?.disconnectedAt);
  assert.equal(await claimNextMcpControlRequest(), null, 'Standby must pause control execution.');
  await assert.rejects(
    enqueueMcpControlRequest({ agentId: defaultAgent.agent.id, action: 'trading.reconcile' }),
    /runtime is not active/,
  );
  const disabledRuntime = await setMcpRuntimeMode('disabled', 'dashboard:test-admin');
  assert.equal(disabledRuntime.cancelledControlRequests, 1);
  assert.equal(disabledRuntime.cancelledProposals, 1);
  assert.equal((await getMcpControlRequest(pausedRequest.id))?.status, 'failed');
  assert.equal((await listMcpProposals()).find(item => item.id === pausedProposal.id)?.status, 'failed');
  await assert.rejects(setMcpRuntimeMode('invalid', 'test'), /must be active, standby, or disabled/);
  await setMcpRuntimeMode('active', 'test:resume');

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
  assert.equal(
    (await listMcpAgentActions()).find(action => action.toolName === 'tsx_no_session')?.sessionId,
    null,
  );
  await recordMcpAgentAction({
    agentId: created.agent.id,
    toolName: 'tsx_error_instance',
    permission: 'system.read',
    outcome: 'failed',
    request: {},
    error: new Error('typed action error'),
    startedAt: Date.now(),
  });
  await recordMcpAgentAction({
    agentId: created.agent.id,
    toolName: 'tsx_error_object',
    permission: 'system.read',
    outcome: 'failed',
    request: {},
    error: { code: 'structured-action-error' },
    startedAt: Date.now(),
  });
  const circularError = {};
  circularError.self = circularError;
  await recordMcpAgentAction({
    agentId: created.agent.id,
    toolName: 'tsx_error_circular',
    permission: 'system.read',
    outcome: 'failed',
    request: {},
    error: circularError,
    startedAt: Date.now(),
  });
  await recordMcpAgentAction({
    agentId: created.agent.id,
    toolName: 'tsx_error_symbol',
    permission: 'system.read',
    outcome: 'failed',
    request: {},
    error: Symbol('non-serializable-error'),
    startedAt: Date.now(),
  });
  const persistedErrors = await getDatabase().all(
    `SELECT tool_name AS toolName, error FROM mcp_agent_actions
     WHERE tool_name LIKE 'tsx_error_%'`,
  );
  assert.equal(persistedErrors.find(row => row.toolName === 'tsx_error_instance')?.error, 'typed action error');
  assert.equal(persistedErrors.find(row => row.toolName === 'tsx_error_object')?.error, '{"code":"structured-action-error"}');
  assert.equal(persistedErrors.find(row => row.toolName === 'tsx_error_circular')?.error, 'Unknown error.');
  assert.equal(persistedErrors.find(row => row.toolName === 'tsx_error_symbol')?.error, 'Unknown error.');

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
  assert.equal(await deleteMcpAgent(created.agent.id), true);
  assert.equal((await listMcpAgents()).some(agent => agent.id === created.agent.id), false);
  assert.equal((await listMcpSessions()).find(item => item.id === session.id)?.disconnectedAt !== null, true);
  assert.match((await listMcpAgentActions())[0].agentName, /^Gelöschter MCP-Agent /);
  await assert.rejects(deleteMcpAgent(created.agent.id), /does not exist/);
  console.log('MCP control-plane tests passed.');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
