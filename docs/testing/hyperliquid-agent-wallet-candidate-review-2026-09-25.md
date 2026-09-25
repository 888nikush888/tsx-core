# Hyperliquid agent-wallet candidate review

Status: 2026-09-25. This is a local implementation review of the narrow
Hyperliquid Testnet agent-wallet candidate. It is not provider acceptance,
account acceptance, a live release decision, or permission to place an order.

## Scope

The candidate adds a deliberately narrow signer path for a Testnet agent
credential. The account identity remains the master wallet. Before a REST or
Pro client is constructed, the signer is derived with the pinned CCXT runtime
and must be present in a current `userRole` response and in exactly one
matching `extraAgents` entry. The grant must remain valid beyond the request
budget. The grant fingerprint is included in the credential generation.

Agent credentials are accepted only with the exact two-field secret shape and
only in `testnet` mode. Mainnet, malformed, foreign, revoked, ambiguous, and
near-expiry grants fail closed. A grant is re-read under the mutation lock;
rotation or expiry cannot reuse the previous generation.

The agent transport accepts only the exact Testnet REST and WebSocket origins,
disables proxy/environment use, rejects redirects and late URL drift, and
allows exchange mutations only through the reviewed REST authority. Builder
actions, unsupported action types, out-of-scope assets, WebSocket exchange
calls, and ambiguous envelopes are rejected before transport.

## Evidence and limits

The candidate tests cover grant parsing, duplicate keys, response bounds,
redirect refusal, role and expiry binding, rotation, transport-route drift,
origin and proxy changes, mutation-lock revalidation, account-generation
rebind, and read-only preflight behavior. The tests use synthetic credentials
and synthetic provider responses; no private key is read from disk and no
exchange request is sent.

The candidate does not implement the real provider acceptance journal,
authenticated Testnet lifecycle, order/stop/cleanup proof, partial and late
fill evidence, fee/funding evidence, or the final source/SDK/credential-
generation receipt. Those remain separate release gates.

## Source review

The reviewed implementation is the current worktree delta for:

- `exchange_executor/hyperliquid_agent_grant.py`
- `exchange_executor/ccxt_client.py`
- `exchange_executor/ccxt_sdk_policy.py`
- `exchange_executor/tests/test_hyperliquid_agent_grant.py`
- `exchange_executor/tests/test_mutation_identity.py`
- `scripts/hyperliquid_bound_preflight.py`
- `tests/test_hyperliquid_bound_preflight.py`

The existing Master-Key-only review remains historical evidence. This delta
does not change the provider-acceptance or live-release decision.
