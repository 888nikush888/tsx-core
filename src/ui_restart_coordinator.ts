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

/** Only confirmed operator restarts receive a deadline for the entire graceful shutdown. */
export function createProcessRestartRequest(shutdown: () => Promise<unknown>, shutdownTimeoutMs = 60_000): () => void {
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1_000 || shutdownTimeoutMs > 180_000) {
    throw new Error('Restart shutdown deadline must be between 1000 and 180000 milliseconds.');
  }
  let requested = false;
  return () => {
    if (requested) return;
    requested = true;
    const previousExitCode = process.exitCode;
    const exit = (fallbackCode: number): never => process.exit(process.exitCode || previousExitCode || fallbackCode);
    // Response completion and audit flush can both remain pending forever. Keep
    // the watchdog independent of either promise; do not remove locks or claim
    // graceful completion when the deadline expires.
    const watchdog = setTimeout(() => {
      process.stderr.write('[CRITICAL] Confirmed operator restart exceeded its shutdown deadline; forcing non-graceful exit.\n');
      exit(1);
    }, shutdownTimeoutMs);
    const finish = (fallbackCode: number) => { clearTimeout(watchdog); exit(fallbackCode); };
    setTimeout(() => {
      void Promise.resolve().then(shutdown).then(
        () => finish(0),
        () => finish(1),
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
