# Sonar backlog implementation

Planned at `e03eacfa3ea482d3be56f731f970b58761dd2510` on 2026-09-07. The user explicitly requested all 672 open Sonar findings to be resolved and the GitHub repository to be brought up to date. These are three independent execution scopes; integration, receipts, publication and live Sonar verification belong to the root reviewer.

| Plan | Scope | Findings | Dependencies | Status |
| --- | --- | ---: | --- | --- |
| 001 | Frontend source and tests | 280 | none | IMPLEMENTED; browser follow-up and live Sonar pending |
| 002 | Backend TypeScript and JavaScript tests | 223 | none | IMPLEMENTED; integration and live Sonar pending |
| 003 | Python executor and tests | 169 | none | IMPLEMENTED; 542 tests passed, live Sonar pending |

Existing `plans/` contains unrelated implementation evidence and is preserved. The initial inventory is the verified final-main Sonar export from run 34104645000. Exact issue IDs and original locations are retained in each executor worktree's ignored `tmp/sonar-baseline.json`.

No quality threshold, licensed Sonar scope, existing acceptance policy, certification status, required GitHub review or branch protection may be weakened. No live exchange action or production deployment is part of this source cleanup. Real-provider acceptance remains separate. Root will independently review changes, rerun the relevant checks, renew truthful source/SDK implementation evidence and confirm the original issue IDs in a fresh Sonar analysis.

Individually evidenced analyzer false positives are handled separately from code fixes. The deprecated `beforeunload.returnValue` API is retained as an explicitly documented compatibility exception for browsers that need it; it is not described as an analyzer false positive. Source and regression-test hashes bind each reviewed decision before any Sonar issue transition. The final accounting must distinguish source fixes, false positives, this compatibility exception and any remaining open findings.
