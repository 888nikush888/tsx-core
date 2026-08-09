import assert from 'node:assert/strict';
import { checkRiskAcceptances, validateRiskAcceptance } from '../scripts/check_risk_acceptances.js';

const validRecord = `---
id: RA-TEST
owner: service-owner
approver: security-owner
created: 2026-07-01
expires: 2026-07-20
scope: exact component
gate: example-gate
---
## Risk
Concrete failure scenario.
## Evidence
Exact test and scan evidence.
## Compensating controls
Named temporary control.
## Exit criteria
Measurable remediation condition.
`;

const now = new Date('2026-07-13T00:00:00Z');
assert.deepEqual(validateRiskAcceptance(validRecord, now), []);
assert.ok(validateRiskAcceptance('invalid', now).includes('missing YAML front matter'));
assert.ok(
  validateRiskAcceptance(validRecord, new Date('2026-07-21T00:00:00Z'))
    .includes('risk acceptance is expired')
);
assert.ok(
  validateRiskAcceptance(validRecord, new Date('2026-07-19T12:00:00Z'))
    .includes('risk acceptance must retain at least 24 hours of validity')
);

const futureRecord = validRecord
  .replace('created: 2026-07-01', 'created: 2099-01-01')
  .replace('expires: 2026-07-20', 'expires: 2099-01-20');
assert.ok(validateRiskAcceptance(futureRecord, now).includes('created must not be in the future'));

const tooLongRecord = validRecord.replace('expires: 2026-07-20', 'expires: 2026-08-20');
assert.ok(validateRiskAcceptance(tooLongRecord, now).includes('acceptance duration must not exceed 30 days'));

const sameIdentity = validRecord.replace('approver: security-owner', 'approver: service-owner');
assert.ok(validateRiskAcceptance(sameIdentity, now).includes('owner and approver must differ'));

const emptySections = validRecord.replace(
  /(?:Concrete failure scenario|Exact test and scan evidence|Named temporary control|Measurable remediation condition)\./g,
  ''
);
for (const section of ['Risk', 'Evidence', 'Compensating controls', 'Exit criteria']) {
  assert.ok(
    validateRiskAcceptance(emptySections, now).includes(`section must contain concrete content: ${section}`)
  );
}

const placeholderSections = validRecord
  .replace('Concrete failure scenario.', 'TBD')
  .replace('Exact test and scan evidence.', '<!-- add evidence -->')
  .replace('Named temporary control.', '[ ]')
  .replace('Measurable remediation condition.', 'N/A');
assert.equal(
  validateRiskAcceptance(placeholderSections, now)
    .filter(error => error.startsWith('section must contain concrete content:')).length,
  4
);

const largeEmptyListSection = Array.from(
  { length: 20_000 },
  (_, index) => index % 2 === 0 ? '  -  ' : '  *  '
).join('\r\n');
const largeEmptyListRecord = validRecord.replace(
  'Concrete failure scenario.',
  largeEmptyListSection
);
assert.ok(
  validateRiskAcceptance(largeEmptyListRecord, now)
    .includes('section must contain concrete content: Risk'),
  'Large whitespace-only list sections must be rejected without regex backtracking.'
);

const repositoryRecords = await checkRiskAcceptances(new Date('2026-08-09T00:00:00Z'));
assert.deepEqual(repositoryRecords.violations, []);
assert.deepEqual(repositoryRecords.files, []);

console.log('Risk-acceptance governance tests passed.');
