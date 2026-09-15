# Signal-contract regex execution budget

The previous contract syntax checks accepted `^(a+)+$`. Under Node 22.23.2,
`validateSignalContractDefinition` accepted it and `validateSignalXml` then hung
on an otherwise valid signal whose additional field contained 50 `a` characters
followed by `!`. A separate child process printed `contract-validated` and was
terminated by its parent after 1.5 seconds (`ETIMEDOUT`). The parent test process
was never exposed to the unbounded match.

Contract-field matching now uses the existing `safeRegexTest` VM timeout. All
additional fields share a 100 ms deadline for each dynamic contract validation;
the budget is not renewed for every one of the up to 30 fields. A timeout or
execution failure becomes `SignalValidationError`, without including the pattern
or field value. A normal non-match retains the existing validation error.

The syntax checks remain unchanged. They are explicitly documented as insufficient
to prove bounded backtracking. This preserves legitimate nested patterns,
alternations, Unicode properties and escaped literal syntax while bounding actual
execution. No scanner rule is suppressed.

Regression coverage includes three catastrophic patterns in independently bounded
child processes, ordinary matching and non-matching patterns, 30 ordinary field
patterns, and a controlled clock proving that the execution budget is shared.

Passed on Node 22.23.2: signal-contract validation, signal-schema migration, strict
signal-parser tests, TypeScript typecheck, targeted ESLint, architecture and
complexity gates, and `git diff --check`. The timeout is a per-validation bound,
not a global admission-control mechanism for unlimited repeated requests.
