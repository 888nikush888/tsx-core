# Independent review of regex fixer branches

Reviewed 2026-09-11 against integration baseline `d72cf40d029a4df4e916bd586e5ad884ea2c9f83`. This review inspects each branch's changes from its merge base with that baseline and compares the affected patterns with the baseline implementation. It does not claim a final integration test or scanner result.

| Branch suffix (`origin/deepsource-autofix-`) | Reviewed head |
| --- | --- |
| 03965093 | `25f65f7c18fa70f68afa3087027446cfa60140d1` |
| 4907ff91 | `1fcb19b4bfaaf8481f4bbe168268f7a30472c650` |
| 953b964c | `5edc9e5a6066ee3aa8589988da560f8ac078c075` |
| 6ca8828e | `c621b6613c399b4e3b1f5078904e7cdc60263865` |

## Decision

Retain the original character policy for every non-equivalent proposal. These are established identifier, path, journal, and review-input contracts; changing their accepted character sets is not an equivalent lint fix. Reject the syntax error, missing path separator check, and weakened client-identifier checks. Equivalent escape-spelling changes may remain in their original form to avoid unnecessary churn. Exact Unicode-property substitutions are optional only where the original complete set is identical.

All affected original patterns remain in the reviewed integration baseline. Its `scripts/verify_exchange_implementation.js` pattern already additionally uses the `u` flag; that does not change this pattern's accepted character set.

## Complete pattern accounting

E = equivalent; B = broadens rejection and changes accepted data; X = concrete regression or accidental change; unchanged = branch has no hunk. C0 means U+0000–U+001F, DEL U+007F, and C1 U+0080–U+009F. Script paths below are under `scripts/`; other paths are under `src/`.

| File and pattern | 03965093 | 4907ff91 | 953b964c |
| --- | --- | --- | --- |
| `scripts/exchange_acceptance_contract.js`: data key | B: adds C1 | B: adds C1 | E |
| `scripts/sonar_review_decisions.js`: rationale | E | B: adds C1 | E |
| `scripts/sonar_review_decisions.js`: branch ref | X: literal newline makes regex invalid syntax | B: permits only printable ASCII refs | X: accidental extra `^` exclusion |
| `scripts/sonar_scope.js`: ordinary branch ref | E | B: adds 51 rejected code points | B: same |
| `scripts/sonar_scope.js`: PR branch/base refs | E | B: adds 51 rejected code points | B: same |
| `scripts/verify_exchange_implementation.js`: relative source path | E | B: adds C1 | E |
| `backup.ts`: template path segment | B: adds DEL/C1 | B: adds DEL/C1 | X: removes forbidden backslash |
| `backup_generation.ts`: archive member segment | E | B: adds DEL/C1 | E |
| `exchange_contract_validation.ts`: identifier | E | B: adds DEL/C1 | E |
| `exchange_history_contract.ts`: token | E | B: adds DEL/C1 | E |
| `exchange_order_identity_contract.ts`: identifier | E | B: adds DEL/C1 | E |
| `logger.ts`: ANSI escape sequence | E | E | E |
| `trading_account_log_contract.ts`: token | B: adds DEL/C1 | B: adds DEL/C1 | E |
| `trading_account_log_contract.ts`: economic field | E | B: adds DEL/C1 | E |
| `trading_accounting_contract.ts`: token | E | B: adds DEL/C1 | E |
| `trading_fill_identity.ts`: identifier | E | B: adds DEL/C1 | E |
| `trading_fill_quantity_contract.ts`: token | E | B: adds C1 | E |
| `trading_fx_contract.ts`: canonical key | E | E: complete Cc set | E |
| `trading_order_identity.ts`: stored client identifier | X: `\s` permits 27 formerly rejected controls | X: same | E |
| `trading_order_identity.ts`: local leg identifiers | E | X: `\s` permits 27 formerly rejected controls | E |
| `trading_order_repository.ts`: provider symbol | E | B: adds DEL/C1 | E |
| `trading_recovery_schedule_contract.ts`: account identifier | E: Cc+Cs | E: Cc+Cs | E: Cc plus original surrogate range |
| `trading_repository.ts`: external account identifier | E | B: adds C1 | X: changes policy to printable ASCII only |
| `workflow_repository.ts`: history label | E | unchanged | E |

## Verification and precise semantic differences

Node.js v22.23.2 exhaustively evaluated the relevant original/proposed single-character membership predicates for every integer code point U+0000 through U+10FFFF, including lone surrogate values created by `String.fromCodePoint`. Counts below describe the regex predicate matching a character, before surrounding validation logic; a newly matched character is generally newly rejected by its validator. These checks do not replace application tests.

| Original predicate | Proposed predicate | Newly matched | No longer matched |
| --- | --- | ---: | ---: |
| `[\x00-\x1f]` | `\p{Cc}` with `u` | 33 (DEL/C1) | 0 |
| `[\x00-\x1f\x7f]` | `\p{Cc}` with `u` | 32 (C1) | 0 |
| `[\x00-\x20]` | `\s` | 19 Unicode whitespace characters | 27 controls, including NUL |
| `[\x00-\x1f\x7f]` | `[^\x20-\x7E]` | 1,113,984 | 0 |
| `[\x00-\x1f\x7f-\x9f]` | `\p{Cc}` with `u` | 0 | 0 |
| `[\x00-\x1f\x7f-\x9f\uD800-\uDFFF]` with `u` | `[\p{Cc}\p{Cs}]` with `u` | 0 | 0 |
| `[\x00-\x20\x7f]` with `u` | `[\s\p{Cc}]` with `u` | 51 | 0 |
| Original backup forbidden-character class | 953b964c backup class | 0 | 1 (U+005C backslash) |

Equivalent `\xNN` to `\u00NN` changes preserve the same literal characters and existing ranges. The ANSI escape rewrite preserves the ESC character and the remainder of its pattern. Complete Cc and surrogate-set substitutions retain the same Unicode-mode handling, including valid surrogate pairs.

Reading `03965093:scripts/sonar_review_decisions.js` into Node's module syntax checker failed at the inserted newline in the branch-ref regex with `SyntaxError: Invalid regular expression: missing /`. This is an independently reproduced parse failure, not a speculative warning.

## RegExp construction branch

`6ca8828e` has one change in `src/signal_contract.ts`: `new RegExp(pattern, 'u');` becomes `const regexInstance = new RegExp(pattern, 'u');`. Construction and exception behavior remain identical, but the new variable is unused. The repository's TypeScript unused-variable rule reports such names as warnings, so this is not a net quality improvement. Retaining the original implementation is safe. If resolving a standalone-construction diagnostic, `void new RegExp(pattern, 'u');` expresses intentional validation while preserving construction and exceptions without introducing an unused local.
