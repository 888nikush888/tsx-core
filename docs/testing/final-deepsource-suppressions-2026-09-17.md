# Existing suppression review — 2026-09-17

Reviewed all **370 baseline skipcq comments / 389 rule mentions in 161 files**. Retain **368 comments / 387 mentions** on their current contracts; removed **two obsolete JS-W1042 comments**. No scanner rule, threshold, or remote disposition changed. JS-R1005 remains outside remediation.

Each of the 370 JSON records binds its baseline location to the current AST target and hash, identifies the actual Promise/interface/assertion/validation behavior, records source caller candidates and test references, and states the scope of that evidence. Family counts are a summary of those records, not a substitute for individual review.

| Rule | Baseline mentions | Retained mentions |
| --- | ---: | ---: |
| JS-0004 | 20 | 20 |
| JS-W1035 | 19 | 19 |
| JS-0119 | 3 | 3 |
| JS-0116 | 222 | 222 |
| JS-0320 | 2 | 2 |
| JS-0263 | 10 | 10 |
| JS-0105 | 38 | 38 |
| JS-W1042 | 68 | 66 |
| JS-0061 | 2 | 2 |
| JS-0114 | 2 | 2 |
| JS-C1003 | 1 | 1 |
| JS-0087 | 1 | 1 |
| JS-R1002 | 1 | 1 |

The two removed comments were at tests/test_dupe_blocker.js:49 and tests/test_coverage_perfektion.js:11 in baseline 58c01bc74f83cc212849ddcd7e487412ff06b2b7. Both assertions already used zero-argument nested calls and had no explicit undefined argument. Printed ASTs with comments removed are identical before/after. No runtime code changed.

The retained sites comprise 107 production native-Promise boundaries, 115 asynchronous test doubles, 60 exact-arity undefined assertions, six other explicit-undefined contracts (reduce seed, mock arity, React setters/refs), 38 instance-interface methods, 19 control-character rejection guards plus one ANSI-removal guard, and 22 additional sentinel/process/object-identity/adversarial-fixture/regex/namespace contracts. All 222 async targets still have no own await, and all 38 suppressed instance methods still have no own this; their current API behavior justifies retention.

Also reassessed all **seven prior Sonar false positives, one accepted browser-compatibility finding, and two NOSONAR sites**. SDK coroutine and mutable-dictionary snapshot contracts, VM execution budgets, keyboard focus, unload fallback, and legacy diagnostic coercion still apply. Previously accepted private/loopback HTTP risk scope remains unchanged. The JSON contains an individual rationale and evidence for each.

Validation: ten Node22 regression suites passed; Python SDK/stream tests passed 9 tests; the two frontend suites passed 11 tests with the configured jsdom environment. The initial frontend invocation omitted that environment flag and failed before exercising DOM behavior; the corrected invocation passed without source changes. Full-repository testing remains root-owned. This review does not claim that all 370 branches were executed or that syntactic caller matches are a whole-program type proof.
