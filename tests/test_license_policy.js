import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateNpmLicenses, evaluatePythonLockedRequirements } from '../scripts/check_licenses.js';

function npmFixture(metadata) {
  return { lockfileVersion: 3, packages: { 'node_modules/fixture': metadata } };
}

assert.deepEqual(evaluateNpmLicenses('fixture', null), {
  violations: ['fixture requires an npm lockfileVersion 3 package map'], inventory: [],
});
for (const packages of [[], 'invalid', 1, null]) {
  assert.deepEqual(evaluateNpmLicenses('fixture', { lockfileVersion: 3, packages }), {
    violations: ['fixture requires an npm lockfileVersion 3 package map'], inventory: [],
  }, 'Malformed package maps must not be treated as an empty, accepted inventory.');
}
for (const metadata of [null, false, 'invalid']) {
  assert.deepEqual(evaluateNpmLicenses('fixture', npmFixture(metadata)), {
    violations: ['fixture: node_modules/fixture has invalid artifact metadata'], inventory: [],
  });
}
assert.deepEqual(evaluateNpmLicenses('fixture', npmFixture({ link: true })), { violations: [], inventory: [] });
assert.deepEqual(evaluateNpmLicenses('fixture', npmFixture({ version: '1.0.0', license: 'MIT' })).violations, []);
assert.deepEqual(evaluateNpmLicenses('fixture', npmFixture({ version: '1.0.0' })).violations,
  ['fixture: fixture@1.0.0 has no declared license']);
assert.deepEqual(evaluateNpmLicenses('fixture', npmFixture({ version: '1.0.0', license: 'CC-BY-4.0' })).violations,
  ['fixture: fixture@1.0.0 uses disallowed production license CC-BY-4.0']);
assert.deepEqual(evaluateNpmLicenses('fixture', npmFixture({ version: '1.0.0', license: 'CC-BY-4.0', dev: true })).violations, []);

const [direct, locked] = await Promise.all([
  readFile(new URL('../exchange_executor/requirements.in', import.meta.url), 'utf8'),
  readFile(new URL('../exchange_executor/requirements.lock', import.meta.url), 'utf8'),
]);
const original = evaluatePythonLockedRequirements(direct, locked);
assert.deepEqual(original.violations, [], 'The complete reviewed lock remains accepted.');
for (const version of ['1/2', '1:2', '1!2']) {
  const malformed = `${locked}
fixture==${version} \\
    --hash=sha256:${'a'.repeat(64)}
`;
  const result = evaluatePythonLockedRequirements(direct, malformed);
  assert.deepEqual(result.violations, [`python: locked requirement is not exactly pinned: fixture==${version}`],
    'Malformed lock entries must produce a blocking policy result instead of a null-match TypeError.');
  assert.deepEqual(result.inventory, original.inventory, 'Malformed entries cannot become accepted license evidence.');
}
const unreviewed = evaluatePythonLockedRequirements(direct, `${locked}
fixture==1.2.3 \\
    --hash=sha256:${'b'.repeat(64)}
`);
assert.deepEqual(unreviewed.violations, ['python: fixture@1.2.3 has no reviewed license policy entry']);
assert.equal(unreviewed.inventory.at(-1).license, null);

console.log('License policy: malformed metadata and lock versions fail closed; production/build and reviewed artifact boundaries passed.');
