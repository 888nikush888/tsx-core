# Snyk onboarding

`.github/workflows/security-services.yml` runs for trusted pull requests, main
pushes, a weekly schedule, and manual dispatch.
It does not modify existing Quality OS gates or install scanner dependencies
into application manifests. Fork pull requests cannot read repository secrets;
their skipped credential-dependent job is not a clean scan.

Configure the GitHub repository secret `SNYK_TOKEN`; optionally configure repository
variable `SNYK_ORG` with the organization ID. Snyk Code must be enabled for that
organization. Missing credentials, entitlement failures, and unsupported scans
fail visibly rather than producing a clean assessment.

The workflow installs exactly Snyk CLI `1.1307.1` and runs five independent scans:

- Backend `package-lock.json`, including development dependencies.
- Frontend `frontend/package-lock.json`, including development dependencies.
- Python `exchange_executor/requirements.in` with the explicit pip parser,
  resolving the installed dependency tree from the verified runtime lock.
- Python `exchange_executor/requirements-dev.lock` with the explicit pip parser.
- Repository Snyk Code analysis.

Python dependencies are installed using both hash-locked requirements files,
Python 3.12 and binary wheels only. No application build or native Node rebuild is
needed for these scans. Node 22 runs the CLI. The five jobs do not cancel each
other when one finds a problem.

The universal runtime lock includes mutually exclusive Windows/Linux packages.
Snyk's direct lock parsing reported missing platform packages on Windows despite
a complete hash-verified installation. Scanning the declared root requirements
instead traverses the actually installed CCXT tree. CI scans the Linux tree;
local Windows scans provide additional platform evidence. Neither scan alone is
described as covering packages that only install on the other platform.

No severity or fixability filter is introduced. Dependency
scans use `--ignore-policy`. Snyk Code instead supports `--include-ignores`; its
SARIF is checked for every result, including suppressed results, since a zero
CLI exit alone does not prove that no ignored findings exist. Existing server
policies and scan coverage still require review during actual onboarding.

Code results now also pass through `scripts/check_snyk_code_review.js`. Only
independently confirmed, individual false positives can satisfy that check:
the complete fingerprints, reported locations/dataflows, primary file hash and
every reviewed context file must still match. Open findings, unapproved risks,
new identities, changed source, missing flow bindings and invalid scan evidence
remain failures. The raw findings are retained; a passing reviewed scan is not
reported as having zero scanner results. The original SARIF hash and reviewed
Git revision in the ledger document the review's provenance; the checked source
and exact per-finding evidence determine its applicability to the current scan.

The owner's explicit acceptance of four internal HTTP findings is separate from
false-positive review. The checker pins the acceptance document's exact SHA-256,
four identities/rules/paths and the existing 30-day policy. A verified acceptance
still requires every source and flow binding to match. It cannot extend to other
findings, survive altered evidence, or pass after expiry. Artifacts report accepted
risks separately from false positives and unresolved findings.

Each scan uploads its own SARIF, optional native JSON, and status JSON, including
the Git revision, scanner version, original exit code, result count and disposition.
Snyk may omit the native Code JSON on a clean scan; SARIF and status are mandatory
for a successful gate. Scan errors (including invalid evidence) and findings have
different dispositions and both fail the job. Artifacts remain available for
14 days. Code additionally uploads the individual review outcomes. Setup failures
can occur before scan evidence exists and remain explicit
failed job steps; the artifact step does not manufacture findings evidence.

## Verification performed before authenticated onboarding

- Workflow syntax and expressions validated with actionlint 1.7.12.
- Extracted scan step executed under Bash with scanner fixtures: clean result,
  findings, suppressed-only findings with exit zero, scan error, unsupported
  project, invalid evidence, and empty SARIF runs. Expected gate statuses passed
  for all seven cases.
- `git diff --check` passed.

These checks validate workflow mechanics, not live Snyk account access or results.
An authenticated GitHub run remains required before claiming integration
success or zero findings.

The subsequent independent review of the source-bound Code checker reproduced
and corrected six malformed-evidence cases. Sixteen regression tests pass. The
85-result historical CI scan evaluates to 80 reviewed false positives and five
open findings against its exact Git source. Later source changes require renewed
review; those historical counts do not certify the current branch. The four
dependency jobs have passed in authenticated GitHub runs; Code remains blocking.
The updated shell step was also exercised with ten fixtures, including reviewed
and unreviewed findings, suppressed results, source drift, malformed flows and
scanner failures. Expected exit codes and recorded dispositions all matched.

## Official references

- [Dependency test options](https://docs.snyk.io/developer-tools/snyk-cli/commands/test)
- [Snyk Code test options and exit statuses](https://docs.snyk.io/developer-tools/snyk-cli/commands/code-test)
- [Snyk Code ignore semantics](https://docs.snyk.io/manage-risk/prioritize-issues-for-fixing/ignore-issues/consistent-ignores-for-snyk-code/snyk-cli)
- [CLI options summary](https://docs.snyk.io/snyk-cli/cli-commands-and-options-summary)
- [Pinned CLI Code implementation](https://github.com/snyk/cli/blob/v1.1307.1/src/lib/plugins/sast/index.ts)

The action revisions match the existing `quality.yml` pins. Local actionlint and
jq validation executables were downloaded from their official GitHub releases
and checked against their published SHA-256 checksums.
