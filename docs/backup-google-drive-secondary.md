# Google Drive secondary encrypted backup mirror

`GoogleDriveBackupMirror` is a bounded adapter for a **second copy** of an
already encrypted `.tgfb` bundle. It refuses a source without the encrypted
backup header, checks the local SHA-256 before uploading, uses a resumable Drive
upload, then downloads the whole stored object and verifies its byte count and
SHA-256. A same-name object is reused only after the same readback check.

The adapter can now be injected into `HttpsBackupReplicator`. One TGFE1 bundle
is encrypted once, uploaded to the primary gateway, downloaded, hash-checked,
decrypted and checked against the backup artifact. Only after the primary
retention receipt and round trip pass does the adapter receive that same
encrypted file and expected SHA-256. The scheduler stores separate primary and
Drive receipts and health; a required Drive failure fails the backup run after
preserving the valid primary receipt. Local retention still runs after primary
or required mirror failures and protects the latest verified local artifact.
An unconfigured mirror reports unhealthy on its own status while remaining
optional for overall backup health. A Drive receipt cannot satisfy the
primary retention gate. Provider error text is replaced with a generic status
message so tokens cannot leak through the backup UI or log.
Google Drive permits owner deletion, so it is not an immutable audit or backup
destination by itself. No Drive credentials, folder, or real upload were used
for this slice.

This is an injectable core path, **not a runtime-enabled Drive connection**.
No OAuth credentials or Drive API calls were used. To enable it safely:

1. Add an operator UI flow for OAuth consent with least-privilege `drive.file`
   scope and an app-created dedicated folder. Keep refresh tokens in the
   existing enterprise secret store, not source or logs. Test token expiry,
   revocation, reauthorization, and credential rotation.
2. Add validated runtime settings and a secret-store-backed token resolver,
   then pass the adapter to `HttpsBackupReplicator` and the required policy to
   `BackupScheduler`. Keep the immutable B2 primary mandatory in enterprise
   mode. Expose configured/required state separately in the operator UI.
3. Add reconciliation for an ambiguous upload timeout and Drive's eventual
   visibility: retries can create duplicate same-name files. Do not silently
   treat duplicates as success. Show and resolve them before release.
4. Test a real, isolated Drive account with a small encrypted fixture, offline
   failure, quota exhaustion, recovery by file ID, and a restore drill. Recheck
   free capacity against actual encrypted backup size and schedule.

The adapter's official API basis is Google's [resumable upload guide](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
and [`files.get` media download](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get).
