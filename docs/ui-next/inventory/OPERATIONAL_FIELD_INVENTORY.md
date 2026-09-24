# Operational setting inventory: source-scoped baseline

This inventory is a classification and gap ledger for the UI requirement. It is **not** a release sign-off or a claim that an input is usable end to end. The source baseline is integration SHA `368a7741250c508c9d4ce6eadc7a1b509373f271`.

## Denominators

`operational-fields.json` enumerates each of the **311 unique** paths in `parameters.json` exactly once. It records the intended lifecycle class and the *state of proof*, separately. There are 280 catalog paths with `editable: true`; this catalog flag alone does not establish a browser control, API authorization, persistence, audit event, activation behavior or rollback. The current statuses are 46 `first-slice-static`, six `known-gap`, and **259 `unverified`**. The earlier 52-path slice remains the source for its static evidence. None of these rows has a verified browser-to-persistence-to-effect E2E claim.

`external-operational-controls.json` enumerates **70 further source-scoped control records**: 23 distinct Compose substitutions, 11 internal-TLS artifacts, 11 monitoring configuration groups, 18 alert rules and seven backup/host/observation controls. The 45 Compose container environment names and 12 TLS environment bindings are inventoried as wiring aliases, not added to the control count. The 35 managed-runtime environment mappings are attached to their existing catalog fields, also not added.

The combined **source-scoped control-record count is 378**: 311 catalog paths, minus the three aggregate deployment paths `deployment.hostPorts`, `deployment.cpu`, `deployment.memory`, plus 70 external records that expand or extend those sources. Image selectors remain distinct from `deployment.imageDigest`: selecting an image is not observing the running digest. `relatedCatalogPath` and `relation` document other conceptual overlaps without claiming equality. Alert rules and monitoring configuration groups can contain several scalar settings, so **378 is a lower-bound record count for these named sources, not a proven denominator for every possible host or integration setting**. A later host-plane inventory must decompose these groups before claiming a globally exhaustive percentage.

## Verification rule

`tests/test_operational_field_inventory.js` compares the catalog path set to its explicit classification one-for-one, checks editability, immutable safety gates, first-slice provenance and proof statuses, and rejects unproven UI/E2E claims. It also compares every Compose substitution, fixed container environment name and alert-rule name to the external registry; checks TLS and backup/host controls; and pins the source-scoped counts so any source expansion requires review. It is registered in `tests/run_all.js`.

The test deliberately accepts `unverified` rows as honest gaps. Promoting a row requires a separate field-specific test proving the UI control, authorized API mutation or read path, validation, persistence, audit event, effective value and restart/rollback semantics. The three immutable gates remain code-bound: protective stop required, close remainder at last target, and parser file writes disabled. Other read-only values include generated IDs/schema metadata, observations and the fixed viewer time format. CI/review gates are outside the operator setting inventory and must never gain a UI override.

## Remaining gaps

- 259 catalog paths have no field-level proof in the first slice; existing forms are not counted as missing, but their behavior must be verified field by field.
- Six deployment catalog paths already carry an explicit host-maintenance UI gap. None of the 70 external controls has a verified maintenance UI or safe apply/rollback path.
- Compose variables, certificate/key lifecycle, Tailscale Serve, monitoring rule edits, backup placement and immutable encryption-key retention require an authenticated host maintenance design. This inventory does not authorize exposing a Docker socket, arbitrary shell, private keys or safety-gate switches in the Core browser.
- The source set covers the named Compose, managed runtime, TLS, monitoring, backup and host references. Custom orchestrators, VPS configuration, DNS/firewall, all possible environment variables, and the eventual live host are not yet enumerated. Claiming "everything in the UI" or a global completion percentage from this file would be premature.

The next implementation slices should first prove trade/risk fields and their immutable gates, then integration/secret and paper/journal fields, followed by the independent host maintenance plane and exact-release E2E verification. No trading or provider receipt was changed by this inventory work.
