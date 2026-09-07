# Plan 001: Resolve all frontend Sonar findings

- Planned at: `e03eacfa3ea482d3be56f731f970b58761dd2510`, 2026-09-07.
- Priority P2; effort L; regression risk medium; dependencies none.
- Executor worktree: `C:/Users/nikla/Documents/ChatGPT/TSX CORE SERVER INSTALLATION/tmp/tsx-core-sonar-frontend`.
- Exact inventory: `tmp/sonar-baseline.json`, 280 findings in 73 files, including source and test locations. Each record retains the key, rule, message, original line, text range and secondary flows. Resolve this full inventory, not only a selected severity.

## Scope and invariants

Modify only `frontend/src/**`, `frontend/tests/**` and `frontend/e2e/**`. New small helpers or meaningful regression tests in those paths are allowed. Do not change dependencies, configs, scanner exclusions, thresholds, workflows, receipts, backend files or plan inventory. Preserve operator permissions, confirmations, review-hash ordering, operation IDs, stale-response handling, form behavior, accessible interaction, CSS rendering and human-facing content. Native HTML semantics must preserve layout, keyboard and form behavior. Do not solve warnings by removing accessibility semantics, adding redundant ARIA, blanket suppressions or dropping assertions.

## Execution

1. Check `git status --short` is clean and `git diff e03eacf HEAD -- frontend` shows no source drift. Read the inventory and affected code before edits. Group by rule and produce a per-issue accounting file in ignored `tmp/`. Most recurring issues are nested conditionals, readonly props and native semantic elements; still inspect every affected context.
2. Apply semantic fixes in bounded groups. Use explicit branch helpers for nested conditionals, readonly props, stable data identities for list keys, associated labels and appropriate native elements. Preserve empty/zero/false/null distinctions. Do not insert no-op asynchronous work or casts merely to silence rules. If a finding is truly incompatible with intended behavior, report its exact ID and reasoning to root instead of making an arbitrary disposition.
3. Run frontend ESLint, TypeScript, full frontend tests/coverage and build. Add regression tests only for meaningful behavioral changes. Root performs browser integration and final live Sonar verification. Record every original issue key as corrected or explicitly unresolved with a reason; do not claim scanner closure from source inspection.
4. Commit only in this isolated local branch, in logical units. Do not push, merge, change settings or update the plan index. Report commits, complete file list, test results and remaining concerns.

## Commands and done criteria

Use Node 22 from `C:/Users/nikla/AppData/Local/npm-cache/_npx/519c93549f30fecf/node_modules/node/bin` and npm 10 from the adjacent `npm/bin/npm-cli.js`. Locked `node_modules` are already provided by junctions; do not reinstall into shared dependencies. Run `npm run lint --prefix frontend`, `npm run test:coverage --prefix frontend`, `npm run build --prefix frontend`, and `git diff --check`. All must succeed. The existing baseline is 217 passing tests in 27 files. Changed functions must stay within cognitive complexity 15. Verify changed-file scope and account for all 280 issue keys. Stop and report an unexpected baseline, required out-of-scope change or unverifiable semantic assumption; root will resolve it while independent work continues.
