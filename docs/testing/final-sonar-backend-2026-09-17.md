# Final backend Sonar cleanup evidence — 2026-09-17

The complete main baseline is analysis dc4e3d23-4cad-4d91-abaf-b8c1e239815e, revision 58c01bc74f83cc212849ddcd7e487412ff06b2b7, captured by the existing exporter at reports/final-findings/sonar-baseline. Capture was complete and stable: 1,307 issues across all statuses, 79 open issues and zero security hotspots. This package covers 46 backend occurrences: 31 SQL projection annotations, nine other source-level fixes, and six individually justified false-positive candidates. Source-level outcomes remain pending a candidate scan.

## Behavior and boundary contracts

- Journal loaders now use separate intent/join, order, fill, timeline and schema projections. LEFT JOIN fields retain nullability. MCP runtime state follows its TEXT/INTEGER NOT NULL schema. Search projections declare the selected scalar aliases. Adaptive pagination reuses concrete risk projections and requires the selected clock and identity keys. SQL statements, money values, existing conversions and transactions are unchanged.
- TDLib chat identity accepts primitive strings verbatim and safe integer numbers (including negative IDs and zero). The pinned native type declares chat.id as number at node_modules/@prebuilt-tdlib/types/tdlib-types.d.ts:9231; tdl documents int53 as JavaScript number at node_modules/tdl/README.md:137. Existing string compatibility is preserved. Arrays, boxed/custom objects, missing values and unsafe/nonfinite numbers reject before a manufactured identity can route a message. Existing numeric lookup/fallback ordering remains.
- Additional contract minimum/maximum bounds are optional primitive decimals. The published contract declares strings (src/trading_types.ts:119); existing number and bigint callers remain supported through the existing decimal normalizer. Undefined/empty omission, whitespace and decimal spelling normalization remain. Structured values are rejected without calling their converters.
- Paper market producers require symbol:string (src/trading_types.ts:512 and src/trading_web_control.ts:2). Revision lookup rejects structured/numeric symbols before lookup; missing/null retains the empty fallback. Primitive case/whitespace normalization remains. Integration confirms rejected combined changes do not alter the balance or market. Baseline's revision helper could coerce arrays/boxed strings to BTC; this evidence does not claim that every such malformed value previously passed the later market writer.
- Invalid API-ID diagnostics now describe the type without another conversion. API-ID normalization is unchanged. Backup optional chaining preserves fail-closed proof, artifact, freshness and eligibility checks.

## Individual exception candidates

These are per occurrence findings, with current source and test evidence. No rule exclusion or remote status transition was performed by this package. Config, parser/retry classification and web snapshot behavior remain unchanged at these sites.

| Issue | Baseline location | Evidence and rationale |
| --- | --- | --- |
| AaCvLE7QFuOCeZdBf0dv | src/config.ts:311 | normalizeModelNames excludes null, arrays and every object before String(rawValue). The remaining primitive/function compatibility is intentional and the allowlist rejects invalid text. Fresh tests prove default and custom object conversion is never called, while string/number/boolean/bigint and the existing custom function conversion retain their exact prior result. |
| AaCvLE_4FuOCeZdBf0d2 | src/signal_parser.ts:198 | providerCode is diagnostic classification of an unknown Error-like value. Existing bounded allowlist rejects default object text; Error-like custom code conversion and numeric cause.code remain compatible. Tests verify default object exclusion, valid custom conversion, invalid text exclusion and propagation of a throwing converter. No identity, amount or authorization key is derived here. |
| AaCvLE_4FuOCeZdBf0d3 | src/signal_parser.ts:226 | Error-like name is intentionally converted for timeout classification. Default object text does not match timeout; a legacy custom name returning ProviderTimeoutError does. Restricting names to primitive strings would change established retry behavior. Fresh tests cover both outcomes without modifying source. |
| AaCvLE_bFuOCeZdBf0d1 | src/tdlib_retry.ts:52 | The bounded TDLib retry classifier intentionally accepts Error-like message or whole-error conversion. Default object text is not FLOOD_WAIT and rethrows the original value after one attempt. Fresh tests retain primitive and custom message/whole-error FLOOD_WAIT_0 retries and original-error identity for ordinary errors. |
| AaCvLE5sFuOCeZdBf0ds | src/web_server.ts:1699 | Production Config.sourceChannels is string[] and validateSideEffectContracts rejects any non-string element before persistence/use. The private snapshot compatibility path also supports legacy records with primitive id/name or channelId/title fields. Existing web-server tests were rerun and preserve exact primitive identifiers. No new malformed-legacy metadata policy is introduced for this read-only display endpoint. |
| AaCvLE5sFuOCeZdBf0dt | src/web_server.ts:1700 | Production sourceChannels entries are validated primitive strings. Tested legacy display records supply primitive name/title (or id fallback). The snapshot keeps these existing display labels unchanged; rejecting or recasting unsupported legacy metadata merely to satisfy S6551 would introduce a new runtime policy. Fresh execution of the current web-server compatibility test confirms exact labels. |

The web snapshot exceptions cover the supported production string list and tested legacy primitive metadata records. They do not declare arbitrary malformed records safe; changing the fallback policy for such records needs a separately specified display/compatibility requirement.

## Validation

Node v22.23.2: all 13 focused suites passed. Backend type checking and targeted ESLint passed. The JSON companion contains each test, duration, every issue key/disposition, and observed file hashes. Hashes are evidence bindings, not independent approval or renewed scanner attestations.

- tests/test_trade_journal_streams.js
- tests/test_trading_fx_journal_viewer.js
- tests/test_mcp_control_plane.js
- tests/test_ui_change_reviews.js
- tests/test_ui_adaptive_risk.js
- tests/test_backup_evidence.js
- tests/test_config.js
- tests/test_forwarder_error_types.js
- tests/test_signal_contract_validation.js
- tests/test_signal_parser.js
- tests/test_tdlib_retry.js
- tests/test_trading_web_control.js
- tests/test_web_server.js

Red-before/green-after evidence exists for returned TDLib identities and structured contract bounds. Paper revision conversion was compared in memory against the exact baseline Git blob without editing the baseline. Existing parser/retry coercion is characterized explicitly, including object defaults, custom Error-like conversion and original exception propagation.

## Integration limits

No commits, staging, pushes, scanner configuration changes, remote issue transitions or cryptographic attestation renewal were made. Fill identity, frontend, scripts and Python are separate owners. The parent agent must independently review this source diff and reconcile candidate scan results before calling findings closed. Historical accepted/false-positive decisions were not overwritten.
