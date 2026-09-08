# Plan 002: Resolve all backend Sonar findings

- Planned at: `e03eacfa3ea482d3be56f731f970b58761dd2510`, 2026-09-07.
- Priority P2; effort L; regression risk high; dependencies none.
- Executor worktree: `C:/Users/nikla/Documents/ChatGPT/TSX CORE SERVER INSTALLATION/tmp/tsx-core-sonar-backend`.
- Exact inventory: `tmp/sonar-baseline.json`, 223 findings in 78 files. Each record retains the key, rule, message, original line, text range and secondary flows. Resolve the full inventory.

## Scope and invariants

Modify only `src/**` and existing root `tests/**` files implicated by findings or necessary behavioral tests. Small helpers in `src/` are allowed; notify root of any new test file requiring central registry registration. Do not change `tests/run_all.js`, frontend, Python, dependencies, configs, scanner scope, thresholds, workflows, certification receipts or plan inventory. Preserve API contracts, raw-input rejection, error redaction, deterministic digest inputs, locale-independent ordering, currency precision, credential generation and account/position identity, trading authorization, timeout/unknown outcomes, replay and restart safety. Optional chaining and nullish coalescing must not change false/zero/empty/null semantics. Regex simplification must retain the exact accepted language and anchoring. Default object stringification findings need safe meaningful handling, not unchecked casts or moved unsafe coercion.

## Execution

1. Confirm clean worktree and no drift from e03eacf. Read the full inventory and affected contexts before editing. Group findings by rule, preserve an issue-ID accounting file in ignored `tmp/`, and inspect secondary locations for nested conditionals or templates.
2. Resolve findings in bounded groups with small explicit helpers, non-mutating sorts where callers need order preservation, readable branches, safe diagnostics and precise type handling. Do not change workflow/risk semantics to satisfy a style rule. No blanket suppressions, inserted no-op calls, dropped assertions or changed quality limits. Report a suspected false positive with exact ID and evidence to root.
3. Test changed behavior with relevant existing tests, then run lint/typecheck, the complete backend test suite and architectural/complexity checks. Use actual evidence for all test claims; root independently reruns integration coverage. All 223 original IDs must be accounted for, but actual scanner closure belongs to a later live analysis.
4. Commit in this isolated local branch, in logical units. Do not push, merge, alter settings or update the plan index. Return commits, files, verification and remaining concerns.

## Commands and done criteria

Use Node 22 in `C:/Users/nikla/AppData/Local/npm-cache/_npx/519c93549f30fecf/node_modules/node/bin`, npm 10 at adjacent `npm/bin/npm-cli.js`, and set `TSX_TEST_PYTHON` to `C:/Users/nikla/Documents/ChatGPT/TSX CORE SERVER INSTALLATION/tmp/tsx-python-test-env/Scripts/python.exe`. Dependency junctions already exist; do not reinstall shared dependencies. Run `npm run lint`, `npm run typecheck`, `node tests/run_all.js`, `npm run quality:architecture`, `npm run quality:complexity`, and `git diff --check`. All must pass; baseline is 209 backend test files. No changed function may exceed cognitive complexity 15. Stop and report baseline drift, required out-of-scope changes or unresolved semantics; root resolves obstacles while independent work continues.
