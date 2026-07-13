import assert from 'node:assert/strict';
import { checkRiskAcceptances, validateRiskAcceptance } from '../scripts/check_risk_acceptances.js';

const validRecord = `---
id: RA-TEST
owner: service-owner
approver: security-owner
created: 2026-07-01
expires: 2026-07-20
scope: example
gate: example-gate
---
## Risk
Example risk.
## Evidence
Example evidence.
## Compensating controls
Example controls.
## Exit criteria
Example exit criteria.
`;

assert.deepEqual(validateRiskAcceptance(validRecord, new Date('2026-07-13T00:00:00Z')), []);
assert.ok(
  validateRiskAcceptance(validRecord, new Date('2026-07-21T00:00:00Z')).includes(
    'risk acceptance is expired'
  )
);
assert.ok(validateRiskAcceptance('invalid').includes('missing YAML front matter'));

const repositoryRecords = await checkRiskAcceptances(new Date('2026-07-13T00:00:00Z'));
assert.deepEqual(repositoryRecords.violations, []);

console.log('Risk-acceptance governance tests passed.');
