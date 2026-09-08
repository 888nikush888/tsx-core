import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyzeFrontend, frontendDependencies } from '../scripts/check_frontend_reachability.js';

assert.deepEqual(frontendDependencies(`
  import React from 'react';
  export { item } from './item';
  const lazy = import('./lazy');
  const worker = new URL('./worker.ts', import.meta.url);
  const network = new URL('https://example.invalid/script.js');
  const rootAsset = new URL('/image.png', window.location.origin);
  // import 'not-a-dependency';
  const text = "from 'not-a-package'";
`), ['react', './item', './lazy', './worker.ts']);
assert.deepEqual(frontendDependencies("import 'https://example.invalid/module.js';"),
  ['https://example.invalid/module.js'], 'A real external module import must still be checked by dependency policy.');

const result = await analyzeFrontend();
assert.equal(result.reachable.size, result.files.length + result.sharedFiles.length);
assert.ok(result.files.every(file => result.reachable.has(file)), 'Every frontend module remains reachable.');
assert.ok(result.sharedFiles.every(file => result.reachable.has(file)), 'Shared contracts are included in the inspected graph.');
assert.deepEqual(result.violations, []);
assert.ok(result.usedPackages.has('react'));

const analyticsUtility = await readFile('frontend/src/utils/analytics.ts', 'utf8');
assert.doesNotMatch(
  analyticsUtility,
  /\bconsole\.log\s*\(/,
  'Production frontend utilities must not emit informational console logs.',
);

console.log('Frontend reachability and dependency tests passed.');
