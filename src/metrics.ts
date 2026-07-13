import http from 'http';

interface MetricsState {
  totalForwardedCountCallback: () => number;
  getQueueStateCallback: () => { running: number; queued: number; maxConcurrency: number };
}

let server: http.Server | null = null;

export function startMetricsServer(
  port: number,
  state: MetricsState
): void {
  server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
      return;
    }
    
    if (req.url === '/metrics') {
      const queue = state.getQueueStateCallback();
      const forwarded = state.totalForwardedCountCallback();
      
      const metrics = [
        '# HELP tg_forwarder_total_forwarded Total number of forwarded messages',
        '# TYPE tg_forwarder_total_forwarded counter',
        `tg_forwarder_total_forwarded ${forwarded}`,
        '',
        '# HELP tg_forwarder_queue_running Number of tasks currently running in queue',
        '# TYPE tg_forwarder_queue_running gauge',
        `tg_forwarder_queue_running ${queue.running}`,
        '',
        '# HELP tg_forwarder_queue_queued Number of tasks currently queued',
        '# TYPE tg_forwarder_queue_queued gauge',
        `tg_forwarder_queue_queued ${queue.queued}`,
        '',
        '# HELP tg_forwarder_queue_max_concurrency Max concurrency limit of the queue',
        '# TYPE tg_forwarder_queue_max_concurrency gauge',
        `tg_forwarder_queue_max_concurrency ${queue.maxConcurrency}`
      ].join('\n');
      
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(metrics);
      return;
    }
    
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });
  
  server.listen(port, () => {
    // We log using console.log directly to stdout, or via addLog if imported. 
    // To avoid circular dependencies, we write to console.log directly.
    console.log(`[INFO] Prometheus metrics server listening on port ${port} (metrics at /metrics, health at /healthz)`);
  });
}

export function stopMetricsServer(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (server) {
      server.close(() => {
        resolve();
      });
      server = null;
    } else {
      resolve();
    }
  });
}
