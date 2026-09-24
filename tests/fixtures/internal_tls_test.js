import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

const generator = fileURLToPath(new URL('./internal_tls_fixture.py', import.meta.url));
const listenerPrefixes = ['DASHBOARD', 'METRICS', 'ALERT_RELAY', 'TELEGRAM_VIEWER', 'EXECUTOR'];

async function removeTlsFixture(directory) {
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir())
    || !path.basename(resolved).startsWith('tsx-internal-tls-test-')) {
    throw new Error('Refusing to remove a TLS fixture outside its dedicated temporary directory.');
  }
  await rm(resolved, { recursive: true, force: true });
}

export async function setupInternalTlsTest() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-internal-tls-test-'));
  const python = process.env.TSX_TEST_PYTHON || 'python';
  const result = spawnSync(python, [generator, directory], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) {
    await removeTlsFixture(directory);
    throw new Error(`Cannot generate temporary TLS fixture: ${result.stderr || result.error?.message || result.status}`);
  }
  const files = JSON.parse(result.stdout);
  const previousCertificates = tls.getCACertificates('default');
  const previousEnvironment = new Map();
  const updates = { NODE_EXTRA_CA_CERTS: files.ca };
  for (const prefix of listenerPrefixes) {
    updates[`${prefix}_TLS_CERT_FILE`] = files.cert;
    updates[`${prefix}_TLS_KEY_FILE`] = files.key;
  }
  for (const [name, value] of Object.entries(updates)) {
    previousEnvironment.set(name, process.env[name]);
    process.env[name] = value;
  }
  tls.setDefaultCACertificates([...previousCertificates, readFileSync(files.ca, 'utf8')]);
  return {
    ...files,
    async cleanup() {
      tls.setDefaultCACertificates(previousCertificates);
      for (const [name, value] of previousEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await removeTlsFixture(directory);
    },
  };
}
