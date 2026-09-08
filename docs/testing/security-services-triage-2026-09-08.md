# Security-services triage against the verified fix branch — 2026-09-08

Scope: DeepSource default-branch static issue occurrences and Codacy issues for
`888nikush888/tsx-core`, both pinned to main revision
`be8cf5af59f60d69ad946d778973add8161b7672`, compared against fix-branch HEAD
`6085aef` (`codex/security-quality-services-2026-09-08`).
No finding status was changed on either platform; this is triage evidence only.

## DeepSource export (verified)

Exporter: `node scripts/export_deepsource_findings.js` with `DEEPSOURCE_TOKEN_FILE`.
Result: `complete: true`, scope `default-branch-static-issue-occurrences`,
count 4459, uniqueCount 4459, revision `be8cf5a…`, first-page re-verified.

| Category | Occurrences |
| --- | ---: |
| ANTI_PATTERN | 3541 |
| BUG_RISK | 785 |
| TYPECHECK | 41 |
| PERFORMANCE | 55 |
| SECURITY | 1 |
| SECRETS | 36 |

Severity: MINOR 2779, MAJOR 609, CRITICAL 1071.
Analyzers: javascript 4193, python 228, secrets 36, docker 2.

Top production (`src/`) shortcodes: JS-R1005 complexity notes (917),
JS-0323 `Unexpected any` (752, e.g. `src/workflow_repository.ts:2440`),
JS-0339 non-null assertions (295), JS-0116 async-without-await (142).
The single SECURITY occurrence is BAN-B104
(`exchange_executor/server.py:217`, possible all-interface bind) — the same
intentional authenticated container listener already documented in
`docs/testing/codacy-inventory-2026-09-08.md`. The 36 SECRETS occurrences are
test-fixture strings such as `must-not-persist` and `fixture-key`, not live
credentials. Control-character regex flags (JS-0004/JS-W1035, e.g.
`src/trading_order_identity.ts:26`) mark intentional client-ID sanitizers
(`/[\x00-\x20]/`); removing them would weaken validation. The `used before
defined` flags (JS-0357, e.g. `src/ui_restart_coordinator.ts:58`) reference
closures that only run after the later `const` is assigned (timer set up at
line 65 before any `finish()` call site).

## Codacy export (verified)

Repository API confirms `lastAnalysedCommit.sha be8cf5a`, grade A (96),
issuesCount 358, all 358 fetched via `POST …/issues/search` (no cursor left).

Levels: Error 239, High 92, Warning 19, Info 8.
Categories: Security 333, ErrorProne 25.

Top patterns: path-traversal/non-literal-fs rules on already-hardened
backup/config code (`src/backup_generation.ts`, `src/config.ts`,
`scripts/sonar_review_decisions.js:90-99` with per-segment `lstat`,
`realpath` and root-prefix checks), Bandit_B105 exclusively on test fixtures
(`local-fixture-secret`, `isolated-fake-secret`), Trivy HIGH/MEDIUM on
`monitoring/govulncheck/go.mod` requiring go 1.26.0 — the fix branch already
pins `go 1.26.6`. The single markdown anchor flag
(`docs/PRODUCTION_GUIDE.md:9`) references a fragment the fix branch already
corrected to `#14-enterprise-nachweise-und-aktuelle-offene-punkte`.

## Local verification on the fix branch

Runtime: portable Node v22.23.2 (`.nvmrc`: 22), Python 3.12.13 with
ccxt 4.5.75 via `TSX_TEST_PYTHON` (repo pins: `.python-version` 3.12,
CCXT 4.5.75).

| Gate | Result |
| --- | --- |
| `tsc --noEmit` | clean (exit 0) |
| `eslint src/**/*.ts tests/**/*.js scripts/**/*.js *.js --quiet` | clean (exit 0) |
| frontend `npm run lint` (oxlint, 149 files) | 0 warnings, 0 errors |
| `python -m ruff check exchange_executor` | all checks passed |
| `node tests/run_all.js` | ALL 225 TEST FILES PASSED |
| `python -m pytest exchange_executor/tests` | 550 passed, 994 subtests passed |
| `git diff --check` | clean |

## Disposition

No runtime change is made by this report. The actionable cloud findings
(Go minimum version, docs anchor, fs-boundary hardening) are already present
in the fix branch; the remainder is stale-main, test-fixture, or stylistic
scanner output where bulk edits would risk stability without safety gain.
A platform rescan after merge is the correct closure mechanism, not further
local churn.
