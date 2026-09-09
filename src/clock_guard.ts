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

function validatedClockLimit(maxDriftMilliseconds: number): number {
  if (!Number.isSafeInteger(maxDriftMilliseconds) || maxDriftMilliseconds < 100 || maxDriftMilliseconds > 5_000) {
    throw new Error('Maximum clock drift must be an integer between 100 and 5000 milliseconds.');
  }
  return maxDriftMilliseconds;
}

function validatedClockBaseline(value: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError('Clock sources must return finite millisecond values.');
  }
  return value;
}

interface ClockBaselines {
  baselineWallMilliseconds: number;
  baselineMonotonicMilliseconds: number;
}

function sourceDriftError(wall: number, monotonic: number, guard: ClockBaselines): string | null {
  if (!Number.isFinite(wall) || !Number.isFinite(monotonic)) {
    return 'A system clock source returned a non-finite value.';
  }
  if (monotonic < guard.baselineMonotonicMilliseconds) {
    return 'The monotonic clock moved backwards.';
  }
  return null;
}

function measuredDrift(wall: number, monotonic: number, guard: ClockBaselines): number {
  return Math.abs((wall - guard.baselineWallMilliseconds) - (monotonic - guard.baselineMonotonicMilliseconds));
}

function measuredDriftOutcome(
  wall: number, monotonic: number, guard: ClockBaselines & { maxDriftMilliseconds: number },
): { driftMilliseconds: number; reason: string | null } {
  const driftMilliseconds = measuredDrift(wall, monotonic, guard);
  if (driftMilliseconds <= guard.maxDriftMilliseconds) return { driftMilliseconds, reason: null };
  return { driftMilliseconds, reason: `System clock changed by ${Math.ceil(driftMilliseconds)}ms relative to the monotonic clock; limit is ${guard.maxDriftMilliseconds}ms.` };
}

export class ClockGuard implements ClockHealthMonitor {
  readonly baselineWallMilliseconds: number;
  readonly baselineMonotonicMilliseconds: number;
  private latchedReason: string | null = null;
  private latchedDriftMilliseconds = 0;

  constructor(
    readonly maxDriftMilliseconds = DEFAULT_MAX_CLOCK_DRIFT_MS,
    private readonly wallClock: () => number = Date.now,
    private readonly monotonicClock: () => number = () => performance.now(),
  ) {
    validatedClockLimit(maxDriftMilliseconds);
    this.baselineWallMilliseconds = validatedClockBaseline(this.wallClock());
    this.baselineMonotonicMilliseconds = validatedClockBaseline(this.monotonicClock());
  }

  sampleDrift(wall: number, monotonic: number): { driftMilliseconds: number; reason: string | null } {
    const reason = sourceDriftError(wall, monotonic, this);
    return reason === null ? measuredDriftOutcome(wall, monotonic, this) : { driftMilliseconds: Number.POSITIVE_INFINITY, reason };
  }

  sample(): ClockHealthSnapshot {
    const wall = this.wallClock();
    const monotonic = this.monotonicClock();
    const outcome = this.sampleDrift(wall, monotonic);
    let { driftMilliseconds, reason } = outcome;

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
