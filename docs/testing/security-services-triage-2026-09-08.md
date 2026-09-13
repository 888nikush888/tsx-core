# Security-services triage and reconciliation

The original triage branch (3cf589b69b52bc66d2690e7cf62dc4e49f605dca) was based on 6085aef. Its historical report described 4,459 DeepSource occurrences and 358 Codacy issues on main be8cf5a. These are historical inventories, not final counts for the integrated tree.

The inherited claims that entire finding classes could be closed as documentation, that style/type findings were out of scope, or that green branch checks proved complete remediation are withdrawn. The user requested all findings. A finding requires an actual fix or a specific, supported disposition followed by verification against the current source. Aikido is excluded by the user's explicit instruction; the four previously accepted internal HTTP risks retain their existing scope and expiry.

## Integration review, 2026-09-13

The independent targeted review is recorded in `fixer-triage-independent-review-2026-09-11.md`. It identified broken equality assertions, lost Promise rejection boundaries, dropped HTTP compression negotiation, an inherited-key SQL allowlist regression, missing inventory error handling, and an unsound generic redaction return type. These are being corrected in the separate reconciliation worktree. The review is not an approval of every changed line.

The integration work additionally reproduced an empty-fill regression: a settlement-asset check had moved outside the exit-fill loop and blocked accounting before any fill existed. The check now applies when an exit event needs the asset; the existing FX engine test passes without changing its expected outcome.

The 24 DeepSource fixer branches were reconciled separately and passed all 226 backend test files on 9079ddd. That result does not establish the larger triage merge as verified. Current reconciliation results and outstanding checks are recorded separately; final scanner rescans and source-bound reviews are still required. No production deployment or default-branch merge is attested here.
