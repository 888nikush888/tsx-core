# Google Drive secondary encrypted backup mirror

`GoogleDriveBackupMirror` is a bounded adapter for a **second copy** of an
already encrypted `.tgfb` bundle. It refuses a source without the encrypted
backup header, checks the local SHA-256 before uploading, uses a resumable Drive
upload, then downloads the whole stored object and verifies its byte count and
SHA-256. A same-name object is reused only after the same readback check.

The adapter is deliberately **not wired into the backup scheduler yet**. The
current `HttpsBackupReplicator` creates and deletes its encrypted bundle within
one call. Wiring a mirror needs that same bundle to be passed to both backends,
with separate primary and secondary receipts in backup status and the UI.
Primary B2 compliance-mode Object Lock success must remain independent of
Drive's success; a Drive receipt must never satisfy the primary retention gate.
Google Drive permits owner deletion, so it is not an immutable audit or backup
destination by itself. No Drive credentials, folder, or real upload were used
for this slice.

To finish this slice safely:

1. Add an operator UI flow for OAuth consent with least-privilege `drive.file`
   scope and an app-created dedicated folder. Keep refresh tokens in the
   existing enterprise secret store, not source or logs. Test token expiry,
   revocation, reauthorization, and credential rotation.
2. Produce one encrypted bundle, verify the B2 primary round trip and retention
   receipt, then call this adapter on the identical bytes. Store separate
   `primaryVerified` and `driveMirrorVerified` receipts, with separate errors;
   decide explicitly whether a secondary failure blocks a backup run.
3. Add reconciliation for an ambiguous upload timeout and Drive's eventual
   visibility: retries can create duplicate same-name files. Do not silently
   treat duplicates as success. Show and resolve them before release.
4. Test a real, isolated Drive account with a small encrypted fixture, offline
   failure, quota exhaustion, recovery by file ID, and a restore drill. Recheck
   free capacity against actual encrypted backup size and schedule.

The adapter's official API basis is Google's [resumable upload guide](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
and [`files.get` media download](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get).
