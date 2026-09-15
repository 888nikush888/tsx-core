import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportDeepSource } from '../scripts/export_deepsource_findings.js';

const revision = 'a'.repeat(40);
function page(ids, { total = 2, next = false, cursor = null, oid = revision } = {}) {
  return { data: { repository: { id: 'repo', name: 'tsx-core', isActivated: true,
    defaultBranch: 'main', latestCommitOid: oid, issueOccurrences: {
      totalCount: total, pageInfo: { hasNextPage: next, endCursor: cursor },
      edges: ids.map(id => ({ node: { id, path: 'src/example.ts', beginLine: 1, issue: { shortcode: 'JS-0001' } } })),
    } } } };
}
function fixture(responses) {
  const calls = [];
  return { calls, fetchImpl: async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    assert.ok(responses.length, 'Unexpected extra API call');
    return { ok: true, json: async () => responses.shift() };
  } };
}
test('exports every page and verifies revision/count again without exposing token', async () => {
  const first = page(['1'], { next: true, cursor: 'next' });
  const api = fixture([first, page(['2']), first]);
  const result = await exportDeepSource({ token: 'private-token', ...api, expectedRevision: revision });
  assert.equal(result.count, 2);
  assert.equal(result.uniqueCount, 2);
  assert.deepEqual(result.occurrences.map(item => item.id), ['1', '2']);
  assert.deepEqual(api.calls.map(call => call.body.variables.after), [null, 'next', null]);
  assert.equal(api.calls[0].options.redirect, 'error');
  assert.equal(JSON.stringify(result).includes('private-token'), false);
});
test('accepts a verified empty repository', async () => {
  const empty = page([], { total: 0 });
  assert.equal((await exportDeepSource({ token: 't', ...fixture([empty, empty]) })).count, 0);
});
for (const [name, responses, message] of [
  ['GraphQL partial failure', [{ data: {}, errors: [{ message: 'private-token' }] }], /GraphQL errors/],
  ['missing next cursor', [page(['1'], { next: true })], /pagination/],
  ['early end', [page(['1'])], /incomplete/],
  ['duplicate identity', [page(['1', '1'])], /duplicate/],
  ['total changes', [page(['1'], { next: true, cursor: 'n' }), page(['2'], { total: 3 })], /count changed/],
  ['revision changes', [page(['1'], { next: true, cursor: 'n' }), page(['2'], { oid: 'b'.repeat(40) })], /revision/],
  ['repeated cursor', [page(['1'], { total: 3, next: true, cursor: 'n' }), page(['2'], { total: 3, next: true, cursor: 'n' })], /pagination/],
  ['final verification changes', [page(['1', '2']), page(['1', '3'])], /first page changed/],
]) {
  test(`fails closed on ${name}`, async () => {
    await assert.rejects(exportDeepSource({ token: 'private-token', ...fixture(responses) }), message);
  });
}
test('HTTP errors never expose the response body', async () => {
  await assert.rejects(exportDeepSource({ token: 't', fetchImpl: async () => ({ ok: false, status: 401 }) }), /HTTP 401/);
});
test('network exceptions never expose authentication data', async () => {
  await assert.rejects(exportDeepSource({ token: 't', fetchImpl: async () => { throw new Error('secret'); } }),
    error => error.message === 'DeepSource request failed; export is unverified.');
});
