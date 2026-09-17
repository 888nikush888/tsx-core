# Final findings stabilization run — 2026-09-17

## Scope and acceptance

The owner authorized implementation of the final Codacy, DeepSource and Sonar plan. Stability comes first. All active findings and previous individual false-positive decisions must be reconciled against the final source. An individually evidenced false positive is permitted; a stale dismissal is not evidence.

Baseline main: `58c01bc74f83cc212849ddcd7e487412ff06b2b7`, tree `8977cd3028670c806f1acaba9e93969641ab998d`. Work uses one integration branch, `codex/final-findings-2026-09-17`.

- Codacy: 92 active records, 347 ignored records. Trivy and ESLint analysis errors prevent a complete baseline analysis despite the passing issue-delta gate.
- DeepSource: 1,315 active occurrences, including 1,178 JS-R1005 occurrences. The other 137 occurrences and 370 local suppression comments require reconciliation.
- Sonar: 79 open findings, seven false-positive decisions, one accepted compatibility decision, two local NOSONAR comments; no security hotspots.
- JS-R1005 alone is excluded from this run. Its rule remains enabled and its threshold unchanged; a negative aggregate DeepSource status caused by this rule is expected.
- Aikido remains excluded. Snyk Actions and the existing individually accepted internal HTTP risks remain in force. No new blanket rule exclusions or lowered quality thresholds are authorized.

Full exports are kept under ignored `reports/final-findings/`; committed review records must omit tokens, credential values and full secret-bearing source snippets.

Completion requires every enabled analyzer to finish on the final source, every occurrence to have a current decision, all required tests/checks to pass, and full main scans after an authorized merge. An external analyzer failure, a stale revision or a clean PR delta cannot establish completion. The prior PR72 branch-protection exception does not authorize another exception.

## Fill identity correction

Sonar's three coercion findings in `src/trading_fill_identity.ts` exposed a real proof-validation defect: an array containing the correct Bybit execution timestamp or Hyperliquid fill/order identifier produced the same canonical identity as a native scalar.

The new regression in `tests/test_exchange_fill_identity.js` failed against the baseline with a proven identity where `null` was required. The production correction validates primitive decimal strings or nonnegative safe integers before comparison. It preserves leading-zero Hyperliquid strings and exact strings larger than JavaScript's safe-integer range. No coercion hooks run. Unsafe numeric originals deliberately remain unproven because JSON numbers cannot establish their exact original identity; archived raw values are never converted into invented original strings.

Existing control flow handles rejection: `provenFillIdentity` returns `null`, correlated persistence records sanitized unresolved economic evidence, and historical binding leaves legacy rows unresolved. No schema, public API or existing canonical-key format changed. The test verifies that malformed live observations do not modify fill or money rows, that diagnostic evidence retains the existing sanitized boundary, and that malformed historical originals cannot be bound. Valid originals, restart deduplication and accounting remain covered.

Validation completed with Node 22.23.2 using the registered test runner:

```text
node tests/run_all.js test_exchange_fill_identity.js test_trading_fill_identity.js test_trading_fill_identity_backfill.js test_fill_identity_contract_guards.js test_trading_evidence_repository.js test_fill_quantity_persistence.js test_trading_fx_fill_accounting.js
ALL 7 TEST FILES PASSED
```

This focused result is not a full-run or scanner completion claim. Independent review found an additional null-sentinel comparison risk in the Hyperliquid order proof; a red-before/green-after regression now requires both normalized native identifiers to be non-null before equality. All seven suites passed again. The independent review is recorded in `final-fill-identity-independent-review-2026-09-17.md`. Integrated verification, renewed implementation evidence and final cloud scans remain pending.

## Python lookup assertions

The twelve open Sonar `python:S8714` occurrences in eight executor test modules now use `next(iterator, sentinel)` followed by `assertIsNot` with the original failure message. A unique object sentinel preserves the distinction between exhaustion and any actual yielded value. The scripted position reader returns its actual page only after the assertion; no missing-data fallback or weakened assertion was introduced.

Focused verification passed: execution constraints (18 tests), history coverage/pagination/reader (30), and FX evidence/Hyperliquid retention/phase2 registry/recovery schedule (70), totaling 118 tests on Python 3.12.14. Ruff passed on all eight edited files. Fresh Sonar confirmation remains pending.

## Reviewed backend and frontend packages

The backend Sonar package covers 46 occurrences: 40 source changes pending scan confirmation and six individually evidenced compatibility/classification decisions. Root reviewed the nine source diffs and six affected test diffs, including actual SQL SELECT projections, inner/left joins, nullable columns, MCP schema and adaptive cursor keys. Query text, transaction boundaries and persisted money representations remain unchanged. TDLib, contract-bound and paper-symbol validation now rejects structured values before identity/amount coercion. Thirteen focused suites, backend TypeScript and targeted ESLint passed.

The UI/Python/mechanical package covers 57 DeepSource and 18 Sonar occurrences, with source changes distinguished from individual exception candidates in its companion ledger. A separate agent reviewed all 17 changed frontend source files and the new viewer regression without a blocking finding. The viewer regression verifies stable focused controls and one revision-bound settings write. Focused evidence comprises 173 frontend tests, 21 Python tests, six root suites, frontend types/lint, and a separately versioned mypy reproduction. The three KuCoin typing reports still require provider reconciliation; local non-reproduction is not proof of a completed DeepSource scan.

The remaining 15 Sonar IDs are bound individually in `final-sonar-fill-python-2026-09-17.json`: three fill-proof boundaries and twelve test assertions. Exact inventory subtraction verifies that these three packages cover every one of the 79 open Sonar IDs without overlap.

The prior-suppression audit covers all 370 baseline comments and 389 rule mentions. Two obsolete JS-W1042 comments were removed; their executable ASTs are unchanged. The other 368 comments retain individual current-contract evidence. The same ledger reassesses seven previous Sonar false positives, one accepted compatibility finding and two NOSONAR sites. Focused evidence comprises ten Node suites, nine Python tests and eleven frontend tests; this does not imply every suppressed branch was executed.

Two private TradingEngine helpers that have no instance dependency or override callers are now static. Their three call sites retain the same awaited behavior. Six engine/evidence suites passed. Instance methods used as adapter interfaces or fault-injection seams remain unchanged. Additional control tests prove native Promise rejection/adoption, immediate mutation ownership and synchronous operator fencing; four control/race suites passed. The occurrence ledger must record these retained contracts individually.

## Codacy analyzer status

A fresh main reanalysis on 2026-09-17 completed at 12:15:07 UTC and reproduced both provider failures: Trivy rejects missing line metadata, and the deployed ESLint security-node rule crashes on valid try/finally statements. The same revision still contains Go 1.26.6 while retained Trivy findings describe Go 1.26.0. These 33 records remain stale/incomplete, rather than being falsely classified as fixed or false positive. Neither rules nor files were excluded to conceal analyzer failures.

## Remaining completion work

- Renew every Codacy decision and establish successful Trivy/ESLint execution; reconcile retained Go alerts with fresh scan evidence.
- Complete Sonar SQL projection typing, coercion-boundary review, UI/test cleanup and reviewed exceptions.
- Complete all 19 non-JS-R1005 DeepSource rule families and reconcile every local suppression with current callers/tests.
- Run all backend/frontend/Python tests, coverage, four mutation groups, browser/accessibility projects, lint/type/build and existing security/container/governance gates.
- Independently review the final source and renew implementation receipts and scanner decision bindings from actual evidence, not hash substitution alone.
- Obtain protected-branch approval, merge only the verified revision, and re-export complete main analyses.
