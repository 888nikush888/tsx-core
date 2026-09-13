# Local historical fixer branch completeness — 2026-09-13

Reviewed committed integration revision: `122d65ab793c3f0913aa500cdc326af96ab32f82`.

Result: no missing product-code fix was identified among the 20 older local branches that are not ancestry-merged into this revision. There is one absent historical browser-verification JSON record, separately described below. It is evidence for an older checkout, not a product patch or current verification.

Method: enumerate every local ref with `git for-each-ref --no-merged=<revision> refs/heads`; run `git cherry <revision> <branch>` for each; individually inspect all three non-equivalent non-merge commits with their full patches; compare their changed paths against the integration revision. Also inspect non-ancestor merge commits using `git show --remerge-diff` so merge-only resolutions are not silently omitted. No remote refresh, branch mutation, source change, original-main worktree access or broad test suite was performed.

## Per-branch result

A negative cherry marker means an equivalent patch is already represented in integration history, despite the original commit not being an ancestor. Counts are branch-local and overlap across histories; do not sum them as independent patches.

| Local branch | Frozen head | Equivalent commits | Non-equivalent candidates |
|---|---|---:|---:|
| `codex/ci-audit` | `c4868c1d794ee3e87cb3e6fe1c3564984a45094f` | 1 | 0 |
| `codex/codacy-fixes-2026-09-08` | `ce29e9500086553e09f61e52c7b6881f2c9e7eed` | 57 | 0 |
| `codex/codacy-inventory-2026-09-08` | `4d6457cb1ca47dbd7a3261e3b5da58bdff4ea144` | 58 | 1 |
| `codex/governance-proof-2026-09-07` | `eb499680fe0b86e1f32c8c5599d963f379c7b8b6` | 0 | 1 |
| `codex/governance-response-fix` | `da183dc688311f0ab2fd128e1ff744e940cafb0e` | 1 | 0 |
| `codex/quality-event-concurrency-fix` | `ee8c12cde5c940378696d7b7a1d6a3c980e57cb3` | 1 | 0 |
| `codex/restart-recovery-audit` | `c2ecf43320b37d0ee49fce606567d5a6b6c2ef41` | 2 | 0 |
| `codex/scanner-export-2026-09-08` | `3fb8beb75703e44224bea49f51d4d99502bf0dc9` | 50 | 1 |
| `codex/security-web-quality-2026-09-08` | `20eb3012b0bef2277bb344f3df45822c81c836e1` | 2 | 0 |
| `codex/sonar-backend-2026-09-07` | `1ae7711ef73e1b64105f053c1fc0af4def31cdc3` | 2 | 0 |
| `codex/sonar-backend-coverage-2026-09-07` | `62551445b88925ef90485b1a7e2983861a2cc807` | 1 | 0 |
| `codex/sonar-explicit-pr-scope` | `e4d6f4ec3a4fcc69cb76b525746f045a16e6fe20` | 1 | 0 |
| `codex/sonar-frontend-2026-09-07` | `69e541d8812d51befaa28438dc2ab7cdc7be3956` | 4 | 0 |
| `codex/sonar-frontend-coverage-2026-09-07` | `bba30a8f35843fcce78c70f70f06f040f4996aed` | 1 | 0 |
| `codex/sonar-lcov-scope-fix` | `717e8acb744149a7cf48c9a09cac65db90a6e361` | 1 | 0 |
| `codex/sonar-python-2026-09-07` | `04f4b44650021ee5c6cddafbfb43ec2860d3e78d` | 5 | 0 |
| `codex/sonar-python-coverage-2026-09-07` | `1d2a64cdcc3abbb7289d18b807d5a81a1ea3902e` | 1 | 0 |
| `codex/sonar-reviewed-pr29-2026-09-07` | `24dc568fcddeab0027f8b0f39797c82553543bc8` | 1 | 0 |
| `codex/sonar-test-env-fix` | `11b8c3d6d1f552ad2c91b983001bf254e43b9868` | 1 | 0 |
| `codex/ui-quality-audit` | `023aae1a84e93114f32117e50bdd061d72c204d0` | 2 | 0 |

## Every non-equivalent candidate resolved

1. `codex/scanner-export-2026-09-08`, commit `19cfa733a76b45d739530ceafd7569af063f61c6`: **already integrated with an additional explanatory comment**. Integration contains `996af1dd2867295e58dd55d331c718a8c0b7a796` with the same title and helper extraction. Comparing the candidate's `scripts/sonar_scope.js` to integration shows only the two-line comment about refs being data and rejecting scanner interpolation. Comparing `996af1d` to integration for that path is completely clean. All six individual Sonar-scope finding entries and the 484-comparison evidence sentence are present in `security/deepsource-js-test-review-2026-09-08.json`. No missing executable hunk identified.
2. `codex/governance-proof-2026-09-07`, commit `cc7d216ee02b65ba53159673f66b12583b1eba88`: **intentional disposable negative verification artifact, not a product fix**. The entire patch creates `docs/testing/ci-governance-probe.md` saying that the PR intentionally modifies an audited build input without renewing implementation evidence, must fail that gate, is not a release candidate and will be discarded. Importing it would add an obsolete negative-test document. This branch's three otherwise non-ancestor merge commits (`e35f41708892a0b81d3814eeb0a6d5441d4b8cf2`, `40a69f7c5b82628bf620d4c6d1150a7a2930d848`, `eb499680fe0b86e1f32c8c5599d963f379c7b8b6`) have empty remerge diffs: no additional manual merge resolution patch was found.
3. `codex/codacy-inventory-2026-09-08`, commit `29c0ca037f3bdc61fd8c4cac1dce2ece38c8b5fd`: **one historical evidence record is absent; no product code is missing**. Its entire patch adds `docs/testing/deepsource-frontend-browser-verification-2026-09-08.json` (26 lines). The record binds a 196-case local Playwright run to historical revision `386a196113a3c69c26d898b537cfdec2ac8ea057`, frontend tree `f458e7719d1f1cfe874481cd7dd5ada3da7b930a`, log hash `55b0919c4e859b4ca2c2dd5f346fff80821a2fb2402176bd144716518545d853`, and explicitly acknowledges shared dependencies and additional parent API fixes. That file is absent from integration and does not appear in its path history. This review did not locate/revalidate the original log, so it must not be presented as fresh verification. The existing frontend inventory Markdown also discusses historical 196-case browser coverage, but is not asserted to be an exact replacement for this particular receipt. Retain the commit reference if historical evidence needs importing later.

## Explicitly requested examples checked

- `codex/codacy-fixes-2026-09-08`: all 57 branch-only non-merge commits have equivalent patches in integration; no non-equivalent patch remains.
- `codex/security-web-quality-2026-09-08`: both patches are equivalent. `119049ba2ebca6c081f86c0a3a13c49a1f2b38f1` is represented by `94ed395ed2e5fdd2d0cfd9b700119a0301d59f66`; `20eb3012b0bef2277bb344f3df45822c81c836e1` by `49bb1b7`. Current `tests/test_trading_history.js` still fixes all checkpoint timestamps to 1 and compares all checkpoint fields after sorting by source, preserving the scheduling-tie regression test.
- All listed Sonar backend, frontend, Python, coverage, PR-scope, environment and LCOV branches have zero non-equivalent non-merge candidates.

## Boundaries

This is a committed-branch completeness check, not another line-by-line re-audit of every equivalent historical patch after all later modifications. Patch equivalence establishes integration history; later intentional rewrites are handled by the main merge review and current tests. Uncommitted work in other worktrees was not inspected or imported. The separate 25-frozen-head ancestry ledger remains authoritative for the newly requested remote fixer branches. No scanner finding is declared closed by this branch inventory.
