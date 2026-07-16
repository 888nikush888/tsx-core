import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyManagedRuntimeSettings, createAlertRelay } from '../src/alert_relay.js';
import { DEFAULT_RUNTIME_SETTINGS } from '../src/runtime_settings.js';

const incomingToken = 'i'.repeat(64);
const outgoingToken = 'o'.repeat(64);
let outgoingStatus = 204;
let deliveredBody = null;
const receiver = http.createServer(async (request, response) => {
  assert.equal(request.headers.authorization, `Bearer ${outgoingToken}`);
  assert.equal(request.headers['x-alert-source'], 'telegram-forwarder');
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  deliveredBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  response.writeHead(outgoingStatus).end();
});
let activeRelay = null;

try {
  receiver.listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  const receiverAddress = receiver.address();
  assert.ok(receiverAddress && typeof receiverAddress === 'object');
  activeRelay = createAlertRelay({
    incomingToken,
    webhookUrl: `http://127.0.0.1:${receiverAddress.port}/incident`,
    webhookToken: outgoingToken,
    allowInsecureLoopback: true
  });
  activeRelay.listen(0, '127.0.0.1');
  await once(activeRelay, 'listening');
  const relayAddress = activeRelay.address();
  assert.ok(relayAddress && typeof relayAddress === 'object');
  const baseUrl = `http://127.0.0.1:${relayAddress.port}`;
  const payload = {
    status: 'firing',
    alerts: [{ labels: { alertname: 'Synthetic', severity: 'critical' }, annotations: { summary: 'test' } }]
  };

  let response = await fetch(`${baseUrl}/healthz`);
  assert.equal(response.status, 200);
  response = await fetch(`${baseUrl}/alerts`, { method: 'POST', body: JSON.stringify(payload) });
  assert.equal(response.status, 401);
  response = await fetch(`${baseUrl}/alerts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${incomingToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  assert.equal(response.status, 202);
  assert.equal(deliveredBody.alerts[0].labels.alertname, 'Synthetic');

  response = await fetch(`${baseUrl}/alerts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${incomingToken}` },
    body: '{bad json'
  });
  assert.equal(response.status, 400);
  outgoingStatus = 503;
  response = await fetch(`${baseUrl}/alerts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${incomingToken}` },
    body: JSON.stringify(payload)
  });
  assert.equal(response.status, 502, 'Alertmanager must retry when the incident endpoint fails');
  await new Promise(resolve => activeRelay.close(resolve));

  assert.throws(
    () => createAlertRelay({ incomingToken, webhookUrl: 'http://example.com', webhookToken: outgoingToken }),
    /must use HTTPS/
  );

  const settingsDirectory = await mkdtemp(path.join(os.tmpdir(), 'alert-relay-settings-'));
  try {
    const settingsPath = path.join(settingsDirectory, 'runtime-settings.json');
    await writeFile(settingsPath, JSON.stringify({
      ...DEFAULT_RUNTIME_SETTINGS,
      alertWebhookUrl: 'https://incident.example/alerts',
      alertWebhookTimeoutMs: 12_000
    }));
    const managedEnvironment = { RUNTIME_SETTINGS_PATH: settingsPath };
    await applyManagedRuntimeSettings(managedEnvironment);
    assert.equal(managedEnvironment.ALERT_WEBHOOK_URL, 'https://incident.example/alerts');
    assert.equal(managedEnvironment.ALERT_WEBHOOK_TIMEOUT_MS, '12000');

    const explicitEnvironment = {
      RUNTIME_SETTINGS_PATH: settingsPath,
      ALERT_WEBHOOK_URL: 'https://override.example/alerts'
    };
    await applyManagedRuntimeSettings(explicitEnvironment);
    assert.equal(explicitEnvironment.ALERT_WEBHOOK_URL, 'https://override.example/alerts');
    assert.equal(explicitEnvironment.ALERT_WEBHOOK_TIMEOUT_MS, undefined);
  } finally {
    await rm(settingsDirectory, { recursive: true, force: true });
  }
  console.log('ALL ALERT RELAY SECURITY TESTS PASSED!');
} finally {
  receiver.close();
  activeRelay?.closeAllConnections();
  activeRelay?.close();
}
