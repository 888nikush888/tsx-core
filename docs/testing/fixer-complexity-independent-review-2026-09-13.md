# Independent complexity correction review

Reviewed current complete ten-file diff against HEAD122d65ab793c3f0913aa500cdc326af96ab32f82. Result: no concrete validation-order, error-text or side-effect regression found in this bounded diff. Source and policy files were not edited by this reviewer. git diff HEAD --check passes. No tests were rerun by this reviewer; root owns execution evidence.

- backup_replication: the second URL/token/encryption-key read and nonempty validation is extracted at precisely its original position, after timeout/recovery-limit/retention parsing and before key parsing/constructor. Read order, trim use, returned original strings and error text remain identical. The earlier initial configured check remains, so this is not a deduplication that changes getter/read timing.
- ccxt_exchange: open-state envelope checks still run after request/assertObject and before validateOpenState. Array checks remain first, fingerprint format next, acquisition presence last. Short-circuit order and error classes/messages remain. The separate validated-state acquisition check is retained.
- signal_schema: ordered-target extraction occurs after range and profit-side checks and the same orderedTargets/index0 early return. Previous-target lookup, missing-previous error, LONG min/previous max and SHORT max/previous min comparisons remain in the original order with identical messages. No ordering/geometry switch was removed.
- trading_account_scope: receipt is validated before binding helper; namespace lookup and short-circuit mismatch checks retain order (namespace, fingerprint, credential generation, record count, optional UID). Unproved bindings still await the same unresolved consumer result and return before record classification. No new null/unknown acceptance.
- trading_credentials: legacy helper receives exactly the prevalidated accountId/input after object, account binding, timestamp and version1 checks. Same exchange allowlist, allowed-key rejection, Hyperliquid key/address branch, Bybit/Kraken key/secret checks and storedCredentials invocation. No extra conversion or migration writes introduced; version2 remains untouched.
- trading_leverage_admission: tier selection stays after evidence/table/original decision/quantity checks and before entry quantity/FX budget checks. Only tierForQuantity is inside the same catch; selected-index/undefined/maxLeverage evidence check remains outside. Errors and downstream order unchanged.
- mcp_control_bridge: reviewed each of the25 dispatch arms against the map entry. Same control method, argument/member, workflow spread/confirmation/actor string and kill-switch payload. Arrow closures defer every property access until the selected handler, preserving selected-only invocation and control receiver. Unknown/prototype keys differ at the private dispatch method, but the real executeProposal path awaits preflightMcpAction first; that starts with proposalAction and rejects anything outside PROPOSAL_ACTIONS before dispatch. Thus the map does not make inherited keys reachable through the reviewed authorized execution path. No runtime risk acceptance or permission expansion is inferred.
- ui_setup_review removes only an unused named import from a module still imported for redactReviewRecord, so module evaluation remains.
- web_server removes only unused local binding; requireBootstrapSecretStore(context) still executes in the same try block before proof/origin checks. Throws/validation are not skipped.
- test_web_server moves the empty workflow-detail request/status/error assertions into an awaited helper at the same sequence point. The outer response variable is overwritten by the immediately following fetch before any read; no later assertion changes its subject. No expected value or assertion dropped.

Boundaries: this is approval of the ten-file complexity delta only, not full repository/implementation certification, not scanner disposition renewal, and not deployment approval. Previously reviewed Snyk source/context bindings must be re-evaluated for new source bytes as required by the existing checker.

Exact reviewed current checkout SHA256 (Windows bytes, not Git-normalized blob hashes):
ED8A03D8A5DD3E416CEC9BBC4E45FBBBC622268FBD7D050F9DCE21D31E98F0A2 .\src\backup_replication.ts
ADC917238BE037B2DE1A52B7297EB312FBFF80CEC3887D0A0FC656C612400CDB .\src\ccxt_exchange.ts
DD4FD8AF769618B74C57D3EB1A33A86DB34FBD6B9E12A8EF69AEF27E60B58FAF .\src\mcp_control_bridge.ts
CC62363EF835B6CFC60DEE0869095EBDECEBC249B03744113C8A7241F3BEC2E4 .\src\signal_schema.ts
194E80BA22DED82644FCF06F213DA4BC8DED19AF5532390D08AF99FE2A07DC3F .\src\trading_account_scope.ts
FF74C6A0411B64195ADBBD54116D0E753AA2F410C2816D9694F73C8C8A44A8FA .\src\trading_credentials.ts
0FAF39305F9729DF26B1A1544BB3AFC7A1E74C89216D760A55C3A9FF47ADD150 .\src\trading_leverage_admission.ts
60ED15F819CD1CB2269883567587ABEDB3B8C4DA87BCAAF56B4227F1E3F0F9CF .\src\ui_setup_review.ts
1A83AE109A4AE1C8CE5719258EA54A42A9DD7EA07420D79941A073596F02E18F .\src\web_server.ts
785F92778EA758BD28E9DB59EC5B36D5143053C5E05D82B5D51A06FE19F1C616 .\tests\test_web_server.js
