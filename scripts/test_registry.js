import { readdirSync } from 'node:fs';

const TEST_NAME = /^test_[a-z0-9_]+\.js$/;

/** Full-suite preflight only: focused TDD runs may coexist with unfinished tests. */
export function assertTestRegistry(directory, registered) {
  if (!Array.isArray(registered) || registered.length === 0) throw new Error('A nonempty test registry is required.');
  const listed = new Set();
  for (const name of registered) {
    if (typeof name !== 'string' || !TEST_NAME.test(name)) throw new Error('Invalid registered test file name.');
    if (listed.has(name)) throw new Error(`Duplicate registered test: ${name}`);
    listed.add(name);
  }
  const discovered = new Set();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!/^test_.*\.js$/i.test(entry.name)) continue;
    if (!TEST_NAME.test(entry.name)) throw new Error(`Invalid discovered test file name: ${entry.name}`);
    if (!entry.isFile()) throw new Error(`Test is not a regular file: ${entry.name}`);
    discovered.add(entry.name);
  }
  const unregistered = [...discovered].filter(name => !listed.has(name)).sort();
  const missing = [...listed].filter(name => !discovered.has(name)).sort();
  if (unregistered.length || missing.length) {
    const reasons = [];
    if (unregistered.length) reasons.push(`Unregistered tests: ${unregistered.join(', ')}`);
    if (missing.length) reasons.push(`Missing registered test files: ${missing.join(', ')}`);
    throw new Error(reasons.join('\n'));
  }
}
