import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateNpmDependencyPolicy, evaluatePythonHashLock } from '../scripts/check_dependency_policy.js';

const manifest = { dependencies: { fixture: '1.2.3' } };
const artifact = { version: '1.2.3', integrity: 'sha512-fixture', resolved: 'https://registry.npmjs.org/fixture/-/fixture-1.2.3.tgz' };
function npmLock(metadata) {
  return { packages: { '': manifest, 'node_modules/fixture': metadata } };
}
assert.deepEqual(evaluateNpmDependencyPolicy('fixture', manifest, npmLock(artifact)), []);
assert.deepEqual(evaluateNpmDependencyPolicy('fixture', manifest, npmLock(null)), [
  'fixture: fixture@1.2.3 is not the exact locked artifact',
  'fixture: node_modules/fixture has invalid artifact metadata',
], 'Null metadata must return blocking policy violations rather than throwing while inspecting link metadata.');
assert.deepEqual(evaluateNpmDependencyPolicy('fixture', manifest, npmLock({ ...artifact, version: '1.2.4' })),
  ['fixture: fixture@1.2.3 is not the exact locked artifact']);
assert.deepEqual(evaluateNpmDependencyPolicy('fixture', manifest, npmLock({ version: '1.2.3', resolved: 'https://outside.example.test/fixture.tgz' })), [
  'fixture: node_modules/fixture has no sha512 lock integrity',
  'fixture: node_modules/fixture resolves outside the npm registry',
]);
assert.deepEqual(evaluateNpmDependencyPolicy('fixture', {}, { packages: { 'node_modules/linked': { link: true } } }), []);

const [direct, locked] = await Promise.all([
  readFile(new URL('../exchange_executor/requirements.in', import.meta.url), 'utf8'),
  readFile(new URL('../exchange_executor/requirements.lock', import.meta.url), 'utf8'),
]);
assert.deepEqual(evaluatePythonHashLock(direct, locked), []);
assert.deepEqual(evaluatePythonHashLock('fixture>=1.2.3', locked), [
  'python direct dependency is not exact: fixture>=1.2.3',
  'python lock is missing direct dependency fixture>=1.2.3',
]);
assert.deepEqual(evaluatePythonHashLock(direct, locked.replace('--universal ', '')),
  ['python lock must be generated universally for Python 3.12']);
assert.deepEqual(evaluatePythonHashLock(direct, `${locked}
fixture==1.2.3 \\
    # missing artifact hash
`), ['python lock artifact has no sha256 hash: fixture==1.2.3']);

console.log('Dependency policy: exact artifacts, malformed metadata, registry origin, universal generation and complete hashes passed.');
