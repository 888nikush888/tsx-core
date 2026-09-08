# Individual DeepSource secret-finding review

The 36 `SCT-A000` occurrences exported on 2026-09-08 were each checked against
the exact source revision recorded by DeepSource:
`be8cf5af59f60d69ad946d778973add8161b7672`. They cover 15 files.

The [individual ledger](deepsource-secrets-review-2026-09-08.json) records every
occurrence ID, issue ID, original path and lines, exact source SHA-256, selected
line SHA-256, classification, separate rationale, and supporting source lines.
It also binds the review to the original inventory SHA-256. No credential literal
is copied into the ledger.

All 36 are proposed false positives based on their actual source and usage:
synthetic credential fixtures, deliberate negative inputs, redaction sentinels,
documentation placeholders, or non-secret project identifiers. No real credential
was identified in these 36 occurrences. No platform status was changed. This is
a source review, not proof obtained by attempting provider authentication; it
does not claim that all other repository or historical secret findings are clear.

The review did not infer safety merely from a `tests/` path. Each entry identifies
the relevant behavior: injected transport or fake exchange adapter, temporary
credential-store lifecycle, expected validation failure, or explicit assertion
that sensitive fields cannot leave the server or enter exported backups. The
Sonar export and review-decision tests inject their HTTP transport; the trading
tests use fake adapters or a temporary local credential store. The AI-parser
fixture uses injected completion callbacks and restores the original environment.

No fixture was split into string fragments, renamed to evade detection, or
excluded from scanning. No application or test source was changed by this review.
Keeping these explicit fixtures preserves tests of real credential field names,
empty/missing credential rejection, legacy credential migration, candidate
promotion/discard/recovery, and nested redaction in UI and backup outputs.
Blanket exclusions would weaken the ongoing detection of an accidentally added
real credential in these files.

The ledger was checked for exactly 36 unique occurrence IDs, complete one-to-one
coverage of the exported rule occurrences, existing supporting line references,
and hashes computed directly from Git blob bytes at the scanned revision.
`git diff --check` passed. Since this change is review evidence only, it does not
claim a new execution of the application tests. Existing targeted and full-suite
validation belongs to the integrating stabilization task.

Future changes to a cited source file invalidate its file hash and should trigger
re-review before reusing these dispositions. In particular, later redaction fixes
may shift UI-test line numbers; the ledger deliberately retains the original
DeepSource revision and locations rather than silently remapping them.
