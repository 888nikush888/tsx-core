# Risk acceptances

Only files named `RA-<YYYYMMDD>-<slug>.md` are records. Copy the template below, replace every value, and remove the record after remediation.

Every required section must contain concrete, non-placeholder content. Empty headings, comments, checkboxes, `TBD`, `N/A`, or equivalent filler fail `npm run quality:risk-acceptances`. A record may remain active for at most 30 days, may not be future-dated, and must retain at least 24 hours of validity when evaluated.

TSX Core does not publish a custom GitHub approval status. These records are local, reviewable evidence for an explicitly accepted temporary deviation. They never make the following acceptable:

- critical security vulnerabilities;
- untested destructive migrations;
- missing restore or rollback evidence;
- critical execution paths without tests;
- unresolved irreversible trading or AI side effects.

Use separate, real people for `owner` and `approver` whenever a second qualified reviewer is available. `scope` must identify the exact affected component or commit, and `gate` must name the blocked quality or operational gate. Deleting an expired or remediated record does not erase it from Git history.

```markdown
---
id: RA-YYYYMMDD-short-name
owner: service-owner
approver: independent-reviewer
created: YYYY-MM-DD
expires: YYYY-MM-DD
scope: exact component, change, or commit
gate: affected-gate
---

## Risk

Concrete failure scenario and impact.

## Evidence

Exact test, scan, issue, or measurement references.

## Compensating controls

Temporary controls with named operators.

## Exit criteria

Measurable remediation and removal condition.
```
