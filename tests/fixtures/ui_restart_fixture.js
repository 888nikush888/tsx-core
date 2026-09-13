import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { UiOperationStore } from '../../src/ui_operation_store.js';
import { STARTUP_GATES, StartupAuthority } from '../../src/startup_authority.js';

export const ADMIN = 'isolated-restart-admin-fixture-'.repeat(2);
export const VIEWER = 'isolated-restart-viewer-fixture-'.repeat(2);
export const COMMANDS = [
  { kind: 'restart', route: '/api/restart', confirmation: 'restart-service', status: 202 },
  { kind: 'backup-restore', route: '/api/backups/restore', confirmation: 'restore-backup', status: 200 },
  { kind: 'factory-reset', route: '/api/factory-reset', confirmation: 'factory-reset', status: 200 },
];

export function deferred() {
  let resolve = null;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

export function backupProof() {
  const now = Date.now();
  const proof = { verifiedAt: now, artifactCreatedAt: new Date(now).toISOString(), artifactSha256: 'a'.repeat(64) };
  return { healthy: true, lastSuccessAt: now, integrityVerified: proof, configurationCoherent: proof,
    restoreEligibility: { status: 'eligible', scope: 'artifact-local-integrated-restore', checkedAt: now,
      artifactSha256: proof.artifactSha256, reasons: [] } };
}

export function commandRequest(command, id, extra = {}) {
  const body = { jobId: id, ...(command.kind === 'backup-restore' ? { name: 'backup-2026-fixture' } : {}),
    ...(command.kind === 'factory-reset' ? { confirmation: 'FACTORY RESET' } : {}), ...extra };
  return { method: 'POST', headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json',
    'X-Requested-With': 'forwarder-dashboard', 'X-Destructive-Confirmation': command.confirmation,
    ...(command.kind === 'restart' ? { 'X-Operator-Job-ID': id } : {}) }, body: JSON.stringify(body) };
}

export async function createRestartFixture(directory, generation) {
  const store = new UiOperationStore(path.join(directory, 'jobs'), generation);
  await store.list();
  const authority = new StartupAuthority();
  authority.beginRecovery();
  for (const gate of STARTUP_GATES) authority.completeGate(gate);
  authority.release();
  const controls = { work: 0, restart: 0, entered: deferred(), restarted: deferred(), barrier: null, failWork: false, blockAudit: null };
  const work = async kind => {
    controls.work++;
    authority.holdMutations(`isolated ${kind}`);
    controls.entered.resolve();
    if (controls.barrier) await controls.barrier;
    if (controls.failWork) throw new Error('Isolated command rejected by safety gate.');
    await appendFile(path.join(directory, 'effects.log'), kind + '\n');
    return { previousDatabase: 'isolated-rollback' };
  };
  const app = {
    config: { sourceChannels: [], targetChannel: '', forwardOptions: { forwardToTarget: false } },
    state: { isRunning: true }, startupAuthority: authority, uiOperations: store,
    getQueueState: () => ({ running: 0, queued: 0, maxConcurrency: 1, paused: true }),
    startForwarding: async () => { throw new Error('Routing is disabled in this isolated fixture.'); },
    stopForwarding: () => work('restart'), restoreBackup: () => work('backup-restore'), performFactoryReset: () => work('factory-reset'),
    reloadConfig: () => {}, getOperationsStatus: () => ({ backup: backupProof() }),
    auditTrail: { snapshot: () => ({ healthy: true }), record: async event => {
      if (controls.blockAudit) await controls.blockAudit(event);
      await appendFile(path.join(directory, 'audit.log'), JSON.stringify(event) + '\n');
    } },
    requestRestart: () => { controls.restart++; controls.restarted.resolve(); },
  };
  return { app, store, controls, authority };
}
