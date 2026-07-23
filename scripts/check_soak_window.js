import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../src/env.js';

const WINDOW = '30d';
const THRESHOLDS = Object.freeze({
  minimumScrapes: 171_936,
  minimumDeliveries: 100,
  minimumAvailability: 0.995,
  minimumDeliverySuccess: 0.995,
  maximumP95LatencySeconds: 60,
  maximumUnknownDeliveries: 0,
  minimumBackupHealth: 1,
  minimumRetentionHealth: 1,
  minimumDiskHealth: 1,
  minimumAuditHealth: 1,
  minimumTradingHealth: 1,
  minimumTradingIntents: 100,
  maximumTradingUnknownOrders: 0,
  maximumTradingUnprotectedPositions: 0,
  maximumTradingKillSwitch: 0,
  maximumResidentMemoryBytes: 805_306_368,
  maximumQueuedTasks: 100,
  maximumOldestPendingAgeSeconds: 300
});

export function soakQueries(window = WINDOW) {
  return {
    scrapeCount: `sum(count_over_time(up{job="tsx-core"}[${window}]))`,
    availability: `avg(avg_over_time(tg_forwarder_readiness[${window}]))`,
    attempts: `sum(increase(tg_forwarder_delivery_attempts_total[${window}]))`,
    deliverySuccess: `sum(increase(tg_forwarder_delivery_confirmed_total[${window}])) / clamp_min(sum(increase(tg_forwarder_delivery_attempts_total[${window}])), 1)`,
    p95LatencySeconds: `histogram_quantile(0.95, sum by (le) (rate(tg_forwarder_delivery_latency_seconds_bucket[${window}])))`,
    unknownDeliveries: `max(max_over_time(tg_forwarder_outbox_tasks{status="unknown"}[${window}]))`,
    backupHealth: `min(min_over_time(tg_forwarder_backup_healthy[${window}]))`,
    retentionHealth: `min(min_over_time(tg_forwarder_retention_healthy[${window}]))`,
    diskHealth: `min(min_over_time(tg_forwarder_disk_capacity_healthy[${window}]))`,
    auditHealth: `min(min_over_time(tg_forwarder_audit_healthy[${window}]))`,
    tradingHealth: `min(min_over_time(tg_forwarder_trading_healthy[${window}]))`,
    tradingIntents: `sum(increase(tg_forwarder_trading_intents_total[${window}]))`,
    tradingUnknownOrders: `max(max_over_time(tg_forwarder_trading_unknown_orders[${window}]))`,
    tradingUnprotectedPositions: `max(max_over_time(tg_forwarder_trading_unprotected_positions[${window}]))`,
    tradingKillSwitch: `max(max_over_time(tg_forwarder_trading_kill_switch_active[${window}]))`,
    maxResidentMemoryBytes: `max(max_over_time(process_resident_memory_bytes[${window}]))`,
    maxQueuedTasks: `max(max_over_time(tg_forwarder_queue_queued[${window}]))`,
    maxOldestPendingAgeSeconds: `max(max_over_time(tg_forwarder_outbox_oldest_pending_age_seconds[${window}]))`
  };
}

export function evaluateSoakWindow(values, thresholds = THRESHOLDS) {
  const checks = [
    { name: '30-day scrape sample completeness', actual: values.scrapeCount, target: `>= ${thresholds.minimumScrapes}`, passed: values.scrapeCount >= thresholds.minimumScrapes },
    { name: 'delivery sample size', actual: values.attempts, target: `>= ${thresholds.minimumDeliveries}`, passed: values.attempts >= thresholds.minimumDeliveries },
    { name: 'readiness availability', actual: values.availability, target: `>= ${thresholds.minimumAvailability}`, passed: values.availability >= thresholds.minimumAvailability },
    { name: 'confirmed delivery success', actual: values.deliverySuccess, target: `>= ${thresholds.minimumDeliverySuccess}`, passed: values.deliverySuccess >= thresholds.minimumDeliverySuccess },
    { name: 'P95 accepted-to-confirmed latency seconds', actual: values.p95LatencySeconds, target: `<= ${thresholds.maximumP95LatencySeconds}`, passed: values.p95LatencySeconds <= thresholds.maximumP95LatencySeconds },
    { name: 'unknown delivery maximum', actual: values.unknownDeliveries, target: `<= ${thresholds.maximumUnknownDeliveries}`, passed: values.unknownDeliveries <= thresholds.maximumUnknownDeliveries },
    { name: 'backup health minimum', actual: values.backupHealth, target: `>= ${thresholds.minimumBackupHealth}`, passed: values.backupHealth >= thresholds.minimumBackupHealth },
    { name: 'retention health minimum', actual: values.retentionHealth, target: `>= ${thresholds.minimumRetentionHealth}`, passed: values.retentionHealth >= thresholds.minimumRetentionHealth },
    { name: 'disk health minimum', actual: values.diskHealth, target: `>= ${thresholds.minimumDiskHealth}`, passed: values.diskHealth >= thresholds.minimumDiskHealth },
    { name: 'audit health minimum', actual: values.auditHealth, target: `>= ${thresholds.minimumAuditHealth}`, passed: values.auditHealth >= thresholds.minimumAuditHealth },
    { name: 'trading health minimum', actual: values.tradingHealth, target: `>= ${thresholds.minimumTradingHealth}`, passed: values.tradingHealth >= thresholds.minimumTradingHealth },
    { name: 'trading intent sample size', actual: values.tradingIntents, target: `>= ${thresholds.minimumTradingIntents}`, passed: values.tradingIntents >= thresholds.minimumTradingIntents },
    { name: 'trading unknown order maximum', actual: values.tradingUnknownOrders, target: `<= ${thresholds.maximumTradingUnknownOrders}`, passed: values.tradingUnknownOrders <= thresholds.maximumTradingUnknownOrders },
    { name: 'trading unprotected position maximum', actual: values.tradingUnprotectedPositions, target: `<= ${thresholds.maximumTradingUnprotectedPositions}`, passed: values.tradingUnprotectedPositions <= thresholds.maximumTradingUnprotectedPositions },
    { name: 'trading kill switch maximum', actual: values.tradingKillSwitch, target: `<= ${thresholds.maximumTradingKillSwitch}`, passed: values.tradingKillSwitch <= thresholds.maximumTradingKillSwitch },
    { name: 'resident memory maximum bytes', actual: values.maxResidentMemoryBytes, target: `<= ${thresholds.maximumResidentMemoryBytes}`, passed: values.maxResidentMemoryBytes <= thresholds.maximumResidentMemoryBytes },
    { name: 'queued task maximum', actual: values.maxQueuedTasks, target: `<= ${thresholds.maximumQueuedTasks}`, passed: values.maxQueuedTasks <= thresholds.maximumQueuedTasks },
    { name: 'oldest pending task age seconds', actual: values.maxOldestPendingAgeSeconds, target: `<= ${thresholds.maximumOldestPendingAgeSeconds}`, passed: values.maxOldestPendingAgeSeconds <= thresholds.maximumOldestPendingAgeSeconds }
  ];
  return { passed: checks.every(check => check.passed), checks };
}

function validatePrometheusUrl(value) {
  const url = new URL(value);
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(url.hostname);
  if (url.username || url.password || url.hash) throw new Error('PROMETHEUS_URL must not contain credentials or a fragment.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('PROMETHEUS_URL must use HTTPS unless it targets loopback.');
  }
  return url;
}

async function queryPrometheus(baseUrl, query, token) {
  const endpoint = new URL('/api/v1/query', baseUrl);
  endpoint.searchParams.set('query', query);
  const response = await fetch(endpoint, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    redirect: 'error',
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`Prometheus query failed with HTTP ${response.status}.`);
  const payload = await response.json();
  const result = payload?.data?.result;
  if (payload?.status !== 'success' || !Array.isArray(result) || result.length !== 1) {
    throw new Error('Prometheus query did not return exactly one result.');
  }
  const value = Number(result[0]?.value?.[1]);
  if (!Number.isFinite(value)) throw new Error('Prometheus query returned a non-finite value.');
  return value;
}

async function run() {
  loadEnv();
  const baseUrl = validatePrometheusUrl(process.env.PROMETHEUS_URL || 'http://127.0.0.1:9090');
  const token = process.env.PROMETHEUS_TOKEN?.trim() || '';
  if (token && (token.length < 32 || /[\r\n]/.test(token))) throw new Error('PROMETHEUS_TOKEN must contain at least 32 characters without line breaks.');
  const queries = soakQueries();
  const values = {};
  let queryError = null;
  try {
    await Promise.all(Object.entries(queries).map(async ([name, query]) => {
      values[name] = await queryPrometheus(baseUrl, query, token);
    }));
  } catch (error) {
    queryError = error.message;
  }
  const evaluation = queryError ? { passed: false, checks: [] } : evaluateSoakWindow(values);
  const evidence = {
    schemaVersion: 1,
    evaluatedAt: new Date().toISOString(),
    window: WINDOW,
    passed: evaluation.passed,
    queryError,
    values,
    checks: evaluation.checks
  };
  const evidenceDirectory = path.resolve('reports', 'soak');
  await mkdir(evidenceDirectory, { recursive: true });
  const evidencePath = path.join(evidenceDirectory, `soak-${Date.now()}.json`);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  if (!evaluation.passed) {
    const failures = queryError || evaluation.checks.filter(check => !check.passed).map(check => check.name).join(', ');
    throw new Error(`30-day soak gate failed: ${failures}. Evidence: ${evidencePath}`);
  }
  console.log(`30-DAY SOAK GATE PASSED evidence=${evidencePath}`);
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    await run();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
