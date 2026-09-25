# Exact-head non-provider verification evidence

`scripts/run_receipt_verification.mjs` records non-provider execution evidence for a later independent Hyperliquid implementation-receipt review. It does not create or approve a receipt, change `ccxt_implementation_reviews.py`, contact an exchange, authorize provider acceptance, or replace exact-head GitHub CI. Dependency audit and monitoring commands may use the network; they do not use exchange credentials.

Run it only after the source is frozen and all build inputs are committed. From the repository root, with Node 22/npm 10.9 and the hash-locked Python 3.12/CCXT 4.5.75 environment installed:

On the current WSL staging host, use the verified Linux Node distribution and the separately installed Python lockfile environment; do not let the Windows npm executable on WSL `PATH` supply the runtime:

```bash
revision=$(git rev-parse HEAD)
git_binary=$(command -v git)
git_digest=$(sha256sum "$git_binary" | cut -d ' ' -f 1)
node_binary="$HOME/.local/tsx-node-22.22.1/bin/node"
python_binary="$HOME/.local/tsx-core-python-3.12/bin/python"
tag=freeze-20260925-01
for group in foundation backend python frontend build browser mutations dependencies; do
  "$node_binary" scripts/run_receipt_verification.mjs --sha "$revision" --python "$python_binary" --git "$git_binary" --git-sha256 "$git_digest" --group "$group" --tag "$tag" || exit 1
done
```

The downloaded Node archive was checked against the official Node release SHA-256 list, and the Python environment was installed using both repository `requirements*.lock` files with `--require-hashes`. Record and independently review those installation commands, manifest/digests, and the clean `npm ci` installations before treating any local command output as dependency-bound evidence. The following PowerShell example is for a separately provisioned Windows Node 22/npm 10.9 host, not the current Windows Node 24 shell:

```powershell
$revision = (git rev-parse HEAD).Trim()
$python = 'C:\Users\nikla\Documents\ChatGPT\TSX CORE SERVER INSTALLATION\tmp\tsx-security-python-env\Scripts\python.exe'
$git = (Get-Command git -CommandType Application).Source
$gitDigest = (Get-FileHash -LiteralPath $git -Algorithm SHA256).Hash.ToLowerInvariant()
$tag = 'freeze-20260925-01'
foreach ($group in @('foundation','backend','python','frontend','build','browser','mutations','dependencies')) {
  node scripts/run_receipt_verification.mjs --sha $revision --python $python --git $git --git-sha256 $gitDigest --group $group --tag $tag
  if ($LASTEXITCODE -ne 0) { throw "Verification group failed: $group" }
}
```

Use the actual absolute interpreter path on the verification host. The Git digest computed above is an observation, not a trust decision: an independent reviewer must verify the executable and approve its exact digest before using these reports. Tags are unique and may contain only lowercase letters, digits and hyphens. Reports and logs are written without replacing a previous initial report under `reports/receipt-verification/<tag>/`. Keep the complete directory as restricted review evidence; it is ignored by Git.

Before each group and after each successful command, the runner requires the expected HEAD, a clean Git index/worktree and an exact byte comparison of every discovered implementation build input with the frozen Git blobs. This also catches ignored or untracked files in the source inventory. Git must be an absolute, canonical executable matching the explicitly supplied SHA-256; a different `git` earlier on `PATH` is rejected. The executable path and digest are recorded for independent review. It checks the pinned Node/npm and Python/CCXT runtime, captures current executor, SDK and profile hashes, and repeats source/runtime checks after the group. Every command's exit status, timestamps, exact arguments and log SHA-256 are recorded. A failed command stops its group; an incomplete or failed report is not a green verification. The command inventory includes the current Quality-OS static, test/coverage, build, browser, mutation and dependency checks, including B2 gateway, B2 audit receiver, incident Worker and internal-TLS/Hyperliquid preflight tests. Mutation shards run separately with bounded 50/30-minute budgets matching CI.

Child processes receive only an allowlist of operating-system path/cache variables and the explicit Python and Git runtime paths. They do not inherit `NODE_OPTIONS`, `PYTHONPATH`, `npm_config_*`, arbitrary application variables or secrets; network audit commands may therefore need a separately reviewed non-secret network configuration. npm must come from the installation adjacent to the running Node executable. These reports **do not prove dependency-install provenance**: a clean, reproducible `npm ci` and hash-locked pip installation on an isolated host still need separate evidence. Accordingly, `performedGateExecution`, `receiptSufficiency` and `providerAcceptanceVerified` remain false even when `supplementalChecksPassed` is true.

An independent reviewer must verify that all eight terminal reports pass and bind the same frozen SHA, complete source inventory and runtime; inspect their logs and actual test counts; compare the command inventory with the **then-current** required CI workflow; review every source delta and the parity witness graph; and validate any candidate receipt separately. The runner cannot prove container execution, hosted scanners, real provider responses, off-host restore, alert delivery, or a live release. If CI adds a required command, update and review this bound runner before freezing the source; never treat an older report as evidence for a newer revision.
