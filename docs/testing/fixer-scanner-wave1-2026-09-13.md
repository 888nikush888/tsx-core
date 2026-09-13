# First scanner follow-up after fixer integration

The 25-branch integration remains complete. This follow-up addresses four
DeepSource JavaScript type findings and nine Python import findings without
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

No scanner rule, test threshold, risk acceptance, provider authorization,
implementation receipt or approval pin changed. These 13 DeepSource fixes still
require a scan of their published revision to confirm remote closure.

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
