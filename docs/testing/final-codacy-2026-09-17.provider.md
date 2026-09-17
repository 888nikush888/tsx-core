# Draft provider report — not sent

Repository: `gh/888nikush888/tsx-core`, main revision `58c01bc74f83cc212849ddcd7e487412ff06b2b7`.

Two analyses of the identical revision fail in the same analyzer integrations. Initial analysis: 2026-09-17 10:56:38–10:57:22 UTC. Reanalysis requested through the ordinary Codacy UI: 2026-09-17 12:14:36–12:15:07 UTC. The exact-revision logs are saved in the local sanitized exports `reports/final-findings/codacy-analysis-58c01bc7.json` and `codacy-reanalysis-outcome-58c01bc7.json`.

## Trivy result mapping

Both runs report `Error on file monitoring/govulncheck/go.mod:1. Cause: Line numbers not supported`.

The exact analyzed file is a valid Go module with `go 1.26.6` and direct requirement `golang.org/x/vuln v1.6.0`. The Codacy file-content endpoint also returns that current version. Nevertheless, the repository-wide issue search retains 33 findings naming `golang/stdlib@v1.26.0`, whereas the file's `totalIssues` is zero. The complete 1,214-file inventory totals 59 issues; repository search totals 92. The discrepancy remains after the normal UI reanalysis.

The public [adapter implementation](https://github.com/codacy/codacy-trivy/blob/master/internal/tool/tool.go) maps issues without a source line to file errors and includes a stdlib go/toolchain directive fallback. Please identify the deployed adapter image/version and the package/result that still lacks a line, correct or deploy the mapping fix, and rerun this exact revision. Please also reconcile the stale repository issue records with the current file results. We have not marked these vulnerabilities false positive or disabled the scanner.

## ESLint null-handler crash

Both runs identify container `codacy/codacy-eslint:9.18.10`, rule `security-node/detect-unhandled-async-errors`, and `TypeError: Cannot read properties of null (reading 'type')` in `isTryCatchStatement` at the plugin's line 41.

The reported functions are:

- `src/backup_cli.ts:22` — `restoreOfflineBackup`
- `src/trading_recovery.ts:47` — `withDispatchWitness`
- `scripts/run_staging_e2e.js:30` — `withTimeout`

These functions have valid try/finally cleanup. A try/finally AST node has a null catch handler, but the [upstream rule](https://github.com/gkouziik/eslint-plugin-security-node/blob/master/lib/rules/detect-unhandled-async-errors.js) reads `bodyArg.handler.type`. The older [PR 63](https://github.com/gkouziik/eslint-plugin-security-node/pull/63) concerns a null catch parameter, not a missing catch handler. Please supply or deploy a rule build that handles valid try/finally and confirm successful analysis of all three files and the complete repository. Application asynchronous rejection and cleanup semantics should not need to change to avoid an analyzer exception.

## Reanalysis authorization observations

A documented API request to `/api/v3/organizations/gh/888nikush888/repositories/tsx-core/reanalyzeCommit` with the commit UUID and `cleanCache:true` returned 403 `Operation is not authorized`. The same account token successfully reads `/user`, organization membership and repository permission `admin`. The normal logged-in UI request succeeded and produced the fresh analysis logs above. The [API specification](https://api.codacy.com/api/api-docs) and [token documentation](https://docs.codacy.com/codacy-api/api-tokens/) advertise account/project-token authentication. Please clarify the endpoint-specific authorization requirement if it differs; the evidence does not establish that the user lacks repository administrator permission.

No token, secret source value or credential excerpt belongs in a submitted report. The local permission export retains only the fields needed for this authorization diagnosis. No support message, rule exclusion, analysis-mode migration or tool disabling has been performed.

Success means the intended tools finish on the requested exact revision, repository and file inventories agree, and a complete fresh active/ignored export can be reconciled. The later local cleanup source revision `161c6d38771d4814bc78195171832c2682ceb0b4` must receive its own analysis after publication; these baseline runs are not claimed as final-source scan coverage.
