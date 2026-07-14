import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { auditTrailFromEnvironment, EnterpriseAuditTrail } from '../src/audit_trail.js';

const TOKEN = 'audit-token-0123456789abcdef0123456789abcdef';
const testDirectory = await mkdtemp(path.join(os.tmpdir(), 'forwarder-audit-test-'));
const received = [];
let gatewayStatus = 204;
const gateway = http.createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  received.push({ authorization: request.headers.authorization, body: JSON.parse(body) });
  response.writeHead(gatewayStatus).end();
});

try {
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  const address = gateway.address();
  assert.ok(address && typeof address === 'object');
  const filePath = path.join(testDirectory, 'audit.jsonl');
  const trail = new EnterpriseAuditTrail({
    filePath,
    remoteUrl: `http://127.0.0.1:${address.port}/audit`,
    bearerToken: TOKEN,
    remoteRequired: true,
    allowHttpLoopback: true
  });
  await trail.initialize();
  await Promise.all([
    trail.record({ phase: 'authorized', action: 'dashboard.mutation', requestId: 'request-1', actorId: 'token:one', actorRole: 'admin', method: 'POST', path: '/api/control' }),
    trail.record({ phase: 'completed', action: 'dashboard.mutation', requestId: 'request-1', actorId: 'token:one', actorRole: 'admin', method: 'POST', path: '/api/control', statusCode: 200 })
  ]);
  assert.equal(received.length, 2);
  assert.ok(received.every(record => record.authorization === `Bearer ${TOKEN}`));
  const records = (await readFile(filePath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 2);
  assert.equal(records[1].previousHash, records[0].hash, 'Audit records must form a hash chain.');
  assert.deepEqual(trail.snapshot(), {
    healthy: true,
    remoteRequired: true,
    lastRemoteSuccessAt: trail.snapshot().lastRemoteSuccessAt,
    recordCount: 2
  });
  assert.ok(trail.snapshot().lastRemoteSuccessAt > 0);

  await writeFile(filePath, `${JSON.stringify({ ...records[0], event: { ...records[0].event, path: '/tampered' } })}\n`, 'utf8');
  const tampered = new EnterpriseAuditTrail({ filePath, remoteRequired: false });
  await assert.rejects(tampered.initialize(), /Audit chain verification failed/);

  gatewayStatus = 503;
  const failing = new EnterpriseAuditTrail({
    filePath: path.join(testDirectory, 'failing.jsonl'),
    remoteUrl: `http://127.0.0.1:${address.port}/audit`,
    bearerToken: TOKEN,
    remoteRequired: true,
    allowHttpLoopback: true
  });
  await failing.initialize();
  await assert.rejects(failing.record({ phase: 'startup', action: 'service.startup', actorRole: 'system' }), /HTTP 503/);
  assert.equal(failing.snapshot().healthy, false);
  gatewayStatus = 204;
  assert.equal(await failing.replayRemote(), 1, 'Replay must resend the locally durable gap idempotently.');
  assert.equal(failing.snapshot().healthy, true);

  assert.throws(() => new EnterpriseAuditTrail({
    filePath: path.join(testDirectory, 'missing-remote.jsonl'),
    remoteRequired: true
  }), /requires AUDIT_WEBHOOK_URL/);

  const savedEnvironment = process.env;
  process.env = { ENTERPRISE_MODE: 'false', AUDIT_LOG_PATH: path.join(testDirectory, 'standalone.jsonl') };
  assert.equal(auditTrailFromEnvironment().snapshot().remoteRequired, false);
  process.env = { ENTERPRISE_MODE: 'true', AUDIT_LOG_PATH: path.join(testDirectory, 'enterprise.jsonl') };
  assert.throws(() => auditTrailFromEnvironment(), /requires AUDIT_WEBHOOK_URL/);
  process.env = savedEnvironment;

  console.log('Enterprise audit trail tests passed.');
} finally {
  gateway.close();
  await rm(testDirectory, { recursive: true, force: true });
}
