import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import tls from 'node:tls';

import { startAlertRelay } from '/app/dist/alert_relay.js';
import { internalExecutorOrigin } from '/app/dist/executor_origin.js';
import { startTelegramViewerHealthServer } from '/app/dist/telegram_viewer/health_server.js';

const ca = fs.readFileSync('/run/tsx-tls/ca.pem');
const results = [];
let step = 'startup';

function tlsAttempt(host, port, options = {}) {
  return new Promise(resolve => {
    const socket = tls.connect({ host, port, ca: options.invalidCa ? [] : ca,
      rejectUnauthorized: true, servername: options.servername ?? host });
    socket.setTimeout(4_000, () => socket.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    socket.once('secureConnect', () => {
      const authorized = socket.authorized;
      socket.end();
      resolve({ authorized, code: authorized ? 'AUTHORIZED' : 'UNAUTHORIZED' });
    });
    socket.once('error', error => resolve({ authorized: false, code: error.code || error.name }));
  });
}

function plaintextAttempt(host, port) {
  return new Promise(resolve => {
    const request = http.get({ host, port, path: '/healthz', timeout: 4_000 }, response => {
      response.resume();
      resolve({ rejected: false, code: `HTTP_${response.statusCode}` });
    });
    request.once('timeout', () => request.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    request.once('error', error => resolve({ rejected: true, code: error.code || error.name }));
  });
}

async function endpoint(name, host, port, path, expectedStatus) {
  step = name;
  const response = await fetch(`https://${host}:${port}${path}`, {
    redirect: 'manual', signal: AbortSignal.timeout(5_000),
  });
  await response.body?.cancel();
  assert.ok(expectedStatus.includes(response.status), `${name} HTTPS status was not accepted`);
  const valid = await tlsAttempt(host, port);
  assert.equal(valid.authorized, true, `${name} rejected the mounted CA`);
  const invalidCa = await tlsAttempt(host, port, { invalidCa: true });
  assert.equal(invalidCa.authorized, false, `${name} accepted an untrusted CA`);
  assert.notEqual(invalidCa.code, 'TIMEOUT');
  assert.notEqual(invalidCa.code, 'ECONNREFUSED');
  const wrongName = await tlsAttempt(host, port, { servername: 'unexpected.invalid' });
  assert.equal(wrongName.authorized, false, `${name} accepted the wrong server name`);
  assert.equal(wrongName.code, 'ERR_TLS_CERT_ALTNAME_INVALID');
  const cleartext = await plaintextAttempt(host, port);
  assert.equal(cleartext.rejected, true, `${name} accepted cleartext HTTP`);
  results.push({ name, httpsStatus: response.status, trustedCa: valid.code,
    invalidCa: invalidCa.code, wrongName: wrongName.code, cleartext: cleartext.code });
}

function close(server) {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

let viewer = null;
let relay = null;
try {
  await endpoint('dashboard', 'forwarder', 8080, '/', [200, 301, 302, 401, 403]);
  await endpoint('metrics', 'forwarder', 9100, '/healthz', [200]);
  assert.equal(internalExecutorOrigin('https://exchange-executor:8090'), 'https://exchange-executor:8090');
  assert.throws(() => internalExecutorOrigin('http://exchange-executor:8090'), /HTTPS|https/u);
  await endpoint('dashboard-to-executor', 'exchange-executor', 8090, '/healthz', [200]);

  process.env.TELEGRAM_VIEWER_TLS_CERT_FILE = '/run/tsx-tls/viewer.crt';
  process.env.TELEGRAM_VIEWER_TLS_KEY_FILE = '/run/tsx-tls/viewer.key';
  viewer = startTelegramViewerHealthServer({ host: '127.0.0.1', port: 0,
    serviceToken: 'v'.repeat(43), status: () => ({ healthy: true, ready: true }) });
  await once(viewer, 'listening');
  await endpoint('viewer-status', '127.0.0.1', viewer.address().port, '/healthz', [200]);
  step = 'viewer-status-auth';
  const viewerUnauthorized = await fetch(`https://127.0.0.1:${viewer.address().port}/status`,
    { signal: AbortSignal.timeout(5_000) });
  assert.equal(viewerUnauthorized.status, 401);
  await viewerUnauthorized.body?.cancel();
  const viewerAuthorized = await fetch(`https://127.0.0.1:${viewer.address().port}/status`,
    { headers: { Authorization: `Bearer ${'v'.repeat(43)}` }, signal: AbortSignal.timeout(5_000) });
  assert.equal(viewerAuthorized.status, 200);
  await viewerAuthorized.body?.cancel();

  process.env.ALERT_RELAY_TLS_CERT_FILE = '/run/tsx-tls/alert-relay.crt';
  process.env.ALERT_RELAY_TLS_KEY_FILE = '/run/tsx-tls/alert-relay.key';
  relay = startAlertRelay({ incomingToken: 'a'.repeat(40),
    webhookUrl: 'https://127.0.0.1:9/unreachable', webhookToken: 'b'.repeat(40) }, 0, '127.0.0.1');
  await once(relay, 'listening');
  await endpoint('alert-relay', '127.0.0.1', relay.address().port, '/healthz', [200]);
  step = 'alert-post-auth';
  const unauthorized = await fetch(`https://127.0.0.1:${relay.address().port}/alerts`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: '{"status":"firing","alerts":[]}', signal: AbortSignal.timeout(5_000),
  });
  assert.equal(unauthorized.status, 401);
  await unauthorized.body?.cancel();

  step = 'prometheus-scrape';
  let scrape = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await fetch('http://prometheus:9090/api/v1/query?query=up%7Bjob%3D%22tsx-core%22%7D',
      { signal: AbortSignal.timeout(5_000) });
    const body = await response.json();
    scrape = body?.data?.result?.[0]?.value?.[1] ?? null;
    if (scrape === '1') break;
    await new Promise(resolve => setTimeout(resolve, 5_000));
  }
  assert.equal(scrape, '1', 'Prometheus did not scrape metrics through HTTPS');
  const configResponse = await fetch('http://prometheus:9090/api/v1/status/config',
    { signal: AbortSignal.timeout(5_000) });
  const config = await configResponse.json();
  assert.match(config?.data?.yaml ?? '', /scheme: https/u);
  assert.match(config?.data?.yaml ?? '', /ca_file: \/run\/tsx-tls\/ca\.pem/u);

  console.log(JSON.stringify({ status: 'PASS', revision: '0e6346b7ebded36897cbb6e8624db5dd0d712124',
    project: 'tsx-tls-smoke-0e6346', internalNetworksOnly: true,
    realCredentials: false, ordersSent: 0, deliveriesSent: 0,
    unauthorizedViewerStatus: viewerUnauthorized.status, unauthorizedAlertPost: unauthorized.status,
    prometheusHttpsUp: scrape, results }));
} catch (error) {
  console.error(JSON.stringify({ status: 'FAIL', step, code: error?.code || error?.name || 'UNKNOWN' }));
  process.exitCode = 1;
} finally {
  if (viewer) await close(viewer);
  if (relay) await close(relay);
}
