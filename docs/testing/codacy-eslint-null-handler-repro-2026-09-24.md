# Codacy ESLint analyzer crash: independent diagnosis

Observed on PR #79 analysis for `b3a15c843a0da858ceb81484b3cc7b4fa745d196`. The two sanitized Codacy exports `codacy-b3a15c84-prior-logs.json` and `codacy-b3a15c84-logs.json` both mark ESLint `error`. The later run was 2026-09-24 19:18:35–19:19:52 UTC. Its `codacy/codacy-eslint:9.18.10` stack reports `TypeError: Cannot read properties of null (reading 'type')` in `security-node/detect-unhandled-async-errors`, `isTryCatchStatement` line 41, while linting `src/trading_recovery.ts:47`, `src/backup_cli.ts:22`, and `scripts/run_staging_e2e.js:30`. These three files have the same SHA-256 as the earlier failing b3 triage: `8d5e993cc840bc7e1c1308373e4158bc46560366ae4934c5098f9353f228130a`, `d0fd89cea0779ef15598a6d07d1ce7930ee2c9df815c71a2036ed0ef17c8fd7d`, and `c52ec25fee05b5865e0356648a1ac0d42c37af1318010c46474cd645e889d64a`, respectively. The current integration checkout still contains those exact bytes as of this diagnosis.

The [upstream 1.1.4 rule](https://raw.githubusercontent.com/gkouziik/eslint-plugin-security-node/1.1.4/lib/rules/detect-unhandled-async-errors.js) checks `bodyArg.handler.type` whenever `bodyArg.type === 'TryStatement'`. An ESTree `try … finally` without `catch` has `handler: null`. The older [upstream PR #63](https://github.com/gkouziik/eslint-plugin-security-node/pull/63) only guards a null **catch parameter**; it does not guard a missing catch handler. The [Codacy ESLint dependency manifest](https://raw.githubusercontent.com/codacy/codacy-eslint/master/package-lock.json) still resolves `eslint-plugin-security-node` 1.1.4. The Codacy container stack is consistent with that build. This is an analyzer exception, not a source-code finding or a successful full scan.

## Smallest independent probe

Outside the TSX repository, install only `eslint@8.57.0` and `eslint-plugin-security-node@1.1.4`. Put this synthetic single line in `probe.js`:

```js
async function probe() { try { await Promise.resolve(); } finally {} }
```

Run ESLint 8 with no repository configuration and only the affected rule:

```sh
npm install --no-save --ignore-scripts --no-audit --no-fund eslint@8.57.0 eslint-plugin-security-node@1.1.4
node node_modules/eslint/bin/eslint.js --no-eslintrc --env es2022 --parser-options '{"ecmaVersion":2022}' --plugin security-node --rule 'security-node/detect-unhandled-async-errors:error' probe.js
```

The isolated execution on Node 22.23.2 exits 1 with the same `null.type` error and the same plugin stack positions: `isTryCatchStatement:41:21`, `FunctionDeclaration:113:19`. The synthetic file has SHA-256 `fd2c79b112749da1396e2bd9c4d9d5ea83ef9b59978352ad8d8f843b6e08e12d`. No token, TSX source excerpt, account data, or provider request is required.

## Safe recovery boundary

No verified repository-only change can repair the cloud container's rule while keeping the three valid `try … finally` functions, all analyzed files, the rule, and the quality gate intact. Changing the application's cleanup/rejection flow or adding catch/rethrow solely to placate the scanner is not a justified stability fix. Adding a project dependency does not demonstrably replace the plugin bundled under Codacy's `/node_modules` path. A `.codacy.yml` exclusion or disabling the pattern would remove coverage and would not satisfy complete analysis.

The direct resolution is an upstream/Codacy build with a null-handler guard in this rule, followed by an exact-commit reanalysis proving ESLint completes across the whole repository. Codacy [documents a build-server ESLint route](https://docs.codacy.com/repositories-configure/local-analysis/running-eslint/) using remote code patterns and SARIF upload; that is a candidate only after the current pattern set and file coverage are shown equivalent, the synthetic probe and all three affected files pass, cloud/tool-mode interaction is verified, and the same commit's gate consumes the complete result. None of those conditions has been demonstrated here. No Codacy settings, rules, gates, source files, credentials, or support channel were changed or used.
