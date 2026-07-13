import assert from 'node:assert/strict';
import { analyzeArchitecture } from '../scripts/check_architecture.js';

const { graph, violations } = await analyzeArchitecture();
assert.ok(graph.has('forwarder.ts'));
assert.ok(graph.has('db.ts'));
assert.deepEqual(violations, []);

console.log('Architecture fitness tests passed.');
