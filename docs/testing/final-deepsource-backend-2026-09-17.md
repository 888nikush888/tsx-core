# Remaining DeepSource backend review — 2026-09-17

The complete default-main export at revision 58c01bc74f83cc212849ddcd7e487412ff06b2b7 has 1,315 unique occurrences. Excluding only JS-R1005 leaves 137. Subtracting the exact 57 DeepSource IDs in the UI/Python ledger leaves the 80 IDs in this document's JSON companion; the union is disjoint and complete.

## Results

- JS-0116: 56 individually reviewed retained Promise contracts — 25 production boundaries, 30 test wrappers/helpers, and one Paper-only fairness probe. The exact 31 test/probe functions were executed in memory with controlled dependencies. Every one retained immediate invocation, distinct native Promise adoption, and rejection of the original synchronous failure.
- JS-0105: two private engine helpers are already converted to static by root and await rescan. Their bodies are byte-identical after the modifier and every caller is qualified. Two engine instance seams remain necessary for actual damaged-plan and final-persistence-fence regressions; three Paper methods implement the selected adapter's instance interface.
- PYL-R0201: both Hyperliquid setup-refusal methods remain bound coroutine overrides. The pinned CCXT REST and Pro initialization test passed independently with no fetch calls.
- SCT-A000: 15 individually reviewed false positives: eleven local credential-storage fixtures/assertions, one forbidden quantity-field fixture, two documentation export-example assignments, and one historical TokenProvider type annotation inside escaped review diff. No credential values are reproduced.

The JSON ledger records every original ID/location, its particular function or fixture role, identifier references, supporting test files, source/function hashes, and rationale. Each rationale identifies the reviewed caller or dispatch path; identifier search results also include declarations and same-named methods. These are occurrence-specific review recommendations, not remote closures or family exclusions.

## Independent verification

Five focused Node suites passed: test_trading_control_error_types, test_trading_credentials, test_fill_quantity_contract, test_trading_engine_type_guards and test_trading_protection_receipt. The actual SDK async contract passed one Python test across REST/Pro initialization. A first Python launcher lookup found no registered 3.12 runtime; the existing project test environment was then used successfully without installing or changing dependencies.

The six control APIs preserve validation as rejected Promises, immediate mutation ownership and existing fence scope. The Paper wrong-exchange read also rejects asynchronously. The two retained engine seams prove no malformed-target side effect and final-source-fence rollback, respectively.

## Occurrence index

| ID | Rule | Location | Reviewed function or role | Disposition |
| --- | --- | --- | --- | --- |
| T2NjdXJyZW5jZTpnZXZqZHhqd2U= | JS-0116 | tests/test_workflow_migration.js:83 | anonymous async wrapper | reviewed_expected_behavior |
| T2NjdXJyZW5jZTpyZWt5bmd5cm4= | JS-0116 | tests/test_workflow_history_barriers.js:133 | anonymous async wrapper | reviewed_expected_behavior |
| T2NjdXJyZW5jZTptcmRvbmxva2s= | JS-0116 | tests/test_workflow_history.js:328 | anonymous async wrapper | reviewed_expected_behavior |
| T2NjdXJyZW5jZTp2dm1hbmRha3g= | JS-0116 | tests/test_workflow_fallback.js:843 | anonymous async wrapper | reviewed_expected_behavior |
| T2NjdXJyZW5jZTpveWFtZHZtb2s= | JS-0116 | tests/test_workflow_builder.js:725 | anonymous async wrapper | reviewed_expected_behavior |
| T2NjdXJyZW5jZTp4cmdhbmphb2Q= | JS-0116 | tests/test_web_server.js:2065 | anonymous async wrapper | reviewed_expected_behavior |
| T2NjdXJyZW5jZTprdnlrZGdrcGU= | JS-0116 | tests/test_telegram_viewer_service.js:429 | anonymous async wrapper | reviewed_expected_behavior |
| T2NjdXJyZW5jZTplYXhqeXZqbnI= | JS-0116 | tests/test_telegram_viewer_runtime.js:246 | anonymous async wrapper | reviewed_expected_behavior |
| T2NjdXJyZW5jZTpwcXdybmpydmQ= | JS-0116 | tests/test_telegram_viewer_core.js:394 | anonymous async wrapper | reviewed_expected_behavior |
| T2NjdXJyZW5jZTpuZ3d2ZGp2eG4= | JS-0116 | tests/test_telegram_viewer_api.js:276 | anonymous async wrapper | reviewed_expected_behavior |
| T2NjdXJyZW5jZTplYXhqeXZqa2Q= | JS-0116 | tests/test_signal_schema_migration.js:95 | anonymous async wrapper | reviewed_expected_behavior |
| T2NjdXJyZW5jZTpwcXdybmpyeWU= | JS-0116 | tests/test_signal_parser.js:592 | anonymous async wrapper | reviewed_expected_behavior |
| T2NjdXJyZW5jZTp3bXJhd3Bhb2U= | JS-0116 | tests/test_setup_bundle.js:488 | anonymous async wrapper | reviewed_expected_behavior |
| T2NjdXJyZW5jZTpqd2dlZG1lcnk= | JS-0116 | tests/test_retention.js:332 | anonymous async wrapper | reviewed_expected_behavior |
| T2NjdXJyZW5jZTpuZ3d2ZGp2eW4= | JS-0116 | tests/test_queue.js:288 | anonymous async wrapper | reviewed_expected_behavior |
| T2NjdXJyZW5jZTphbmFqdmxqZGw= | JS-0116 | tests/test_outbox.js:544 | anonymous async wrapper | reviewed_expected_behavior |
| T2NjdXJyZW5jZTpyZWt5bmd5dnk= | JS-0116 | tests/test_modules.js:121 | anonymous async wrapper | reviewed_expected_behavior |
| T2NjdXJyZW5jZTptcmRvbmxvcHI= | JS-0116 | tests/test_metrics.js:215 | anonymous async wrapper | reviewed_expected_behavior |
| T2NjdXJyZW5jZTp2dm1hbmRheW4= | JS-0116 | tests/test_metrics.js:214 | anonymous async wrapper | reviewed_expected_behavior |
| T2NjdXJyZW5jZTpveWFtZHZta28= | JS-0116 | tests/test_mcp_server.js:350 | anonymous async wrapper | reviewed_expected_behavior |
| T2NjdXJyZW5jZTp4cmdhbmpheXY= | JS-0116 | tests/test_integration.js:129 | anonymous async wrapper | reviewed_expected_behavior |
| T2NjdXJyZW5jZTprdnlrZGdrcXE= | JS-0116 | tests/test_filters.js:195 | anonymous async wrapper | reviewed_expected_behavior |
| T2NjdXJyZW5jZTpwcXdybmpyeGU= | JS-0116 | tests/test_dupe_blocker.js:201 | anonymous async wrapper | reviewed_expected_behavior |
| T2NjdXJyZW5jZTp3bXJhd3BheWU= | JS-0116 | tests/test_delivery_tracker.js:154 | anonymous async wrapper | reviewed_expected_behavior |
| T2NjdXJyZW5jZTpqd2dlZG1lcXk= | JS-0116 | tests/test_crash_guard.js:168 | anonymous async wrapper | reviewed_expected_behavior |
| T2NjdXJyZW5jZTpuZ3d2ZGp2ZW4= | JS-0116 | tests/test_coverage_perfektion.js:83 | anonymous async wrapper | reviewed_expected_behavior |
| T2NjdXJyZW5jZTphbmFqdmxqd2w= | JS-0116 | tests/test_configurable_fallback_migration.js:96 | anonymous async wrapper | reviewed_expected_behavior |
| T2NjdXJyZW5jZTpnZXZqZHhqeWw= | JS-0116 | tests/test_backup.js:566 | anonymous async wrapper | reviewed_expected_behavior |
| T2NjdXJyZW5jZTpyZWt5bmd5d3k= | JS-0116 | tests/evaluate_signal_golden_set.js:101 | anonymous async wrapper | reviewed_expected_behavior |
| T2NjdXJyZW5jZTpqd2dlZG1lank= | JS-0105 | src/trading_engine.ts:2106 | persistRemoteFill | source_change_pending_rescan |
| T2NjdXJyZW5jZTpuZ3d2ZGp2cG4= | JS-0105 | src/trading_engine.ts:1929 | storeReconciliationSuccess | reviewed_expected_behavior |
| T2NjdXJyZW5jZTphbmFqdmxqcWw= | JS-0105 | src/trading_engine.ts:1844 | assertRemoteAccountIdentity | source_change_pending_rescan |
| T2NjdXJyZW5jZTpkYWtqd2xqb2c= | JS-0105 | src/trading_engine.ts:1538 | ensureTakeProfitCoverage | reviewed_expected_behavior |
| T2NjdXJyZW5jZTpyZWt5bmd5eHk= | JS-0105 | src/paper_exchange.ts:475 | openState | reviewed_expected_behavior |
| T2NjdXJyZW5jZTptcmRvbmxveHI= | JS-0105 | src/paper_exchange.ts:358 | marketSnapshot | reviewed_expected_behavior |
| T2NjdXJyZW5jZTp2dm1hbmRham4= | JS-0105 | src/paper_exchange.ts:336 | accountSnapshot | reviewed_expected_behavior |
| T2NjdXJyZW5jZTpyZWt5bmdyb3I= | JS-0116 | src/db.ts:3870 | listOutboxTasks | reviewed_expected_behavior |
| T2NjdXJyZW5jZTptcmRvbmxrcXk= | JS-0116 | src/db.ts:3778 | claimOutboxTask | reviewed_expected_behavior |
| T2NjdXJyZW5jZTp2dm1hbmRrbHk= | JS-0116 | src/db.ts:3593 | findDuplicateSignal | reviewed_expected_behavior |
| T2NjdXJyZW5jZTpveWFtZHZvbmU= | JS-0116 | src/paper_exchange.ts:475 | openState | reviewed_expected_behavior |
| T2NjdXJyZW5jZTp4cmdhbmpvcG0= | JS-0116 | src/mcp_repository.ts:912 | claimNextMcpControlRequest | reviewed_expected_behavior |
| T2NjdXJyZW5jZTprdnlrZGdwbXI= | JS-0116 | src/mcp_repository.ts:640 | deleteMcpAgent | reviewed_expected_behavior |
| T2NjdXJyZW5jZTplYXhqeXZucWU= | JS-0116 | src/mcp_repository.ts:366 | setMcpRuntimeMode | reviewed_expected_behavior |
| T2NjdXJyZW5jZTpwcXdybmp2cGw= | JS-0116 | src/mcp_repository.ts:358 | getMcpRuntimeState | reviewed_expected_behavior |
| T2NjdXJyZW5jZTp3bXJhd3B4bnA= | JS-0116 | src/mcp_repository.ts:1244 | preflightWorkflowAction | reviewed_expected_behavior |
| T2NjdXJyZW5jZTpqd2dlZG1ub2w= | JS-0116 | src/mcp_repository.ts:1181 | preflightConfigurationAction | reviewed_expected_behavior |
| T2NjdXJyZW5jZTpuZ3d2ZGp4a2w= | JS-0116 | src/forwarder.ts:634 | invokeWithRetry | reviewed_expected_behavior |
| T2NjdXJyZW5jZTpuZ3d2ZGp4am8= | JS-0116 | tests/test_trading_web_control.js:112 | historicalCredentialEvidence | reviewed_expected_behavior |
| T2NjdXJyZW5jZTphbmFqdmxnbHg= | JS-0116 | src/workflow_repository.ts:2405 | advanceWorkflowFallbackOnEligibleFailure | reviewed_expected_behavior |
| T2NjdXJyZW5jZTpsbXF4ZGxlbHI= | JS-0116 | src/workflow_repository.ts:1476 | applyWorkflowBuilderHistory | reviewed_expected_behavior |
| T2NjdXJyZW5jZTpkYWtqd2xubHg= | JS-0116 | src/workflow_repository.ts:685 | deleteWorkflowResourceFamily | reviewed_expected_behavior |
| T2NjdXJyZW5jZTpxcGVnbmRtZGQ= | JS-0116 | src/workflow_repository.ts:642 | archiveWorkflowResourceFamily | reviewed_expected_behavior |
| T2NjdXJyZW5jZTp5Z3lqbmx2bHc= | JS-0116 | src/trading_web_control.ts:886 | configurePaper | reviewed_expected_behavior |
| T2NjdXJyZW5jZTpnZXZqZHh3bW4= | JS-0116 | src/trading_web_control.ts:783 | removeAccount | reviewed_expected_behavior |
| T2NjdXJyZW5jZTpyZWt5bmdyZG0= | JS-0116 | src/trading_web_control.ts:736 | releaseAccountKillSwitch | reviewed_expected_behavior |
| T2NjdXJyZW5jZTptcmRvbmxrZ2Q= | JS-0116 | src/trading_web_control.ts:676 | setAccountEnabled | reviewed_expected_behavior |
| T2NjdXJyZW5jZTp2dm1hbmRrd2U= | JS-0116 | src/trading_web_control.ts:556 | replaceAccountCredentials | reviewed_expected_behavior |
| T2NjdXJyZW5jZTpveWFtZHZvam0= | JS-0116 | src/trading_repository.ts:1536 | deleteTradingStrategyVersion | reviewed_expected_behavior |
| T2NjdXJyZW5jZTp4cmdhbmpvZXI= | JS-0116 | src/trading_web_control.ts:637 | verifyAccount | reviewed_expected_behavior |
| T2NjdXJyZW5jZTprdnlrZGdwbGQ= | JS-0116 | src/trading_repository.ts:982 | createTradingIntent | reviewed_expected_behavior |
| T2NjdXJyZW5jZTplYXhqeXZubG4= | JS-0116 | src/trading_engine.ts:1653 | reconcileAccount | reviewed_expected_behavior |
| T2NjdXJyZW5jZTpwcXdybmp2YXk= | JS-0116 | src/trading_engine.ts:945 | retireUnauthorizedPreparation | reviewed_expected_behavior |
| T2NjdXJyZW5jZTpnZXZlZGpvZ20= | JS-0116 | plans/002-pending-worker-fairness-probe.mjs:45 | anonymous async wrapper | reviewed_expected_behavior |
| T2NjdXJyZW5jZTpsbXFtZGRkbmw= | PYL-R0201 | exchange_executor/ccxt_sdk_policy.py:27 | set_ref | reviewed_expected_behavior |
| T2NjdXJyZW5jZTpkYWthd3d3dnE= | PYL-R0201 | exchange_executor/ccxt_sdk_policy.py:24 | handle_builder_fee_approval | reviewed_expected_behavior |
| T2NjdXJyZW5jZTp2dm12bm54cWc= | SCT-A000 | exchange_executor/certifications/reviews/fixer-s6551-contract-fixes-2026-09-15.json:39 | Fixture/documentation/type declaration | reviewed_false_positive |
| T2NjdXJyZW5jZTprdnlxZHJranc= | SCT-A000 | tests/test_trading_credentials.js:121 | Fixture/documentation/type declaration | reviewed_false_positive |
| T2NjdXJyZW5jZTplYXhteXJqa3Y= | SCT-A000 | tests/test_trading_credentials.js:115 | Fixture/documentation/type declaration | reviewed_false_positive |
| T2NjdXJyZW5jZTpwcXd4bm1yeWE= | SCT-A000 | tests/test_trading_credentials.js:108 | Fixture/documentation/type declaration | reviewed_false_positive |
| T2NjdXJyZW5jZTp3bXJ5d2VheW4= | SCT-A000 | tests/test_trading_credentials.js:79 | Fixture/documentation/type declaration | reviewed_false_positive |
| T2NjdXJyZW5jZTpqd2dxZHZlcWE= | SCT-A000 | tests/test_trading_credentials.js:78 | Fixture/documentation/type declaration | reviewed_false_positive |
| T2NjdXJyZW5jZTpuZ3dlZGF2ZXc= | SCT-A000 | tests/test_trading_credentials.js:74 | Fixture/documentation/type declaration | reviewed_false_positive |
| T2NjdXJyZW5jZTphbmF3dnhqd20= | SCT-A000 | tests/test_trading_credentials.js:73 | Fixture/documentation/type declaration | reviewed_false_positive |
| T2NjdXJyZW5jZTpsbXFuZHZ4bng= | SCT-A000 | tests/test_trading_credentials.js:60 | Fixture/documentation/type declaration | reviewed_false_positive |
| T2NjdXJyZW5jZTpkYWt2d21qdmE= | SCT-A000 | tests/test_trading_credentials.js:54 | Fixture/documentation/type declaration | reviewed_false_positive |
| T2NjdXJyZW5jZTpxcGVvbmxnb24= | SCT-A000 | tests/test_trading_credentials.js:38 | Fixture/documentation/type declaration | reviewed_false_positive |
| T2NjdXJyZW5jZTp5Z3lxbnhqcXY= | SCT-A000 | tests/test_trading_credentials.js:35 | Fixture/documentation/type declaration | reviewed_false_positive |
| T2NjdXJyZW5jZTp4cmd5bmtheXE= | SCT-A000 | tests/test_fill_quantity_contract.js:41 | Fixture/documentation/type declaration | reviewed_false_positive |
| T2NjdXJyZW5jZTpuZ3dlZGF2cHc= | SCT-A000 | docs/QUALITY_OS.md:109 | Fixture/documentation/type declaration | reviewed_false_positive |
| T2NjdXJyZW5jZTphbmF3dnhqcW0= | SCT-A000 | docs/QUALITY_OS.md:108 | Fixture/documentation/type declaration | reviewed_false_positive |

## Limits

No application-source edits, scanner transitions, suppressions, commits or staging were performed by this review. The two static-helper edits belong to root. Hashes bind this reviewed snapshot and are not cryptographic attestation renewal. Root owns integrated tests and final candidate scanner reconciliation; no additional issues were found in this bounded review.
