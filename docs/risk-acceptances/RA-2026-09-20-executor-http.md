---
id: RA-2026-09-20-executor-http
owner: Codex TSX Core stabilization
approver: 888nikush888
created: 2026-09-20
expires: 2026-10-08
scope: Existing internal dashboard-to-executor HTTP transport on port 8090
gate: Sonar source-bound review of the internal executor transport
---

## Risk

The internal executor transport uses plaintext HTTP. A compromised host or permitted container/network peer can observe or interfere with traffic, including Bearer authorization and trading/control metadata. Reachability controls do not encrypt this hop. This is an accepted residual risk, not a false positive or a repaired transport.

On 2026-09-20 the repository owner explicitly selected: "Internes HTTP beibehalten und Risiko ausdrücklich akzeptieren" after being told this additional executor endpoint is separate from the four previously accepted listeners. Retaining the existing transport prioritizes stability and preserves current clients, token handling and healthchecks. This bounded acceptance expires on 2026-10-08, alongside the earlier internal-HTTP review window; it does not extend or replace that record.

## Evidence

The reviewed source is commit 6677d8947b88fdb19f01e1d3189cdce7ef3015ea. Related Sonar identities are AZ-NnEECEgNzpYnZ8gHi (executor server), AZ-NnD9lEgNzpYnZ8gHE (exchange client), and AaBObe2ncp18kkeMmOQ1 (catalog client). The two older retained client findings may have historical scanner status; that status is not proof of encryption.

Relevant files are exchange_executor/server.py, exchange_executor/credentials.py, src/executor_origin.ts, src/ccxt_exchange.ts, src/exchange_catalog.ts and docker-compose.yml. Source contracts and their regression tests were examined in the final findings review. No live deployment inspection or provider acceptance is claimed.

## Compensating controls

The executor defaults to 127.0.0.1. Compose overrides this to 0.0.0.0 inside its network, exposes port 8090 internally and publishes no host port. Expose is not an access-control rule between peers. POST dispatch requires a constant-time Bearer-token comparison; the managed secret is mounted read-only. GET health readiness remains unauthenticated and does not disclose credentials.

The client origin validator restricts origins to plain HTTP with approved loopback, localhost or exchange-executor hostnames, without URL credentials, extra path, query or fragment. Exchange and catalog calls preserve their authenticated JSON contract. These controls reduce exposure without claiming confidentiality from other permitted network peers.

## Exit criteria

Re-review and obtain explicit renewal before expiry, or implement coordinated TLS with certificate issuance/rotation, client trust, Compose configuration and healthchecks. Changed source/dataflow or broader network exposure requires a new review. Public exposure, disabled certificate validation, unrelated findings, incomplete scanner runs and live exchange operations are outside this acceptance.
