# Owner-accepted internal HTTP; preflight disclosure corrected

The independent second review does not accept the four HTTP listeners as false
positives: the internal transport remains plaintext. Loopback, unpublished
container ports and the outer TLS proxy reduce exposure but do not encrypt that
hop. On 2026-09-08 the owner explicitly accepted these four residual risks to
preserve stability. [RA-2026-09-08-internal-http](../risk-acceptances/RA-2026-09-08-internal-http.md)
records that decision, its exact identities and source-bound controls. It expires
on 2026-10-08 under the existing 30-day repository policy. These findings are
accepted risks, not false positives or encrypted transports. The public preflight disclosure is corrected
and absent from the subsequent 85-finding CI scan. This review does not inspect,
reconfigure or make claims about a running deployment.

## HTTP listeners

The relevant trust boundary is the application listener behind local service
clients or a transport-terminating proxy. Incoming request data cannot choose
whether the listener uses HTTP, its address, or the Compose port bindings.

| Listener | Code default | Supplied Compose boundary | Resolution |
| --- | --- | --- | --- |
| Dashboard | 127.0.0.1 | Published only on host 127.0.0.1; documented Tailscale Serve proxy | Intentional internal HTTP; no transport change |
| Metrics | 127.0.0.1 | Published only on host 127.0.0.1; monitoring consumes service HTTP | Intentional local/service HTTP; no transport change |
| Alert relay | Now 127.0.0.1 | Explicit container bind; no published relay port | Unsafe standalone wildcard default corrected |
| Viewer health/status | Now 127.0.0.1 | Explicit container bind; only internal expose, no published port | Unsafe standalone wildcard default corrected |

Commit `886d2b3` makes standalone relay and viewer listeners local by default.
`ALERT_RELAY_HOST` and `TELEGRAM_VIEWER_HEALTH_HOST` let the supplied Compose files
explicitly retain their required container binds. The relay verifies incoming
authorization; detailed viewer status verifies a service token. Its unauthenticated
liveness/readiness endpoints return booleans. Dashboard and metrics defaults were
already local and remain so.

The reviewed architecture trusts the local machine and the configured service
network. It does not claim protection against a compromised local host/container
or arbitrary operator changes publishing a port. Those are changes to the trust
boundary, rather than unchecked network input in these four reported calls.
HTTP on this internal hop is intentional, but that is not evidence of encryption.
Moving TLS into each Node listener would require coordinated changes to the proxy,
monitoring, health probes, service clients, certificate provisioning and renewal.
Neither the absence of an input-flow exploit nor the limited network exposure
repairs these four transport findings; the explicit owner acceptance governs them.

Actual listener tests verify default loopback and explicit container-style binds
for the relay, and default loopback for viewer health. Existing health authentication,
relay security, UI-review and MCP-control tests pass. The merged Compose configuration
passes `docker compose ... config --quiet`. No service was started or changed by
that configuration check.

## Fresh preflight diagnostics

The preceding credential-pattern redaction was insufficient for arbitrary internal
error text. Commit `38c2f24` gives `preflightMcpAction` an explicit public diagnostic
mode used by `uiMcpProposalReview`. Authored domain blockers, such as a missing
contract, remain intact. A caught exception has no approved user-facing message
contract and produces a static validation-failure explanation with a retry/check
instruction. Internal callers retain their existing diagnostics.

Tests prove the public review contains neither arbitrary internal paths/text nor
credential sentinels; the review still blocks the action and retains its approval
hash. A separate assertion proves explicit domain blockers remain unchanged.
This is a targeted fix for the reported preflight-to-UI flow, not a global change
to all server error responses.

All four relevant suites, TypeScript typecheck, targeted ESLint and diff checks
passed under Node 22.23.2. The original 86-finding ledger records the first review;
its architecture dispositions are superseded by the independent review's open
status for HTTP and the subsequent explicit owner risk acceptance. No Snyk
platform statuses were changed.
