# Verified security dependency updates

Authenticated Snyk CLI 1.1307.1 scans included development dependencies and
ignored policies. The initial backend scan reported six unique vulnerabilities;
the frontend reported 17. Updated dependency scans report zero vulnerabilities
for both trees. The native reports are retained under ignored `reports/snyk/`.

| Scope | Exact update |
| --- | --- |
| Backend override | Hono 4.12.34 → 4.13.5; Undici 6.28.0 → 6.28.1 |
| Frontend overrides | Hono 4.13.5; fast-uri 3.1.7; js-yaml 4.3.2; Undici 7.29.1 |
| Frontend test tools | Vitest and coverage-v8 4.1.10 → 4.1.11, with their matching internal packages |

Package versions and Node compatibility were verified against the npm registry.
The frontend lock update also refreshes three dependencies in the Vitest tree:
es-module-lexer 2.3.1 → 2.3.2, tinyexec 1.2.4 → 1.3.1, and tinyrainbow 3.1.0 → 3.1.1.
No application major-version migration is included.

npm 10.9.8 and the declared 10.9.2 both crashed inside Arborist while resolving
Vitest peers. npm 11.11.0 generated the lock in an isolated temporary directory;
only that resolver invocation allowed the npm engine mismatch. The resulting
lock was installed successfully with normal Node 22/npm 10 `npm ci`. Repository
engine requirements, install flags, and CI versions were not relaxed.

Both npm audits (including low severity), dependency policy, license policy,
ESLint, parser regression tests, complete frontend tests, and application build
passed after these updates. Final combined-commit CI is still required.

## Reproducible local Python checks

The previous shared test environment did not exactly match the runtime lock.
A separate Python 3.12 environment now installs the runtime lock with hashes.
The development lock previously allowed Linux wheels only. The corresponding
Windows x86_64 CPython 3.12 coverage wheel and Windows Ruff wheel hashes were
verified against official PyPI metadata and added alongside the existing Linux
hashes. Versions and the runtime dependency lock are unchanged. A fresh complete
hash-checked install and `pip check` passed.

Snyk successfully scans the installed Windows runtime tree from requirements.in
and the development lock. Linux runtime validation remains a separate CI scan.
