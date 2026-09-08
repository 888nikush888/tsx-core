# Snyk onboarding

`.github/workflows/security-services.yml` is initially manual (`workflow_dispatch`).
It does not modify existing Quality OS gates or install scanner dependencies
into application manifests. After authenticated onboarding and evidence review,
automatic triggers can be introduced deliberately.

Configure the GitHub repository secret `SNYK_TOKEN`; optionally configure repository
variable `SNYK_ORG` with the organization ID. Snyk Code must be enabled for that
organization. Missing credentials, entitlement failures, and unsupported scans
fail visibly rather than producing a clean assessment.

The workflow installs exactly Snyk CLI `1.1307.1` and runs five independent scans:

- Backend `package-lock.json`, including development dependencies.
- Frontend `frontend/package-lock.json`, including development dependencies.
- Python `exchange_executor/requirements.lock` with the explicit pip parser.
- Python `exchange_executor/requirements-dev.lock` with the explicit pip parser.
- Repository Snyk Code analysis.

Python dependencies are installed using both hash-locked requirements files,
Python 3.12 and binary wheels only. No application build or native Node rebuild is
needed for these scans. Node 22 runs the CLI. The five jobs do not cancel each
other when one finds a problem.

No severity filter, fixability filter, or ignore policy is introduced. Dependency
scans use `--ignore-policy`. Snyk Code instead supports `--include-ignores`; its
SARIF is checked for every result, including suppressed results, since a zero
CLI exit alone does not prove that no ignored findings exist. Existing server
policies and scan coverage still require review during actual onboarding.

Each scan uploads its own SARIF, optional native JSON, and status JSON, including
the Git revision, scanner version, original exit code, result count and disposition.
Snyk may omit the native Code JSON on a clean scan; SARIF and status are mandatory
for a successful gate. Scan errors (including invalid evidence) and findings have
different dispositions and both fail the job. Artifacts remain available for
14 days. Setup failures can occur before scan evidence exists and remain explicit
failed job steps; the artifact step does not manufacture findings evidence.

## Verification performed before authenticated onboarding

- Workflow syntax and expressions validated with actionlint 1.7.12.
- Extracted scan step executed under Bash with scanner fixtures: clean result,
  findings, suppressed-only findings with exit zero, scan error, unsupported
  project, invalid evidence, and empty SARIF runs. Expected gate statuses passed
  for all seven cases.
- `git diff --check` passed.

These checks validate workflow mechanics, not live Snyk account access or results.
An authenticated manual GitHub run remains required before claiming integration
success or zero findings.

## Official references

- [Dependency test options](https://docs.snyk.io/developer-tools/snyk-cli/commands/test)
- [Snyk Code test options and exit statuses](https://docs.snyk.io/developer-tools/snyk-cli/commands/code-test)
- [Snyk Code ignore semantics](https://docs.snyk.io/manage-risk/prioritize-issues-for-fixing/ignore-issues/consistent-ignores-for-snyk-code/snyk-cli)
- [CLI options summary](https://docs.snyk.io/snyk-cli/cli-commands-and-options-summary)
- [Pinned CLI Code implementation](https://github.com/snyk/cli/blob/v1.1307.1/src/lib/plugins/sast/index.ts)

The action revisions match the existing `quality.yml` pins. Local actionlint and
jq validation executables were downloaded from their official GitHub releases
and checked against their published SHA-256 checksums.
