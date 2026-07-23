import { performance } from 'node:perf_hooks';

export const DEFAULT_MAX_CLOCK_DRIFT_MS = 1_000;

export interface ClockHealthSnapshot {
  healthy: boolean;
  driftMilliseconds: number;
  maxDriftMilliseconds: number;
  checkedAt: number;
  reason: string | null;
}

export interface ClockHealthMonitor {
  sample(): ClockHealthSnapshot;
}

export class ClockDriftError extends Error {
  readonly code = 'CLOCK_DRIFT_UNSAFE';

  constructor(readonly snapshot: ClockHealthSnapshot) {
    super(snapshot.reason || 'System clock drift is outside the configured safety limit.');
    this.name = 'ClockDriftError';
  }
}
export function clockDriftLimitFromEnvironment(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CLOCK_MAX_DRIFT_MS?.trim();
  if (!raw) return DEFAULT_MAX_CLOCK_DRIFT_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 100 || value > 5_000) {
    throw new Error('CLOCK_MAX_DRIFT_MS must be an integer between 100 and 5000.');
  }
  return value;
}

export class ClockGuard implements ClockHealthMonitor {
  private readonly baselineWallMilliseconds: number;
  private readonly baselineMonotonicMilliseconds: number;
  private latchedReason: string | null = null;
  private latchedDriftMilliseconds = 0;

  constructor(
    readonly maxDriftMilliseconds = DEFAULT_MAX_CLOCK_DRIFT_MS,
    private readonly wallClock: () => number = Date.now,
    private readonly monotonicClock: () => number = () => performance.now(),
  ) {
    if (!Number.isSafeInteger(maxDriftMilliseconds) || maxDriftMilliseconds < 100 || maxDriftMilliseconds > 5_000) {
      throw new Error('Maximum clock drift must be an integer between 100 and 5000 milliseconds.');
    }
    this.baselineWallMilliseconds = this.wallClock();
    this.baselineMonotonicMilliseconds = this.monotonicClock();
    if (!Number.isFinite(this.baselineWallMilliseconds) || !Number.isFinite(this.baselineMonotonicMilliseconds)) {
      throw new TypeError('Clock sources must return finite millisecond values.');
    }
  }

  sample(): ClockHealthSnapshot {
    const wall = this.wallClock();
    const monotonic = this.monotonicClock();
    let driftMilliseconds = Number.POSITIVE_INFINITY;
    let reason: string | null = null;

    if (!Number.isFinite(wall) || !Number.isFinite(monotonic)) {
      reason = 'A system clock source returned a non-finite value.';
    } else if (monotonic < this.baselineMonotonicMilliseconds) {
      reason = 'The monotonic clock moved backwards.';
    } else {
      const wallElapsed = wall - this.baselineWallMilliseconds;
      const monotonicElapsed = monotonic - this.baselineMonotonicMilliseconds;
      driftMilliseconds = Math.abs(wallElapsed - monotonicElapsed);
      if (driftMilliseconds > this.maxDriftMilliseconds) {
        reason = `System clock changed by ${Math.ceil(driftMilliseconds)}ms relative to the monotonic clock; limit is ${this.maxDriftMilliseconds}ms.`;
      }
    }

    if (reason && !this.latchedReason) {
      this.latchedReason = reason;
      this.latchedDriftMilliseconds = driftMilliseconds;
    }
    if (this.latchedReason) {
      reason = this.latchedReason;
      driftMilliseconds = this.latchedDriftMilliseconds;
    }

    return {
      healthy: reason === null,
      driftMilliseconds: Number.isFinite(driftMilliseconds) ? driftMilliseconds : this.maxDriftMilliseconds + 1,
      maxDriftMilliseconds: this.maxDriftMilliseconds,
      checkedAt: Number.isFinite(wall) ? wall : this.baselineWallMilliseconds,
      reason,
    };
  }

  assertHealthy(): ClockHealthSnapshot {
    const snapshot = this.sample();
    if (!snapshot.healthy) throw new ClockDriftError(snapshot);
    return snapshot;
  }
}
