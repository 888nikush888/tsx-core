# Final findings follow-up — 2026-09-20

Implementation of advisor plan004 is in progress, stability first. JS-R1005 alone remains excluded; no new provider approval, deployment or remote issue transition is claimed.

## Verification blockers corrected

The emergency regression was reproduced at the Hyperliquid profile with CUMULATIVE_EXECUTION_MISMATCH. Its fixture supplied descriptive alphabetic exchange IDs where both pinned Python and TypeScript native proof contracts require decimal IDs. Three fixture expressions now generate unique decimal provider IDs within each Hyperliquid fixture account; client IDs, other profiles, persistence relationships and production guards are unchanged. An independent reviewer verified append-only order/fill collections and cancellation behavior. Eight focused emergency, fill identity, immutable evidence and accounting suites passed.

Both full backend runs then passed with unchanged input bytes:227 registered test files; critical coverage97.23% statements/lines,90.5% branches,100% functions; module coverage96.62% statements/lines,86.73% branches,99.24% functions. Logs are preserved under reports/final-findings/verification-backend-emergency-fixture-20260920.json. These runs precede the later small changes below and are not claimed as their final integrated verification.

All103candidate assessments/84evidence references/21unique paths were checked for drift. The only mismatch was Bybit's test_history_coverage.py evidence, whose sole content delta preserves iterator/filter, failure message and assertion using a unique object sentinel instead of catching StopIteration. Independent source review approved updating only this reference and the resulting assessment commitment. Decisions, reasons, inventory and lack of provider acceptance remain unchanged. Three candidate policy tests and12history coverage tests passed. The subsequent full Python coverage run passed548tests with unchanged input bytes; coverage report and XML succeeded. Report: reports/final-findings/verification-python-candidate-renewal-20260920.json.

## Small subsequent source and tooling corrections

- Three MCP resultJson row fields now reflect nullable database columns. Independent review checked schema, inserts, projections and the existing null-accepting parser; generated runtime behavior is unchanged.
- ESLint exports the flat array directly. The old helper result and current array were compared with deepStrictEqual using installed packages; all six entries, rules, parser and plugin bindings match.
- Executor apk arguments are sorted without changing any package/version or installation flags. The supply-chain assertion verifies all four quoted pins inside the actual apk command. Its former first-argument-only SQLite regex was updated after it rejected the valid reordering. It is not a general shell parser.
- Browser CI directly invokes the lockfile-installed playwright/cli.js for installation and tests, retaining working directory, matrix arguments and preceding npm ci. This removes an npx fallback; local CLI reports1.61.1. Supply-chain and governance tests pass.
- Six native config read/parse/validation failure checks cover synchronous and asynchronous cause/message preservation. They do not exercise the native unlink-cleanup failure branch. No new production error policy or arbitrary object-throw contract was introduced.

Focused config/MCP/supply-chain suites, backend typecheck and targeted ESLint passed before the final workflow invocation adjustment; supply-chain/governance suites passed after it. Exact final-source integrated verification, coverage ratchet update, implementation receipts and cloud scans remain pending. No old execution is rebound to changed source bytes.

## Historical findings and review boundaries

Fresh complete main inventories still reference58c01bc7: Codacy92active+347ignored; DeepSource1315active including1178excluded JS-R1005; Sonar79open,8resolved individual decisions,1220closed and no hotspots. Codacy retains Trivy/ESLint analyzer errors; its passing delta gate does not establish complete analysis.

All225retained DeepSource runs and900checks were fully paginated:29282unique STATIC check issue IDs, zero isSuppressed=true. Newest/oldest run boundaries were stable on recheck. API-retained history spans September7–17; deleted/expired history and reason/audit trails are not exposed, and incremental checks are not complete repository snapshots. The370known inline suppression comments remain a separate review population.

All1220closed Sonar records now have initial path/scope/current-source evidence. Independent detailed reviews cover42same-rule/path overlap records and20unique excluded/deleted-path records; some remain unresolved, and these sets are not automatically additive. Three native config diagnostic closures required actual producer-contract review beyond their type casts. Docker/ESLint/workflow constructs that disappeared from scanner scope were reviewed separately; changes above address maintenance findings without weakening digest pinning. Remaining historical mappings, deleted component behavior and final scan confirmation are still required.

Source-context renewal candidates are prepared per affected occurrence. Adoption requires checking candidate, previous-ledger and current-source bytes and preserving historical execution metadata. The previous frozen1f21249receipt preparation does not certify the changed tree. Container Docker daemon is unavailable locally; native monitoring configuration checks do not prove the hardened container images. Main branch protection and review requirements remain unchanged.
