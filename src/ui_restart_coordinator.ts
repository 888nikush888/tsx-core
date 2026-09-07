import type { ServerResponse } from 'node:http';
import path from 'node:path';
import type { UiJob, UiOperationStore } from './ui_operation_store.js';

export const RESTART_RESPONSE_GRACE_MS = 500;

export function assertRestartReceiptsPreserved(receipts: string, targets: Iterable<string>): void {
  for (const target of targets) {
    const relative = path.relative(target, receipts);
    if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error('Factory reset requires operator receipts outside every erased directory.');
    }
  }
}

/** All confirmed jobs share one shutdown request in a process generation. */
export function createProcessRestartRequest(shutdown: () => Promise<unknown>): () => void {
  let requested = false;
  return () => {
    if (requested) return;
    requested = true;
    setTimeout(() => {
      void shutdown().then(
        () => process.exit(process.exitCode || 0),
        () => process.exit(process.exitCode || 1),
      );
    }, 150);
  };
}

/** A response can shorten the grace period, but can never cancel a confirmed restart. */
export class UiRestartCoordinator {
  private readonly scheduled = new Set<string>();
  constructor(private readonly store: UiOperationStore, private readonly requestRestart: () => void) {}

  schedule(job: UiJob, response?: ServerResponse): boolean {
    const restart = job.restart;
    if (job.instanceId !== this.store.processInstanceId || restart?.sourceInstanceId !== job.instanceId
      || !['awaiting-restart', 'unknown'].includes(job.state) || this.scheduled.has(job.id)) return false;
    this.scheduled.add(job.id);
    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      clearTimeout(fallback);
      response?.removeListener('finish', finish);
      response?.removeListener('close', finish);
      this.requestRestart();
    };
    // Keep this timer referenced: successful destructive work must complete even if
    // its disconnected response was the last remaining event-loop handle.
    const fallback = setTimeout(finish, RESTART_RESPONSE_GRACE_MS);
    response?.once('finish', finish);
    response?.once('close', finish);
    if (!response || response.destroyed || response.closed || response.writableFinished) finish();
    return true;
  }

  async reconcile(): Promise<void> {
    for (const job of await this.store.list()) this.schedule(job);
  }
}
