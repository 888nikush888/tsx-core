# Codacy full inventory and individual review, 2026-09-17

The repository/main snapshot at `58c01bc74f83cc212849ddcd7e487412ff06b2b7` contains **92 active and 347 ignored findings**. All 439 records are represented in [the occurrence ledger](final-codacy-2026-09-17.json). The code review identifies 59 active false-positive candidates, renews 343 current ignored code occurrences, and records four superseded ignored statements separately. The remaining 33 active Trivy records are stale/incomplete provider results, not approved false positives and not a clean dependency scan.

Each code occurrence was reviewed against its actual source scope and controlling callers/validation. Historical comments were leads, not authority. The ledger retains exact baseline Git blob/hash bindings, source locations, operation kinds, controlling-flow explanations, limits, and a separate final-source review. Numeric literal warnings were independently checked through the AST: every live reported literal is an exactly represented safe integer. Credential source values and source-line text are omitted. No remote ignore/unignore operation is performed by this package.

Final semantic renewal is complete against source commit `161c6d38771d4814bc78195171832c2682ceb0b4`: 116 bound source/context files, including 14 changed prior files and three new helper/test/registry contexts. The changed contexts affect 28 existing occurrence records. The source-manifest SHA256 is `9f40f7fa0ae4fbb4c4be346be10eb0461dc75dc9da2a318a5122246dbf9a1fab`. The integrity command, its contract suite and targeted ESLint with zero warnings passed. This does not claim a provider scan of that final source commit.

The final source integrity command is `node scripts/check_final_codacy_review.js` under Node 22. It checks the reviewed source and caller files, inventory completeness and line evidence, and fails on later drift. It never renews a hash or changes a provider decision. A successful result verifies evidence consistency; it does not establish analyzer success. Its contract test is `node tests/test_final_codacy_review.js` and includes changed-source, changed-caller, missing-context, missing-line, pending-review, duplicate and count-mismatch failures.

## Inventory completeness

- Active search: 92 unique records, one page. Ignored search: 347 unique records, four pages; every ignored record has reason `FalsePositive`. No active/ignored identity overlap. The provider's potential-false-positive filter returned zero; that filter is not a review result.
- File inventory: all 1,214 files, 13 pages. Their `totalIssues` sum is 59. The current `monitoring/govulncheck/go.mod` file reports zero issues, while repository issue search retains 33 older Trivy records referring to Go 1.26.0. Exact baseline and Codacy file content both declare Go 1.26.6.
- Configuration: 14 enabled tools, 6,758 patterns fetched completely, 1,873 enabled and 4,885 disabled. Enabled patterns inherit the Default coding standard; zero custom/nonstandard enabled patterns. No repository ignored-file entries or Codacy configuration file were found. No rules, tools or exclusions were changed.
- Initial analysis ran 10:56:38–10:57:22 UTC. The normal UI reanalysis ran 12:14:36–12:15:07 UTC on the same SHA. A full post-reanalysis search at 12:30:14 UTC still returned 92 active and 347 ignored records.
- PR 72's passing delta (0 new, 21 fixed at `d6dcdd7c5fce992d86452b822867cf11be97d663`) is a different measurement from repository-wide findings. Its tree matches the baseline, but its passing delta is not zero repository findings or proof of complete analysis.

Ignored local exports in `reports/final-findings/codacy-*.json` retain the sanitized active/ignored pages, configuration, file inventory, exact-SHA logs, initial manifest, location mapping, API authorization result, role checks and fresh UI-triggered analysis outcome. Provider `lineText` values and potentially credential-bearing scanner messages/historical comments are replaced with SHA256 commitments. The fresh ledger records credential type and provenance without values. These exports are evidence, not new suppression configuration.

## Every rule family

The full provider identifiers are retained in the JSON ledger; labels below shorten only repeated prefixes.

| Rule family | Active | Ignored |
|---|---:|---:|
| Bandit B101 | 0 | 2 |
| Bandit B104 | 0 | 1 |
| Bandit B105 | 0 | 28 |
| Bandit B106 | 0 | 1 |
| Bandit B404 | 0 | 6 |
| Bandit B603 | 0 | 7 |
| ESLint8 no-control-regex | 1 | 3 |
| ESLint8 security/detect-non-literal-fs-filename | 0 | 19 |
| ESLint8 security/detect-object-injection | 0 | 7 |
| ESLint8 security/detect-possible-timing-attacks | 0 | 1 |
| ESLint8 security-node/detect-possible-timing-attacks | 0 | 1 |
| ESLint8 security-node/detect-unhandled-async-errors | 0 | 3 |
| PMD InnaccurateNumericLiteral | 0 | 20 |
| Prospector pyflakes | 0 | 1 |
| Pylint E0203 | 0 | 1 |
| Pylint W0102 | 0 | 5 |
| Pylint W0221 | 0 | 3 |
| Opengrep detected-sonarqube-docs-api-key | 0 | 3 |
| Opengrep javascript/dos/non-literal-regexp | 0 | 21 |
| Opengrep javascript/eval/eval-with-expression | 0 | 3 |
| Opengrep javascript/pathtraversal/non-literal-fs-filename | 0 | 37 |
| Opengrep path-join-resolve-traversal | 8 | 73 |
| Opengrep prototype-pollution-loop | 0 | 2 |
| Opengrep unsafe-dynamic-method | 0 | 5 |
| Opengrep python/dangerous-subprocess-use-audit | 0 | 7 |
| Opengrep crypto/node-timing-attack | 0 | 3 |
| Opengrep eval/eval-nodejs | 0 | 1 |
| Opengrep headers/generic-header-injection | 0 | 1 |
| Opengrep ssrf/node-ssrf | 50 | 82 |
| Trivy vulnerability_high | 22 | 0 |
| Trivy vulnerability_medium | 9 | 0 |
| Trivy vulnerability_minor | 2 | 0 |
| **Total** | **92** | **347** |

## Decision boundaries and superseded records

All 50 active SSRF reports are local web-server fixture fetches; their private caller chain derives the destination from the actual ephemeral loopback listener. The eight active traversal reports select fixed backup-scheduler fixture paths under `mkdtemp`. The active control-regex report deliberately rejects control characters from workflow history labels; weakening validation to remove it is inappropriate.

The ignored production occurrences were reviewed separately from fixtures. Filesystem paths use operator startup authority or explicit canonical/member/ownership guards; this review does not turn lstat/read sequencing into a race-proof OS guarantee. Operator-configured webhooks and HTTPS endpoints remain operator trust boundaries. The cleartext service host allowlist is not misrepresented as a universal HTTPS/redirect allowlist. Public digest/capability comparisons are distinguished from secret authentication comparisons. Dynamic property reads and closed dispatch tables are checked at their actual callers, including authentication and permitted-key boundaries.

Regex matching in signal/schema and filters retains bounded VM execution; the log-search worker retains owner termination. Python mutable defaults capture fresh per-iteration test values rather than accumulating shared application state. Subprocess fixtures use fixed executable/script/phase authority and private test roots. Assertions are local test contracts. Credential-shaped values are synthetic inputs, field labels, cursors, or public Git/action metadata; no source values appear in this record. Function-constructor tests execute fixed named declarations from trusted checked-out source through the installed TypeScript compiler, with fixture values passed later as data. This is not a sandbox guarantee.

The previous 343-record review package could not simply be renewed from file hashes: only 97 source bindings and 72 complete source/context sets still matched the baseline. All current occurrences were reviewed anew. Four additional later ignored records were included as well.

| Superseded ignored ID | Current disposition |
|---|---|
| `732f68a52feca6faee35ed0fb4ff1156` | Old schema matcher removed; current matcher is separately reviewed under `757f1b7f1e131822522fc6812066e0d6`. |
| `bcc491e9fbd07391b500810e103d52e2` | Old module-coverage numeric fixture statement is absent. |
| `ef97adb8ab0f95227d11fb4105a8c75d` | Old workflow validator dispatch statement is absent; replacement kind/DB constraints were inspected. |
| `fda6a264aefb274f456acd3e83a130aa` | Old contract RegExp statement removed; current syntax-only construction is separately reviewed under `78b31b234a8932e9787ca8054b286d82`. |

Final source changes were re-reviewed for their effects on these decisions. The JSON records the changed-file reasoning and final file manifest. The newly added TDLib identity extraction test introduces another trusted-source Function constructor; it is recorded as an additional reviewed candidate without inventing a provider issue ID. Remote dispositions require an actual matching current provider occurrence and cannot be inferred from that candidate.

## Analyzer recovery and remaining provider dependency

Both attempts fail **Trivy** on `monitoring/govulncheck/go.mod:1` with `Line numbers not supported`. The current file declares Go 1.26.6, yet issue search retains 33 findings originally associated with 1.26.0. The [Codacy Trivy adapter](https://github.com/codacy/codacy-trivy/blob/master/internal/tool/tool.go) converts findings without line numbers into file errors. Current upstream also has a Go stdlib directive fallback; the deployed image and exact unlocated package in this run are not established by these logs. Therefore an adapter/version/result-mapping correction and successful exact-SHA reanalysis are still needed. Independent container/Go scans remain separate evidence and do not make this failed provider run successful.

Both attempts fail **ESLint**, container `codacy/codacy-eslint:9.18.10`, in `security-node/detect-unhandled-async-errors`, dereferencing a null `handler` while inspecting valid try/finally. The crashes identify `src/backup_cli.ts:22` (`restoreOfflineBackup`), `src/trading_recovery.ts:47` (`withDispatchWitness`), and `scripts/run_staging_e2e.js:30` (`withTimeout`). The [upstream rule](https://github.com/gkouziik/eslint-plugin-security-node/blob/master/lib/rules/detect-unhandled-async-errors.js) accesses `bodyArg.handler.type`; a try/finally has no catch handler. [Upstream PR 63](https://github.com/gkouziik/eslint-plugin-security-node/pull/63) guards a null catch parameter, a different condition. Its changelog is not proof this null-handler crash is fixed. Application Promise rejection timing, cleanup/finally semantics and receiver binding must not be rewritten to satisfy this plugin.

The documented API reanalysis request with `cleanCache:true` returned HTTP 403. Read-only checks succeeded for `/user`, organization membership and repository permission `admin`; [API-token documentation](https://docs.codacy.com/codacy-api/api-tokens/) supports account tokens and repository tokens, and the [API specification](https://api.codacy.com/api/api-docs) advertises both authentication forms for reanalysis. The [reanalysis guide](https://docs.codacy.com/faq/repositories/how-do-i-reanalyze-my-repository/) also describes committer membership and the normal UI action. The user restored the normal browser session and the UI request did run, as the fresh logs prove. Thus a missing user repository role or wrong token type is not established; the remaining repeatable failure is analyzer integration.

[Codacy's supported local ESLint workflow](https://docs.codacy.com/repositories-configure/local-analysis/running-eslint/) can upload results, but it requires build-server analysis configuration and an explicit tool/rule configuration. That is a possible separately validated recovery route, not an automatic substitute for this failed cloud run. Before adopting it, prove rule parity with the current 118 enabled ESLint patterns, preserve all source coverage, demonstrate that the null-handler case analyzes successfully, and bind results to the final SHA. No client-side migration, rule disabling, file exclusion or scanner upload was performed here.

An [unsent provider report](final-codacy-2026-09-17.provider.md) is ready from the two exact-SHA log exports: request confirmation of the deployed Trivy image and unlocated package, corrected Go directive/result mapping, and an ESLint rule build that handles valid try/finally without null dereference. Ask for successful exact-revision reanalysis and refreshed repository/file issue agreement. No provider/support message has been sent. The report must exclude credentials and credential source excerpts.

## Completion conditions

1. Finish source/caller review and retain a passing final integrity check before applying any new per-ID decision. Preserve native async rejection, finally cleanup, fixed fixture authority, SQLite receivers and money/accounting behavior.
2. Run the relevant application regression tests as part of the overall cleanup, including backup/restore/generation ownership, web/session/API behavior, regex timeout behavior and exchange identity/precision/dispatch fences. The Codacy integrity test is additional evidence, not a replacement for those tests.
3. Apply only individually evidenced current false-positive decisions after final-source verification; do not bulk-close stale Trivy findings or resurrect superseded ignored statements. Record any later remote outcomes in ignored evidence reports after source freeze.
4. Require successful Trivy and ESLint steps on the final revision, a fresh complete active/ignored export and per-file/repository reconciliation before describing Codacy analysis as complete. Until then, report the provider dependency explicitly even if the PR gate passes.
