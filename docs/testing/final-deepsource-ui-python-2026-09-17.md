# Final DeepSource UI/Python review — September 17, 2026

Base: `58c01bc74f83cc212849ddcd7e487412ff06b2b7`. The occurrence-level JSON companion binds each disposition to its original scanner ID/location and before/after source hashes. Raw source findings and credentials are not reproduced.

## Scope and result

- Full DeepSource default-main baseline: 1,315 occurrences; JS-R1005 alone excluded (1,178); visible non-complexity scope 137.
- This work covers 57 DeepSource occurrences and 18 open frontend SonarCloud occurrences.
- Dispositions: `{"DeepSource:source_change_pending_rescan":47,"DeepSource:reviewed_expected_behavior":6,"DeepSource:reviewed_false_positive":1,"DeepSource:reviewed_false_positive_pending_full_rescan":3,"SonarCloud:source_change_pending_rescan":17,"SonarCloud:reviewed_expected_behavior":1}`.
- No scanner settings, remote statuses, inline suppressions, commits or staging were changed.

## Changes

Converted 21 no-substitution literals by cooked AST value, removed 13 single-child fragments, extracted stable Telegram display fields, clarified callback/fixture types and unsuccessful returns, preserved own prototype-like data-key assertions, and simplified one Python comparison. Frontend Sonar changes add union aliases, precise optional leverage/read-model types, remove redundant optional undefined and make workflow condition scopes explicit.

## Individual review decisions

Native asynchronous React callbacks and Paper editor refresh contracts remain unchanged. Two string-rejection fixtures retain non-Error coverage. The sessionStorage identifier is not an authentication secret. Three KuCoin nullable diagnostics do not reproduce with mypy 2.3.1: the existing overload returns str by default and str | None only when nullable is requested. The named scrollable change-review region remains keyboard focusable, backed by an existing focus regression. These decisions are tied to individual occurrence IDs; full remote rescan/disposition verification remains required.

## Validation

Frontend tsc and oxlint passed. Fifteen affected frontend suites passed 172 tests; a new Telegram display regression passed one test covering DOM/focus identity and a single revision-bound write. Six root mechanical suites passed. Python account-log tests passed 13 tests and KuCoin provider-control passed eight. An initial Python invocation from the repository root had an import-path error; rerunning from the executor directory passed without code changes. The isolated mypy reproduction passed.

No live exchange/provider calls were made. Source changes are pending integrated main analysis, and this document does not claim remote closure.
