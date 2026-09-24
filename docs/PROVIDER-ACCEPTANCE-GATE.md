# Independent provider acceptance gate

The CCXT implementation receipt and a catalog status of `certified` prove only
an offline implementation review. They do not authorize live exposure. Live
account creation and read-only verification remain available, but verification
does not enable the account. The Node control plane rejects live re-enablement,
the live runtime switch, and every live entry precondition until a separate
provider-acceptance grant is verified. Existing ready/enabled rows do not
bypass the entry check. Paper and sandboxed testnet retain their current paths.

The Python executor independently checks live exposure-increasing orders at
the resolved futures market before slippage, leverage, or order writes. It
rechecks immediately before leverage and order calls so a revoked grant closes
subsequent checks. Read, reconciliation, cancel, and reduce-only orders do not
need a new-exposure grant. Protected entry batches always need one. The
executor's existing account identity and credential-generation binding remains
mandatory; a provider grant cannot replace it.

Both processes accept only an Ed25519-signed JSON grant, read afresh from an
absolute `PROVIDER_ACCEPTANCE_GRANTS_FILE`. The separate reviewer public key
comes from an absolute `PROVIDER_ACCEPTANCE_REVIEWER_KEY_FILE`, and its DER
SHA-256 must match the digest pinned in both source modules. A grant binds
`exchange`, `product` (`swap:linear`, `swap:inverse`, `future:linear`, or
`future:inverse`), `mode=live`, local `accountId`, verified
`externalAccountId`, and `credentialGeneration`. It includes a distinct
`reviewId`, `validFrom`, and `validUntil` (maximum seven days). Its signature
covers the exact flat `grant` object serialized as sorted-key compact ASCII
JSON. Changing a field, rotating credentials, altering the reviewer key,
expiring the grant, deleting it from the file, or removing the file closes the
gate. The Node check requires at least one valid product grant for that
account; the executor checks the actual resolved product on every new order.

**Current release state:** the reviewer-key digest is intentionally empty in
both modules. A separate source/SDK/profile provenance verifier also returns
false in both modules. No grant can currently activate live trading, even if
an operator places a validly shaped signed file in the separate acceptance volume.
The grant schema does not yet bind an exact source tree, pinned CCXT SDK tree,
or profile hash. Before live can open, an independently reviewed change must
implement exact runtime provenance verification in both processes, add those
hashes to the signed grant, and pin a reviewer public key after genuine testnet
provider acceptance, evidence review, and account binding. The reviewer must
control the corresponding private key outside TSX Core; no UI action, secret
file edit, or receipt update can issue a grant. Compose mounts the separate
`provider_acceptance` volume read-only in both processes. An operator-owned
helper, run outside these services, must populate that volume only after the
independent review; neither TSX process receives write access. To revoke,
remove the grant through that external operator path and fence active entries.
An in-flight write that passed its final check remains uncertain and requires
normal reconciliation. A host operator with Docker-volume write access could
restore an old still-valid signed grant; a future release must add an
independent revocation epoch before claiming rollback-resistant revocation.
