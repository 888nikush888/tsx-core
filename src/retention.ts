import {
  getDatabaseStorageStats,
  pruneOperationalData,
  type DatabaseStorageStats,
  type OperationalRetentionResult
} from './db.js';

const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_RETENTION_BATCH_SIZE = 1_000;
const DEFAULT_MIN_FREE_BYTES = 1024 * 1024 * 1024;
const MAX_BATCHES_PER_RUN = 20;

export interface RetentionPolicy {
  retentionDays: number;
  intervalMs: number;
  batchSize: number;
  minFreeBytes: number;
}

export interface RetentionStatus extends DatabaseStorageStats {
  healthy: boolean;
  lastSuccessAt: number | null;
  lastError: string | null;
  deletedTotal: number;
  backlog: boolean;
}

function envInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

export function retentionPolicyFromEnvironment(env: NodeJS.ProcessEnv = process.env): RetentionPolicy {
  return {
    retentionDays: envInteger(env, 'DATA_RETENTION_DAYS', DEFAULT_RETENTION_DAYS, 1, 3_650),
    intervalMs: envInteger(env, 'DATA_RETENTION_INTERVAL_MS', DEFAULT_RETENTION_INTERVAL_MS, 300_000, 86_400_000),
    batchSize: envInteger(env, 'DATA_RETENTION_BATCH_SIZE', DEFAULT_RETENTION_BATCH_SIZE, 100, 10_000),
    minFreeBytes: envInteger(env, 'DATA_MIN_FREE_BYTES', DEFAULT_MIN_FREE_BYTES, 64 * 1024 * 1024, Number.MAX_SAFE_INTEGER)
  };
}

function addResults(total: OperationalRetentionResult, next: OperationalRetentionResult): void {
  total.completedOutbox += next.completedOutbox;
  total.incomingMessages += next.incomingMessages;
  total.signals += next.signals;
  total.aiUsageDays += next.aiUsageDays;
}

function resultCount(result: OperationalRetentionResult): number {
  return result.completedOutbox + result.incomingMessages + result.signals + result.aiUsageDays;
}

function hasFullBatch(result: OperationalRetentionResult, batchSize: number): boolean {
  return Object.values(result).some(count => count >= batchSize);
}

export class OperationalDataRetention {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private status: RetentionStatus = {
    healthy: false,
    lastSuccessAt: null,
    lastError: null,
    deletedTotal: 0,
    backlog: false,
    allocatedBytes: 0,
    reusableBytes: 0
  };

  constructor(
    private readonly policy: RetentionPolicy,
    private readonly logger: (message: string) => void,
    private readonly now: () => number = Date.now
  ) {}

  async start(): Promise<void> {
    if (this.timer) throw new Error('Operational data retention is already running.');
    await this.runNow();
    this.timer = setInterval(() => {
      void this.runNow().catch(error => {
        this.logger(`[ERROR] Operational data retention failed: ${error.message}`);
      });
    }, this.policy.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  async runNow(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.execute();
    try {
      await this.running;
    } finally {
      this.running = null;
    }
  }

  getStatus(): RetentionStatus {
    const staleAfter = this.policy.intervalMs * 2;
    const fresh = this.status.lastSuccessAt !== null
      && this.now() - this.status.lastSuccessAt <= staleAfter;
    return {
      ...this.status,
      healthy: fresh && !this.status.lastError && !this.status.backlog
    };
  }

  private async execute(): Promise<void> {
    const total: OperationalRetentionResult = {
      completedOutbox: 0,
      incomingMessages: 0,
      signals: 0,
      aiUsageDays: 0
    };
    let latest: OperationalRetentionResult = { ...total };
    try {
      for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
        latest = await pruneOperationalData(
          this.policy.retentionDays,
          this.policy.batchSize,
          this.now()
        );
        addResults(total, latest);
        if (!hasFullBatch(latest, this.policy.batchSize)) break;
      }
      const backlog = hasFullBatch(latest, this.policy.batchSize);
      const storage = await getDatabaseStorageStats();
      this.status = {
        healthy: !backlog,
        lastSuccessAt: this.now(),
        lastError: backlog ? 'Retention backlog exceeds the bounded per-run cleanup limit.' : null,
        deletedTotal: this.status.deletedTotal + resultCount(total),
        backlog,
        ...storage
      };
      this.logger(`[INFO] Operational retention deleted ${resultCount(total)} row(s); database=${storage.allocatedBytes} bytes, reusable=${storage.reusableBytes} bytes.`);
      if (backlog) throw new Error(this.status.lastError!);
    } catch (error: any) {
      this.status = { ...this.status, healthy: false, lastError: error.message };
      throw error;
    }
  }
}
