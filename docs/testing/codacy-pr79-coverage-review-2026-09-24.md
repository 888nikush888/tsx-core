# Codacy PR #79: coverage helper review (24 September 2026)

Source analyzed by Codacy: `34a932dc2da90feff6d3ca9218d925e6655cabf0`.
Codacy reports seven new security issues and 33 potentially fixed issues on this
PR. The coverage panel is still waiting for reports. This is not a complete
quality verdict: Codacy ESLint 9.18.10 exits with an exception in
`security-node/detect-unhandled-async-errors` while inspecting valid async
`try`/`finally` functions in `backup_cli.ts`, `trading_recovery.ts`, and
`run_staging_e2e.js`. The provider error is not a source finding and remains
open; rewriting those recovery paths to satisfy a crashing analyzer would be a
trading-stability risk. No quality gate or analyzer has been disabled.

Three findings are actionable even though their interpolations have bounded
values: `b68ad027471e06b1fc9814097f616eeb` and
`b2acb187fc5a538d8c2d1dbf215b2ab7` in
`tests/test_operational_field_inventory.js`, and
`3823902244befc6589c1d42c3ba643bc` in `tests/test_lcov_paths.js`.
The follow-up source change replaces each dynamic `RegExp` with literal-line
matching. The tests still require the exact coverage-report command, critical
alert fields, and six-space Compose TLS binding. Targeted tests and ESLint
passed locally; cloud reanalysis remains required.

Four findings in `scripts/verify_codacy_coverage_paths.py` are reviewed
individually, not silently discarded:

| Codacy ID | Concern | Source-bound assessment |
| --- | --- | --- |
| `dfee97def6b9a73a0ad20bf69f57e17a` | Native XML parser may allow XXE | Expat's DTD and entity handlers raise; external-entity handler raises; parameter entities are disabled. The 10 MB input bound prevents unbounded coverage input. A DTD/external-entity negative fixture fails before upload. This specific use does not resolve external entities. |
| `f8850f9e0e0039277096915246cc92b5` | Dynamic subprocess executable | Only `git` from `shutil.which` is resolved to an absolute executable. The arguments are the fixed literals `ls-files` and `-z`; no report value enters the command. |
| `a7d4f19413bcce70e679dc0863534744` | Untrusted subprocess input | The process has `shell=False` and a fixed repository working directory. Coverage paths are compared with its tracked-file output after the process exits; they are never passed as command arguments. |
| `bf805c51d649ddbda74ba6f9e3663ea5` | Generic subprocess import | The import serves only the fixed Git invocation described above. No arbitrary command or shell interpreter is exposed. |

These four assessments are **pending a provider-complete rescan** and are not
equivalent to a green Codacy gate. The operator has declined contacting Codacy
support for now. Coverage upload additionally needs the repository-scoped
`CODACY_PROJECT_TOKEN` secret; the account-level token is deliberately not
used. No scanner finding is claimed resolved merely because this review exists.
