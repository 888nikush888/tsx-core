# First scanner follow-up after fixer integration

The 25-branch integration remains complete. This follow-up addresses four
DeepSource JavaScript type findings, nine Python import findings and six redundant
arguments in Promise test fixtures without
changing runtime delivery or provider acceptance behavior.

## Current scanner evidence

The finished DeepSource run `c9e07b75-df1c-4825-9dcd-7988b11a4ddb` analyzed
`c684aafc4c43de9031c68a1a3145d0430f43f850` against main
`be8cf5af59f60d69ad946d778973add8161b7672`. All check issue pages were exported
with stable totals, unique IDs and terminal cursors. Its PR delta contains 243
JavaScript, 9 Python and 14 secret findings; Docker adds none. It reports 1,864
JavaScript, 209 Python and 19 secret findings resolved. These are PR changes,
not a complete branch inventory. A separately completed default-branch export
still contains 4,459 unique findings at the old main revision.

Codacy's enabled integration branch was fully analyzed at the same head and
contains 343 unique active findings, zero ignored. All reported source lines
were checked against that Git revision. The separate PR delta is 35 added and
52 fixed findings; it must not substitute for the full branch inventory.
Neither service is currently claimed clean.

## Changes and verification

- Six individually reviewed calls to `Promise.resolve(undefined)` in three tests
  now use `Promise.resolve()`. They still return a Promise fulfilled with the
  missing-row value. All three affected tests pass. The eight separately reported
  `assert.equal` calls retain their required `undefined` expected argument.
- Delivery tracking now describes consumed optional Telegram fields explicitly
  and uses `unknown` for scalar payload values instead of four `any` annotations.
  No executable statement changed. Independent TypeScript 6.0.3 compilation to
  ES2022/CommonJS, with comments removed, produced byte-identical JavaScript.
  Whole-project type checking, lint and the existing delivery tracker tests pass.
  In particular, the asynchronous batch callback and its rejection handling remain.
- The provider acceptance test runner retains all 19 historical exported object
  identities. Eight compatibility reexports are now explicit assignments; the
  internally used imports no longer repeat their own names as aliases. Its 28
  existing offline acceptance/journal tests and Ruff pass. An independent review
  repeated those tests and checked the assignments and import ordering.
- A fresh Snyk Code scan after these two source edits returns 85 findings. The
  existing source-bound verifier passes unchanged: 81 individually reviewed false
  positives, four explicitly accepted internal HTTP risks, zero unresolved.

No scanner rule, risk acceptance, provider authorization,
implementation receipt or approval pin changed. These 19 DeepSource fixes still
require a scan of their published revision to confirm remote closure.

A subsequent documentation-only change replaces 13 independently reviewed
synthetic fixture copies in two historical Codacy reports with Git/hash
references. Each report retains its original revision and complete report hash;
each affected field retains its original line and value hash. One rationale is
restated without its fixture literal. Independent structural comparison confirms
that all issue IDs, source bindings, classifications and other rationales remain
unchanged. These replacements are not new runtime fixes or evidence that the
remote scanner has already closed the corresponding findings. The fourteenth
introduced secret finding is a non-secret browser storage key identifier and
remains a separately reviewed false-positive proposal.

A separate Codacy finding exposed an unqualified Windows command-processor path
in the journal junction test. The fixture now obtains the absolute system path
from `GetSystemDirectoryW`, validates it and its temporary-directory arguments,
and disables command-processor AutoRun. Its existing 28 acceptance tests pass on
Windows, including actual junction creation. Spoofed PATH, ComSpec and SystemRoot
values do not affect executable selection. The Unix symlink branch is unchanged.

The c684aaf GitHub core job 103692702455 passed both complete 226-file Node runs,
all 547 Python tests, build and static gates including monitoring. The CI merge
commit and c684aaf have identical Git tree fec5f0e6a1591381b34f43f9c789d325c97e0155.
All four browser and mutation jobs also passed. Module coverage was
96.48/86.50/99.20/96.48 percent (statements/branches/functions/lines) on Linux and
96.48/86.44/99.20/96.48 on Windows. An independent check approved raising the
baseline to their componentwise minimum; no threshold was lowered. Linux used
the CI clean dependency installation; Windows used the existing locked dependency
installation and is not a new clean-install claim.

The container job stopped at the implementation comparison before image checks.
Its failure is retained as an open gate; the successful core tests do not replace
it. A refreshed Sonar check and scans of the follow-up commits remain necessary.

## Evidence and remaining work

The local evidence directory `reports/security-services` contains the full
DeepSource run export, paginated default-branch export, Codacy branch and PR
exports, Python per-occurrence triage, independent delivery and remaining Python
reviews, targeted test logs, fresh Snyk SARIF and its verification result.

The remaining Python implementation diff from the historical receipt source was
independently reviewed: all 55 previous file bindings still match (including the
six later individually reviewed changes), and nine additional Python paths were
examined. The extracted acceptance contracts preserve all 17 definitions and two
constants structurally. Another 55 targeted offline checks passed. This is review
evidence only: the old implementation receipt remains stale, and current full
execution/container evidence and final source binding are still required.

DeepSource and Codacy backlog remediation, current Sonar results and final
implementation verification remain open. Aikido is excluded by the owner's
instruction. Main merge and deployment have not occurred.
