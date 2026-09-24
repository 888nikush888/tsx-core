# External B2 audit receiver candidate

This standalone service accepts the exact `EnterpriseAuditTrail` JSON record at `POST /v1/records` over HTTPS. A successful response is issued only after the receiver has read back the exact B2 object **version**, confirmed its bytes and `COMPLIANCE` retention, and re-listed it as the sole version. The predecessor must already exist as one still-locked version with a matching `previousHash` and is also re-listed before the next record; gaps and competing versions fail closed. Same-byte retry returns 200 without another upload. A different record for the same source and sequence returns 409. B2 failures, ambiguous versions, weak retention, and unsupported conditional writes return 503. No delete API is used.

This is an isolated candidate, **not an accepted live audit sink**. The tests use a mocked B2 client and a local HTTP transport harness; neither proves B2 behavior, certificate deployment, or off-host durability.

## Contract and configuration

The sender is `src/audit_trail.ts`. It sends compact JSON with `schemaVersion`, `sequence`, `timestamp`, `previousHash`, `event`, `hash`; the hash is SHA-256 of the JSON string without `hash`. The receiver limits bodies to 256 KiB, validates this serialization and hash, and uses the fixed source ID plus zero-padded sequence as the stable object key. Rotating or resetting the sender's local audit chain requires a **new** source ID and a reviewed new epoch; silently reusing sequence numbers fails closed.

Provision a **separate private B2 bucket with Object Lock enabled**, independent of the backup bucket. Use a dedicated bucket-restricted application key granting only the read/list/write and retention-read actions actually needed by this service, and no delete or administrative actions. Store the following as host secrets, never in Git or the UI logs:

| Variable | Meaning |
| --- | --- |
| `B2_AUDIT_REGION` | B2 region, for example `us-east-005` |
| `B2_AUDIT_ENDPOINT` | Exactly `https://s3.<region>.backblazeb2.com` |
| `B2_AUDIT_BUCKET` | Dedicated private Object Lock bucket |
| `B2_AUDIT_KEY_ID`, `B2_AUDIT_APPLICATION_KEY` | Dedicated B2 S3-compatible key pair |
| `B2_AUDIT_SOURCE_ID` | Stable slug for one sender chain |
| `B2_AUDIT_RETENTION_DAYS` | 31–3000, default 90; one-day margin ensures at least 30 days remain after write verification |
| `B2_AUDIT_OPERATION_TIMEOUT_MS` | Each B2 call and object stream, 100–10000 ms, default 3000 |
| `B2_AUDIT_TOTAL_TIMEOUT_MS` | Whole record operation, at least the per-call deadline and at most 25000 ms, default 8000 |
| `AUDIT_RECEIVER_TOKEN` | At least 32 characters, same value as sender `AUDIT_WEBHOOK_TOKEN` |
| `AUDIT_RECEIVER_TLS_CERT`, `AUDIT_RECEIVER_TLS_KEY` | PEM file paths for a trusted TLS server certificate and key |
| `AUDIT_RECEIVER_HOST`, `AUDIT_RECEIVER_PORT` | Default `127.0.0.1:9445`; off-host reverse proxy or direct restricted TLS listener |

**B2 is off-host immutable storage; it does not make the receiver process itself off-host.** Running this receiver on the same VPS as TSX Core leaves their compute, network, and administrative failure domains shared and cannot complete the independent-audit-host gate. Deploy it on a separate host or independently controlled service (for example a separately operated container host or a Worker implementation with the same verified contract), with its own credentials and monitoring. Bind sender `AUDIT_WEBHOOK_URL` to `https://<audit-host>/v1/records` and enable remote-required Enterprise mode only after end-to-end verification. A single active receiver instance per source is required: in-process serialization cannot arbitrate multiple hosts. The B2 object key must never be reused for a different sender or audit epoch.

The receiver reserves at most four authenticated records (1 MiB of maximum body capacity) including the active write, and rejects excess requests with 503 before reading their bodies. A disconnected queued request is removed; an active write retains its reservation until its bounded storage operation settles. The receiver closes incomplete request bodies after eight seconds; the HTTPS listener also bounds header, request, idle, and keep-alive time. Every SDK call carries an abort signal. The Smithy HTTP handler enforces connection/request timeouts and throws on request timeout; an outer per-call deadline covers SDK stalls and object stream reads, while a whole-record deadline releases the serial queue. The sender's `AUDIT_WEBHOOK_TIMEOUT_MS` must exceed the measured receiver end-to-end latency but remain within its 30-second limit. The defaults are designed to fail closed within the sender's 10-second default; any tuning requires a latency/outage test.

## Release blockers

1. Backblaze documents version IDs, Object Lock, `Get Object Retention`, and `List Object Versions`, but its published `Put Object` page does **not** guarantee `If-None-Match: *`. This candidate requests it and fails closed on rejection; on an uncertain response it reconciles only one verified existing version. Before live use, run a disposable-bucket test against the selected B2 region to prove conditional creation, concurrent duplicate/conflicting writers, lost-response retry, version listing, and exact-version retention/read-back. If B2 ignores the condition, add a separately proven single-writer/atomic-claim design; a mocked test is insufficient.
2. Provision and inspect the private bucket/key capabilities; prove that the key cannot delete objects or alter retention. Test COMPLIANCE retention expiry, version IDs, private access, and no hidden/delete markers. Never use the production audit bucket for destructive tests.
3. The package is bound into Quality OS test, dependency, license, SBOM, and `BUILD_INPUT_POLICY` gates in this candidate. The final merged branch still needs verification of these gates and container/image policy. A standalone package without those checks is not sufficient.
4. Run an external HTTPS end-to-end test using the actual sender, trusted certificate, timeout, 2xx-after-persist behavior, replay, outage/503 mutation block, restart, and off-host recovery. Validate alerting for the audit receiver and B2 failures. No live trade may rely on this candidate until those results are reviewed.

Primary provider references: [B2 S3 Put Object](https://www.backblaze.com/apidocs/s3-put-object), [B2 List Object Versions](https://www.backblaze.com/apidocs/s3-list-object-versions), [B2 Object Lock](https://www.backblaze.com/docs/cloud-storage-object-lock), [B2 S3-compatible API](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api).
