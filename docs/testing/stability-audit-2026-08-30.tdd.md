# Stability audit – 2026-08-30

## Sources and scope

This audit checked the current `main` branch against five external analyses supplied by the operator:

- `TSX-Core-Debug-Report-2026-08-30.md`
- `TSX-Core-Code-Review-2026-08-30.md`
- `TSX-Core-Code-Quality-Report-2026-08-30.md`
- `TSX-Core-AI-Slop-Audit-2026-08-30.md`
- `TSX-Core-Variant-Analysis-2026-08-30.md`

The reports were treated as hypotheses. A finding was changed only when the current source or a reproducer proved it.

## User journeys

- As an operator, I want production assets to remain bounded, so that dashboard delivery cannot regress into a single oversized JavaScript transfer.
- As an operator, I want setup imports to have bounded collections, so that a validly shaped but excessively large model list cannot monopolize validation.
- As a maintainer, I want unsupported local runtimes to fail before installation, so that native modules and test results match CI and production.
- As a maintainer, I want Python lint to be a locked CI gate, so that known static defects cannot silently return.
- As a reviewer, I want each external claim classified from authoritative evidence instead of accepted by assertion.

## Finding disposition

| Report claim | Authoritative evidence | Disposition |
|---|---|---|
| Node 24/npm 11 and Python 3.14 were used locally although the project targets Node 22/npm 10.9 and Python 3.12 | `package.json`, `.github/workflows/quality.yml`, local version output | Confirmed environment mismatch. Added `.nvmrc`, `.python-version`, and `engine-strict=true`; repository governance tests enforce all three. |
| `npm ci --ignore-scripts` left `sqlite3` unusable and the frontend needs a separate install | CI explicitly rebuilds `sqlite3`/`esbuild`; README and production guide use both locked installs | Not a runtime defect. The report used the supply-chain install mode without its required rebuild step. Supported versions now fail fast locally. |
| Production frontend emitted an 801.76 kB chunk | Clean Vite production build and RED test `test_frontend_bundle.js` | Confirmed and fixed. Semantic chart/icon splitting produces largest chunks of 436.87, 360.17 and 325.52 kB without Vite chunk or cycle warnings. A 500 KiB regression gate runs in the core suite. |
| GTM utility emitted informational production console logs | `frontend/src/utils/analytics.ts` and RED source-quality assertion | Confirmed and fixed. Initialization behavior is unchanged and production `console.log` calls are absent. |
| Python Ruff check had 13 findings and was not a CI gate | `python -m ruff check exchange_executor` | Confirmed and fixed. Ruff 0.15.7 is hash-locked, the intentional test import-path exception is explicit, real findings were corrected, and CI invokes `npm run lint:python`. |
| `sourceChannels: null` could be persisted through config update/import and cause startup failure | `serializedConfig()` validates a structured clone before the atomic write; new `test_config.js` regression | Not reproducible in production. The invalid value is rejected and the last valid file remains byte-for-byte effective. |
| String `sourceFilters` leads to unsafe enumeration or regex execution | `normalizeSourceFilters()`, `getRegexPatternsForSource()`, ReDoS and filter tests | Incorrect for current `main`. Non-object source filters normalize to an empty map; regex compilation is bounded and tested. |
| Legacy persisted outbox/parser configuration bypasses validation | `mergeConfigDefaults()` at task execution plus strict parser/workflow validation suites | Not reproducible. Persisted task configuration is validated before use; invalid parser and contract payloads fail closed. |
| Journal export accepts arbitrarily many intent IDs and can exceed SQLite parameter limits | `GET /api/trading/journal/export`, `MAXIMUM_JOURNAL_ROWS = 500`, relation IDs derived from bounded query rows | Incorrect endpoint/data-flow description. No caller-supplied intent-ID array exists and relation fan-out is bounded to 500 intents. |
| Setup preview permits a 4 MiB event-loop denial of service with unbounded resources | 4 MiB request cap, depth 40, graph 1,000 nodes/4,000 edges, resources 1,000, accounts 100 | Partly incorrect but exposed one gap: model collection counts were not independently capped. All four model collections are now limited to 1,000 and covered by RED/GREEN tests. |
| Large TypeScript modules and relaxed strictness are immediate defects | Architecture, complexity, type, coverage and Sonar gates | Maintainability debt, not a reproduced stability failure. No big-bang rewrite was performed: current graph has zero cycles, complexity has zero warnings/violations, and risky central modules retain high integration coverage. Incremental extraction remains preferable when behavior changes require it. |
| Missing `PRODUCT.md`/`EVIDENCE.md` and absent browser evidence prove generated or unstable UI | Existing product/quality documentation and current Playwright run | Not a product defect. The current run passed all 44 desktop/mobile Chromium, Firefox, WebKit and WCAG scenarios. |

## TDD checkpoints

| Behavior | RED checkpoint and evidence | GREEN checkpoint and evidence |
|---|---|---|
| 500 KiB production bundle budget, no GTM logs, bounded setup model lists | `203a99d`; failures showed `page-*.js` at 801,761 bytes, `console.log` matches, and missing model-list cap | `e918678`; the same four targeted test files passed and Vite built without warnings |
| Fail-fast local runtime selection | `a0fcfeb`; governance test failed because `.nvmrc` was absent | `e39a477`; governance test passed with Node 22, Python 3.12 and strict npm engines |
| Locked Python lint gate | `1fe16e3`; supply-chain test failed because Ruff and its workflow gate were absent | `21920aa`; Ruff, supply-chain policy and all 41 Python tests passed |

## Test specification

| # | Guarantee | Test or command | Type | Result |
|---|---|---|---|---|
| 1 | No emitted JavaScript chunk exceeds 500 KiB and Vite emits no large-chunk warning | `tests/test_frontend_bundle.js` | Build integration | PASS |
| 2 | Production analytics utility contains no informational console logging | `tests/test_frontend_quality.js` | Static regression | PASS |
| 3 | Each portable model collection rejects more than 1,000 entries before deep validation | `tests/test_setup_bundle.js` | Boundary/unit | PASS |
| 4 | `sourceChannels: null` cannot replace the last valid atomic configuration | `tests/test_config.js` | Persistence regression | PASS |
| 5 | Local runtime selectors and strict npm engine enforcement cannot disappear | `tests/test_repository_governance.js` | Governance | PASS |
| 6 | Ruff remains pinned, callable and present in the exact GitHub quality workflow | `tests/test_supply_chain.js`, `npm run lint:python` | Supply-chain/static | PASS |
| 7 | Python executor behavior remains unchanged after lint cleanup | Python unittest discovery | Unit/integration | PASS, 41/41 |
| 8 | Builder, responsive layout and accessibility remain functional in real browsers | `npm run test:e2e --prefix frontend` | E2E/WCAG | PASS, 44/44 |

## Coverage and gates

- Core critical coverage: 97.47% statements, 89.03% branches, 100% functions, 97.47% lines.
- Full measured Node module coverage: 95.37% statements, 83.43% branches, 99.21% functions, 95.37% lines.
- Python: 41 tests passed; 74% aggregate statement/branch report, with changed production bundle validation at 99.56% Node coverage.
- Frontend: 101 tests passed plus 44 real-browser/WCAG scenarios. Existing aggregate unit instrumentation is 62.43% statements; changed delivery behavior is additionally covered by the production-build integration test.
- Architecture: 74 modules, 230 internal imports, zero cycles.
- Complexity: zero warnings and zero threshold violations; worst cyclomatic complexity 15 and worst function length 93 lines.
- Duplication: 0.97% duplicated lines, below the 5% gate.
- Local monitoring container build could not run because Docker Desktop was unavailable. The exact Linux Docker/monitoring gate remains mandatory in GitHub before this audit is complete.

## Merge evidence

RED and GREEN commits remain separate on `main`; they were not squashed or rewritten. Final acceptance additionally requires the exact pushed revision to pass GitHub Quality OS, SonarQube Cloud, browser matrix, mutation, SAST, supply-chain and container jobs.
