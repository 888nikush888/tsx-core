import { randomUUID } from 'node:crypto';

if (!process.argv.includes('--confirm-alert-delivery')) {
  console.error('Refusing to page the incident route without --confirm-alert-delivery.');
  process.exit(2);
}

const target = new URL(process.env.ALERTMANAGER_URL || 'http://127.0.0.1:9093');
const loopback = ['127.0.0.1', '::1', 'localhost'].includes(target.hostname);
if (target.protocol !== 'https:' && !(target.protocol === 'http:' && loopback)) {
  throw new Error('ALERTMANAGER_URL must use HTTPS unless it targets loopback.');
}
target.pathname = '/api/v2/alerts';
target.search = '';
target.hash = '';
const correlationId = randomUUID();
const now = Date.now();
const response = await fetch(target, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify([{
    labels: {
      alertname: 'EnterpriseSyntheticAlert',
      severity: 'critical',
      service: 'telegram-forwarder',
      correlation_id: correlationId
    },
    annotations: {
      summary: 'Synthetic alert delivery verification',
      runbook: 'docs/runbooks/operations.md#alarm-triage'
    },
    startsAt: new Date(now).toISOString(),
    endsAt: new Date(now + 5 * 60_000).toISOString(),
    generatorURL: 'quality-os://synthetic-alert'
  }]),
  redirect: 'error',
  signal: AbortSignal.timeout(10_000)
});
await response.body?.cancel();
if (response.status < 200 || response.status >= 300) {
  throw new Error(`Alertmanager rejected the synthetic alert with HTTP ${response.status}.`);
}
console.log(`Synthetic alert accepted. Confirm receipt for correlation_id=${correlationId}.`);
