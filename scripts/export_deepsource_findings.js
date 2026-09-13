import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Documented schema: https://docs.deepsource.com/docs/developers/api/repository
// Occurrence fields: https://docs.deepsource.com/docs/developers/api/check
const QUERY = `query ExportOccurrences($login: String!, $name: String!, $after: String) {
  repository(login: $login, name: $name, vcsProvider: GITHUB) {
    id name defaultBranch latestCommitOid isActivated
    issueOccurrences(first: 100, after: $after) {
      totalCount pageInfo { hasNextPage endCursor }
      edges { node {
        id path title beginLine beginColumn endLine endColumn
        issue { id shortcode title category severity analyzer { shortcode } }
      } }
    }
  }
}`;

class ExportError extends Error {}
function fail(message) { throw new ExportError(message); }
function nonempty(value) { return typeof value === 'string' && value.trim().length > 0; }

async function requestPage(fetchImpl, token, variables) {
  let response = null;
  try {
    response = await fetchImpl('https://api.deepsource.com/graphql/', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: QUERY, variables }),
    });
  } catch { fail('DeepSource request failed; export is unverified.'); }
  if (!response.ok) fail(`DeepSource HTTP ${response.status}; export is unverified.`);
  let payload;
  try { payload = await response.json(); } catch { fail('DeepSource returned invalid JSON.'); }
  // Never print server error messages: they can echo request data or sensitive findings.
  if (!payload || (payload.errors !== undefined && (!Array.isArray(payload.errors) || payload.errors.length))) {
    fail('DeepSource returned GraphQL errors; export is unverified.');
  }
  return payload;
}

function repositoryIdentity(repository) {
  if (!repository?.isActivated || !nonempty(repository.id) || !nonempty(repository.name)
    || !nonempty(repository.defaultBranch) || !/^[a-f0-9]{40,64}$/i.test(repository.latestCommitOid ?? '')) {
    fail('DeepSource repository identity or revision is unavailable.');
  }
  return { id: repository.id, name: repository.name, defaultBranch: repository.defaultBranch,
    latestCommitOid: repository.latestCommitOid };
}

function validatePage(connection, expectedTotal) {
  if (!Number.isSafeInteger(connection?.totalCount) || connection.totalCount < 0
    || !Array.isArray(connection.edges) || typeof connection.pageInfo?.hasNextPage !== 'boolean') {
    fail('DeepSource returned an invalid occurrence page.');
  }
  if (expectedTotal !== undefined && connection.totalCount !== expectedTotal) {
    fail('DeepSource occurrence count changed during export.');
  }
  for (const edge of connection.edges) validateOccurrence(edge?.node);
}

function validateOccurrence(node) {
    if (!nonempty(node?.id) || !nonempty(node.path) || !nonempty(node.issue?.shortcode)
      || !Number.isSafeInteger(node.beginLine) || node.beginLine < 0) {
      fail('DeepSource returned an invalid occurrence.');
    }
}

function validateIdentity(current, previous, name, expectedRevision) {
  if (current.name !== name || (expectedRevision && current.latestCommitOid !== expectedRevision)
    || (previous && JSON.stringify(previous) !== JSON.stringify(current))) {
    fail('DeepSource repository revision changed or differs from the requested revision.');
  }
}

function appendOccurrences(connection, ids, occurrences) {
  for (const { node } of connection.edges) {
    if (ids.has(node.id)) fail('DeepSource returned duplicate occurrence IDs.');
    ids.add(node.id);
    occurrences.push(node);
  }
  if (ids.size > connection.totalCount) fail('DeepSource occurrence count exceeds the declared total.');
}

function nextCursor(connection, ids, cursors) {
  if (!connection.pageInfo.hasNextPage) {
    if (ids.size !== connection.totalCount) fail('DeepSource export is incomplete.');
    return null;
  }
  const cursor = connection.pageInfo.endCursor;
  if (!nonempty(cursor) || cursors.has(cursor) || connection.edges.length === 0 || ids.size >= connection.totalCount) {
    fail('DeepSource pagination cannot progress completely.');
  }
  cursors.add(cursor);
  return cursor;
}

/** Export documented default-branch static issue occurrences; does not claim SCA/AI coverage. */
export async function exportDeepSource({ token, login = '888nikush888', name = 'tsx-core',
  expectedRevision, fetchImpl = fetch }) {
  if (!nonempty(token)) fail('DEEPSOURCE_TOKEN or DEEPSOURCE_TOKEN_FILE is required.');
  if (!/^[A-Za-z0-9_.-]+$/.test(login) || !/^[A-Za-z0-9_.-]+$/.test(name)) fail('Invalid repository name.');
  if (expectedRevision !== undefined && !/^[a-f0-9]{40,64}$/i.test(expectedRevision)) fail('Invalid expected revision.');
  const pages = [], occurrences = [], ids = new Set(), cursors = new Set();
  let after = null, identity, total;
  for (;;) {
    const payload = await requestPage(fetchImpl, token, { login, name, after });
    const repository = payload.data?.repository;
    const currentIdentity = repositoryIdentity(repository);
    validateIdentity(currentIdentity, identity, name, expectedRevision);
    identity = currentIdentity;
    const connection = repository.issueOccurrences;
    validatePage(connection, total);
    total = connection.totalCount;
    appendOccurrences(connection, ids, occurrences);
    pages.push(payload);
    after = nextCursor(connection, ids, cursors);
    if (after === null) break;
  }
  // Re-read first page to detect revision/count changes across the final page boundary.
  const finalPayload = await requestPage(fetchImpl, token, { login, name, after: null });
  if (JSON.stringify(repositoryIdentity(finalPayload.data?.repository)) !== JSON.stringify(identity)) {
    fail('DeepSource repository revision changed during final verification.');
  }
  validatePage(finalPayload.data.repository.issueOccurrences, total);
  if (JSON.stringify(finalPayload.data.repository.issueOccurrences) !== JSON.stringify(pages[0].data.repository.issueOccurrences)) {
    fail('DeepSource first page changed during final verification.');
  }
  return { schemaVersion: 1, exportedAt: new Date().toISOString(), scope: 'default-branch-static-issue-occurrences',
    repository: { login, ...identity }, count: total, uniqueCount: ids.size, complete: true, occurrences, pages };
}

export async function main(environment = process.env) {
  let token = environment.DEEPSOURCE_TOKEN?.trim();
  if (!token && environment.DEEPSOURCE_TOKEN_FILE) {
    try { token = (await readFile(environment.DEEPSOURCE_TOKEN_FILE, 'utf8')).trim(); }
    catch { fail('Cannot read DEEPSOURCE_TOKEN_FILE.'); }
  }
  const result = await exportDeepSource({ token, login: environment.DEEPSOURCE_LOGIN || '888nikush888',
    name: environment.DEEPSOURCE_REPOSITORY || 'tsx-core', expectedRevision: environment.DEEPSOURCE_EXPECTED_REVISION });
  // Unique directories prevent a failed attempt from presenting a stale success as fresh.
  const directory = path.resolve('reports', 'deepsource', result.exportedAt.replaceAll(':', '-'));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'findings.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ complete: true, scope: result.scope, count: result.count,
    uniqueCount: result.uniqueCount, revision: result.repository.latestCommitOid, report: path.join(directory, 'findings.json') }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof ExportError ? error.message : 'DeepSource export failed; export is unverified.');
    process.exitCode = 1;
  });
}
