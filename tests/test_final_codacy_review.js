import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { checkFinalCodacyReview, checkFinalCodacyInventories } from '../scripts/check_final_codacy_review.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const contents = new Map([
  ['src/example.ts', 'export const state = 1;\n'],
  ['tests/example.js', 'assert.equal(state, 1);\n'],
]);
const rationale = 'The source and its caller were semantically reviewed; hashes only detect later changes.';
const ledger = {
  schemaVersion: 1,
  counts: { total: 1, active: 1, ignored: 0 },
  ruleCounts: { example: { active: 1, ignored: 0 } },
  sources: [...contents.keys()].map(path => ({ path })),
  entries: [{
    issueId: 'reviewed-issue', providerStatus: 'active', rule: 'example', path: 'src/example.ts',
    baselineSourceSha256: hash(contents.get('src/example.ts')), rationale,
    disposition: 'false-positive-proposed', reviewedLocations: [{ line: 1 }],
    evidence: [{ path: 'tests/example.js', line: 1 }],
    finalSourceRenewal: 'reviewed-final-source', finalSourcePaths: [...contents.keys()],
    finalEvidence: [{ path: 'src/example.ts', line: 1, normalizedLineSha256: hash('export const state = 1;') }],
  }],
  finalReview: {
    status: 'complete',
    sources: [...contents].map(([path, text]) => ({ path, normalizedSha256: hash(text), semanticReview: rationale })),
  },
};
const verify = value => checkFinalCodacyReview(value, name => {
  assert.ok(contents.has(name), 'Only explicit fixture paths may be read.');
  return contents.get(name);
});
assert.equal(verify(ledger).ok, true);
assert.equal(checkFinalCodacyReview(ledger, name => contents.get(name).replaceAll('\n', '\r\n')).ok, true,
  'Checkout line-ending conversion must not imply semantic source drift.');

for (const name of contents.keys()) {
  const result = checkFinalCodacyReview(ledger, file => contents.get(file) + (file === name ? '// drift\n' : ''));
  assert.equal(result.ok, false);
  assert.ok(result.problems.includes(`Source drift requires semantic renewal: ${name}`));
}
const pending = structuredClone(ledger);
pending.entries[0].finalSourceRenewal = 'pending-final-working-tree-freeze';
assert.equal(verify(pending).ok, false, 'Matching bytes must not approve a pending semantic review.');
const missingContext = structuredClone(ledger);
missingContext.entries[0].finalSourcePaths.pop();
assert.equal(verify(missingContext).ok, false, 'Reviewed caller evidence cannot silently be dropped.');
const missingBinding = structuredClone(ledger);
missingBinding.finalReview.sources.pop();
assert.equal(verify(missingBinding).ok, false);
const badLocation = structuredClone(ledger);
badLocation.entries[0].finalEvidence[0].line = 2;
assert.equal(verify(badLocation).ok, false);
const missingLocation = structuredClone(ledger);
missingLocation.entries[0].finalEvidence = [];
assert.equal(verify(missingLocation).ok, false);
const duplicate = structuredClone(ledger);
duplicate.entries.push(structuredClone(duplicate.entries[0]));
assert.equal(verify(duplicate).ok, false);
const wrongCount = structuredClone(ledger);
wrongCount.ruleCounts.example.active = 0;
assert.equal(verify(wrongCount).ok, false);
const unsafePath = structuredClone(ledger);
unsafePath.finalReview.sources[0].path = '../outside';
assert.equal(verify(unsafePath).ok, false);
assert.equal(checkFinalCodacyReview({}, () => { throw new Error('Must not read an invalid ledger.'); }).ok, false);
assert.equal(verify({ ...ledger, entries: [null] }).ok, false);
const before = JSON.stringify(ledger);
verify(ledger);
assert.equal(JSON.stringify(ledger), before, 'Integrity checking never renews or mutates decisions.');
console.log('Codacy review integrity contracts passed.');

const historical = JSON.parse(readFileSync(new URL('../docs/testing/final-codacy-2026-09-17.json', import.meta.url), 'utf8'));
const supplement = JSON.parse(readFileSync(new URL('../docs/testing/final-codacy-pr73-2026-09-20.json', import.meta.url), 'utf8'));
assert.equal(checkFinalCodacyInventories(historical, supplement).ok, true);
const missingHistorical = structuredClone(historical);
const removedHistorical = missingHistorical.entries.pop();
missingHistorical.counts.total -= 1;
missingHistorical.counts[removedHistorical.providerStatus] -= 1;
missingHistorical.ruleCounts[removedHistorical.rule][removedHistorical.providerStatus] -= 1;
assert.equal(checkFinalCodacyInventories(missingHistorical, supplement).ok, false,
  'Self-consistent counts must not hide a missing historical finding.');
const missingNew = structuredClone(supplement);
missingNew.entries.pop();
assert.equal(checkFinalCodacyInventories(historical, missingNew).ok, false);
const overlapping = structuredClone(supplement);
overlapping.entries[0].issueId = historical.entries[0].issueId;
assert.equal(checkFinalCodacyInventories(historical, overlapping).ok, false);
const renamed = structuredClone(supplement);
renamed.entries[0].issueId = renamed.entries[0].issueId.toUpperCase();
assert.equal(checkFinalCodacyInventories(historical, renamed).ok, false, 'Issue identities are case-sensitive.');
assert.equal(checkFinalCodacyInventories(historical, undefined).ok, false);
console.log('Codacy retained historical and supplemental identity inventories passed.');
