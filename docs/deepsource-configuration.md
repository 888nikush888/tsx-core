# DeepSource analysis configuration

## Verified baseline

The authenticated, fully paginated September 8, 2026 export contains 6,620 unique
static issue occurrences at `be8cf5af59f60d69ad946d778973add8161b7672`.
The documented API `repository.configJson` and `enabledAnalyzers` were queried
before writing this configuration. All four enabled analyzers are preserved:
JavaScript, Python, Docker, and Secrets. Existing generated-artifact exclusions
are unchanged; no source file exclusions or rule suppressions are added.

The cloud JavaScript settings incorrectly selected `module_system = commonjs`.
Both root and frontend package manifests declare `type = module`, and the root
ESLint configuration already uses `sourceType = module`. The new TOML makes
ES modules, TypeScript, Node/browser globals and React explicit. It also identifies
the root JavaScript tests and frontend end-to-end tests as tests. Existing Airbnb
style selection and the strict `low` JavaScript complexity threshold are retained.
Python retains mypy, 100-character line length and `medium` complexity.

The legacy cloud `ecma_version = 2020` and `track_test_doc_coverage = false` keys
are not in the current documented JavaScript/Python option schemas and are not
copied into the new file. No documentation-coverage skip is added. Node 22 is
declared by the package manifests; the analyzer has no documented Node-version
option. Python 3.12 is declared in `.python-version`; the documented analyzer
selector is `3.x.x`, not an invented `3.12` selector.

## Findings and expected change

| Rule | Before | Assessment and expected result |
| --- | ---: | --- |
| JS-0833 | 279 | Parser errors explicitly reject import/export without sourceType module. Correct ESM configuration should resolve this class and allow previously unparsed JS files to be analyzed. New substantive findings may appear. |
| JS-0067 | 2,780 | Global-scope warnings on top-level module functions. Official rule documentation explicitly says ESM declarations are module scoped. Strong configuration-artifact candidate; verify the fresh scan before closing. |
| JS-R1005 | 1,112 | Complexity exceeds the existing low threshold. This is a policy finding, not a parser error. Threshold remains low; decompose carefully with behavior tests. |
| JS-0323 | 1,052 | Explicit any types. Requires meaningful boundary types or narrowing; blanket replacement with unknown or assertions is unsafe. |
| JS-0339 | 329 | Non-null assertions. Replace with validated invariants or narrowing when justified; preserve error behavior. |
| JS-0116 | 222 | Async functions without await. Some expose a Promise contract or wrap synchronous throws; do not mechanically remove async. |
| SCT-A000 | 36 | Potential secrets. Separate review required; test classification does not establish false positive status. |

Purely mechanical candidates for later review include redundant explicit Boolean
comparisons and proven redundant assertions. Such edits still require rule-level
fixtures and type checking. This change performs no source codemods.

## Validation and activation

TOML is parsed with Python `tomllib`; analyzer names/options are compared with the
official reference and the live cloud inventory. Authenticated GraphQL schema
introspection exposes no query or mutation whose name contains config, valid, or
lint, and no documented configuration-validation endpoint was found. Consequently
there is no claimed platform lint or completed rescan for this unpushed file.

After merge, verify that file-based configuration is enabled in DeepSource, the
effective `configJson` matches the TOML, and all four analyzers finish on the new
default-branch SHA. Then export again and compare rule counts, especially JS-0833
and JS-0067. Do not claim a fixed numerical reduction in advance. DeepSource
documents that PR configuration changes and full default-branch analysis can
produce different results.

The current official reference lists TypeScript support through 5.9, while this
repository uses TypeScript 6.0.3. Any remaining parser incompatibility needs
explicit scanner verification; this change does not downgrade the application.

Sources, checked September 8, 2026:
- https://docs.deepsource.com/docs/platform/reference/core-analyzers
- https://docs.deepsource.com/docs/developers/api/repository
- https://docs.deepsource.com/docs/platform/getting-started/configure-analyzers
- https://docs.deepsource.com/docs/platform/support/troubleshooting
- https://deepsource.com/directory/javascript/issues/JS-0067
- https://deepsource.com/directory/javascript/issues/JS-R1005
