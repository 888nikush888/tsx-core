# Independent review of fixer triage branch

Reviewed branch: origin/codex/security-quality-triage-2026-09-08. Frozen branch commit: 3cf589b69b52bc66d2690e7cf62dc4e49f605dca. Diff baseline: 6085aef; integration comparison baseline: d72cf40. Date: 2026-09-11.

## Scope and limits

The diff contains 249 files, 3,366 insertions and 1,658 deletions. This was a read-only targeted semantic review of the highest-risk source changes, shared transaction contracts, request handling, safety checks, and changed tests; it is not an independent line-by-line approval of all 249 files. Automated AST inspection covered all changed JavaScript test files for missing assertion operands. No complete branch test suite was run by this reviewer. No scanner dispositions or implementation receipts are authorized by this review. Full integrated tests and source-bound security receipts are still required.

## Confirmed findings and resolution

1. **P1: 57 broken equality assertions across 29 files.** Removing an explicit expected undefined from Node assert.equal/assert.strictEqual is not behavior-preserving. Node 22.23.2 directly reproduced ERR_MISSING_ARGS for assert.strictEqual(undefined). Restore every expected operand; do not suppress or delete the assertions. Complete locations below refer to the frozen triage branch.
2. **P1: Promise failure contracts changed into synchronous throws.** src/trading_repository.ts:767 removes async from updateTradingAccountState although validateAccountStateUpdate can throw before returning a Promise. An isolated transpilation of the actual two functions reproduced d72cf40 returning a rejected Promise and triage throwing synchronously for {status:'error',enabled:true}. Existing tests/test_trading_core.js:914-917 relies on assert.rejects(updateTradingAccountState(...)). Restore async on this function and public wrappers with equivalent pre-return validation; review all removals below. Do not modify rejection tests to hide the API change. Shared src/db.ts withDatabaseTransaction/SerializedDatabaseAccess.execute also run caller operations immediately when already owned, so synchronous callback exceptions must keep their original rejection boundary.
3. **P2: gzip negotiation lost.** src/web_server.ts:2986 calls staticResponseBody(content,mimeType,undefined) from extracted serveStaticFile, dropping request Accept-Encoding. Forward the original request header to retain static asset compression and Vary behavior.
4. **P2: SQL column allowlist accepts inherited keys.** src/ui_signal_original.ts:13 replaces Object.hasOwn(columns,field) with truthy ORIGINAL_COLUMNS[kind]?.[field]. constructor/toString/__proto__ now pass the boundary and reach SQL interpolation. Restore an explicit own-key check or use an equivalent exact safe map. Ordinary prototype values produce SQL errors; arbitrary SQL injection is not claimed.
5. **P2: offline inventory errors escape the intended CLI boundary.** exchange_executor/tools/audit_derivatives_candidates.py:439 removes ValueError from load_inventory; line463 removes it from main. JSONDecodeError and InventoryError (a ValueError subclass) therefore escape instead of returning the established failed verification result. Retain ValueError. UnicodeDecodeError already subclasses ValueError.
6. **P2: redaction return type is unsound.** src/ui_change_review.ts:29 promises redactReview<T>(value:T):T even though secret-key values and deep objects become strings. Runtime behavior is retained, but the replacement hides rather than resolves unsafe typing. Keep unknown or an explicitly modeled redacted value/DTO type; do not assert the original generic type.

## Broken assertion locations

- tests/test_alert_relay.js: 105
- tests/test_architecture.js: 4, 12
- tests/test_backup.js: 102, 103, 104, 147
- tests/test_config.js: 36, 69, 138
- tests/test_forwarder_error_types.js: 18, 23
- tests/test_mcp_server.js: 180, 186, 197, 202, 233, 240, 247, 262
- tests/test_module_coverage.js: 78
- tests/test_outbox.js: 186
- tests/test_runtime_settings.js: 23
- tests/test_secret_store.js: 90
- tests/test_setup_bundle.js: 440
- tests/test_signal_contract_validation.js: 259
- tests/test_snyk_code_review.js: 195
- tests/test_soak_window.js: 75
- tests/test_supply_chain.js: 409, 410
- tests/test_trading_core.js: 208, 1395
- tests/test_trading_entry_price.js: 42, 48, 51
- tests/test_trading_fill_identity_backfill.js: 80
- tests/test_trading_fx_automatic_valuation.js: 62, 68
- tests/test_trading_fx_contract.js: 23, 24
- tests/test_trading_fx_sizing.js: 54
- tests/test_trading_kraken_cashleg_migration.js: 93
- tests/test_trading_protected_entry_crash.js: 97
- tests/test_trading_recovery_schedule_contract.js: 129, 130
- tests/test_trading_recovery_schedule_transport.js: 175, 203, 266, 267, 267
- tests/test_trading_take_profit.js: 154
- tests/test_ui_change_reviews.js: 75
- tests/test_ui_next_reads.js: 70, 200, 242, 242
- tests/test_web_server.js: 229

## Complete removed async-line inventory

This inventory includes rewritten/extracted async functions as well as actual removals. It is an inspection checklist, not a claim that every line introduces a bug. For genuine removals, preserve Promise return/rejection and microtask contracts. Test doubles that formerly returned Promises must retain that shape; synchronous and asynchronous failures are different cases. Prefer restoration unless equivalence is proven. No assertions should be weakened to accommodate a changed mock contract.

### scripts/sonar_review_decisions.js

```text
const ledger = await applyReviewedDecisions({ event, revision, clean, dryRun, mode, writeLedger: async value => {
```

### src/audit_cli.ts

```text
async function main(): Promise<void> {
```

### src/backup.ts

```text
async function fileExists(filePath: string): Promise<boolean> {
async function preserveCurrentFiles(plan: RestorePlan, progress: RestoreProgress): Promise<void> {
```

### src/backup_cli.ts

```text
async function run(): Promise<void> {
```

### src/backup_generation.ts

```text
export async function initializeConfigurationGeneration(sources: ConfigurationSources, owner: ProcessLock): Promise<ConfigurationGenerationEvidence> {
return withProcessLockOwner(owner, path.dirname(normalized.databasePath), async () => {
export async function reenrollConfigurationGeneration(sources: ConfigurationSources, owner: ProcessLock,
export async function retireConfigurationGeneration(configurationPath: string, databasePath: string, owner: ProcessLock,
```

### src/backup_restore_drill.ts

```text
async function runWorker(artifact: string, root: string, nonce: string, expected: string): Promise<unknown> {
```

### src/backup_restore_drill_worker.ts

```text
async function perform(): Promise<void> {
```

### src/crash_guard.ts

```text
export async function checkCrashLoopFiles(
```

### src/dashboard_auth.ts

```text
async authenticate(authorization: string | string[] | undefined): Promise<AuthenticatedActor | null> {
async authenticate(
```

### src/db.ts

```text
export async function mcpMaintenanceActive(databasePath = operationalDatabasePath()): Promise<boolean> {
async execute<T>(operation: () => Promise<T>): Promise<T> {
await this.execute(async () => undefined);
export async function withDatabaseTransaction<T>(
export async function withDatabaseDispatchFence<T>(verify: () => Promise<void>, start: () => Promise<T>): Promise<{ pending: Promise<T> }> {
export async function saveSignal(
export async function reserveAiUsage(
export async function clearDb(): Promise<DatabaseClearResult> {
```

### src/delivery_tracker.ts

```text
public async waitForResult(result: any, signal?: AbortSignal): Promise<ConfirmedDelivery> {
const destinationMessageIds = await Promise.all(messages.map(async (message: any) => {
```

### src/exchange_stream_repository.ts

```text
export async function listExchangeStreamStates(): Promise<Array<Record<string, unknown>>> {
```

### src/factory_reset_paths.ts

```text
export async function assertFactoryResetTarget(
```

### src/forwarder.ts

```text
async function invokeWithRetry(tdClient, query, signal: AbortSignal | null = null, maxAttempts = 3) {
getOutboxTasks: async (statuses) => {
retryOutboxTask: async (taskId) => {
acknowledgeOutboxTask: async (taskId, reason) => {
runBackupNow: async () => {
runBackupDrill: async (artifactName) => {
```

### src/mcp_control_bridge.ts

```text
async start(): Promise<void> {
private async executeAuthorized(request: McpControlRequest): Promise<unknown> {
```

### src/mcp_maintenance.ts

```text
export async function beginMcpSharedMaintenance(reason: string, databasePath: string, owner: ProcessLock,
export async function beginMcpOfflineMaintenance(reason: string, databasePath: string, owner: ProcessLock,
async function beginMaintenance(reason: string, databasePath: string, owner: ProcessLock,
```

### src/mcp_repository.ts

```text
export async function getMcpRuntimeState(): Promise<McpRuntimeState> {
export async function setMcpRuntimeMode(
export async function deleteMcpAgent(idValue: unknown): Promise<boolean> {
export async function claimNextMcpControlRequest(): Promise<McpControlRequest | null> {
async function preflightConfigurationAction(
async function preflightWorkflowAction(
```

### src/mcp_server.ts

```text
}, async ({ definition, xml, sourceText }) => {
}).catch(async () => {
```

### src/metrics.ts

```text
server = http.createServer(async (req, res) => {
```

### src/migration_cli.ts

```text
async function main(): Promise<void> {
```

### src/migration_recovery.ts

```text
async function verifySnapshot(snapshot: string, target: string, lease: McpMaintenanceLease): Promise<void> {
```

### src/outbox_scheduler.ts

```text
private async pump(): Promise<void> {
```

### src/paper_exchange.ts

```text
async function transaction<T>(operation: () => Promise<T>): Promise<T> {
async accountSnapshot(account: TradingAccount): Promise<TradingAccountSnapshot> {
async submitOrder(account: TradingAccount, request: ExchangeOrderRequest): Promise<ExchangeOrderResult> {
async submitProtectedEntry(
async openState(account: TradingAccount): Promise<ExchangeOpenState> {
```

### src/process_lock.ts

```text
async function ownershipTurn<T>(owner: ProcessLock, action: () => Promise<T>): Promise<T> {
export async function withProcessLockOwner<T>(owner: ProcessLock, stateDirectory: string, action: (directory: string) => Promise<T>): Promise<T> {
```

### src/runtime_settings.ts

```text
async set(input: unknown, baseRevision?: string): Promise<RuntimeSettings> {
```

### src/signal_parser.ts

```text
return async (request, requestOptions) =>
```

### src/telegram_viewer/health_server.ts

```text
void (async () => {
```

### src/telegram_viewer/runtime.ts

```text
export async function readRuntimeSecret(directory: string, fileName: string, pattern: RegExp): Promise<string> {
```

### src/telegram_viewer_secrets.ts

```text
async readBotToken(): Promise<string | null> {
async serviceToken(): Promise<string> {
```

### src/telegram_viewer_settings.ts

```text
async set(input: unknown, baseRevision?: string): Promise<TelegramViewerSettings> {
```

### src/trade_journal.ts

```text
export async function journalMoneyDetails(intentId: string): Promise<JournalMoneyDetails> {
async function loadJournalRows(
async function loadJournalOrders(database: Database, intentIds: string[]): Promise<JournalRow[]> {
async function loadJournalFills(database: Database, orders: JournalRow[]): Promise<JournalRow[]> {
async function loadJournalTimelines(database: Database, intentIds: string[]): Promise<JournalRow[]> {
async function loadJournalSchemas(database: Database, rows: JournalRow[]): Promise<JournalRow[]> {
```

### src/trading_account_baseline.ts

```text
async function baselineRow(account: TradingAccount): Promise<BaselineRow | undefined> {
```

### src/trading_account_log_repository.ts

```text
export async function accountLogCheckpoint(account: TradingAccount): Promise<AccountLogCheckpoint | null> {
```

### src/trading_accounting.ts

```text
export async function assertEntryAccountingReady(account: TradingAccount, snapshot: TradingAccountSnapshot): Promise<TradingAccountingEvidence> {
```

### src/trading_cancel_recovery.ts

```text
async function latestCancel(accountId: string, clientOrderId: string): Promise<CancelAttempt | undefined> {
```

### src/trading_emergency.ts

```text
export async function requestEmergencyExit(accountId: string, intentId: string, reason: string): Promise<boolean> {
export async function prepareEmergencyReduction(account: TradingAccount, intent: TradingIntent, quantity: string): Promise<PlannedOrder> {
```

### src/trading_engine.ts

```text
async function transaction<T>(operation: () => Promise<T>): Promise<T> {
async function createReplacementStop(intent: TradingIntent, plan: TradingPlan, quantity: string, trigger: string): Promise<PlannedOrder> {
async retireUnauthorizedPreparations(accountId: string): Promise<number> {
private async retireUnauthorizedPreparation(intentId: string): Promise<number> {
async reconcileAccount(accountId: string, options?: ReconciliationOptions): Promise<ReconciledAccountEvidence | undefined> {
```

### src/trading_entry_commitment.ts

```text
export async function requestedEntryDrains(accountId: string, now = Date.now()): Promise<EntryCommitment[]> {
export async function resolveActiveEntryCancelAttempts(account: TradingAccount, remote: ExchangeOpenState): Promise<void> {
export async function entryCancelRetryAuthorized(accountId: string, clientOrderId: string): Promise<boolean> {
```

### src/trading_evidence_repository.ts

```text
export async function persistCorrelatedFill(account: TradingAccount, fill: ExchangeFill, read?: ExchangeAcquisitionEvidence): Promise<FillResult> {
async function recordFillConflict(account: TradingAccount, existing: any, incoming: ExchangeFill): Promise<void> {
```

### src/trading_fill_identity_repository.ts

```text
export async function bindLegacyFillIdentity(account: TradingAccount, fillId: string): Promise<boolean> {
async function nextBackfillRows(accountId: string, cursor: BackfillCursor | undefined): Promise<BackfillCursor[]> {
```

### src/trading_fill_quantity_repository.ts

```text
async function assertBinding(account: TradingAccount): Promise<void> {
```

### src/trading_funding_observation.ts

```text
async function observedProof(account: TradingAccount, now: number): Promise<FundingObservationProof> {
```

### src/trading_fx_repository.ts

```text
export async function persistFxConversion(account: FxAccount, baseAsset: string, quoteAsset: string, at: number): Promise<StoredFxConversion> {
export async function readFxConversion(account: FxAccount, id: string): Promise<StoredFxConversion> {
```

### src/trading_fx_valuation.ts

```text
export async function readFxMoneyValuation(eventId: string): Promise<FxMoneyValuation | null> {
export async function valueFxMoneyEvent(account: FxAccount, eventId: string): Promise<FxMoneyValuation> {
```

### src/trading_history_repository.ts

```text
async function alignEvidenceWindow(account: TradingAccount, previous: ExchangeHistoryCheckpoint, since: number, boundary?: number): Promise<ExchangeHistoryCheckpoint> {
```

### src/trading_kraken_cashlegs.ts

```text
export async function projectKrakenCashleg(account: TradingAccount, row: AccountLogRecord): Promise<void> {
```

### src/trading_lifecycle.ts

```text
export async function retireUndispatchedExit(intentId: string, clientOrderId: string): Promise<boolean> {
```

### src/trading_money_ledger.ts

```text
export async function moneyEventsForIntent(intentId: string): Promise<MoneyEvent[]> {
export async function moneyLedgerSnapshot(accountId: string, since: number, until: number): Promise<MoneyLedgerSnapshot> {
```

### src/trading_notifications.ts

```text
export async function recordExecutionNotificationBestEffort(input: {
```

### src/trading_order_identity_bindings.ts

```text
export async function correlateNativeOrderEvidence(account: TradingAccount, orders: ExchangeOrderSnapshot[]): Promise<ExchangeOrderSnapshot[]> {
```

### src/trading_order_repository.ts

```text
export async function persistTradingOrderResult(
export async function persistTradingRemoteOrder(
export async function createGeneratedTradingOrder(intent: Pick<TradingIntent, 'id' | 'accountId'>, template: PlannedOrder): Promise<PlannedOrder> {
```

### src/trading_protection.ts

```text
export async function storedProtectionNeed(accountId: string, intentId: string) {
```

### src/trading_protection_projection.ts

```text
export async function readProtectionProjection(filter: { accountId?: string; intentId?: string } = {}): Promise<ProtectionProjection[]> {
```

### src/trading_protection_sources.ts

```text
export async function protectionScopes(accountId?: string): Promise<Array<{ accountId: string; intentId: string }>> {
```

### src/trading_recovery.ts

```text
export async function prepareTradingOperation(input: TradingOperationInput): Promise<string> {
export async function recoverUndispatchedPlan(intent: TradingIntent): Promise<boolean> {
export async function abandonUndispatchedPlan(intent: TradingIntent): Promise<boolean> {
```

### src/trading_recovery_schedule_repository.ts

```text
async function activeAttempt(id: string): Promise<Attempt | undefined> {
export async function reserveScheduledRecovery(account: FxAccount, query: ExchangeRecoveryQuery,
```

### src/trading_repository.ts

```text
async function transaction<T>(operation: () => Promise<T>): Promise<T> {
export async function createSignalContract(input: {
export async function createSignalContractDraftVersion(
export async function updateSignalContractDraft(input: {
export async function archiveSignalContractVersion(versionId: unknown, now = Date.now()): Promise<SignalContractVersion> {
export async function deleteSignalContractDraft(versionId: unknown): Promise<boolean> {
export async function deleteSignalContractVersion(versionId: unknown): Promise<boolean> {
export async function deleteTradingSignalSchema(id: string): Promise<boolean> {
export async function createTradingStrategyDraft(input: {
export async function updateTradingAccountState(id: string, state: TradingAccountStateUpdate): Promise<TradingAccount> {
export async function updateTradingAccountConfiguration(
export async function createTradingIntent(input: {
export async function archiveTradingStrategyVersion(id: string): Promise<TradingStrategyVersion> {
export async function deleteTradingStrategyVersion(id: string): Promise<boolean> {
export async function deleteTradingAccount(id: string): Promise<boolean> {
```

### src/trading_risk_admission.ts

```text
async function candidateReservation(account: FxAccount, plan: TradingPlan, market: TradingMarketSnapshot, reportingCurrency: string) {
export async function createRiskAdmission(input: { account: TradingAccount; intentId: string; plan: TradingPlan;
```

### src/trading_risk_repository.ts

```text
export async function observeRiskReservations(account: TradingAccount, remote: ExchangeOpenState, epoch: string): Promise<string> {
export async function existingRiskCommitment(account: TradingAccount, excludedIntent: string, epoch: string, currency: string): Promise<ExistingRiskProof> {
```

### src/trading_runtime_release.ts

```text
async function withAccountOwners<T>(
return dependencies.engine.mutations.run(accountId, async context => {
async function commitGlobalRelease(dependencies: RuntimeReleaseDependencies, ids: string[], prepared: PreparedAccount[]) {
```

### src/trading_telemetry.ts

```text
async function performanceRows(since: number): Promise<[any[], any[], any[], TradingEquityPoint[]]> {
```

### src/trading_web_control.ts

```text
async replaceAccountCredentials(payload: CredentialReplacementPayload): Promise<TradingAccount> {
async verifyAccount(id: unknown, enableOnSuccess = false, context?: TradingMutationContext): Promise<TradingAccount> {
async setAccountEnabled(id: unknown, enabledValue: unknown): Promise<TradingAccount> {
async releaseAccountKillSwitch(payload: AccountReleasePayload): Promise<{
async removeAccount(id: unknown): Promise<void> {
return await this.engine.mutations.run('@runtime', async context => {
async configurePaper(payload: PaperConfigurationPayload) {
```

### src/ui_account_evidence.ts

```text
async function accountRiskObservation(accountId: string, observationId: string | null) {
```

### src/ui_adaptive_risk.ts

```text
export async function copyLegacyRiskPolicy(input: { channelId: unknown; copyHash: unknown }) {
```

### src/ui_attention.ts

```text
export async function uiAttention(query: URLSearchParams) {
```

### src/ui_ingress_relations.ts

```text
export async function uiIngressRelations(workId: string, kind: UiIngressRelation, query: URLSearchParams) {
```

### src/ui_mcp_reads.ts

```text
async function page(kind: Kind, query: URLSearchParams, now: number) {
```

### src/ui_mcp_review.ts

```text
export async function approveReviewedMcpProposal(id: string, actor: string, expectedReviewHash: unknown) {
```

### src/ui_resource_publication.ts

```text
export async function publishUiResourceWithDependency(id: string, baseEditRevision: number, expectedHash: unknown) {
```

### src/ui_trade_relations.ts

```text
async function relationEvidence(kind: UiTradeRelation, row: Record<string, any>): Promise<unknown> {
return withDatabaseTransaction(async database => {
```

### src/ui_workflow_drafts.ts

```text
export async function saveUiWorkflowDraft(input: { id: string; baseVersion: number | null; baseRevisionId: string | null; graph: unknown }, actorId: string) {
export async function activateUiWorkflowDraft(input: Parameters<typeof saveWorkflowRevision>[0], binding: { id: string; version: number }) {
```

### src/ui_workflow_models.ts

```text
export async function mutateUiModel(input: { kind: unknown; id: unknown; action: unknown; reviewHash: unknown }) {
```

### src/web_server.ts

```text
if (accepted.created) void store.run(jobId, async () => ({ artifactName: path.basename(await context.appState.runBackupNow!()) })).catch(error => addLog(`[ERROR] Backup job persistence failed: ${errorMessage(error)}`));
if (accepted.created) void store.run(accepted.job.id, async () => ({ artifactName: await context.appState.recoverOffsiteBackup!(objectName) })).catch(error => addLog(`[ERROR] Offsite recovery job persistence failed: ${errorMessage(error)}`));
async function serveStatic(context: RequestContext, url: string): Promise<void> {
async function accountEvidenceResult(kind: string, id: string, query: URLSearchParams) {
```

### src/workflow_repository.ts

```text
export async function archiveWorkflowResource(id: string, now = Date.now()): Promise<WorkflowResourceVersion> {
export async function archiveWorkflowResourceFamily(
export async function deleteWorkflowResourceFamily(resourceId: string): Promise<number> {
export async function saveWorkflowRevision(input: {
export async function previewWorkflowBuilderHistoryImpact(input: {
export async function applyWorkflowBuilderHistory(input: {
export async function advanceWorkflowFallbackOnEligibleFailure(
```

### tests/test_backup.js

```text
{ replicate: async artifact => verifiedReplication('backup-2026-offsite.tgfb', artifact), recover: async () => { throw new Error('not used'); } },
{ replicate: async () => { throw new Error('replication unavailable'); }, recover: async () => { throw new Error('not used'); } },
replicate: async artifact => {
recover: async () => { throw new Error('not used'); }
```

### tests/test_backup_generation.js

```text
await assert.rejects(withManagedConfigurationWrite(sources.configurationPath, foreign, '{}', async () => { throw new Error('must not run'); }), /different.*scope/);
```

### tests/test_backup_generation_ownership.js

```text
await withPinnedConfigurationGeneration(sources.configurationPath, sources.databasePath, async generation => {
```

### tests/test_backup_proofs.js

```text
replicator.replicate = async () => { throw new Error('isolated offsite failure'); };
```

### tests/test_deepsource_export.js

```text
await assert.rejects(exportDeepSource({ token: 't', fetchImpl: async () => { throw new Error('secret'); } }),
```

### tests/test_dynamic_exchange_registry.js

```text
browserCatalog: async () => { throw new Error('catalog offline'); },
probe: async () => { throw new Error('catalog offline'); },
```

### tests/test_signal_parser.js

```text
requestCompletion: async request => {
requestCompletion: async request => {
requestCompletion: async request => {
requestCompletion: async request => {
requestCompletion: async () => { deniedProviderCalls += 1; throw new Error('must not run'); }
requestCompletion: async (_request, options) => {
```

### tests/test_startup_authority.js

```text
await assert.rejects(runStartupGate(gateFailure, 'dashboard', async () => { throw new Error('EADDRINUSE fixture'); }), /EADDRINUSE/);
```

### tests/test_telegram_viewer_service.js

```text
core.get = async () => { throw new Error('projection unavailable'); };
```

### tests/test_test_scheduler.js

```text
concurrency: 1, runTest: async () => { throw new Error('fixture rejection'); }, error: message => errors.push(message),
async function runActualFixture(label, { workers = 1, focused = false, selection } = {}) {
```

### tests/test_trading_dispatch_fence.js

```text
['source-changed', 'abandoned', { beforeSend: async () => { throw new Error('sources changed'); } }],
['reject-send', 'unresolved', { send: async () => { throw new Error('asynchronous adapter failure'); } }],
db.exec = async sql => {
rejected.beforeSend = async witness => { capturedWitness = witness; throw new Error('reject before send'); };
```

### tests/test_trading_entry_commitment.js

```text
const restarted = new TradingEngine([{ exchange: 'paper', cancelOrder: async () => { throw new Error('No blind cancel after hard crash'); } }]);
```

### tests/test_trading_failures.js

```text
const adapter = wrappedAdapter(paper, async (...args) => {
const adapter = wrappedAdapter(paper, async (...args) => {
marketSnapshot: async () => {
marketSnapshot: async () => {
const adapter = wrappedAdapter(paper, async (_account, request) => {
const adapter = wrappedAdapter(paper, async (targetAccount, request) => {
const adapter = wrappedAdapter(paper, async (_targetAccount, request) => {
adapter.cancelOrder = async (_targetAccount, clientOrderId) => {
adapter.openState = async (...args) => {
reconcileAccount: async () => { throw new Error('simulated periodic exchange outage'); },
reconcileAccount: async (_accountId, options) => {
reconcileAccount: async (_accountId, options) => { forced.push(options?.force === true); },
cancelExpiredEntries: async () => { throw new Error('simulated expiry cancellation outage'); },
reconcileAccount: async accountId => {
adapter.cancelOrder = async () => { throw new Error('simulated stale-stop cancellation timeout'); };
reconcileAccount: async () => {
reconcileAccount: async (accountId, options) => { reconciliations.push([accountId, options?.force]); },
reconcileAccount: async () => { throw new Error('simulated unmanaged startup exposure'); },
```

### tests/test_trading_mutation_coordinator.js

```text
await assert.rejects(coordinator.run('a', async () => { throw new Error('expected'); }), /expected/);
```

### tests/test_trading_protection_receipt.js

```text
paper.accountSnapshot = async () => { throw new Error('unknown money'); };
```

### tests/test_trading_risk_repository.js

```text
await refreshReconciledRisk({ account, remote, epoch: '0:0', readBalance: async () => { throw new Error('account read failed'); }, budgetForIntent: () => Promise.resolve('19') });
```

### tests/test_ui_restart_recovery.js

```text
current.controls.blockAudit = async () => { throw new Error('audit unavailable'); };
```

### tests/test_workflow_fallback.js

```text
marketSnapshot: async () => { throw new Error('Exchange executor request failed (502): simulated timeout'); },
accountSnapshot: async () => { throw new Error('Exchange executor request failed (503): account unavailable'); },
submitOrder: async () => { throw new Error('simulated submit timeout'); },
submitProtectedEntry: async () => { throw new Error('simulated submit timeout'); },
```

