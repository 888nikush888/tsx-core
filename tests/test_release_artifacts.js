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

console.log('Release artifact governance tests passed.');
