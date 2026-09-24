# Exact-head offline verification evidence

`scripts/run_receipt_verification.mjs` records non-provider execution evidence for a later independent Hyperliquid implementation-receipt review. It does not create or approve a receipt, change `ccxt_implementation_reviews.py`, contact an exchange, authorize provider acceptance, or replace exact-head GitHub CI. Dependency audit and monitoring commands may use the network; they do not use exchange credentials.

Run it only after the source is frozen and all build inputs are committed. From the repository root, with Node 22/npm 10.9 and the hash-locked Python 3.12/CCXT 4.5.75 environment installed:

```powershell
$revision = (git rev-parse HEAD).Trim()
$python = 'C:\Users\nikla\Documents\ChatGPT\TSX CORE SERVER INSTALLATION\tmp\tsx-security-python-env\Scripts\python.exe'
$tag = 'freeze-20260925-01'
foreach ($group in @('foundation','backend','python','frontend','build','browser','mutations','dependencies')) {
  node scripts/run_receipt_verification.mjs --sha $revision --python $python --group $group --tag $tag
  if ($LASTEXITCODE -ne 0) { throw "Verification group failed: $group" }
}
```

Use the actual absolute interpreter path on the verification host. Tags are unique and may contain only lowercase letters, digits and hyphens. Reports and logs are written without replacing a previous initial report under `reports/receipt-verification/<tag>/`. Keep the complete directory as restricted review evidence; it is ignored by Git.

Before each group and after each successful command, the runner requires the expected HEAD, a clean Git index/worktree and an exact byte comparison of every discovered implementation build input with the frozen Git blobs. This also catches ignored or untracked files in the source inventory. It checks the pinned Node/npm and Python/CCXT runtime, captures current executor, SDK and profile hashes, and repeats source/runtime checks after the group. Every command's exit status, timestamps, exact arguments and log SHA-256 are recorded. A failed command stops its group; an incomplete or failed report is not a green verification. The command inventory includes the current Quality-OS static, test/coverage, build, browser, mutation and dependency checks, including B2 gateway, B2 audit receiver, incident Worker and internal-TLS/Hyperliquid preflight tests.

An independent reviewer must verify that all eight terminal reports are green and bind the same frozen SHA, complete source inventory and runtime; inspect their logs and actual test counts; compare the command inventory with the **then-current** required CI workflow; review every source delta and the parity witness graph; and validate any candidate receipt separately. The runner cannot prove container execution, hosted scanners, real provider responses, off-host restore, alert delivery, or a live release. If CI adds a required command, update and review this bound runner before freezing the source; never treat an older report as evidence for a newer revision.
