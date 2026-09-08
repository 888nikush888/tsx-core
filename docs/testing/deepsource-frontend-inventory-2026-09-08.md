# Frontend DeepSource review, 2026-09-08

Scope: frontend/src, frontend/tests and frontend/e2e. The complete export contains 4,459 occurrences; this ownership scope contains 847 unique occurrence IDs. Baseline commit: be8cf5af59f60d69ad946d778973add8161b7672. The accompanying JSON binds every occurrence to its original source SHA-256 and records the locally reviewed source SHA-256 by path. Original export and execution logs stay in ignored reports.

This is an in-progress ledger, not a claim that the frontend scan is clean. At implementation commit d10ad71, 102 occurrences have a local fix awaiting rescan, 8 have a concrete proposed false-positive rationale, and 737 remain open for review. No platform status, rule or quality threshold was changed. Hash binding identifies the reviewed text; it does not make a pending occurrence reviewed.

## Implemented changes

- 57bfdb5: explicit presence guards replace source non-null assertions; generic chart rows retain consumer fields and validate currency. Missing graph selections fail before mutation. Original UTF-16 edge hashing is preserved.
- c061252: evidence cells use unknown with existing runtime narrowing; search observation, group and entry types match the metadata-only search API.
- 33ea619: missing unit-test fixtures fail explicitly before use; original assertions remain. Two literal label regexes use Unicode matching, and a JSX boolean uses shorthand.
- f0c2e01: redundant fragments and string concatenation simplified without changing rendered content.
- 58fe31b: 25 literal-only mock callbacks explicitly return resolved promises, preserving asynchronous callback return contracts.
- 488a98c: exact money chart coordinate validation separated from currency grouping. Complete accounting, exact-value, finite-number and nonzero-underflow checks remain mandatory.
- 44400e3: browser fixtures read request data and viewport once, use explicit missing-value guards, and capture the published resource ID before lookup. Literal label regexes use Unicode matching.

- fe26029/18a3c29: typed equity observation/account inputs and separate validation, grouping, series ordering and per-currency presentation. Numeric/object modes remain excluded.

## Verification

Node 22.23.2 and the locked dependency tree were used. Frontend TypeScript/Vite build, oxlint and all305 unit tests pass after the implementation. Before the final equity extraction, Chromium passed all49 browser tests on an isolated local development server at port 4187. Firefox, WebKit and mobile Chromium each also pass all49 cases (147 additional passes;196 browser passes total). There were no live provider, exchange or deployment acceptance checks.

Logs: reports/security-services/deepsource-frontend-*-build.log, *-tests.log, *-lint.log and *-e2e-chromium.log. The temporary browser configuration changes only the local server port, output path and worker count; it preserves the checked-in projects and test cases.

## Reviewed contract exceptions

Explicit undefined is required for the React 19 useRef initial argument and React state dispatch calls. The Vitest matcher with undefined verifies exactly one argument; removing it changes what the test proves. The browser SilentResizeObserver is deliberately an inert deterministic geometry fixture. These eight findings remain proposed dispositions until the platform review is applied through the authorized review process.
