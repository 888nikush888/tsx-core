# Release audit: PR checks and coverage scope

Quality OS runs on pull requests targeting `main`, as well as the existing main,
release-tag, scheduled and manual events. All matrix checks keep their existing
names and thresholds. The dependency review now runs on PRs, including the
existing private-repository vulnerability/dependency-policy fallback.

Concurrency groups include the event type as well as the workflow and ref.
Scheduled and manual runs therefore cannot cancel the main push run required as
release evidence. Newer pushes and updates to the same PR still cancel their
superseded runs; separate PRs retain separate groups.

## Sonar evidence before and after merge

The Sonar job checks out the PR head commit and proves that exact SHA before
analysis. Sonar's supported GitHub Actions detection supplies the PR key, source
branch and target branch. Normal test/build jobs retain GitHub's merge-candidate
checkout. Neither a skipped PR Sonar scan nor an unavailable token is a passing
analysis: fork PRs fail the Sonar job with an explicit availability message, and
must be moved into a trusted same-repository candidate for protected merging.
The workflow uses `pull_request`, never `pull_request_target`.

PR evidence is separate from main evidence:

- The scanner compute task must have the expected task/project identity and a
  successful analysis ID. Only revision, PR key, source and target are extracted
  from its scanner context; the full context, which can contain secrets, is
  neither logged nor persisted.
- `project_pull_requests/list` must identify exactly the expected PR, branch,
  base and `commit.sha`, with an analysis date. The snapshot is checked again
  after capture; a changed revision/date fails the export.
- All issue pages and both resolution partitions are read with `pullRequest`.
  The quality gate is read by the compute task's exact `analysisId`, and must
  report `OK`. No open blocker/critical issue (including high-impact severities)
  is accepted.
- The legacy hotspot search API has no supported PR filter. PRs therefore use
  the documented `measures/component` PR filter and the
  `new_security_hotspots` / `new_security_hotspots_reviewed` metrics. The count
  must explicitly be zero, or every hotspot must be reviewed (100%). Missing,
  malformed or unreviewed measures fail. `hotspot-review.json` is hashed and
  checked against the summary; PR hotspot counts are in this aggregate evidence,
  while legacy individual hotspot artifacts remain empty for PRs. No main
  hotspot data is substituted and no absent metric is interpreted as zero.
- Artifact hashes, byte lengths, finding partitions and counts remain required.

After merge, the full main analysis still requires its exact revision and
compute-task analysis ID, stable analysis, quality gate `OK`, zero unreviewed
individual hotspots and zero policy-blocking issues across main. A green PR
analysis does not replace that release check. Scanner failures remain failures
even when diagnostic evidence was successfully exported.

The CI configuration makes checks available; GitHub branch protection, review
requirements, code-owner review and last-push approval must still be enforced by
repository settings and verified separately. It does not change review counts
or confer a real-provider trading acceptance.

## Coverage measurement

`.coveragerc` measures executor and executor-tool source, excluding `tests/` and
`test_*.py` only from the denominator. Both CI Python coverage runs still execute
the complete `unittest discover -s exchange_executor/tests -v` suite. The 60%
combined line/branch threshold is unchanged and also checked in the Sonar job.
The XML report consequently contains source coverage without executed test-code
inflation. Critical/module JavaScript thresholds are unchanged.

The Sonar-specific backend LCOV report measures `src/**/*.ts`, retaining the
existing CLI coverage filter. It no longer requests `scripts/**/*.js`:
those tooling files are outside `sonar.sources` and caused unresolved LCOV
warnings despite existing on disk. All tests in `tests/run_all.js` still execute,
including tooling tests; their other CI checks and coverage gates are unchanged.
The frontend report, licensed Sonar source scope and exclusions are unchanged.

`normalize_lcov_paths.js` resolves backend paths from the repository root and
frontend paths from the frontend root, then writes repository-relative `SF:`
paths. It preserves every LCOV record and counter; missing paths, directories,
empty reports and paths outside the repository fail. It introduces no Sonar
source exclusions or scanner-warning suppression.

## API references checked on 2026-09-07

- [Sonar GitHub Actions analysis](https://docs.sonarsource.com/sonarqube-cloud/advanced-setup/ci-based-analysis/github-actions-for-sonarcloud)
- [PR analysis scope and checkout prerequisites](https://docs.sonarsource.com/sonarqube-cloud/improving/pull-request-analysis)
- [Live SonarCloud API schema](https://sonarcloud.io/api/webservices/list)
- [PR list response example including commit SHA](https://sonarcloud.io/api/webservices/response_example?controller=api%2Fproject_pull_requests&action=list)
- [SonarCloud metric definitions](https://sonarcloud.io/api/metrics/search?ps=500)

The supported PR evidence APIs and metrics must remain available to the analysis
token. Permission failures, plan limitations and removed metrics are blocking
availability failures, not permission to reuse a main analysis or skip a gate.
