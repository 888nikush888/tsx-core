import { unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { assertProcessLockOwner, withProcessLockOwner, type ProcessLock } from './process_lock.js';
import {
  databaseMaintenanceEvidence,
  mcpMaintenanceActive,
  mcpMaintenanceMarkerPath,
  operationalDatabasePath,
  readMcpMaintenanceRequest,
  type McpMaintenanceRequest,
  type ParticipantRecord,
} from './db.js';

export {
  databaseFileIdentity,
  mcpMaintenanceActive,
  mcpMaintenanceMarkerPath,
  operationalDatabasePath,
  readMcpMaintenanceRequest,
  registerDatabaseMaintenanceParticipant,
  type DatabaseMaintenanceParticipant,
  type McpMaintenanceRequest,
} from './db.js';

const { canonicalDatabase, participants, nextGeneration, exclusiveJson, matchingAcknowledgement } = databaseMaintenanceEvidence;
const issuedLeases = new WeakSet<object>();

export interface McpMaintenanceLease {
  readonly markerPath: string;
  readonly request: Readonly<McpMaintenanceRequest>;
  readonly protectedEntries: readonly string[];
  waitForQuiescence(): Promise<void>;
  assertQuiescent(): Promise<void>;
  release(): Promise<void>;
}

/** A structural lookalike cannot authorize file replacement, even if its method resolves. */
export async function assertMcpMaintenanceLease(lease: unknown, targetDatabasePath: string): Promise<void> {
  if (!lease || typeof lease !== 'object' || !issuedLeases.has(lease)) throw new Error('A genuine locally issued maintenance lease is required.');
  const issued = lease as McpMaintenanceLease;
  if (issued.request.databasePath !== await canonicalDatabase(targetDatabasePath)) throw new Error('Maintenance lease belongs to another database scope.');
  await issued.assertQuiescent();
}

function processDefinitelyEnded(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch (error: any) { return error?.code === 'ESRCH'; }
}

async function assertOwnedRequest(owner: ProcessLock, request: McpMaintenanceRequest): Promise<void> {
  await assertProcessLockOwner(owner, path.dirname(request.databasePath));
  const current = await readMcpMaintenanceRequest(request.databasePath);
  if (!current || JSON.stringify(current) !== JSON.stringify(request)) throw new Error('Maintenance ownership, nonce or generation changed; operation refused.');
}

function createLease(owner: ProcessLock, request: McpMaintenanceRequest, initial: ParticipantRecord[]): McpMaintenanceLease {
  let released = false;
  let quiescent = false;
  const targets = new Map(initial.filter(record => record.state !== 'closed').map(record => [record.id, record]));
  const check = async () => {
    if (released) throw new Error('Maintenance lease was released.');
    await assertOwnedRequest(owner, request);
    if (Date.now() > request.deadlineAt) throw new Error('Maintenance deadline expired; database files must remain unchanged.');
    await databaseMaintenanceEvidence.assertDatabaseTargetEvidence(request);
    for (const record of await participants(request.databasePath)) {
      const previous = targets.get(record.id);
      if (previous && ['pid', 'instance', 'generation', 'databasePath'].some(field =>
        previous[field as keyof ParticipantRecord] !== record[field as keyof ParticipantRecord])) throw new Error('Maintenance participant ownership changed.');
      if (previous || record.state !== 'closed') targets.set(record.id, record);
    }
    for (const record of targets.values()) {
      if (!processDefinitelyEnded(record.pid) && !await matchingAcknowledgement(request, record)) return false;
    }
    return true;
  };
  const lease: McpMaintenanceLease = Object.freeze({ markerPath: mcpMaintenanceMarkerPath(request.databasePath), request: Object.freeze(request),
    protectedEntries: databaseMaintenanceEvidence.protectedEntries,
    async waitForQuiescence() {
      while (!await check()) await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, request.deadlineAt - Date.now()))));
      quiescent = true;
    },
    async assertQuiescent() { if (!quiescent || !await check()) throw new Error('Database participants have not acknowledged actual handle closure.'); },
    async release() {
      if (released) return;
      await withProcessLockOwner(owner, path.dirname(request.databasePath), async () => {
        await assertOwnedRequest(owner, request);
        await unlink(mcpMaintenanceMarkerPath(request.databasePath));
        released = true;
      });
    },
  });
  issuedLeases.add(lease);
  return lease;
}

/** Publish first, close the local handle, then explicitly wait before any file replacement. */
export async function beginMcpSharedMaintenance(reason: string, databasePath: string, owner: ProcessLock,
  options: { timeoutMs?: number } = {}): Promise<McpMaintenanceLease> {
  return beginMaintenance(reason, databasePath, owner, options, false);
}

/** Offline callers may prove absence; this never fabricates a file identity or ignores participants. */
export async function beginMcpOfflineMaintenance(reason: string, databasePath: string, owner: ProcessLock,
  options: { timeoutMs?: number } = {}): Promise<McpMaintenanceLease> {
  return beginMaintenance(reason, databasePath, owner, options, true);
}

async function beginMaintenance(reason: string, databasePath: string, owner: ProcessLock,
  options: { timeoutMs?: number }, allowAbsent: boolean): Promise<McpMaintenanceLease> {
  const normalized = reason.trim();
  if (!normalized || normalized.length > 200 || /[\r\n\0]/.test(normalized)) throw new Error('MCP shared maintenance reason is invalid.');
  const timeout = options.timeoutMs ?? 30000;
  if ((!Number.isSafeInteger(timeout) || timeout < 1) || timeout > 30000) throw new Error('Maintenance timeout must be between 1 and 30000 ms.');
  return withProcessLockOwner(owner, path.dirname(path.resolve(databasePath)), async () => {
    const canonical = await canonicalDatabase(databasePath);
    if (await mcpMaintenanceActive(canonical)) throw new Error('MCP shared maintenance is already active; existing evidence was preserved.');
    const targetEvidence = await databaseMaintenanceEvidence.databaseTargetEvidence(canonical, allowAbsent);
    const request: McpMaintenanceRequest = { version: 1, nonce: randomUUID(), generation: await nextGeneration(canonical),
      ownerPid: process.pid, ownerInstance: databaseMaintenanceEvidence.processInstance, databasePath: canonical,
      ...targetEvidence, reason: normalized, createdAt: Date.now(), deadlineAt: 0 };
    request.deadlineAt = request.createdAt + timeout;
    await exclusiveJson(mcpMaintenanceMarkerPath(canonical), request);
    return createLease(owner, request, await participants(canonical));
  });
}

/** Startup has no ownership authority to clear an existing maintenance request. */
export async function clearMcpMaintenanceMarker(databasePath = operationalDatabasePath()): Promise<void> {
  if (await mcpMaintenanceActive(databasePath)) throw new Error('Maintenance cleanup requires its owning lease; startup cannot remove the marker.');
}

export function createMaintenanceWorkTracker(): { run<T>(operation: () => Promise<T>): Promise<T>; stopAndDrain(deadlineAt: number): Promise<void> } {
  const active = new Set<Promise<unknown>>();
  let stopping = false;
  return {
    async run<T>(operation: () => Promise<T>): Promise<T> {
      if (stopping) throw new Error('MCP is draining for maintenance; new database work is blocked.');
      const work = Promise.resolve().then(operation);
      active.add(work);
      try { return await work; } finally { active.delete(work); }
    },
    async stopAndDrain(deadlineAt: number) {
      stopping = true;
      while (active.size > 0) {
        if (Date.now() >= deadlineAt) throw new Error('MCP work did not drain before its maintenance deadline; no closure acknowledgement.');
        await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadlineAt - Date.now()))));
      }
    },
  };
}
