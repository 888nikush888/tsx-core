# Codacy complete inventory and bounded fixes — 2026-09-08

The authenticated repository API reports `lastAnalysedCommit.sha` as
`be8cf5af59f60d69ad946d778973add8161b7672`, with analysis starting at
06:01:02.397 UTC and finishing at 06:01:43.36 UTC on 2026-09-08:
`GET https://app.codacy.com/api/v3/analysis/organizations/gh/888nikush888/repositories/tsx-core`.
The issue export contains 358 records, 358 distinct issue IDs, pagination total
358 and limit 1000, with no continuation cursor. Issue-level `commitInfo` is
historical issue attribution and must not be substituted for scan identity.

[The complete ledger](codacy-inventory-2026-09-08.json) binds every occurrence to
its rule, exact source line, source revision and SHA-256 of the Git blob at that
revision. All 358 reported lines were found in that source. Origin evidence is
normalized per file and referenced by each issue; no occurrence was omitted.

## Inventory and remaining review

| Group | Occurrences | Disposition in this review |
| --- | ---: | --- |
| Tests and test fixtures | 240 | 239 proposed false positives with controlling-input evidence; one Windows `cmd` executable-lookup concern remains for review |
| Go standard-library findings on scanner module | 33 | Minimum version aligned with existing Go 1.26.6 builders; scanner rescan pending |
| GTM HTML/JavaScript construction | 4 | DOM-only construction and identifier validation implemented; rescan pending |
| AES-GCM tag length | 1 | Existing 16-byte format made explicit; rescan pending |
| Production-guide anchor | 1 | Fix owned separately by the main task |
| Contract regular expressions | 2 | Fixed separately by the main task in c67c310; rescan pending |
| Other production/tooling findings | 77 | Individually reviewed: 76 proposed false positives and one intentional authenticated container listener; no platform closure asserted |

The test findings include loopback-only fixture HTTP calls, temporary-directory
paths, finite assertion patterns, public commit/action SHA pins, exact safe
integer fixtures, and synthetic credential strings. Each occurrence has its own
ID and source binding. This is proposed review evidence, not a blanket rule
exclusion. No platform finding status or rule configuration was changed.

## Changes and verification

- GTM no longer interpolates `VITE_GTM_ID` into executable JavaScript or HTML.
  A valid `GTM-[A-Z0-9]+` identifier is passed through URL search parameters to
  fixed Google endpoints, using DOM nodes. Production-only behavior and existing
  data-layer entries are preserved. Seven focused cases cover valid input,
  absent and malicious identifiers, and non-production behavior.
- Backup decryption now explicitly requires `authTagLength: TAG_BYTES` where
  `TAG_BYTES` is already 16. The writer and stored format are unchanged; existing
  roundtrip and tampered-download rejection tests passed.
- `monitoring/govulncheck/go.mod` now requires Go 1.26.6. Both monitoring
  Dockerfiles already pin the Go 1.26.6 builder by digest, use
  `GOTOOLCHAIN=local` and `GOFLAGS=-mod=readonly`, and verify the builder version.
  The old module directive was a lower compiler minimum, not proof that release
  binaries used the vulnerable standard library. Dependencies and `go.sum`
  are unchanged. A real Go 1.26.6 readonly module download, module verification
  and govulncheck build succeeded; binary metadata confirms Go 1.26.6.

Validation: backend and frontend lint passed; the full frontend suite passed
303 tests in 37 files; the complete application/frontend build passed; backup
replication integration tests and monitoring-artifact governance tests passed.
The Go check built the Windows scanner executable locally; Linux container
reproducibility and scanner closure must still be verified by the final CI run.

The source baseline used by this ledger predates these fixes. Its hashes remain
immutable scan evidence, not assertions that the updated source has already
been reanalyzed by Codacy.
