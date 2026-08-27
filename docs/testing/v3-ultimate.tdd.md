# V3 Ultimate: TDD evidence

## Source and user journeys

The journeys were derived from the V3 Ultimate request in the implementation thread; no external plan file was used.

- As an operator, I can connect exchange-account blocks in an ordered chain so a signal reaches the next account only when the current account does not list the pair.
- As an operator, I can see the selected, exhausted, or stopped chain in the Builder, dashboard, analytics, and MCP without risking duplicate execution.
- As an operator, I can rely on technical, account, risk, contract, timeout, and ambiguous-submit failures stopping fail-closed instead of activating another exchange.
- As a release operator, I receive a container that blocks known High/Critical findings and pins the fixed runtime packages.

## RED and GREEN evidence

| Guarantee | Test or command | Type | Result and evidence |
|---|---|---|---|
| Linear `A -> B -> C` chains compile while branches, cycles, and direct/fallback collisions are rejected | `node tests/test_workflow_fallback.js` | Integration | PASS; the three ranks compile and invalid graphs are rejected. |
| Only an identity-bound, side-effect-free `SYMBOL_UNAVAILABLE` response advances the chain | `node tests/test_ccxt_exchange.js` and `python -m unittest discover -s /tests -v` in the executor image | Unit/integration | PASS; 502/503, account, risk, contract, timeout, and ambiguous-submit paths stop. |
| Fallback intents are lazy, atomic, preserve the original entry TTL, and use account-local equity/risk/capacity | `node tests/test_workflow_fallback.js` | Integration | PASS; only the current rank has an intent and the selected account receives its own plan. |
| Builder arrows, connection inspection, accessibility, desktop, and mobile behavior work | `npm run test:e2e --prefix frontend` | E2E | PASS; 40/40 scenarios across Chromium, Firefox, WebKit, and mobile Chromium. |
| Frontend route and dialog behavior remains stable | `npm test --prefix frontend` | Unit/component | PASS; 82/82 tests. |
| Persistent runs survive backup/setup-bundle boundaries and retention protects active chains | `npm test` | Integration | PASS; all 62 test files. |
| The executor image must contain the fixed OpenSSL runtime | `node tests/test_supply_chain.js` before the Dockerfile fix | Supply chain / RED | Expected FAIL on missing `libcrypto3=3.5.8-r0`, reproducing the CI finding for CVE-2026-14456. |
| The executor image contains the fixed OpenSSL runtime | `node tests/test_supply_chain.js` after the Dockerfile fix | Supply chain / GREEN | PASS. |
| The fixed executor still satisfies its API and exchange contracts | executor-container `unittest discover` | Integration / GREEN | PASS; 29/29 tests. |
| No High/Critical finding remains in the fixed executor image | `aquasec/trivy:0.70.0 image --scanners vuln --severity HIGH,CRITICAL --exit-code 1 tsx-core-exchange-executor:cve-fix` | Security / GREEN | PASS; Alpine and every detected Python package reported zero findings. |

## Coverage and gates

- Authoritative clean Linux Node 22 module coverage: 95.06% statements/lines, 83.64% branches, and 99.21% functions. Every value improves the pre-feature baseline of 95.01%, 83.33%, 99.09%, and 95.01% respectively.
- Local frontend unit coverage and E2E suites passed; the critical runtime paths are additionally covered by the Node and Python integration suites.
- Lint, typecheck, production build, architecture, complexity, duplicate ratio, dependency/license policy, SBOM, monitoring, secret boundary, CodeQL, and browser accessibility gates were executed.

## Merge evidence

- Feature commit: `ebc5e7d` (`feat: add ordered exchange account fallback chains`).
- CI calibration: `d731c30` (`ci: calibrate coverage ratchet to linux runner`).
- Security RED checkpoint: `80c716e` (`test: require patched executor ssl packages`).
- The matching GREEN fix is the commit that adds the pinned 3.5.8-r0 packages and this report.

