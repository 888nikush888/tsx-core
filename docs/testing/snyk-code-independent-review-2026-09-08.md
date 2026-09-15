# Independent Snyk Code review, 2026-09-08

Reviewed exactly 85 results from Snyk Code1.1307.1 at analyzed merge revision fa31311c0310cafb88a3eb62977d8756546349aa. The wave3 status file identifies this revision. The independent JSON contains every finding ID, rule, source hash, all scanner flow locations, contextual source hashes and a concrete decision. All hashes come from git blobs at that revision, not current working-tree bytes. No platform state was changed.

Result:80 false positives and5 open findings. The54 hardcoded-value flows point to their own source lines; each literal and fixture boundary was checked. The remaining flows were followed across source files, including backup filename/ownership validation, fixed interpreter invocation, local child-test callers, internal transport configuration and regex CPU limits.

The DOMXSS finding2450255f-e697-4aae-ae63-736ad651be82 remains open because URL reconstruction can turn an allowed same-origin double-slash pathname into a protocol-relative external href. No JavaScript execution is claimed; the declared navigation boundary is nevertheless bypassed. Root implementation c121c76 is a later fix and cannot alter this historical review decision before a fresh scan/review.

Four actual HTTP listeners remain open:alert_relay.ts, metrics.ts, telegram_viewer/health_server.ts and web_server.ts. Loopback publication, Docker network segmentation and documented TLS/Tailscale termination limit exposure but do not encrypt the internal plaintext transport. Treating these as false positives would hide an architectural risk decision. No acceptance of that risk is granted by this review.

Only exact false-positive matches may satisfy the planned gate. The five open findings, unknown fingerprints, missing context paths and changed source/context bytes must block. This is source review, not live deployment, TLS, provider or exchange acceptance evidence.
