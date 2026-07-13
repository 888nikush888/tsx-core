export interface MetricPoint {
  timestamp: string;
  processedCount: number;
  processedDelta: number;
  queueRunning: number;
  queueQueued: number;
  cpuUsage: number;
  memoryUsage: number;
}

export interface MetricsTrackerConfig {
  totalForwardedCountCallback: () => number;
  getQueueStateCallback: () => { running: number; queued: number; maxConcurrency: number; paused: boolean };
  intervalMs?: number;
  maxPoints?: number;
}

export class MetricsTracker {
  private history: MetricPoint[] = [];
  private intervalId: NodeJS.Timeout | null = null;
  private readonly totalForwardedCountCallback: () => number;
  private readonly getQueueStateCallback: () => { running: number; queued: number; maxConcurrency: number; paused: boolean };
  private readonly intervalMs: number;
  private readonly maxPoints: number;
  private lastTotalForwarded = 0;
  private lastCpuUsage = process.cpuUsage();
  private lastCpuTime = process.hrtime.bigint();

  constructor(config: MetricsTrackerConfig) {
    this.totalForwardedCountCallback = config.totalForwardedCountCallback;
    this.getQueueStateCallback = config.getQueueStateCallback;
    this.intervalMs = config.intervalMs ?? 5_000;
    this.maxPoints = config.maxPoints ?? 120;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 10) throw new Error('Metrics interval must be at least 10ms.');
    if (!Number.isSafeInteger(this.maxPoints) || this.maxPoints < 1 || this.maxPoints > 10_000) throw new Error('Metrics maxPoints must be between 1 and 10000.');
    this.lastTotalForwarded = this.totalForwardedCountCallback();
  }

  public start(): void {
    if (this.intervalId) return;
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuTime = process.hrtime.bigint();
    this.tick();
    this.intervalId = setInterval(() => this.tick(), this.intervalMs);
    this.intervalId.unref();
  }

  public stop(): void {
    if (!this.intervalId) return;
    clearInterval(this.intervalId);
    this.intervalId = null;
  }

  public getHistory(): MetricPoint[] {
    return this.history.map(point => ({ ...point }));
  }

  private tick(): void {
    const totalForwarded = this.totalForwardedCountCallback();
    const processedDelta = Math.max(0, totalForwarded - this.lastTotalForwarded);
    this.lastTotalForwarded = totalForwarded;
    const queue = this.getQueueStateCallback();
    const point: MetricPoint = {
      timestamp: new Date().toISOString(),
      processedCount: totalForwarded,
      processedDelta,
      queueRunning: queue.running,
      queueQueued: queue.queued,
      cpuUsage: this.getCpuUsagePercentage(),
      memoryUsage: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1))
    };
    this.history.push(point);
    if (this.history.length > this.maxPoints) this.history.shift();
  }

  private getCpuUsagePercentage(): number {
    const currentCpu = process.cpuUsage();
    const currentTime = process.hrtime.bigint();
    const elapsedMicros = Number(currentTime - this.lastCpuTime) / 1_000;
    const cpuMicros = (currentCpu.user - this.lastCpuUsage.user) + (currentCpu.system - this.lastCpuUsage.system);
    this.lastCpuUsage = currentCpu;
    this.lastCpuTime = currentTime;
    if (elapsedMicros <= 0) return 0;
    return Number(Math.max(0, (cpuMicros / elapsedMicros) * 100).toFixed(2));
  }
}
