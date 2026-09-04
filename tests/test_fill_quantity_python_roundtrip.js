import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateOpenState } from '../src/exchange_contract_validation.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The Python fixture intercepts the actual pinned SDK transport and never loads credentials.
const result = spawnSync(process.env.TSX_TEST_PYTHON || 'python', ['-B', path.join(root, 'exchange_executor/tests/quantity_provenance_fixture.py')], {
  cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 512000, windowsHide: true,
  env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP,
    PYTHONNOUSERSITE: '1', PYTHONIOENCODING: 'utf-8' },
});
assert.ifError(result.error);
assert.equal(result.status, 0, result.stderr);
const cases = JSON.parse(result.stdout);
assert.deepEqual(cases.map(row => row.name), ['unit', 'quarter', 'large-short', 'fractional-short', 'rounded', 'sdk-token-rounded', 'parser-canonicalized-spelling']);
for (const { name, fill } of cases) {
  const state = validateOpenState({ orders: [], positions: [], fills: [fill], observedAt: Date.now(), accountFingerprint: 'a'.repeat(64) });
  assert.deepEqual(state.fills[0].quantityNormalization, fill.quantityNormalization, `${name}: real Python fields and both hashes survive Node validation unchanged.`);
  assert.equal(fill.quantityNormalization.market.providerOriginalStatus, 'not-retained');
  assert.equal(fill.quantityNormalization.market.observedAt, null);
}
assert.equal(cases.find(row => row.name === 'rounded').fill.quantityNormalization.arithmetic.exactProduct, false);
assert.equal(cases.find(row => row.name === 'sdk-token-rounded').fill.quantityNormalization.appliedFactor, '0.1');
console.log('Actual Python/CCXT -> Node quantity contracts passed for seven isolated fake-transport cases.');
