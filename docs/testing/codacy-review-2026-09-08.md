# Codacy PR 29 review disposition — 2026-09-08

Scope: the three comments returned by the GitHub API for
[PR 29](https://github.com/888nikush888/tsx-core/pull/29), evaluated against
merged main revision `be8cf5a`.

## URL credential redaction: confirmed and fixed

`src/ui_change_review.ts` previously checked only the interior of URL userinfo
with `userinfo.slice(1, -1).includes(':')`. This missed `:pass`, `user:`, and `:`.
Checking the complete userinfo preserves the bounded regular expression while
redacting credentials with an empty username or password. The review copy is
redacted; authoritative configuration and command inputs are not modified.

`tests/test_ui_change_reviews.js` now covers both personal-data modes, nested
arrays, empty credential components, ordinary usernames, and long inputs. The
former assertions that deliberately preserved empty credential components were
corrected. Username-only userinfo remains unchanged by this credential rule.

## SONAR_BRANCH shell injection: false positive in the current execution path

The suggested blanket restriction on backticks, dollar signs, and parentheses
is not applied. These characters can be part of legitimate Git branch names.

Evidence:

- `scripts/sonar_scan_arguments.js` outputs fixed property placeholders such as
  `-Dsonar.branch.name=${env.SONAR_BRANCH}`, never the actual branch value.
- `.github/workflows/quality.yml` executes that script directly and passes its
  fixed output to the scan action. Pull-request ref values enter through the
  workflow environment, not a shell script string.
- The exact pinned action, revision
  `22918119ff8e1ca75a623e15c8296b6ea4fbe28f`, parses the argument string with
  `parseArgsStringToArgv` and invokes `exec.exec(scannerBin, scannerArgs)`.
  [Pinned action source](https://github.com/SonarSource/sonarqube-scan-action/blob/22918119ff8e1ca75a623e15c8296b6ea4fbe28f/src/main/run-sonar-scanner.js)
- The scanner resolves the environment placeholders after that argument
  boundary. `sonarScope` rejects `${...}` scanner expressions and whitespace or
  control characters, so a ref cannot supply another scanner property through
  this mechanism.
- Sonar API reads use encoded query parameters rather than command execution.

`tests/test_sonar_branch.js` checks exact ref preservation and now executes the
real argument preparation script with shell punctuation in `SONAR_BRANCH`.
It verifies that the entire output contains only the expected fixed argument
template. Existing branch and pull-request tests also cover rejected scanner
interpolation and property delimiters. This is a regression guard for the
current boundary, not a claim that arbitrary future shell interpolation would
be safe.

## Repeated web-handler catch logic: optional maintainability recommendation

No behavior defect was identified and no refactoring was performed.
`src/web_server.ts` already centralizes JSON error responses in `sendError`.
Handlers retain endpoint-specific conversion policies. In particular,
`uiWorkflowModelsHandler` maps unexpected GET failures to 400 and mutation
failures to 409 while preserving explicit `HttpError` status codes such as 404.
Blind catch consolidation could change those semantics.

Existing `tests/test_web_server.js` assertions exercise model lookup 404,
invalid kind 400, viewer mutation 403, and missing confirmation 412. These
were inspected as evidence of intended behavior; this review did not modify
or rerun that web-server suite. The recommendation remains optional and is
not represented as a fixed security vulnerability.

## Local validation

Passed on Node 24.14.1: TypeScript typecheck, ESLint for changed source/tests,
`git diff --check`, and the following suites:

- `test_ui_change_reviews.js`
- `test_sonar_branch.js`
- `test_sonar_pull_request.js`
- `test_sonarcloud_export.js`
- `test_sonar_evidence.js`

The project requires Node 22. The integrating task must repeat verification
under that supported runtime and run the complete required CI checks before
claiming release readiness. No external Codacy finding status was changed by
this local review.
