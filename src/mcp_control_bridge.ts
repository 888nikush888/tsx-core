import type { EnterpriseAuditTrail } from './audit_trail.js';
import {
  agentHasPermission,
  claimNextMcpControlRequest,
  completeMcpControlRequest,
  listMcpAgents,
  recoverInterruptedMcpControlRequests,
  type McpControlAction,
  type McpControlRequest,
  type McpPermission,
} from './mcp_repository.js';
import type { TradingWebControl } from './trading_web_control.js';
import type { LogContext } from './logger.js';

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

  constructor(
    private readonly control: TradingWebControl,
    private readonly auditTrail: Pick<EnterpriseAuditTrail, 'record'>,
    private readonly log: (message: string, fields?: LogContext) => void,
    private readonly pollIntervalMs = 200,
  ) {
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 50 || pollIntervalMs > 5_000) {
      throw new Error('MCP bridge poll interval must be between 50 and 5000 ms.');
    }
  }

  async start(): Promise<void> {
    if (this.worker !== null) return;
    const recovered = await recoverInterruptedMcpControlRequests();
    if (recovered > 0) this.log(`[WARN] ${recovered} interrupted MCP control request(s) marked failed.`);
    this.abortController = new AbortController();
    this.worker = this.run(this.abortController.signal);
    this.log('[INFO] MCP control bridge started.');
  }

  async stop(): Promise<void> {
    this.abortController?.abort();
    await this.worker;
    this.worker = null;
    this.abortController = null;
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const request = await claimNextMcpControlRequest();
        if (request) {
          await this.execute(request);
          continue;
        }
      } catch (error) {
        this.log(`[ERROR] MCP control bridge polling failed: ${errorMessage(error)}`, {
          event: 'mcp_control_bridge_error',
        });
      }
      await new Promise<void>(resolve => {
        const timeout = setTimeout(resolve, this.pollIntervalMs);
        signal.addEventListener('abort', () => {
          clearTimeout(timeout);
          resolve();
        }, { once: true });
      });
    }
  }

  private async execute(request: McpControlRequest): Promise<void> {
    const startedAt = Date.now();
    const auditAction = `mcp.${request.action}`;
    const actorId = `mcp:${request.agentId}`;
    try {
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

  private async executeAuthorized(request: McpControlRequest): Promise<unknown> {
    const payload = payloadObject(request);
    switch (request.action) {
      case 'contracts.create':
        return this.control.createSignalContract(payload);
      case 'contracts.update':
        return this.control.updateSignalContract(payload);
      case 'contracts.publish':
        return this.control.publishSignalContract(payload.versionId);
      case 'contracts.archive':
        return this.control.archiveSignalContract(payload.versionId);
      case 'contracts.delete_draft':
        return this.control.removeSignalContractDraft(payload.versionId);
      case 'risk.update':
        return this.control.setChannelRiskPolicy(payload);
      case 'risk.delete':
        return this.control.removeChannelRiskPolicy(payload.channelId);
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
    }
  }
}
