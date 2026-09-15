import assert from 'node:assert/strict';
import { validateReleaseArtifacts } from '../scripts/check_release_artifacts.js';

const valid = {
  manifest: { version: '1.2.3', license: 'MIT' },
  changelog: '## [1.2.3] - 2026-07-13\n',
  license: 'MIT License\nTHE SOFTWARE IS PROVIDED "AS IS"',
};
assert.deepEqual(validateReleaseArtifacts(valid), []);
assert.deepEqual(validateReleaseArtifacts({ ...valid, license: valid.license.replaceAll('\n', '\r\n') }), []);
assert.ok(
  validateReleaseArtifacts({ ...valid, manifest: { version: 'latest', license: 'MIT' } }).includes(
    'package version is not valid Semantic Versioning'
  )
);
assert.ok(
  validateReleaseArtifacts({ ...valid, changelog: '# Missing version' }).includes(
    'CHANGELOG has no dated section for 1.2.3'
  )
);

const alignedLock = { version: '1.2.3', packages: { '': { version: '1.2.3' } } };
assert.deepEqual(validateReleaseArtifacts({
  ...valid, frontendManifest: valid.manifest, backendLock: alignedLock, frontendLock: alignedLock,
}), []);
for (const lock of [{}, { version: '1.2.3' }, { ...alignedLock, version: '1.2.4' },
  { ...alignedLock, packages: { '': { version: '1.2.4' } } }]) {
  assert.deepEqual(validateReleaseArtifacts({ ...valid, backendLock: lock, frontendLock: lock }), [
    'backend lockfile version must match the release package version',
    'frontend lockfile version must match the release package version',
  ]);
}
assert.deepEqual(validateReleaseArtifacts({
  ...valid, manifest: { version: 'latest', license: 'unknown' }, changelog: '', license: '',
  frontendManifest: valid.manifest, backendLock: alignedLock, frontendLock: alignedLock,
}), [
  'package version is not valid Semantic Versioning',
  'package license must be MIT',
  'CHANGELOG has no dated section for latest',
  'LICENSE is not an MIT license text',
  'LICENSE is missing the MIT warranty disclaimer',
  'frontend package version must match the release package version',
  'backend lockfile version must match the release package version',
  'frontend lockfile version must match the release package version',
]);

console.log('Release artifact governance tests passed.');
