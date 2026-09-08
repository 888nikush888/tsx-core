# Snyk Code: 86-result review

The [individual ledger](snyk-code-review-2026-09-08.json) covers all 86 unique
finding fingerprints from the supplied Code SARIF. Each entry includes the rule,
path, full region, original fingerprints, reviewed file/line SHA-256 and a
source-specific rationale. No credential values are copied into the ledger.

Disposition counts:

- 81 proposed false positives: synthetic test data, intentional local CLI
  capabilities, guarded path/regex execution, fixed predicate callbacks,
  same-origin navigation, or loopback-only test transports.
- One confirmed credential-disclosure defect fixed; broader generic-error
  disclosure review remains open.
- Four production HTTP listeners require deployment-boundary verification.

No finding is suppressed or resolved in Snyk by this review. No new exclusions,
ignore policies, fragmented secret strings or test deletions were introduced.
The Python findings were reviewed read-only; no Python source was changed.

## Confirmed fresh-preflight disclosure

The ServerLeak trace reaches `uiMcpProposalReview` through `boundedError` and
`freshPreflight.blockers`. Proposal, previous and requested values were already
redacted, but fresh preflight data bypassed that protection. A regression test
injects a failure only on the fresh preflight database read. Before the fix,
the resulting Bearer and credential-URL sentinels reached the UI response.

Commit `e639fa0` applies the same review redaction to fresh preflight data. The
test now verifies sentinel absence while retaining the useful diagnostic prefix,
`allowed: false`, and unchanged approval hash. The whole UI review suite,
TypeScript typecheck and targeted ESLint passed on Node 22.23.2.

This fixes the demonstrated credential formats. It does not prove that every
possible arbitrary exception string is safe: `boundedError` still turns unknown
internal errors into text. Replacing all such text with a generic error would
also hide current useful domain-validation explanations. A complete policy needs
an explicit distinction between approved user-facing validation errors and
internal operational diagnostics. The ledger therefore keeps this remainder open.

## Conditional HTTP dispositions

The dashboard and metrics Compose mappings bind host ports to 127.0.0.1.
Dashboard deployment instructions use Tailscale Serve in front of that listener.
The viewer status listener is exposed only within the service network and protects
detailed status with a token. Alertmanager addresses its relay over the internal
service network. These are source/deployment configuration observations, not
verification of the currently running network, proxy or TLS configuration.

The four listeners remain explicitly pending deployment verification. Enabling
TLS directly inside them without coordinating clients and the proxy would alter
the supported deployment and could break monitoring or the operator dashboard.

## Evidence limits and preservation of tests

SARIF does not contain full source blobs or an attested source revision. Reviewed
source files were snapshotted from the integrating worktree and individually
hashed. These are review-source hashes, not an invented clean-commit scan proof.
Reconcile revisions and run Snyk again after integration before applying any
platform dispositions.

All 86 unique IDs have exactly one ledger entry and an existing source region.
The inventory hash binds the ledger to the supplied SARIF. Test credentials remain
explicit because they verify secret-field rejection/redaction, store lifecycle,
SDK signing and intercepted transport behavior. A test-directory location alone
was never the rationale for dismissing a finding. No production credential was
identified among the reviewed literals.
