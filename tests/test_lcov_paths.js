import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeLcov } from '../scripts/normalize_lcov_paths.js';

const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'lcov-paths-'));
try {
  const sourceRoot = path.join(repositoryRoot, 'frontend');
  await mkdir(path.join(sourceRoot, 'src'), { recursive: true });
  await writeFile(path.join(sourceRoot, 'src', 'app.tsx'), 'export const app = 1;');
  const record = 'TN:\r\nSF:src/app.tsx\r\nDA:1,1\r\nLF:1\r\nLH:1\r\nend_of_record\r\n';
  const normalized = await normalizeLcov(record, { repositoryRoot, sourceRoot });
  assert.equal(normalized, record.replaceAll('\r\n', '\n').replace('SF:src/', 'SF:frontend/src/'));
  const absolute = record.replace('src/app.tsx', path.join(sourceRoot, 'src', 'app.tsx'));
  assert.equal(await normalizeLcov(absolute, { repositoryRoot, sourceRoot }), normalized);
  const windowsSeparators = record.replace('src/app.tsx', 'src\\app.tsx');
  assert.equal(await normalizeLcov(windowsSeparators, { repositoryRoot, sourceRoot }), normalized);
  for (const invalid of ['TN:\n', 'SF:\n', 'SF:../../outside.ts\n', 'SF:src/missing.ts\n', 'SF:src\n']) {
    await assert.rejects(normalizeLcov(invalid, { repositoryRoot, sourceRoot }));
  }
  const coverageConfig = await readFile('.coveragerc', 'utf8');
  assert.match(coverageConfig, /source = exchange_executor/u);
  assert.match(coverageConfig, /\*\/tests\/\*/u);
  assert.match(coverageConfig, /\*\/test_\*\.py/u);
  assert.match(coverageConfig, /fail_under = 60/u);
  const workflow = await readFile('.github/workflows/quality.yml', 'utf8');
  assert.equal(workflow.match(/unittest discover -s exchange_executor\/tests -v/gu).length, 2);
  assert.match(workflow, /node scripts\/normalize_lcov_paths\.js/u);
  assert.match(workflow, /pull_request:\s+branches: \[main\]/u);
  assert.doesNotMatch(workflow, /pull_request_target/u);
  assert.match(workflow, /TRUSTED_SOURCE:/u);
  assert.match(workflow, /SONAR_EXPECTED_REVISION: \$\{\{ github.event.pull_request.head.sha \|\| github.sha \}\}/u);
} finally {
  await rm(repositoryRoot, { recursive: true, force: true });
}
console.log('Coverage scope and LCOV path tests passed.');
