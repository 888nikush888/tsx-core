# Security service stabilization — 2026-09-08

Baseline source: `be8cf5af59f60d69ad946d778973add8161b7672` on
[`888nikush888/tsx-core`](https://github.com/888nikush888/tsx-core).
This is an intake record, not a clean-scan or release certificate.

## Verified progress checkpoint

The [Snyk Security services run for `7f6eb9a`](https://github.com/888nikush888/tsx-core/actions/runs/34214924854)
passed all five jobs: backend and frontend dependency trees, Python runtime and
development dependencies, and source code. The Code result is explicitly
**85 raw findings = 81 independently reviewed false positives + four owner-accepted
internal HTTP risks + zero unresolved findings**, not a zero-finding scan.
The [wave5 review](snyk-code-independent-review-wave5-2026-09-08.json) binds every
finding to exact source, context, fingerprint and flow evidence at
`032dff339607b6138eb5a6db134dc91c1be5cb82`. The only following changes in the passing
revision were the review document and its workflow selection. Changed source or
flows require review again. The four HTTP findings remain open in that review;
the separately validated [owner acceptance](../risk-acceptances/RA-2026-09-08-internal-http.md)
expires on 2026-10-08 and never classifies them as false positives.

DeepSource's corrected ESM/React/Node/test configuration produced a complete
4,459-occurrence baseline export at the unchanged `be8cf5a` revision (4,193
JavaScript, 228 Python, 36 Secrets, two Docker). Configuration corrections and
local code corrections are recorded separately. Local remediation ledgers still
require a new complete cloud scan; pull-request deltas do not prove a clean main
branch. One attempted synthetic-secret disposition remains unconfirmed on
readback, so it is not counted as resolved and has not been blindly retried.

Codacy's complete inventory contains 358 unique issues at `be8cf5a`, with no
platform dispositions applied. The [independent production review](codacy-independent-production-review-2026-09-08.json)
records 76 individually checked false-positive proposals. The other proposals
and locally corrected issues must remain distinguishable from cloud-confirmed
resolutions. Aikido remains entirely outside scope at the owner's request.

The isolated Python 3.12.14 environment with the exact hash-locked dependencies
passed all 546 tests. The latest combined frontend revision `4313b69` passed its
build and 316 tests across 37 files. All four browser jobs for `7f6eb9a` passed in
GitHub. The earlier local 196-case browser run had one initial resource-loading
failure (`ERR_NO_BUFFER_SPACE` for a local CSS file), passed its retry, and the
affected mobile keyboard test then passed ten isolated repetitions with retries
disabled. This intermittent local infrastructure result is retained honestly;
test timeouts and assertions were not weakened.

Further local fixes after this checkpoint are under continued review and test.
The repository is not yet declared fully remediated or ready for deployment.

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
