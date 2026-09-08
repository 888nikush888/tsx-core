# Security service stabilization — 2026-09-08

Baseline source: `be8cf5af59f60d69ad946d778973add8161b7672` on
[`888nikush888/tsx-core`](https://github.com/888nikush888/tsx-core).
This is an intake record, not a clean-scan or release certificate.

## Verified baseline

The [main Quality OS run](https://github.com/888nikush888/tsx-core/actions/runs/34192859674)
completed successfully: 13 successful jobs and two context-dependent skips.
The current work uses an isolated worktree; existing local development changes
are not part of this baseline. No production deployment is included.

| Service | Observed state | Remaining verification |
| --- | --- | --- |
| SonarQube Cloud | Analysis `069ac89c-30ef-43e1-84af-9feb1e982fe7` matches the baseline; gate OK, zero unresolved issues and zero hotspots; coverage 88.4% | Repeat on the final revision. Historical inventory includes 1,072 fixed, seven false positives and one accepted compatibility finding. |
| DeepSource | Authenticated complete export: 6,620 occurrences, 6,620 unique IDs, stable baseline revision | Correct scanner configuration, remediate and repeat the complete scan/export. SCA is inactive and separate from this static-analysis inventory. |
| Codacy | Repository connected; dashboard reports 358 current issues and zero ignored issues | Export all occurrences and establish scan revision; PR review comments are a separate inventory. |
| Snyk | Existing target retains the previous repository name; backend shows four high and two medium issues; frontend and Dockerfile show zero | Verify target identity/revision, update the import and scan both npm trees, Python runtime/development dependencies and source code. |
| Aikido | Existing connection observed, but explicitly excluded by the repository owner during this task | No further Aikido work or verification is included. |

DeepSource static export includes JavaScript 6,341; Python 241; Secrets 36;
Docker 2. Categories: anti-pattern 5,812; bug risk 662; performance 55;
typecheck 54; secrets 36; security one. These counts describe scanner reports,
not confirmed exploitable vulnerabilities.

## Handling findings

Each actual defect needs a correction and relevant validation. A false positive
requires a concrete source/data-flow explanation and an individual disposition;
it is not described as a technical fix. Missing credentials, unsupported scanner
features, incomplete pagination and stale scans are not evidence of zero issues.
Existing required checks and branch protections stay active during onboarding.

Raw exports and local validation logs are kept in ignored `reports/` folders.
Authentication tokens are read from process environment or user-provided local
files outside the checkout, and must never be committed or copied into reports.

The three historical Codacy PR comments have a separate
[review record](codacy-review-2026-09-08.md).
