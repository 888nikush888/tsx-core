import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { evaluateSoakWindow, prometheusValue, soakQueries, validatePrometheusUrl } from '../scripts/check_soak_window.js';

const passing = {
  scrapeCount: 172_800,
  attempts: 200,
  availability: 0.999,
  deliverySuccess: 0.998,
  p95LatencySeconds: 30,
  unknownDeliveries: 0,
  backupHealth: 1,
  retentionHealth: 1,
  diskHealth: 1,
  auditHealth: 1,
  tradingHealth: 1,
  tradingIntents: 120,
  tradingUnknownOrders: 0,
  tradingUnprotectedPositions: 0,
  tradingKillSwitch: 0,
  maxResidentMemoryBytes: 500_000_000,
  maxQueuedTasks: 10,
  maxOldestPendingAgeSeconds: 30
};
assert.equal(evaluateSoakWindow(passing).passed, true);
const failed = evaluateSoakWindow({ ...passing, unknownDeliveries: 1, attempts: 99 });
assert.equal(failed.passed, false);
assert.deepEqual(failed.checks.filter(check => !check.passed).map(check => check.name), [
  'delivery sample size',
  'unknown delivery maximum'
]);
const queries = soakQueries();
assert.ok(Object.values(queries).every(query => query.includes('[30d]')));
assert.match(queries.deliverySuccess, /delivery_confirmed_total/);
assert.match(queries.p95LatencySeconds, /histogram_quantile\(0\.95/);
assert.match(queries.availability, /tg_forwarder_readiness/);
assert.match(queries.tradingIntents, /tg_forwarder_trading_intents_total/);

assert.equal(validatePrometheusUrl('https://prometheus.example').protocol, 'https:');
assert.equal(validatePrometheusUrl('http://127.0.0.1:9090').hostname, '127.0.0.1');
for (const url of ['https://user:password@prometheus.example', 'https://prometheus.example/#fragment']) {
  assert.throws(() => validatePrometheusUrl(url), /credentials or a fragment/u);
}
assert.throws(() => validatePrometheusUrl('http://prometheus.example'), /must use HTTPS/u);
assert.equal(prometheusValue({ status: 'success', data: { result: [{ value: [1, '0'] }] } }), 0);
for (const payload of [null, {}, { status: 'error' }, { status: 'success', data: { result: [] } },
  { status: 'success', data: { result: [{ value: [1, '1'] }, { value: [1, '2'] }] } }]) {
  assert.throws(() => prometheusValue(payload), /exactly one result/u);
}
for (const value of ['NaN', '+Inf', '-Inf', 'invalid']) {
  assert.throws(() => prometheusValue({ status: 'success', data: { result: [{ value: [1, value] }] } }), /non-finite/u);
}

async function runSoakCli(queryValues, httpStatus) {
  const directory = await mkdtemp(path.join(tmpdir(), 'tsx-soak-cli-'));
  try {
    await Promise.all(['scripts', 'src'].map(relative => mkdir(path.join(directory, relative))));
    const byQuery = Object.fromEntries(Object.entries(queries).map(([name, query]) => [query, queryValues[name]]));
    const stub = `const values = ${JSON.stringify(byQuery)}; globalThis.fetch = (url) => Promise.resolve({
      ok: ${httpStatus === 200}, status: ${httpStatus}, json: () => Promise.resolve({status: 'success',
      data: {result: [{value: [1, String(values[new URL(url).searchParams.get('query')])]}]}})});`;
    await Promise.all([
      copyFile(new URL('../scripts/check_soak_window.js', import.meta.url), path.join(directory, 'scripts/check_soak_window.js')),
      writeFile(path.join(directory, 'package.json'), '{"type":"module"}'),
      writeFile(path.join(directory, 'src/env.js'), 'export function loadEnv() { return undefined; }'),
      writeFile(path.join(directory, 'fake-fetch.mjs'), stub),
    ]);
    const result = spawnSync(process.execPath, ['--import', './fake-fetch.mjs', 'scripts/check_soak_window.js'], {
      cwd: directory, encoding: 'utf8', timeout: 15_000, shell: false,
      env: { ...process.env, PROMETHEUS_URL: 'https://prometheus.fixture.invalid', PROMETHEUS_TOKEN: '' },
    });
    assert.equal(result.error);
    assert.equal(result.signal, null);
    const evidenceDirectory = path.join(directory, 'reports/soak');
    const files = await readdir(evidenceDirectory);
    assert.equal(files.length, 1, 'Each run must retain exactly one evidence document.');
    return { result, evidence: JSON.parse(await readFile(path.join(evidenceDirectory, files[0]), 'utf8')) };
  } finally {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
}

const success = await runSoakCli(passing, 200);
assert.equal(success.result.status, 0);
assert.equal(success.evidence.passed, true);
assert.deepEqual(success.evidence.values, passing);
assert.equal(success.evidence.window, '30d');
assert.equal(success.evidence.queryError, null);
assert.match(success.result.stdout, /30-DAY SOAK GATE PASSED/u);
const unhealthy = await runSoakCli({ ...passing, unknownDeliveries: 1 }, 200);
assert.equal(unhealthy.result.status, 1);
assert.equal(unhealthy.evidence.passed, false);
assert.match(unhealthy.result.stderr, /unknown delivery maximum/u);
const unavailable = await runSoakCli(passing, 503);
assert.equal(unavailable.result.status, 1);
assert.equal(unavailable.evidence.passed, false);
assert.equal(unavailable.evidence.queryError, 'Prometheus query failed with HTTP 503.');
assert.deepEqual(unavailable.evidence.checks, []);
assert.doesNotMatch(unavailable.result.stdout, /PASSED/u);

console.log('30-day soak evaluation tests passed.');
