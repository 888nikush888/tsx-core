import assert from 'node:assert/strict';
import { analyzeArchitecture, architectureLayerViolations, findCycle } from '../scripts/check_architecture.js';

assert.equal(findCycle(new Map()), undefined);
assert.equal(findCycle(new Map([
  ['a', ['b', 'c']], ['b', ['d']], ['c', ['d']], ['d', []],
])), undefined, 'Shared dependencies are not cycles.');
assert.deepEqual(findCycle(new Map([
  ['a', ['b']], ['b', ['c']], ['c', ['b']],
])), ['b', 'c', 'b'], 'A cycle reports the repeated active path only.');
assert.deepEqual(findCycle(new Map([['a', ['a']]])), ['a', 'a']);
assert.equal(findCycle(new Map([['a', ['unlisted']]])), undefined);
assert.deepEqual(architectureLayerViolations(new Map([
  ['db.ts', ['forwarder.ts', 'queue.ts']], ['queue.ts', ['web_server.ts']],
])), [
  'db.ts must not import entry point forwarder.ts',
  'core module db.ts must not import outer module forwarder.ts',
  'db.ts must not import internal module forwarder.ts',
  'db.ts must not import internal module queue.ts',
  'core module queue.ts must not import outer module web_server.ts',
]);
assert.deepEqual(architectureLayerViolations(new Map([
  ['forwarder.ts', ['mcp_server.ts', 'queue.ts']], ['queue.ts', ['trading_decimal.ts']],
])), []);

const { graph, violations } = await analyzeArchitecture();
assert.ok(graph.has('forwarder.ts'));
assert.ok(graph.has('db.ts'));
assert.deepEqual(violations, []);

console.log('Architecture fitness tests passed.');
