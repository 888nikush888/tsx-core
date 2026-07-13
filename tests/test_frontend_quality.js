import assert from 'node:assert/strict';
import { analyzeFrontend } from '../scripts/check_frontend_reachability.js';

const result = await analyzeFrontend();
assert.equal(result.reachable.size, result.files.length);
assert.deepEqual(result.violations, []);
assert.ok(result.usedPackages.has('react'));

console.log('Frontend reachability and dependency tests passed.');
