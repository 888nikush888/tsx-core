import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { B2AuditStore, b2ClientFromEnvironment } from '../b2-store.mjs';
import { AuditConflictError } from '../audit-core.mjs';

const NOW = Date.parse('2026-09-24T00:00:00.000Z');
const BUCKET = 'tsx-private-audit';
const KEY = 'source-1/v1/0000000000000001.json';

function recordBody(action = 'test', sequence = 1, previousHash = '0'.repeat(64)) {
  const unsigned = {
    schemaVersion: 1,
    sequence,
    timestamp: '2026-09-24T00:00:00.000Z',
    previousHash,
    event: { phase: 'authorized', action }
  };
  return { record: { ...unsigned, hash: createHash('sha256').update(JSON.stringify(unsigned)).digest('hex') }, body: Buffer.from(JSON.stringify({ ...unsigned, hash: createHash('sha256').update(JSON.stringify(unsigned)).digest('hex') })) };
}

function mockB2() {
  const objects = [];
  const calls = [];
  let mode = 'COMPLIANCE';
  let failPut = false;
  let lostResponse = false;
  let beforePut = null;
  let beforeRead = null;
  const client = {
    async send(command) {
      calls.push(command);
      const name = command.constructor.name;
      const input = command.input;
      assert.equal(input.Bucket, BUCKET);
      if (name === 'ListObjectVersionsCommand') return {
        Versions: objects.filter(object => object.key === input.Prefix)
          .map(object => ({ Key: object.key, VersionId: object.versionId, LastModified: object.createdAt })),
        IsTruncated: false
      };
      if (name === 'PutObjectCommand') {
        beforePut?.(input, objects);
        if (failPut) throw new Error('conditional put unsupported');
        assert.equal(input.IfNoneMatch, '*');
        assert.equal(input.ObjectLockMode, 'COMPLIANCE');
        if (objects.some(object => object.key === input.Key)) {
          const error = new Error('Precondition Failed');
          error.$metadata = { httpStatusCode: 412 };
          throw error;
        }
        const versionId = `version-${objects.length + 1}`;
        objects.push({ key: input.Key, versionId, body: Buffer.from(input.Body), until: input.ObjectLockRetainUntilDate, createdAt: new Date(NOW) });
        if (lostResponse) throw new Error('response lost after storage');
        return { VersionId: versionId };
      }
      const object = objects.find(entry => entry.key === input.Key && entry.versionId === input.VersionId);
      if (!object) throw new Error('version missing');
      if (name === 'GetObjectRetentionCommand') return {
        Retention: { Mode: mode, RetainUntilDate: object.until }
      };
      if (name === 'GetObjectCommand') return {
        VersionId: object.versionId,
        Body: Readable.from((async function* () { beforeRead?.(); yield object.body; })())
      };
      throw new Error(`Unexpected ${name}`);
    }
  };
  return { client, objects, calls, setMode: value => { mode = value; }, rejectPut: () => { failPut = true; },
    loseResponse: () => { lostResponse = true; }, beforePut: callback => { beforePut = callback; },
    beforeRead: callback => { beforeRead = callback; } };
}

function store(mock, now = () => NOW, retentionDays = 90) {
  return new B2AuditStore({ client: mock.client, bucket: BUCKET, sourceId: 'source-1', now, retentionDays });
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

test('rejects sequence gaps and a predecessor hash mismatch before writing', async () => {
  const mock = mockB2();
  const first = recordBody();
  const second = recordBody('next', 2, first.record.hash);
  await assert.rejects(store(mock).persist(second.record, second.body), /predecessor is missing/);
  assert.equal(mock.objects.length, 0);
  await store(mock).persist(first.record, first.body);
  assert.equal(await store(mock).persist(second.record, second.body), 'stored');
  const wrong = recordBody('wrong', 3, 'f'.repeat(64));
  await assert.rejects(store(mock).persist(wrong.record, wrong.body), AuditConflictError);
  assert.equal(mock.objects.length, 2);
});

test('replays a 61-day-old still-locked record and rejects weak original retention', async () => {
  const mock = mockB2();
  const { record, body } = recordBody();
  await store(mock).persist(record, body);
  assert.equal(await store(mock, () => NOW + 61 * 86400000).persist(record, body), 'replayed');
  mock.objects[0].until = new Date(NOW + 29 * 86400000);
  await assert.rejects(store(mock).persist(record, body), /insufficient COMPLIANCE retention/);
});

test('new records require at least 30 days of protection after verification', async () => {
  const mock = mockB2();
  let clock = NOW;
  const candidate = store(mock, () => { const value = clock; clock += 10; return value; }, 31);
  const { record, body } = recordBody();
  assert.equal(await candidate.persist(record, body), 'stored');
  assert.equal(mock.objects[0].until.getTime() >= clock + 30 * 86400000, true);
  assert.throws(() => store(mock, () => NOW, 30), /31 and 3000/);
});

test('slow read-back cannot turn a stale lock into a fresh 30-day receipt', async () => {
  const mock = mockB2();
  let clock = NOW;
  mock.beforeRead(() => { clock = NOW + 2 * 86400000; });
  const { record, body } = recordBody();
  await assert.rejects(store(mock, () => clock, 31).persist(record, body), /insufficient COMPLIANCE retention/);
});

test('lost upload response and atomic conditional race reconcile only a verified single version', async () => {
  const first = recordBody();
  const lost = mockB2();
  lost.loseResponse();
  assert.equal(await store(lost).persist(first.record, first.body), 'replayed');
  assert.equal(lost.objects.length, 1);
  const race = mockB2();
  race.beforePut((input, objects) => {
    objects.push({ key: input.Key, versionId: 'winner', body: Buffer.from(first.body),
      until: new Date(NOW + 90 * 86400000), createdAt: new Date(NOW) });
  });
  assert.equal(await store(race).persist(first.record, first.body), 'replayed');
  assert.equal(race.objects.length, 1);
  const conflict = mockB2();
  conflict.beforePut((input, objects) => {
    objects.push({ key: input.Key, versionId: 'winner', body: recordBody('other').body,
      until: new Date(NOW + 90 * 86400000), createdAt: new Date(NOW) });
  });
  await assert.rejects(store(conflict).persist(first.record, first.body), AuditConflictError);
});

test('requires a fixed HTTPS Backblaze endpoint and dedicated credentials', () => {
  const env = { B2_AUDIT_REGION: 'us-east-005', B2_AUDIT_ENDPOINT: 'https://s3.us-east-005.backblazeb2.com', B2_AUDIT_KEY_ID: 'id', B2_AUDIT_APPLICATION_KEY: 'secret' };
  assert.ok(b2ClientFromEnvironment(env));
  assert.throws(() => b2ClientFromEnvironment({ ...env, B2_AUDIT_ENDPOINT: 'http://127.0.0.1' }), /endpoint/);
  assert.throws(() => b2ClientFromEnvironment({ ...env, B2_AUDIT_APPLICATION_KEY: '' }), /credentials/);
});
