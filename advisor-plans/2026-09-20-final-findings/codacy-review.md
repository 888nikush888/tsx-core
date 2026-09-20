# Codacy re-audit for the final-run plan — 2026-09-20

Read-only review. No source changes, provider decisions, reanalysis triggers or support messages. Audit playbook Security, Test Coverage and Finding format were read. Credentials were used only in the authenticated API header; no credential values or source-line secrets are included here.

## Freshness and complete inventory

On 2026-09-20 at 10:08:51–10:08:54 UTC the read-only issue-search API returned all **92 active records in one page and 347 ignored records in four pages**. All 439 IDs exactly match `docs/testing/final-codacy-2026-09-17.json`: no new, missing or duplicate IDs. This includes all prior false-positive decisions, not only active findings.

The latest main analysis remains `58c01bc74f83cc212849ddcd7e487412ff06b2b7`, started 2026-09-17 12:14:36 UTC and ended 12:15:07 UTC. A fresh log request still contains two error steps: Trivy with `Line numbers not supported`, and ESLint with `Cannot read properties of null`. A passing delta gate (zero new, 21 fixed) is not successful complete analysis. Current local source is `1f21249adc48f74bf139562e89ca261b14aebc27`; the cloud has not analyzed that revision.

`node scripts/check_final_codacy_review.js` passed during this audit: all **439 occurrences and 116 source/context files** still match the reviewed evidence. This proves ledger consistency, not independent semantic correctness or scanner success.

| Disposition in existing per-ID review | Count | Final-run treatment |
|---|---:|---|
| Active false-positive candidates | 59 | Reconfirm each current occurrence, then apply individual decisions only after source verification |
| Previously ignored current-code occurrences, re-reviewed | 343 | Retain only while exact controlling flow and caller assumptions hold |
| Superseded ignored statements | 4 | Record absent current statement; never invent a replacement suppression |
| Stale/incomplete Trivy records | 33 | Keep unresolved until successful refreshed dependency analysis |

Active rules: 50 local-fixture SSRF, eight backup-fixture path traversal, one intentional control-character rejection, and 33 Trivy records (22 high, nine medium, two minor). Full ignored-rule inventory remains in the JSON ledger.

## Reclassification boundaries

The existing 439-record semantic review and its final-source renewal are available; this audit freshly reconciled every provider ID and source binding and directly inspected representative high-risk controlling flows. It does not claim that all 439 complete caller chains were independently re-read today.

Direct source inspection supports retaining the current narrow decisions: `src/executor_origin.ts:23` constrains the executor origin; `src/telegram_viewer/internal_transport.ts:38` allows configured HTTPS and separately constrains cleartext hosts; `src/filters.ts:33` performs matching with a VM timeout; `src/backup_generation.ts:103`, `:126`, `:160` and `:170` enforce directory/member/file and exclusive-write boundaries. These are specific flow arguments, not global security guarantees. In particular, the cleartext allowlist is not a universal HTTPS or redirect allowlist, and lstat followed by read is not an OS-level race-proof open. Operator startup authority and private fixture roots must remain part of each rationale.

Do not weaken the workflow label control-character rejection, change Promise rejection timing, remove finally cleanup or rewrite SQLite/accounting boundaries merely to make an analyzer quiet. Credential-pattern findings require provenance evidence; any real exposed credential requires rotation as well as removal, without reproducing its value in reports.

## Findings and execution gates

### [CODACY-01] Recover complete analyzer coverage before final closure

- **Evidence:** `docs/testing/final-codacy-2026-09-17.provider.md` and fresh exact-main logs retain two tool failures. Valid try/finally remains at `src/backup_cli.ts:26`, `src/trading_recovery.ts:52` and `scripts/run_staging_e2e.js:32`. `monitoring/govulncheck/go.mod:1` is the Trivy error target.
- **Impact:** 33 dependency findings cannot be resolved confidently, and the failed ESLint run cannot prove complete code coverage even with a green delta gate.
- **Effort:** M plus external provider response time.
- **Risk:** LOW for provider recovery; HIGH if application cleanup/rejection behavior is rewritten to avoid the scanner bug.
- **Confidence:** HIGH for continued analyzer failure; deployed adapter version and exact unlocated dependency still need provider confirmation.
- **Fix sketch:** Use the prepared sanitized provider report when sending is authorized. Obtain a corrected deployed analyzer and exact-final-SHA rescan; alternatively validate local-analysis parity against all 118 currently enabled ESLint patterns and complete source scope before migration. Never disable a tool, rule or file to declare success.

### [CODACY-02] Bind every final disposition to tested source and complete fresh exports

- **Evidence:** The ledger has 59 proposed decisions, 343 historical current-code decisions and four absent statements; current integrity passes, but no cloud analysis exists for local `1f21249`.
- **Impact:** Applying decisions solely from historical ignored state or a passing hash check could hide a changed caller boundary or new occurrence.
- **Effort:** M, including targeted regressions and final scan reconciliation.
- **Risk:** MED; source and caller changes can invalidate an otherwise correct exception.
- **Confidence:** HIGH.
- **Fix sketch:** Freeze the chosen candidate SHA, review any source/caller delta, and run meaningful backup/restore, session/API, regex timeout and trading identity/dispatch/precision regressions. After successful final-SHA analysis, map all current IDs to the per-occurrence evidence, individually apply justified dispositions, and export/reconcile active, ignored and per-file inventories again.

Final success requires: (1) all intended tool steps successful on the exact delivered SHA; (2) every current record and every previously ignored record accounted for; (3) repository and file counts agree; (4) zero unresolved actionable findings, with justified false positives and explicit user exceptions reported separately; (5) required application/CI checks pass without reduced gates; (6) post-merge main rescans confirm the delivered state. Provider failures remain explicit blockers even if application work can proceed safely.
