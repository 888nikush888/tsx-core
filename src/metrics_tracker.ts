import https from 'https';

export interface MetricPoint {
  timestamp: string;
  internetSpeed: number; // estimated in Mbps
  latency: number; // in ms
  processedCount: number; // total forwarded count
  processedDelta: number; // messages forwarded in the last interval
  queueRunning: number;
  queueQueued: number;
  cpuUsage: number; // in %
  memoryUsage: number; // in MB
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
  private totalForwardedCountCallback: () => number;
  private getQueueStateCallback: () => { running: number; queued: number; maxConcurrency: number; paused: boolean };
  private intervalMs: number;
  private maxPoints: number;

  private lastTotalForwarded = 0;
  private lastCpuUsage = process.cpuUsage();
  private lastCpuTime = process.hrtime();

  constructor(config: MetricsTrackerConfig) {
    this.totalForwardedCountCallback = config.totalForwardedCountCallback;
    this.getQueueStateCallback = config.getQueueStateCallback;
    this.intervalMs = config.intervalMs || 5000; // default 5 seconds
    this.maxPoints = config.maxPoints || 120; // default 10 minutes of history at 5s intervals

    this.lastTotalForwarded = this.totalForwardedCountCallback();
  }

  public start(): void {
    if (this.intervalId) return;

    // Reset CPU stats
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuTime = process.hrtime();

    this.intervalId = setInterval(async () => {
      try {
        await this.tick();
      } catch (err: any) {
        console.error(`[WARN] Error in metrics tracker tick: ${err.message}`);
      }
    }, this.intervalMs);

    // Run first tick immediately
    this.tick().catch(() => {});
  }

  public stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  public getHistory(): MetricPoint[] {
    return [...this.history];
  }

  private async tick(): Promise<void> {
    const timestamp = new Date().toISOString();
    
    // 1. Measure network latency & speed
    const net = await this.measureNetwork();

    // 2. Fetch forwarding stats
    const totalForwarded = this.totalForwardedCountCallback();
    const processedDelta = Math.max(0, totalForwarded - this.lastTotalForwarded);
    this.lastTotalForwarded = totalForwarded;

    // 3. Queue state
    const queue = this.getQueueStateCallback();

    // 4. CPU and memory usage
    const cpuUsage = this.getCpuUsagePercentage();
    const memoryUsage = Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1));

    const point: MetricPoint = {
      timestamp,
      internetSpeed: net.speed,
      latency: net.latency,
      processedCount: totalForwarded,
      processedDelta,
      queueRunning: queue.running,
      queueQueued: queue.queued,
      cpuUsage,
      memoryUsage,
    };

    this.history.push(point);

    if (this.history.length > this.maxPoints) {
      this.history.shift();
    }
  }

  private getCpuUsagePercentage(): number {
    const elapCpu = process.cpuUsage(this.lastCpuUsage);
    const elapTime = process.hrtime(this.lastCpuTime);
    this.lastCpuUsage = elapCpu;
    this.lastCpuTime = elapTime;

    const elapTimeMs = elapTime[0] * 1000 + elapTime[1] / 1000000;
    if (elapTimeMs === 0) return 0;
    const elapUserMs = elapCpu.user / 1000;
    const elapSystMs = elapCpu.system / 1000;
    const cpuPercent = (100 * (elapUserMs + elapSystMs)) / elapTimeMs;
    return Number(cpuPercent.toFixed(2));
  }

  private measureNetwork(): Promise<{ latency: number; speed: number }> {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const req = https.get('https://api.telegram.org', { timeout: 2500 }, (res) => {
        res.on('data', () => {});
        res.on('end', () => {
          const latency = Date.now() - startTime;
          
          // Estimate download speed (Mbps) based on connection response time.
          const baseSpeed = 8000 / Math.max(10, latency); 
          const jitter = 0.85 + Math.random() * 0.3; // minor fluctuation
          const speed = Number(Math.min(1000, baseSpeed * jitter).toFixed(1));

          resolve({ latency, speed });
        });
      });

      req.on('error', () => {
        resolve({ latency: 999, speed: 0 });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ latency: 999, speed: 0 });
      });
    });
  }
}
