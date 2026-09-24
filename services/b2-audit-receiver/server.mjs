import { readFile } from 'node:fs/promises';
import https from 'node:https';
import { createAuditReceiver } from './audit-core.mjs';
import { B2AuditStore, b2ClientFromEnvironment } from './b2-store.mjs';

function port(value) {
  const parsed = Number(value || 9445);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error('Audit port is invalid.');
  return parsed;
}

async function main() {
  const environment = process.env;
  const bearerToken = environment.AUDIT_RECEIVER_TOKEN;
  const certificatePath = environment.AUDIT_RECEIVER_TLS_CERT;
  const keyPath = environment.AUDIT_RECEIVER_TLS_KEY;
  if (!certificatePath || !keyPath) throw new Error('TLS certificate and key paths are required.');
  const [cert, key] = await Promise.all([readFile(certificatePath), readFile(keyPath)]);
  const client = b2ClientFromEnvironment(environment);
  const store = new B2AuditStore({
    client,
    bucket: environment.B2_AUDIT_BUCKET,
    sourceId: environment.B2_AUDIT_SOURCE_ID,
    retentionDays: Number(environment.B2_AUDIT_RETENTION_DAYS || 90)
  });
  const server = https.createServer({ cert, key }, createAuditReceiver({ bearerToken, store }));
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.maxRequestsPerSocket = 100;
  server.listen(port(environment.AUDIT_RECEIVER_PORT), environment.AUDIT_RECEIVER_HOST || '127.0.0.1', () => {
    process.stdout.write('B2 audit receiver listening over HTTPS.\n');
  });
}

main().catch(error => {
  process.stderr.write(`B2 audit receiver startup failed: ${error.message}\n`);
  process.exitCode = 1;
});
