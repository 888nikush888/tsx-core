import assert from 'node:assert/strict';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { internalTlsServerOptions } from '../src/internal_tls.js';
import { setupInternalTlsTest } from './fixtures/internal_tls_test.js';

const fixture = await setupInternalTlsTest();
let server = null;
try {
  assert.throws(() => internalTlsServerOptions('UNSUPPORTED_TLS_FILE', 'DASHBOARD_TLS_KEY_FILE'),
    /Unsupported internal TLS file name/);
  const options = internalTlsServerOptions('DASHBOARD_TLS_CERT_FILE', 'DASHBOARD_TLS_KEY_FILE');
  assert.equal(options.minVersion, 'TLSv1.2');
  server = https.createServer(options, (_request, response) => response.end('healthy'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const secure = await fetch(`https://127.0.0.1:${port}/healthz`, { redirect: 'error' });
  assert.equal(secure.status, 200);
  assert.equal(await secure.text(), 'healthy');
  await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`),
    'The HTTPS listener must not accept plaintext requests.');

  process.env.DASHBOARD_TLS_KEY_FILE = fixture.otherKey;
  assert.throws(() => internalTlsServerOptions('DASHBOARD_TLS_CERT_FILE', 'DASHBOARD_TLS_KEY_FILE'),
    /do not match/);
  process.env.DASHBOARD_TLS_KEY_FILE = fixture.key;
  const oversized = path.join(path.dirname(fixture.cert), 'oversized.pem');
  writeFileSync(oversized, Buffer.alloc(65 * 1024));
  process.env.DASHBOARD_TLS_CERT_FILE = oversized;
  assert.throws(() => internalTlsServerOptions('DASHBOARD_TLS_CERT_FILE', 'DASHBOARD_TLS_KEY_FILE'),
    /regular, bounded TLS file/);
  process.env.DASHBOARD_TLS_CERT_FILE = fixture.expiredCert;
  assert.throws(() => internalTlsServerOptions('DASHBOARD_TLS_CERT_FILE', 'DASHBOARD_TLS_KEY_FILE'),
    /not currently valid/);
  delete process.env.DASHBOARD_TLS_CERT_FILE;
  assert.throws(() => internalTlsServerOptions('DASHBOARD_TLS_CERT_FILE', 'DASHBOARD_TLS_KEY_FILE'),
    /absolute TLS file/);
  console.log('Internal TLS trust, cleartext refusal and fail-closed certificate checks passed.');
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await fixture.cleanup();
}
