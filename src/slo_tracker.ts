export interface DeliverySloSnapshot {
  accepted: number;
  attempts: number;
  confirmed: number;
  failed: number;
  unknown: number;
  latencyCount: number;
  latencySumSeconds: number;
  latencyBuckets: Array<{ le: number; count: number }>;
}

const LATENCY_BUCKETS_SECONDS = [1, 5, 15, 30, 60, 120, 300];

export class DeliverySloTracker {
  private accepted = 0;
  private attempts = 0;
  private confirmed = 0;
  private failed = 0;
  private unknown = 0;
  private latencyCount = 0;
  private latencySumSeconds = 0;
  private latencyBuckets = LATENCY_BUCKETS_SECONDS.map(le => ({ le, count: 0 }));

  recordAccepted(): void {
    this.accepted += 1;
  }

  recordAttempt(): void {
    this.attempts += 1;
  }

  recordConfirmed(latencyMs: number): void {
    if (!Number.isFinite(latencyMs) || latencyMs < 0) throw new Error('Delivery latency must be a finite non-negative number.');
    const seconds = latencyMs / 1000;
    this.confirmed += 1;
    this.latencyCount += 1;
    this.latencySumSeconds += seconds;
    for (const bucket of this.latencyBuckets) {
      if (seconds <= bucket.le) bucket.count += 1;
    }
  }

  recordFailure(status: 'failed' | 'unknown'): void {
    if (status === 'unknown') this.unknown += 1;
    else this.failed += 1;
  }

  snapshot(): DeliverySloSnapshot {
    return {
      accepted: this.accepted,
      attempts: this.attempts,
      confirmed: this.confirmed,
      failed: this.failed,
      unknown: this.unknown,
      latencyCount: this.latencyCount,
      latencySumSeconds: this.latencySumSeconds,
      latencyBuckets: this.latencyBuckets.map(bucket => ({ ...bucket }))
    };
  }
}
