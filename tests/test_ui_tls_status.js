import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { internalTlsServerOptions } from '../src/internal_tls.js';
import { uiTlsStatus } from '../src/ui_tls_status.js';
import { setupInternalTlsTest } from './fixtures/internal_tls_test.js';

const fixture = await setupInternalTlsTest();
const secondFixture = await setupInternalTlsTest({ caName: 'TSX Core second disposable CA' });
const secondCa = readFileSync(secondFixture.ca);
await secondFixture.cleanup();
const activeDashboardCertificate = readFileSync(fixture.cert);
const previousMetricsPort = process.env.METRICS_PORT;
const metricsServer = https.createServer(internalTlsServerOptions('METRICS_TLS_CERT_FILE', 'METRICS_TLS_KEY_FILE'));
let metricsConnections = 0;
metricsServer.on('connection', () => { metricsConnections += 1; });
try {
  metricsServer.listen(0, '127.0.0.1');
  await once(metricsServer, 'listening');
  process.env.METRICS_PORT = String(metricsServer.address().port);
  for (const peer of ['ALERT_RELAY', 'TELEGRAM_VIEWER', 'EXECUTOR']) delete process.env[`${peer}_TLS_CERT_FILE`];
  const [status, ...concurrent] = await Promise.all(Array.from({ length: 8 }, () => uiTlsStatus(activeDashboardCertificate)));
  assert.equal(status.trustAnchor.state, 'available');
  assert.equal(status.trustAnchor.certificates.length, 1);
  assert.match(status.trustAnchor.certificates[0].fingerprint256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  assert.equal(metricsConnections, 1, 'Concurrent deployment reads must share one TLS probe per endpoint.');
  assert.ok(concurrent.every(result => result.endpoints[1].active.checkedAt === status.endpoints[1].active.checkedAt));
  const cached = await uiTlsStatus(activeDashboardCertificate);
  assert.equal(cached.endpoints[1].active.checkedAt, status.endpoints[1].active.checkedAt);
  assert.equal(metricsConnections, 1, 'Immediate repeat reads must use the bounded probe cache.');
  assert.deepEqual(status.endpoints.map(endpoint => endpoint.id),
    ['dashboard', 'metrics', 'alert-relay', 'telegram-viewer', 'exchange-executor']);
  const dashboard = status.endpoints[0];
  assert.equal(dashboard.file.state, 'available');
  assert.equal(dashboard.active.state, 'observed');
  assert.equal(dashboard.activeMatchesFile, true);
  assert.equal(status.endpoints[1].active.state, 'observed');
  assert.equal(status.endpoints[1].activeMatchesFile, true);
  assert.match(dashboard.active.certificate.subjectAltName, /DNS:localhost/);
  assert.ok(Date.parse(dashboard.active.certificate.expiresAt) > Date.now());
  for (const peer of status.endpoints.slice(2)) {
    assert.equal(peer.file.state, 'not_visible', `${peer.label} private certificate must not be needed in the dashboard container`);
    assert.equal(peer.activeMatchesFile, null);
  }
  const serialized = JSON.stringify(status);
  assert.ok(!serialized.includes(fixture.key) && !serialized.includes(fixture.cert) && !serialized.includes(fixture.ca));
  assert.ok(!serialized.includes('PRIVATE KEY') && !serialized.includes('BEGIN CERTIFICATE'));

  const bundlePath = path.join(path.dirname(fixture.ca), 'ca-bundle.pem');
  writeFileSync(bundlePath, Buffer.concat([readFileSync(fixture.ca), secondCa]));
  process.env.NODE_EXTRA_CA_CERTS = bundlePath;
  const bundle = await uiTlsStatus(activeDashboardCertificate);
  assert.equal(bundle.trustAnchor.state, 'available');
  assert.equal(bundle.trustAnchor.certificates.length, 2);
  assert.notEqual(bundle.trustAnchor.certificates[0].fingerprint256, bundle.trustAnchor.certificates[1].fingerprint256);
  assert.equal(bundle.trustAnchor.earliestExpiryAt, bundle.trustAnchor.certificates
    .map(certificate => certificate.expiresAt).sort()[0]);
  assert.equal(bundle.endpoints[1].active.state, 'observed');
  assert.equal(metricsConnections, 2, 'A CA bundle change must invalidate the old probe result.');

  const badBundlePath = path.join(path.dirname(fixture.ca), 'ca-bundle-invalid.pem');
  writeFileSync(badBundlePath, Buffer.concat([readFileSync(fixture.ca), readFileSync(fixture.cert)]));
  process.env.NODE_EXTRA_CA_CERTS = badBundlePath;
  const badBundle = await uiTlsStatus(activeDashboardCertificate);
  assert.equal(badBundle.trustAnchor.state, 'invalid', 'Every certificate in a CA bundle must be a CA.');
  assert.equal(badBundle.endpoints[1].active.state, 'not_checked');
  writeFileSync(badBundlePath, Buffer.concat([readFileSync(fixture.ca), readFileSync(fixture.expiredCa)]));
  const expiredBundle = await uiTlsStatus(activeDashboardCertificate);
  assert.equal(expiredBundle.trustAnchor.state, 'expired', 'An expired second CA must invalidate the whole bundle.');
  assert.equal(expiredBundle.trustAnchor.certificates.length, 2, 'The invalid member must remain visible as metadata.');
  assert.equal(expiredBundle.endpoints[1].active.state, 'not_checked');
  writeFileSync(badBundlePath, Buffer.concat(Array.from({ length: 11 }, () => readFileSync(fixture.ca))));
  assert.equal((await uiTlsStatus(activeDashboardCertificate)).trustAnchor.state, 'invalid', 'More than ten CA certificates must be rejected.');

  const otherCaPath = path.join(path.dirname(fixture.ca), 'other-ca.pem');
  writeFileSync(otherCaPath, secondCa);
  process.env.NODE_EXTRA_CA_CERTS = otherCaPath;
  const wrongCa = await uiTlsStatus(activeDashboardCertificate);
  assert.equal(wrongCa.trustAnchor.state, 'available');
  assert.equal(wrongCa.endpoints[1].active.state, 'untrusted', 'A valid but wrong CA must not verify the metrics listener.');

  const wrongNameServer = https.createServer({ cert: readFileSync(fixture.wrongNameCert), key: readFileSync(fixture.key) });
  try {
    wrongNameServer.listen(0, '127.0.0.1');
    await once(wrongNameServer, 'listening');
    process.env.NODE_EXTRA_CA_CERTS = fixture.ca;
    process.env.METRICS_PORT = String(wrongNameServer.address().port);
    const wrongName = await uiTlsStatus(activeDashboardCertificate);
    assert.equal(wrongName.endpoints[1].active.state, 'untrusted', 'A trusted certificate with the wrong IP SAN must fail.');
  } finally { await new Promise(resolve => wrongNameServer.close(resolve)); }
  process.env.METRICS_PORT = String(metricsServer.address().port);
  process.env.NODE_EXTRA_CA_CERTS = fixture.ca;

  process.env.DASHBOARD_TLS_CERT_FILE = fixture.expiredCert;
  const stale = await uiTlsStatus(activeDashboardCertificate);
  assert.equal(stale.endpoints[0].file.state, 'expired');
  assert.equal(stale.endpoints[0].active.state, 'observed');
  assert.equal(stale.endpoints[0].activeMatchesFile, false, 'An on-disk replacement must not be reported as active.');

  process.env.DASHBOARD_TLS_CERT_FILE = fixture.cert;
  delete process.env.NODE_EXTRA_CA_CERTS;
  const withoutCa = await uiTlsStatus(activeDashboardCertificate);
  assert.equal(withoutCa.trustAnchor.state, 'not_configured');
  assert.equal(withoutCa.endpoints[0].active.state, 'observed');
  assert.equal(withoutCa.endpoints[1].active.state, 'not_checked');

  process.env.NODE_EXTRA_CA_CERTS = fixture.cert;
  const invalidCa = await uiTlsStatus(activeDashboardCertificate);
  assert.equal(invalidCa.trustAnchor.state, 'invalid', 'A server leaf certificate must not be presented as a CA.');
  assert.equal(invalidCa.endpoints[1].active.state, 'not_checked');

  process.env.NODE_EXTRA_CA_CERTS = fixture.ca;
  process.env.METRICS_TLS_CERT_FILE = `${fixture.cert}.missing`;
  const missingPeerFile = await uiTlsStatus(activeDashboardCertificate);
  assert.equal(missingPeerFile.endpoints[1].file.state, 'missing');
  assert.equal(missingPeerFile.endpoints[0].active.state, 'observed', 'Peer file failures must not break dashboard status.');
  console.log('Read-only TLS deployment status and absence handling passed.');
} finally {
  await new Promise(resolve => metricsServer.close(resolve));
  if (previousMetricsPort === undefined) delete process.env.METRICS_PORT;
  else process.env.METRICS_PORT = previousMetricsPort;
  await fixture.cleanup();
}
