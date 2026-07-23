import type { ConcurrencyQueue } from './queue.js';

export interface SchedulableOutboxTask {
  id: string;
}

export interface DurableOutboxSchedulerOptions {
  queue: ConcurrencyQueue;
  listPending: (excludedTaskIds: string[], limit: number) => Promise<SchedulableOutboxTask[]>;
  execute: (taskId: string, signal: AbortSignal) => Promise<void>;
  logError: (message: string) => void;
  batchSize?: number;
}

/**
 * Keeps only a bounded window of durable outbox records in memory. Every item
 * remains in SQLite until it is claimed, so queue saturation is backpressure,
 * not dropped work.
 */
export class DurableOutboxScheduler {
  private readonly scheduledTaskIds = new Set<string>();
  private readonly batchSize: number;
  private pumpPromise: Promise<void> | null = null;
  private pumpRequested = false;

  constructor(private readonly options: DurableOutboxSchedulerOptions) {
    this.batchSize = Math.max(1, Math.min(options.batchSize ?? 100, 1000));
  }

  public get scheduledCount(): number {
    return this.scheduledTaskIds.size;
  }

  public schedule(taskId: string): boolean {
    if (!taskId || this.scheduledTaskIds.has(taskId)) return this.scheduledTaskIds.has(taskId);
    if (this.options.queue.isAtCapacity) return false;
    this.scheduleIntoQueue(taskId);
    return true;
  }

  public async resume(): Promise<void> {
    await this.pump();
  }

  public requestPump(): void {
    void this.pump().catch(error => {
      this.options.logError(`Durable outbox scheduler failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private scheduleIntoQueue(taskId: string): void {
    this.scheduledTaskIds.add(taskId);
    void this.options.queue.add(signal => this.options.execute(taskId, signal))
      .catch(error => {
        this.options.logError(`Outbox task ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.scheduledTaskIds.delete(taskId);
        this.requestPump();
      });
  }

  private async pump(): Promise<void> {
    if (this.pumpPromise !== null) {
      this.pumpRequested = true;
      return this.pumpPromise;
    }

    this.pumpPromise = this.pumpAvailableWork();
    try {
      await this.pumpPromise;
    } finally {
      this.pumpPromise = null;
      if (this.pumpRequested) {
        this.pumpRequested = false;
        this.requestPump();
      }
    }
  }

  private async pumpAvailableWork(): Promise<void> {
    if (this.options.queue.paused) return;

    while (this.options.queue.availableCapacity > 0 && !this.options.queue.paused) {
      const limit = Math.min(this.batchSize, this.options.queue.availableCapacity);
      const candidates = await this.options.listPending([...this.scheduledTaskIds], limit);
      if (candidates.length === 0) return;

      let scheduled = 0;
      for (const candidate of candidates) {
        if (this.schedule(candidate.id)) scheduled++;
      }
      if (scheduled === 0) return;
    }
  }
}
