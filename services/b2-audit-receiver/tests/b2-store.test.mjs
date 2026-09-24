import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { B2AuditStore, b2ClientFromEnvironment } from '../b2-store.mjs';
import { AuditConflictError } from '../audit-core.mjs';

const NOW = Date.parse('2026-09-24T00:00:00.000Z');
const BUCKET = 'tsx-private-audit';
const KEY = 'source-1/v1/0000000000000001.json';

function recordBody(action = 'test') {
  const unsigned = {
    schemaVersion: 1,
    sequence: 1,
    timestamp: '2026-09-24T00:00:00.000Z',
    previousHash: '0'.repeat(64),
    event: { phase: 'authorized', action }
  };
  return { record: { ...unsigned, hash: createHash('sha256').update(JSON.stringify(unsigned)).digest('hex') }, body: Buffer.from(JSON.stringify({ ...unsigned, hash: createHash('sha256').update(JSON.stringify(unsigned)).digest('hex') })) };
}

function mockB2() {
  const objects = [];
  const calls = [];
  let mode = 'COMPLIANCE';
  let failPut = false;
  const client = {
    async send(command) {
      calls.push(command);
      const name = command.constructor.name;
      const input = command.input;
      assert.equal(input.Bucket, BUCKET);
      assert.equal(input.Key ?? input.Prefix, KEY);
      if (name === 'ListObjectVersionsCommand') return {
        Versions: objects.map(object => ({ Key: KEY, VersionId: object.versionId })),
        IsTruncated: false
      };
      if (name === 'PutObjectCommand') {
        if (failPut) throw new Error('conditional put unsupported');
        assert.equal(input.IfNoneMatch, '*');
        assert.equal(input.ObjectLockMode, 'COMPLIANCE');
        const versionId = `version-${objects.length + 1}`;
        objects.push({ versionId, body: Buffer.from(input.Body), until: input.ObjectLockRetainUntilDate });
        return { VersionId: versionId };
      }
      const object = objects.find(entry => entry.versionId === input.VersionId);
      if (!object) throw new Error('version missing');
      if (name === 'GetObjectRetentionCommand') return {
        Retention: { Mode: mode, RetainUntilDate: object.until }
      };
      if (name === 'GetObjectCommand') return {
        VersionId: object.versionId,
        Body: Readable.from([object.body])
      };
      throw new Error(`Unexpected ${name}`);
    }
  };
  return { client, objects, calls, setMode: value => { mode = value; }, rejectPut: () => { failPut = true; } };
}

function store(mock) {
  return new B2AuditStore({ client: mock.client, bucket: BUCKET, sourceId: 'source-1', now: () => NOW });
}

test('writes once, verifies exact B2 version bytes and COMPLIANCE retention, replays without a new version', async () => {
  const mock = mockB2();
  const { record, body } = recordBody();
  assert.equal(await store(mock).persist(record, body), 'stored');
  assert.equal(mock.objects.length, 1);
  assert.equal(mock.objects[0].until.getTime() >= NOW + 90 * 86400000, true);
  assert.equal(await store(mock).persist(record, body), 'replayed');
  assert.equal(mock.objects.length, 1);
  assert.equal(mock.calls.filter(call => call.constructor.name === 'PutObjectCommand').length, 1);
});

test('same sequence with different bytes fails; existing version is not overwritten', async () => {
  const mock = mockB2();
  const first = recordBody('first');
  const conflict = recordBody('different');
  await store(mock).persist(first.record, first.body);
  await assert.rejects(store(mock).persist(conflict.record, conflict.body), AuditConflictError);
  assert.equal(mock.objects.length, 1);
});

test('weak retention, extra versions and unsupported conditional upload fail closed', async () => {
  const mock = mockB2();
  const { record, body } = recordBody();
  await store(mock).persist(record, body);
  mock.setMode('GOVERNANCE');
  await assert.rejects(store(mock).persist(record, body), /COMPLIANCE/);
  mock.setMode('COMPLIANCE');
  mock.objects.push({ ...mock.objects[0], versionId: 'version-2' });
  await assert.rejects(store(mock).persist(record, body), /multiple/);
  const fresh = mockB2();
  fresh.rejectPut();
  await assert.rejects(store(fresh).persist(record, body), /conditional put unsupported/);
});

test('requires a fixed HTTPS Backblaze endpoint and dedicated credentials', () => {
  const env = { B2_AUDIT_REGION: 'us-east-005', B2_AUDIT_ENDPOINT: 'https://s3.us-east-005.backblazeb2.com', B2_AUDIT_KEY_ID: 'id', B2_AUDIT_APPLICATION_KEY: 'secret' };
  assert.ok(b2ClientFromEnvironment(env));
  assert.throws(() => b2ClientFromEnvironment({ ...env, B2_AUDIT_ENDPOINT: 'http://127.0.0.1' }), /endpoint/);
  assert.throws(() => b2ClientFromEnvironment({ ...env, B2_AUDIT_APPLICATION_KEY: '' }), /credentials/);
});
