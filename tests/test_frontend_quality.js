import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyzeFrontend } from '../scripts/check_frontend_reachability.js';

const result = await analyzeFrontend();
assert.equal(result.reachable.size, result.files.length);
assert.deepEqual(result.violations, []);
assert.ok(result.usedPackages.has('react'));

const analyticsUtility = await readFile('frontend/src/utils/analytics.ts', 'utf8');
assert.doesNotMatch(
  analyticsUtility,
  /\bconsole\.log\s*\(/,
  'Production frontend utilities must not emit informational console logs.',
);

console.log('Frontend reachability and dependency tests passed.');
