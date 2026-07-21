# Time-bounded risk acceptances

Only files named `RA-<YYYYMMDD>-<slug>.md` are records. Copy the template, replace every value, and remove the record after remediation. A record may remain active for at most 30 days; expired or incomplete records fail CI.

PR risk records use the commit-bound gate `pr-risk:<40-character-head-sha>`. The `scope` must contain the same SHA, and owner and approver must differ. A score of ten or more fails CI unless this exact, valid, and unexpired record exists.

```markdown
---
id: RA-20260713-example
owner: service-owner
approver: security-owner
created: 2026-07-13
expires: 2026-07-20
scope: exact components, versions, and commit SHA
gate: pr-risk:<40-character-head-sha>
---

## Risk

Concrete damage scenario and maximum impact.

## Evidence

Finding, test or scan output, and why the gate cannot currently be met.

## Compensating controls

Time-bounded controls, monitoring, and stop condition.

## Exit criteria

Measurable evidence, responsible owner, and latest remediation date.
```

Critical security vulnerabilities, untested migrations, missing rollback or restore capability, critical flows without tests, and unresolved irreversible AI actions cannot be accepted.
