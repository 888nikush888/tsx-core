import type { EnterpriseAuditTrail } from './audit_trail.js';
import {
  agentHasPermission,
  claimNextApprovedMcpProposal,
  claimNextMcpControlRequest,
  completeMcpProposal,
  completeMcpControlRequest,
  assertMcpRuntimeActive,
  getMcpRuntimeState,
  listMcpAgents,
  preflightMcpAction,
  recoverInterruptedMcpProposals,
  recoverInterruptedMcpControlRequests,
  type McpAgentProposal,
  type McpControlAction,
  type McpControlRequest,
  type McpPermission,
} from './mcp_repository.js';
import type { TradingWebControl } from './trading_web_control.js';
import type { LogContext } from './logger.js';
import { StartupAuthority } from './startup_authority.js';
import { setTimeout as sleep } from 'node:timers/promises';

const ACTION_PERMISSIONS: Record<McpControlAction, McpPermission> = {
  'contracts.create': 'contracts.write',
  'contracts.update': 'contracts.write',
  'contracts.publish': 'contracts.write',
  'contracts.archive': 'contracts.write',
  'contracts.delete_draft': 'contracts.write',
  'risk.update': 'risk.write',
  'risk.delete': 'risk.write',
  'trading.reconcile': 'trading.reconcile',
  'trading.cancel_entries': 'trading.cancel_entries',
  'trading.kill_switch': 'trading.kill_switch',
  'trading.flatten': 'trading.flatten',
};

function proposalPermission(action: McpAgentProposal['action']): McpPermission {
  if (action.startsWith('contracts.') || action.startsWith('schemas.')) return 'contracts.write';
  if (action.startsWith('strategies.')) return 'strategies.write';
  if (action.startsWith('routes.')) return 'routes.write';
  if (action.startsWith('risk.')) return 'risk.write';
  if (action.startsWith('workflow.')) return 'workflow.write';
  return 'trading.kill_switch';
}

const CONTRACT_REMOVAL_ACTIONS: ReadonlySet<string> = new Set([
  'contracts.archive',
  'contracts.delete_draft',
]);

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) || 'Unknown MCP control error.';
  } catch {
    return 'Unknown MCP control error.';
  }
}

function payloadObject(request: McpControlRequest): Record<string, any> {
  if (!request.payload || typeof request.payload !== 'object' || Array.isArray(request.payload)) {
    throw new Error('MCP control payload must be an object.');
  }
  return request.payload as Record<string, any>;
}

export class McpControlBridge {
  private abortController: AbortController | null = null;
  private worker: Promise<void> | null = null;
  private recovered = false;

  constructor(
    private readonly control: TradingWebControl,
    private readonly auditTrail: Pick<EnterpriseAuditTrail, 'record'>,
    private readonly log: (message: string, fields?: LogContext) => void,
    private readonly pollIntervalMs = 200,
    private readonly startup = new StartupAuthority(),
  ) {
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 50 || pollIntervalMs > 5_000) {
      throw new Error('MCP bridge poll interval must be between 50 and 5000 ms.');
    }
  }

  start(): Promise<void> {
    if (this.worker !== null) return Promise.resolve();
    this.recovered = false;
    this.abortController = new AbortController();
    this.worker = this.run(this.abortController.signal);
    this.log('[INFO] MCP control bridge started.');
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    this.abortController?.abort();
    await this.worker;
    this.worker = null;
    this.abortController = null;
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let delayMs = this.pollIntervalMs;
      try {
        const result = await this.pollOnce();
        if (result === 'handled') continue;
        if (result === 'inactive') delayMs = 1_000;
      } catch (error) {
        this.log(`[ERROR] MCP control bridge polling failed: ${errorMessage(error)}`, {
          event: 'mcp_control_bridge_error',
        });
      }
      await sleep(delayMs, undefined, { signal }).catch(error => {
        if (!signal.aborted) throw error;
      });
    }
  }

  private async pollOnce(): Promise<'handled' | 'idle' | 'inactive'> {
    if (!this.startup.canMutate()) return 'inactive';
    if ((await getMcpRuntimeState()).mode !== 'active' || !this.startup.canMutate()) return 'inactive';
    await this.recoverReadyWork();
    if (!this.startup.canMutate()) return 'handled';
    const request = await claimNextMcpControlRequest();
    if (request) { await this.execute(request); return 'handled'; }
    const proposal = await claimNextApprovedMcpProposal();
    if (proposal) { await this.executeProposal(proposal); return 'handled'; }
    return 'idle';
  }

  private async recoverReadyWork(): Promise<void> {
    if (this.recovered) return;
    this.startup.assertReady();
    const recovered = await recoverInterruptedMcpControlRequests();
    if (recovered > 0) this.log(`[WARN] ${recovered} interrupted MCP control request(s) marked failed.`);
    this.startup.assertReady();
    const proposals = await recoverInterruptedMcpProposals();
    if (proposals > 0) this.log(`[WARN] ${proposals} interrupted MCP proposal(s) marked failed.`);
    this.recovered = true;
  }

  private async executeProposal(proposal: McpAgentProposal): Promise<void> {
    const startedAt = Date.now();
    const auditAction = `mcp.proposal.${proposal.action}`;
    const actorId = `mcp:${proposal.agentId}`;
    try {
      this.startup.assertReady();
      await assertMcpRuntimeActive();
      const agent = (await listMcpAgents()).find(candidate => candidate.id === proposal.agentId);
      const permission = proposalPermission(proposal.action);
      if (!agent || !agentHasPermission(agent, permission)) {
        throw new Error('MCP agent is disabled, missing, or no longer has the required proposal permission.');
      }
      await this.auditTrail.record({
        phase: 'authorized',
        action: auditAction,
        requestId: proposal.id,
        actorId,
        actorRole: 'admin',
        method: 'MCP',
        path: proposal.action,
        target: { action: proposal.action, payload: proposal.payload, decidedBy: proposal.decidedBy },
      });
      await assertMcpRuntimeActive();
      this.startup.assertReady();
      const preflight = await preflightMcpAction(proposal.action, proposal.payload);
      if (!preflight.allowed) throw new Error(`MCP execution preflight blocked: ${preflight.blockers.join(' ')}`);
      const result = await this.executeAuthorizedProposal(proposal);
      await this.auditTrail.record({
        phase: 'completed',
        action: auditAction,
        requestId: proposal.id,
        actorId,
        actorRole: 'admin',
        method: 'MCP',
        path: proposal.action,
        statusCode: 200,
        target: { action: proposal.action },
        after: { result },
        outcome: 'succeeded',
      });
      await completeMcpProposal(proposal.id, { result: result ?? null });
      this.log(`[AUDIT] request_id=${proposal.id} action=${auditAction} actor=${actorId} outcome=succeeded`, {
        request_id: proposal.id,
        event: 'mcp_proposal_completed',
        duration_ms: Date.now() - startedAt,
      });
    } catch (error) {
      const message = errorMessage(error);
      await this.auditTrail.record({
        phase: 'completed',
        action: auditAction,
        requestId: proposal.id,
        actorId,
        actorRole: 'admin',
        method: 'MCP',
        path: proposal.action,
        statusCode: 409,
        target: { action: proposal.action },
        after: { error: message },
        outcome: 'failed',
      }).catch(() => undefined);
      await completeMcpProposal(proposal.id, { error: message }).catch(() => undefined);
      this.log(`[WARN] request_id=${proposal.id} MCP proposal ${proposal.action} failed: ${message}`, {
        request_id: proposal.id,
        event: 'mcp_proposal_failed',
        duration_ms: Date.now() - startedAt,
      });
    }
  }

  private executeAuthorizedProposal(proposal: McpAgentProposal): unknown {
    const payload = proposal.payload as Record<string, unknown>;
    switch (proposal.action) {
      case 'contracts.create_version': return this.control.createSignalContractVersion(payload);
      case 'contracts.duplicate': return this.control.duplicateSignalContract(payload);
      case 'contracts.publish': return this.control.publishSignalContract(payload.versionId);
      case 'contracts.archive': return this.control.archiveSignalContract(payload.versionId);
      case 'contracts.delete_draft': return this.control.removeSignalContractDraft(payload.versionId);
      case 'contracts.delete_version': return this.control.removeSignalContractVersion(payload.versionId);
      case 'schemas.create': return this.control.createSignalSchema(payload);
      case 'schemas.update': return this.control.updateSignalSchema(payload);
      case 'schemas.delete': return this.control.removeSignalSchema(payload.id);
      case 'strategies.create': return this.control.createStrategy(payload);
      case 'strategies.update': return this.control.updateStrategy(payload);
      case 'strategies.publish': return this.control.publishStrategy(payload.id);
      case 'strategies.archive': return this.control.archiveStrategy(payload.id);
      case 'strategies.delete': return this.control.removeStrategy(payload.id);
      case 'routes.set': return this.control.setRoute(payload);
      case 'routes.delete': return this.control.removeRoute(payload.channelId);
      case 'risk.update': return this.control.setChannelRiskPolicy(payload);
      case 'risk.delete': return this.control.removeChannelRiskPolicy(payload.channelId);
      case 'workflow.resource_create': return this.control.createWorkflowResource(payload);
      case 'workflow.resource_update': return this.control.updateWorkflowResource(payload);
      case 'workflow.resource_publish': return this.control.publishWorkflowResource(payload.id);
      case 'workflow.resource_archive': return this.control.archiveWorkflowResource(payload.id);
      case 'workflow.resource_delete_draft': return this.control.deleteWorkflowResourceDraft(payload.id);
      case 'workflow.activate': return this.control.activateWorkflow(
        { ...payload, confirmation: 'ACTIVATE WORKFLOW IMPACT' },
        `mcp:${proposal.agentId}`,
      );
      case 'trading.release_kill_switch': return this.control.setRuntime({
        action: 'kill-switch', active: false, confirmation: 'RELEASE GLOBAL KILL SWITCH',
      });
    }
  }

  private async execute(request: McpControlRequest): Promise<void> {
    const startedAt = Date.now();
    const auditAction = `mcp.${request.action}`;
    const actorId = `mcp:${request.agentId}`;
    try {
      this.startup.assertReady();
      await assertMcpRuntimeActive();
      const agent = (await listMcpAgents()).find(candidate => candidate.id === request.agentId);
      const requiredPermission = ACTION_PERMISSIONS[request.action];
      if (!agent || !agentHasPermission(agent, requiredPermission)) {
        throw new Error('MCP agent is disabled, missing, or no longer has the required permission.');
      }
      await this.auditTrail.record({
        phase: 'authorized',
        action: auditAction,
        requestId: request.id,
        actorId,
        actorRole: 'admin',
        method: 'MCP',
        path: request.action,
        target: { action: request.action, payload: request.payload },
      });
      await assertMcpRuntimeActive();
      this.startup.assertReady();
      const result = await this.executeAuthorized(request);
      await this.auditTrail.record({
        phase: 'completed',
        action: auditAction,
        requestId: request.id,
        actorId,
        actorRole: 'admin',
        method: 'MCP',
        path: request.action,
        statusCode: 200,
        target: { action: request.action },
        after: { result },
        outcome: 'succeeded',
      });
      await completeMcpControlRequest(request.id, { result: result ?? null });
      this.log(`[AUDIT] request_id=${request.id} action=${auditAction} actor=${actorId} outcome=succeeded`, {
        request_id: request.id,
        event: 'mcp_control_completed',
        duration_ms: Date.now() - startedAt,
      });
    } catch (error) {
      const message = errorMessage(error);
      await this.auditTrail.record({
        phase: 'completed',
        action: auditAction,
        requestId: request.id,
        actorId,
        actorRole: 'admin',
        method: 'MCP',
        path: request.action,
        statusCode: 409,
        target: { action: request.action },
        after: { error: message },
        outcome: 'failed',
      }).catch(auditError => {
        this.log(`[CRITICAL] request_id=${request.id} MCP failure audit persistence failed: ${errorMessage(auditError)}`, {
          request_id: request.id,
          event: 'mcp_audit_persistence_failed',
        });
      });
      await completeMcpControlRequest(request.id, { error: message }).catch(completionError => {
        this.log(`[CRITICAL] request_id=${request.id} MCP request completion failed: ${errorMessage(completionError)}`, {
          request_id: request.id,
          event: 'mcp_request_completion_failed',
        });
      });
      this.log(`[WARN] request_id=${request.id} MCP action ${request.action} failed: ${message}`, {
        request_id: request.id,
        event: 'mcp_control_failed',
        duration_ms: Date.now() - startedAt,
      });
    }
  }

  private executeAuthorized(request: McpControlRequest): unknown {
    const payload = payloadObject(request);
    const action = request.action;
    if (action.startsWith('contracts.')) {
      if (CONTRACT_REMOVAL_ACTIONS.has(action)) return this.executeContractRemoval(action, payload);
      return this.executeContractWrite(action, payload);
    }
    if (action.startsWith('risk.')) return this.executeRiskAction(action, payload);
    if (action.startsWith('trading.')) return this.executeTradingAction(action, payload);
    throw new Error(`MCP control action is not implemented: ${action}`);
  }

  private executeContractWrite(action: McpControlAction, payload: Record<string, unknown>): unknown {
    switch (action) {
      case 'contracts.create':
        return this.control.createSignalContract(payload);
      case 'contracts.update':
        return this.control.updateSignalContract(payload);
      case 'contracts.publish':
        return this.control.publishSignalContract(payload.versionId);
      default:
        throw new Error(`MCP control action is not implemented: ${action}`);
    }
  }

  private executeContractRemoval(action: McpControlAction, payload: Record<string, unknown>): unknown {
    switch (action) {
      case 'contracts.archive':
        return this.control.archiveSignalContract(payload.versionId);
      case 'contracts.delete_draft':
        return this.control.removeSignalContractDraft(payload.versionId);
      default:
        throw new Error(`MCP control removal action is not implemented: ${action}`);
    }
  }

  private executeRiskAction(action: McpControlAction, payload: Record<string, unknown>): unknown {
    switch (action) {
      case 'risk.update':
        return this.control.setChannelRiskPolicy(payload);
      case 'risk.delete':
        return this.control.removeChannelRiskPolicy(payload.channelId);
      default:
        throw new Error(`MCP control risk action is not implemented: ${action}`);
    }
  }

  private executeTradingAction(action: McpControlAction, payload: Record<string, unknown>): unknown {
    switch (action) {
      case 'trading.reconcile':
        return this.control.reconcile(payload.accountId);
      case 'trading.cancel_entries':
        return this.control.cancelEntries(payload.accountId);
      case 'trading.kill_switch':
        return this.control.setRuntime({
          action: 'kill-switch',
          active: payload.active,
          reason: payload.reason,
        });
      case 'trading.flatten':
        return this.control.emergencyFlatten({
          accountId: payload.accountId,
          confirmation: 'FLATTEN MANAGED POSITIONS',
        });
      default:
        throw new Error(`MCP control trading action is not implemented: ${action}`);
    }
  }
}
