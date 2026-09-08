---
id: RA-2026-09-08-internal-http
owner: Codex TSX Core stabilization
approver: 888nikush888
created: 2026-09-08
expires: 2026-10-08
scope: Four specifically reviewed internal HTTP listeners
gate: Snyk Code source-bound review
---

## Risk

The dashboard, metrics, alert relay and viewer status listeners use plaintext
HTTP on the local host or the configured container network. Traffic, including
service authorization where present, is not encrypted on that internal hop.
A compromised host, permitted peer or changed network boundary can expose it.
These are accepted residual risks, not false positives or repaired transport.

On 2026-09-08 the repository owner explicitly selected:
"Bestehende interne Verbindungen beibehalten und die vier Restrisiken ausdrücklich
dokumentiert akzeptieren (Stabilität bevorzugt)". This preserves the functioning
client, proxy, monitoring and health-check contracts. It authorizes no other risk.

## Evidence

The independent review examined these exact Snyk finding identities:

| Finding | Listener | Source |
| --- | --- | --- |
| 438c84b9-ea83-4e9d-8bdc-d2032e31ae59 | Dashboard | src/web_server.ts |
| d75bc03c-19a7-4475-809c-525e9240e836 | Metrics | src/metrics.ts |
| 15b62184-5d10-4c9f-8c45-36cebd259223 | Alert relay | src/alert_relay.ts |
| 75310963-3f26-40a8-b6da-3e8ab4d6c57b | Viewer health/status | src/telegram_viewer/health_server.ts |

All are `javascript/HttpToHttps`. The complete source/context hashes, fingerprints
and flow evidence remain bound by the independent Snyk review ledger. Its
historical open findings are not rewritten as false positives. This acceptance
requires those bindings to pass again against each current scan.

## Compensating controls

Standalone listener defaults bind to loopback. Compose publishes dashboard and
metrics only on host loopback; relay and viewer ports are internal. The documented
external dashboard boundary uses Tailscale Serve TLS. Relay authorization and
viewer detailed-status tokens remain enforced. Actual listener tests cover the
default/explicit binds and authentication. These controls reduce exposure but do
not encrypt the internal hop, and no live deployment inspection is claimed.

## Exit criteria

Renew explicit owner acceptance within the repository's maximum 30-day window,
or implement and verify coordinated TLS, certificate lifecycle and client/probe
changes. Any changed finding identity, dataflow, source or reviewed configuration
requires a new review. A public listener exposure is outside this acceptance.
The acceptance cannot waive unrelated findings, scanner failures or missing
evidence, and it never authorizes live exchange operations.
