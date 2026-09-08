# Plan 003: Resolve all Python Sonar findings

- Planned at: `e03eacfa3ea482d3be56f731f970b58761dd2510`, 2026-09-07.
- Priority P2; effort L; regression risk high; dependencies none.
- Executor worktree: `C:/Users/nikla/Documents/ChatGPT/TSX CORE SERVER INSTALLATION/tmp/tsx-core-sonar-python`.
- Exact inventory: `tmp/sonar-baseline.json`, 169 findings in 54 files. Records retain keys, rules, messages, original lines, ranges and secondary flows. Resolve the full inventory.

## Scope and invariants

Modify Python source/tests/tooling under `exchange_executor/**` only. Exclude certification JSON/reviews, SDK locks, dependency policy, trusted receipt hash pins and changes that enable quarantined profiles. Notify root if a source fix changes executor source hashes: it requires independently renewed implementation evidence, never fabricated provider acceptance. Preserve precision and accepted numeric syntax, account/credential binding, refusal of unknown provider states, backoff/deadlines, cancellation propagation and asynchronous interface contracts. Python `\d` accepts Unicode digits by default: replacing `[0-9]` must preserve ASCII boundaries with a scoped ASCII flag or an equivalent proven approach. Do not broaden accepted order/identifier syntax.

## Execution

1. Confirm clean worktree and no drift from e03eacf. Read all inventory entries and affected contexts before editing. Save per-key accounting in ignored `tmp/`.
2. Resolve the 125 exception-test scope findings by preparing fixtures/arguments outside `assertRaises` and retaining precisely the intended potentially failing call inside. Preserve expected exception, message and all postconditions; do not drop error-path assertions. Remove redundant exception subclasses only when catch/cancellation semantics are unchanged. Resolve regex, assertion argument order, async and remaining findings with meaningful code changes. No no-op awaits, disabled rules or casts used solely to evade analysis. Report genuine false-positive evidence by exact issue ID to root.
3. Run full Python unittest discovery and Ruff using the pinned Python 3.12 environment. Add meaningful regression cases where accepted syntax or error behavior could change. Root reviews the diff and renews implementation receipts after all integrations. Record all 169 IDs as addressed or unresolved; do not claim live scanner closure.
4. Commit locally in this isolated branch, in logical units. Do not push, merge, change repository settings or update the plan index. Return commits, complete changed-file list, actual test/lint results and concerns.

## Commands and done criteria

Pinned Python: `C:/Users/nikla/Documents/ChatGPT/TSX CORE SERVER INSTALLATION/tmp/tsx-python-test-env/Scripts/python.exe` (3.12.14, locked CCXT 4.5.75). Run `python -m ruff check exchange_executor`, `python -m unittest discover -s exchange_executor/tests -v`, and `git diff --check` using that interpreter. All must pass; baseline is 533 tests. No dependency updates, scanner exclusions, quality-threshold changes or fake provider execution. Stop and report baseline drift, required out-of-scope edits or uncertain contract behavior; root resolves obstacles while independent work continues.
