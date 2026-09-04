import { createHash, randomUUID } from 'node:crypto';
import { getDatabase, withDatabaseTransaction } from './db.js';
import { fillDigestIdentity } from './trading_fill_identity.js';
import { tradingAccountTargetIds } from './trading_account_targets.js';
import {
  getTradingAccount,
  getTradingIntent,
  getTradingRuntimeState,
  getTradingStrategyVersion,
  updateTradingAccountConfiguration,
  updateTradingRuntimeState,
} from './trading_repository.js';
import {
  compareDecimal,
  divideDecimal,
  multiplyDecimal,
  signedDifference,
  subtractDecimal,
  addDecimal,
  quantizeDecimalDown,
} from './trading_decimal.js';
import {
  adaptiveStopLossDecision,
  assertEntryNotExpired,
  assertEntryPriceBoundary,
  createTradingPlan,
  resolveEntryExpiresAt,
  resolveDailyLossLimit,
  TradingRiskError,
} from './trading_risk.js';
import { ClockGuard, type ClockHealthMonitor } from './clock_guard.js';
import { assertBoundedEntryProfile, assertEntryModeEvidence, readEntryModeEvidence } from './trading_execution_constraints.js';
import { LeverageTierError } from './trading_leverage_tiers.js';
import { FxEvidenceError } from './trading_fx_contract.js';
import { prepareSizingFx } from './trading_fx_sizing.js';
import { assertLocalTierScope, assertPlanTierDecision, assertTierEvidence } from './trading_leverage_admission.js';
import { assertAccountingFresh, assertEntryAccountingReady, assertPersistedMoneyReady } from './trading_accounting.js';
import { intentMoneyTotals, projectAccountFillAccounting } from './trading_fill_accounting.js';
import { bindRiskContract } from './trading_risk_repository.js';
import { assertRiskAdmissionFresh, createRiskAdmission, verifyRiskAdmission } from './trading_risk_admission.js';
import { requestFromOrder } from './trading_order_request.js';
import { OrderIdentityBindingError, prepareProtectedOrderIdentityRequests } from './trading_order_identity.js';
import { assertEntrySafetyFresh, proveEntrySafety, type EntrySafetyObservation } from './trading_entry_safety.js';
import { assertCandidateNeverSent } from './trading_entry_candidate.js';
import { refreshReconciledRisk } from './trading_risk_reconciliation.js';
import { TradingSymbolUnavailableError, TradingUnresolvedOrderError } from './trading_errors.js';
import {
  advanceWorkflowFallbackOnEligibleFailure,
  isWorkflowExecutionAuthorized,
  markWorkflowFallbackSelected,
  stopWorkflowFallback,
  type WorkflowFallbackAdvanceResult,
} from './workflow_repository.js';
import { resolveEffectiveChannelRisk, resolveWorkflowAdaptiveRisk } from './trading_channel_risk.js';
import { validateStrategyConfiguration } from './trading_strategy.js';
import { recordTradingEquitySnapshot, recordTradingExecutionEvent } from './trading_telemetry.js';
import { recordTradingNotificationBestEffort } from './trading_notifications.js';
import {
  recordTradingAccountIncident,
  resolveTradingAccountIncidents,
  type TradingIncidentCategory,
} from './trading_incidents.js';
import type {
  ExchangeOpenState,
  ExchangeOrderResult,
  ExchangeEntryConstraints,
  ExchangeStreamBatch,
  PlannedOrder,
  TradingAccount,
  TradingAccountSnapshot,
  TradingAccountingEvidence,
  TradingExchange,
  TradingExchangeAdapter,
  TradingIntent,
  TradingMarketSnapshot,
  TradingPlan,
  StrategyConfiguration,
  WorkflowFallbackReason,
} from './trading_types.js';
import { tradingExchangeId } from './trading_types.js';
import { isWorkflowFallbackReason } from './workflow_fallback_policy.js';
import { EntryAdmissionRevokedError, TradingMutationCoordinator, type TradingMutationContext } from './trading_mutation_coordinator.js';
import { createGeneratedTradingOrder, persistTradingOrderResult as storeOrderResult, persistTradingRemoteOrder, transitionTradingIntent as setIntentState } from './trading_order_repository.js';
import { economicEvidence, persistCorrelatedFill, recordAcquisitionEvidence, recordRemoteEvidence, resolveManagedHistoricalEvidence, unresolvedEvidenceCount } from './trading_evidence_repository.js';
import { failScheduledRecovery, scheduledRecoveryDue, usesScheduledFxRecovery } from './trading_recovery_schedule_repository.js';
import { projectAccountLogMoney } from './trading_account_log_money.js';
import { assertAccountOwnership } from './trading_ownership.js';
import { observeAccountBaseline } from './trading_account_baseline.js';
import { abandonUndispatchedPlan, hasUndispatchedPlanProof, recoverPreparedExits, recoverUndispatchedPlan, runJournaledExchangeWrite, resolveObservedOperations, unresolvedOperationCount, type TradingDispatchWitness } from './trading_recovery.js';
import { entryCancelRetryAuthorized, markEntryDrainAttempt, pendingEntryDrainCount, requestEntryDrain, requestedEntryDrains, type EntryCommitment } from './trading_entry_commitment.js';
import { CancelBudgetExhaustedError, claimCancelAttempt, consumeCancelAttempt, type CancelAttemptPermit } from './trading_cancel_budget.js';
import { resolveActiveCancelAttempts } from './trading_cancel_recovery.js';
import { CancellationEvidenceError } from './trading_cancel_evidence.js';
import { pendingCancelOrderIds, prepareCancelDispatch } from './trading_exit_cancel.js';
import { loadTradeLifecycle, retireUndispatchedExit } from './trading_lifecycle.js';
import { collectAccountSafetyEvidence, type ReconciledAccountEvidence } from './trading_safety_repository.js';
import { assertTradingSafety, evaluateTradingSafety, type SafetyPurpose, type TradingSafetyProof } from './trading_safety_proof.js';
import { prepareEmergencyReduction, requestEmergencyExit } from './trading_emergency.js';
import { loadProtectionOrders, protectiveStopCoverage, requiredStopQuantity } from './trading_protection.js';
import { createProtectionObserver, type ProtectionObservation } from './trading_protection_observation.js';
import { assertProtectionObservationFresh } from './trading_protection_projection.js';
import { collectProtectionReceipt, ProtectionProofRejectedError } from './trading_protection_proof.js';
import { protectionAccountSource, protectionSourceDigest } from './trading_protection_sources.js';
import { correlateRemoteFills, correlateRemoteOrders, type LocalCorrelationOrder } from './exchange_order_correlation.js';
import { loadTakeProfitAllocation, prepareTargetOrder, targetIndexFromOrderRow, targetOrderCoverage, type TakeProfitOrderRow } from './trading_take_profit.js';

type TradingLogger = (message: string) => void;
type ReconciliationOptions = { force?: boolean; mutation?: TradingMutationContext };
export interface TradingEngineOptions {
  /** @deprecated Symbol-unavailable isolation is now enforced by the typed executor contract. */
  isolateUnavailableMarketFailures?: boolean;
  /** The production composition supplies its process-wide startup gate. Unit adapters may be isolated. */
  entryAuthority?: () => boolean;
}
type RemoteStateWithIdentity = ExchangeOpenState & { accountFingerprint?: string };
type SafetyObservation = ProtectionObservation;
type OpenEntryRow = {
  intent_id: string;
  account_id: string;
  client_order_id: string;
  created_at?: number;
  plan_json?: string;
  intent_created_at?: number;
  signal_run_id?: string | null;
  run_created_at?: number;
};

function originalEntryOrigin(intentCreatedAt: number | undefined, signalRunId?: string | null, runCreatedAt?: number): number {
  if (signalRunId && (!Number.isSafeInteger(runCreatedAt) || Number(runCreatedAt) <= 0)) {
    throw new TradingRiskError('ENTRY_DEADLINE_UNPROVEN', 'Original workflow run time cannot be proven.');
  }
  return signalRunId ? Math.min(Number(intentCreatedAt), Number(runCreatedAt)) : Number(intentCreatedAt);
}

async function intentEntryDeadline(intent: TradingIntent, ttlSeconds: number): Promise<number> {
  const run = intent.signalRunId ? await getDatabase().get<{ created_at: number }>(
    'SELECT created_at FROM workflow_signal_runs WHERE id = ? AND workflow_revision_id = ?',
    [intent.signalRunId, intent.workflowRevisionId]) : null;
  const origin = originalEntryOrigin(intent.createdAt, intent.signalRunId, run?.created_at);
  return resolveEntryExpiresAt(origin, ttlSeconds, (intent.plan as TradingPlan | null)?.entryExpiresAt);
}

function entryExpirationReason(row: OpenEntryRow, now: number): string | null {
  try {
    const plan = row.plan_json ? JSON.parse(row.plan_json) as TradingPlan : null;
    if (!plan) return 'ENTRY_DEADLINE_UNPROVEN';
    const origin = originalEntryOrigin(row.intent_created_at, row.signal_run_id, row.run_created_at);
    const deadline = resolveEntryExpiresAt(origin, plan.entryOrderTtlSeconds, plan.entryExpiresAt);
    return now >= deadline ? 'ENTRY_TTL_EXPIRED' : null;
  } catch { return 'ENTRY_DEADLINE_UNPROVEN'; }
}

async function persistRevalidatedEntryDeadline(intent: TradingIntent, plan: TradingPlan): Promise<void> {
  const original = intent.plan as TradingPlan;
  if (JSON.stringify({ ...original, entryExpiresAt: plan.entryExpiresAt }) !== JSON.stringify(plan)) {
    throw new TradingRiskError('PREPARED_PLAN_NO_LONGER_VALID', 'Persisted plan no longer matches current market, sizing or risk constraints.');
  }
  if (JSON.stringify(original) === JSON.stringify(plan)) return;
  const updated = await getDatabase().run(
    `UPDATE trading_trade_intents SET plan_json = ?, updated_at = ?
     WHERE id = ? AND plan_json = ? AND status IN ('planned', 'submitting')`,
    [JSON.stringify(plan), Date.now(), intent.id, JSON.stringify(original)]);
  if (updated.changes !== 1) throw new TradingRiskError('ENTRY_DEADLINE_UNPROVEN', 'Persisted entry changed while deriving its original deadline.');
}

const MIN_PERIODIC_RECONCILIATION_MS = 10_000;
const MAX_RECONCILIATION_ROWS_PER_ACCOUNT = 256;

class ReconciliationMismatchError extends Error {
  constructor(message: string, readonly incidentCategory: TradingIncidentCategory = 'reconciliation_contract') {
    super(message);
    this.name = 'ReconciliationMismatchError';
  }
}

class ReconciliationContinuationRequiredError extends Error {
  readonly code = 'RECONCILIATION_CONTINUATION_REQUIRED';
  constructor() {
    super('Exit synchronization requires another fresh reconciliation; the bounded pass budget is exhausted.');
    this.name = 'ReconciliationContinuationRequiredError';
  }
}

function transientReconciliationFailure(error: unknown): boolean {
  if (error instanceof ReconciliationContinuationRequiredError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /(?:\b50[234]\b|timeout|timed out|abort(?:ed|error)?|fetch failed|econn(?:reset|refused)|temporarily unavailable)/i.test(message);
}

function reconciliationIncidentCategory(error: unknown): TradingIncidentCategory {
  if (error instanceof ReconciliationMismatchError) return error.incidentCategory;
  if (transientReconciliationFailure(error)) return 'reconciliation_transient';
  return 'reconciliation_contract';
}

function reconciliationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function activateAccountKillSwitch(accountId: string, reason: string): Promise<void> {
  await updateTradingAccountConfiguration(accountId, {
    killSwitchActive: true,
    killSwitchReason: reason,
  });
}

async function executionPathConfiguration(intent: TradingIntent): Promise<{
  strategy: StrategyConfiguration;
  adaptiveRisk: null | 'legacy' | { resourceVersionId: string; configuration: any };
}> {
  const storedStrategy = await getTradingStrategyVersion(intent.strategyVersionId);
  assertPublishedStrategy(storedStrategy);
  if (!intent.executionPathId) return { strategy: storedStrategy.configuration, adaptiveRisk: 'legacy' };
  const path = await getDatabase().get<{ effective_configuration_json: string; adaptive_risk_resource_version_id: string | null }>(
    `SELECT effective_configuration_json, adaptive_risk_resource_version_id
     FROM workflow_execution_paths WHERE id = ? AND workflow_revision_id = ?`,
    [intent.executionPathId, intent.workflowRevisionId],
  );
  if (!path) throw new TradingRiskError('WORKFLOW_PATH_MISSING', 'Pinned workflow execution path is unavailable.');
  let effective: any;
  try { effective = JSON.parse(path.effective_configuration_json); } catch (error) {
    throw new TradingRiskError('WORKFLOW_PATH_INVALID', `Pinned workflow execution path is invalid: ${String(error)}`);
  }
  return {
    strategy: validateStrategyConfiguration(effective.strategyConfiguration),
    adaptiveRisk: path.adaptive_risk_resource_version_id && effective.resources?.adaptive_risk?.enabled !== false
      ? {
          resourceVersionId: path.adaptive_risk_resource_version_id,
          configuration: effective.resources.adaptive_risk,
        }
      : null,
  };
}

async function transaction<T>(operation: () => Promise<T>): Promise<T> {
  return withDatabaseTransaction(operation);
}

function pathChannelRisk(intent: TradingIntent, path: Awaited<ReturnType<typeof executionPathConfiguration>>, snapshot: TradingAccountSnapshot) {
  if (path.adaptiveRisk === 'legacy') return resolveEffectiveChannelRisk({ channelId: intent.channelId,
    accountId: intent.accountId, reportingCurrency: snapshot.accounting?.reportingCurrency,
    strategy: path.strategy, currentEquity: snapshot.equity });
  if (path.adaptiveRisk) return resolveWorkflowAdaptiveRisk({ channelId: intent.channelId, accountId: intent.accountId,
    adaptiveResourceVersionId: path.adaptiveRisk.resourceVersionId, configuration: path.adaptiveRisk.configuration,
    strategy: path.strategy, currentEquity: snapshot.equity, reportingCurrency: snapshot.accounting?.reportingCurrency });
  return { riskPercent: path.strategy.sizing.riskPerTradePercent, blocked: false,
    reason: 'Workflow path uses fixed sizing without adaptive risk.' };
}

function assertEntrySlippage(intent: TradingIntent, plan: TradingPlan, result: ExchangeOrderResult): void {
  if (result.status !== 'filled' || !result.averagePrice) return;
  const adverseDifference = intent.side === 'LONG'
    ? signedDifference(result.averagePrice, plan.entryPrice)
    : signedDifference(plan.entryPrice, result.averagePrice);
  if (adverseDifference.startsWith('-') || adverseDifference === '0') return;
  const percent = divideDecimal(multiplyDecimal(adverseDifference, '100'), plan.entryPrice);
  if (compareDecimal(percent, plan.maxSlippagePercent) > 0) {
    throw new TradingRiskError('MAX_SLIPPAGE', `Filled entry slippage ${percent}% exceeds ${plan.maxSlippagePercent}%.`);
  }
}

async function riskEvent(input: {
  severity: 'info' | 'warning' | 'critical';
  code: string;
  accountId?: string;
  intentId?: string;
  details: unknown;
}): Promise<void> {
  if (input.severity === 'critical') {
    const existing = await getDatabase().get<{ id: string }>(
      `SELECT id FROM trading_risk_events
       WHERE severity = 'critical' AND code = ?
         AND account_id IS ? AND intent_id IS ? AND acknowledged_at IS NULL
       LIMIT 1`,
      [input.code, input.accountId || null, input.intentId || null],
    );
    if (existing) return;
  }
  await getDatabase().run(
    `INSERT INTO trading_risk_events (
       id, severity, code, account_id, intent_id, details_json, created_at, acknowledged_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    [randomUUID(), input.severity, input.code, input.accountId || null, input.intentId || null, JSON.stringify(input.details), Date.now()],
  );
}

interface CapacityState {
  accountPositionCount: number;
  symbolOwned: boolean;
  unknownOrderCount: number;
  criticalRiskCount: number;
  transientIncidentCount: number;
  criticalIncidentCount: number;
}

async function loadCapacityState(intent: TradingIntent): Promise<CapacityState> {
  const database = getDatabase();
  const [accountPositions, owner, unknownOrders, criticalRisks, incidents] = await Promise.all([
    database.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM trading_positions
       WHERE account_id = ? AND intent_id <> ? AND status IN ('opening', 'open', 'closing', 'emergency')`,
      [intent.accountId, intent.id],
    ),
    database.get<{ id: string }>(
      `SELECT id FROM trading_positions
       WHERE account_id = ? AND symbol = ? AND intent_id <> ? AND status IN ('opening', 'open', 'closing', 'emergency') LIMIT 1`,
      [intent.accountId, intent.symbol, intent.id],
    ),
    database.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM trading_orders
       WHERE account_id = ? AND intent_id <> ? AND status IN ('submitting', 'cancel_pending', 'unknown')`,
      [intent.accountId, intent.id],
    ),
    database.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM trading_risk_events
       WHERE account_id = ? AND severity = 'critical' AND acknowledged_at IS NULL`,
      [intent.accountId],
    ),
    database.get<{ transient: number; critical: number }>(
      `SELECT SUM(CASE WHEN category = 'reconciliation_transient' THEN 1 ELSE 0 END) AS transient,
              SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) AS critical
       FROM trading_account_incidents WHERE account_id = ? AND status = 'open'`,
      [intent.accountId],
    ),
  ]);
  return {
    accountPositionCount: Number(accountPositions?.count || 0),
    symbolOwned: Boolean(owner),
    unknownOrderCount: Number(unknownOrders?.count || 0),
    criticalRiskCount: Number(criticalRisks?.count || 0),
    transientIncidentCount: Number(incidents?.transient || 0),
    criticalIncidentCount: Number(incidents?.critical || 0),
  };
}

function assertAccountSafetyState(state: CapacityState): void {
  if (state.transientIncidentCount > 0) {
    throw new TradingRiskError('ACCOUNT_EXECUTOR_UNAVAILABLE', 'The exchange executor is temporarily unavailable; new entries remain blocked until reconciliation succeeds.');
  }
  if (state.criticalIncidentCount > 0) {
    throw new TradingRiskError('ACCOUNT_INCIDENT_UNRESOLVED', 'Account has an unresolved critical safety incident.');
  }
  if (state.unknownOrderCount > 0) {
    throw new TradingRiskError('UNRESOLVED_ORDER', 'Account has an order with unknown outcome; new entries are fail-closed.');
  }
  if (state.criticalRiskCount > 0) {
    throw new TradingRiskError('UNACKNOWLEDGED_CRITICAL_RISK', 'Account has an unacknowledged critical risk event.');
  }
}

function candidateCapacitySkipReason(
  state: CapacityState,
  maxConcurrent: number,
): Extract<WorkflowFallbackReason, 'SYMBOL_ALREADY_OWNED' | 'MAX_CONCURRENT_POSITIONS'> | null {
  if (state.symbolOwned) return 'SYMBOL_ALREADY_OWNED';
  if (state.accountPositionCount >= maxConcurrent) return 'MAX_CONCURRENT_POSITIONS';
  return null;
}

function throwCapacitySkip(reason: NonNullable<ReturnType<typeof candidateCapacitySkipReason>>): never {
  if (reason === 'SYMBOL_ALREADY_OWNED') {
    throw new TradingRiskError(reason, 'Another route already owns this account and symbol.');
  }
  throw new TradingRiskError(reason, 'Exchange-account concurrent-position limit is reached.');
}

function assertExecutionPreconditions(
  account: Awaited<ReturnType<typeof getTradingAccount>>,
  runtime: Awaited<ReturnType<typeof getTradingRuntimeState>>,
): asserts account is TradingAccount {
  if (runtime.killSwitchActive) throw new TradingRiskError('KILL_SWITCH_ACTIVE', 'Trading kill switch is active.');
  if (!runtime.executionEnabled) throw new TradingRiskError('EXECUTION_DISABLED', 'Trading execution is disabled.');
  if (account?.status !== 'ready' || !account.enabled) {
    throw new TradingRiskError('ACCOUNT_NOT_READY', 'Trading account is not ready.');
  }
  if (account.killSwitchActive) {
    throw new TradingRiskError('ACCOUNT_KILL_SWITCH_ACTIVE', 'Trading account kill switch is active.');
  }
  if (account.exchange !== 'paper' && (!account.externalAccountId || !account.credentialGeneration)) {
    throw new TradingRiskError('ACCOUNT_IDENTITY_UNVERIFIED', 'Verify the account credential generation before creating new orders.');
  }
  if (account.mode === 'live' && !runtime.liveTradingEnabled) {
    throw new TradingRiskError('LIVE_TRADING_DISABLED', 'Live trading is disabled.');
  }
}

function assertPublishedStrategy(
  strategy: Awaited<ReturnType<typeof getTradingStrategyVersion>>,
): asserts strategy is NonNullable<Awaited<ReturnType<typeof getTradingStrategyVersion>>> {
  if (strategy?.status !== 'published') {
    throw new TradingRiskError('STRATEGY_NOT_PUBLISHED', 'Strategy version is not published.');
  }
}

async function assertExecutionAuthorization(intent: TradingIntent): Promise<void> {
  const database = getDatabase();
  // A pinned workflow remains pinned across publication; do not silently swap
  // it for the newest path. Explicitly disabled/missing authorization is fatal.
  const authorized = intent.executionPathId
    ? await database.get(
        `SELECT id FROM workflow_execution_paths WHERE id = ? AND workflow_revision_id = ?
         AND channel_id = ? AND account_id = ? AND strategy_version_id = ? AND enabled = 1`,
        [intent.executionPathId, intent.workflowRevisionId, intent.channelId, intent.accountId, intent.strategyVersionId],
      )
    : await database.get(
        `SELECT channel_id FROM trading_routes WHERE channel_id = ? AND account_id = ? AND strategy_version_id = ? AND enabled = 1`,
        [intent.channelId, intent.accountId, intent.strategyVersionId],
      );
  if (!authorized) throw new TradingRiskError('ROUTE_NO_LONGER_AUTHORIZED', 'The execution route was removed, changed or disabled.');
  if (intent.executionPathId && !await isWorkflowExecutionAuthorized(intent.executionPathId)) {
    throw new TradingRiskError('ROUTE_NO_LONGER_AUTHORIZED', 'The pinned workflow execution path is no longer authorized by the current graph.');
  }
  const schema = await database.get('SELECT id FROM trading_signal_schemas WHERE id = ? AND enabled = 1', [intent.signal.schema]);
  if (!schema) throw new TradingRiskError('SIGNAL_SCHEMA_UNAVAILABLE', 'The signal schema is no longer enabled.');
  if (await unresolvedEvidenceCount(intent.accountId) > 0) {
    throw new TradingRiskError('UNRESOLVED_REMOTE_EVIDENCE', 'Unresolved remote execution evidence blocks new entries.');
  }
  if (await unresolvedOperationCount(intent.accountId) > 0) {
    throw new TradingRiskError('UNRESOLVED_EXCHANGE_OPERATION', 'An in-flight or unresolved exchange operation requires recovery.');
  }
}

interface IntentFailureClassification {
  code: string;
  fallbackReason: WorkflowFallbackReason | null;
  knownRisk: boolean;
  message: string;
  status: 'blocked' | 'unknown';
}

function classifyIntentFailure(error: unknown, unresolvedDispatch: boolean): IntentFailureClassification {
  const symbolUnavailable = error instanceof TradingSymbolUnavailableError;
  const riskError = error instanceof TradingRiskError || error instanceof LeverageTierError || error instanceof FxEvidenceError;
  const knownCause = symbolUnavailable || riskError;
  // The durable operation wins over an exception label: a late validation/TTL
  // failure cannot prove that an already handed-off write never reached the venue.
  const knownRisk = knownCause && !unresolvedDispatch;
  const code = knownRisk ? error.code : 'ORDER_OUTCOME_UNKNOWN';
  const message = error instanceof Error ? error.message : String(error);
  return {
    code,
    fallbackReason: isWorkflowFallbackReason(code) ? code : null,
    knownRisk,
    message: knownCause && unresolvedDispatch ? `[${error.code}] ${message}` : message,
    status: knownRisk ? 'blocked' : 'unknown',
  };
}

async function recordFallbackAdvanceNotification(
  intent: TradingIntent,
  result: WorkflowFallbackAdvanceResult | null,
): Promise<void> {
  if (!result?.advanced || !result.toAccountId) return;
  await recordTradingNotificationBestEffort({
    dedupeKey: `workflow-fallback:${result.runId}:${result.fromAccountId}:${result.toAccountId}:${result.reason}`,
    eventType: 'workflow_fallback_candidate_skipped',
    intentId: intent.id,
    channelId: intent.channelId,
    accountId: intent.accountId,
    exchange: intent.exchange,
    mode: intent.mode,
    occurredAt: Date.now(),
    details: {
      runId: result.runId,
      fromAccountId: result.fromAccountId,
      toAccountId: result.toAccountId,
      reason: result.reason,
      symbol: intent.symbol,
    },
  });
}

async function provedEntryAverage(intentId: string): Promise<string> {
  const fills = await getDatabase().all<Array<{ price: string; quantity: string }>>(
    `SELECT fills.price, fills.quantity FROM trading_fills AS fills JOIN trading_orders AS orders ON orders.id = fills.order_id
     WHERE orders.intent_id = ? AND orders.role = 'entry'`, [intentId]);
  const cost = fills.reduce((total, fill) => addDecimal(total, multiplyDecimal(fill.price, fill.quantity)), '0');
  const quantity = fills.reduce((total, fill) => addDecimal(total, fill.quantity), '0');
  return divideDecimal(cost, quantity);
}

function remoteStateDigest(account: TradingAccount, remote: ExchangeOpenState): string {
  const stable = {
    version: 3,
    orders: remote.orders.map(order => ({
      clientOrderId: order.clientOrderId,
      exchangeOrderId: order.exchangeOrderId,
      providerSymbol: order.providerSymbol ?? order.symbol,
      status: order.status,
      filled: order.filledQuantity,
      quantity: order.quantity,
      trigger: order.triggerPrice,
    })).sort((left, right) =>
      left.exchangeOrderId.localeCompare(right.exchangeOrderId)
      || String(left.clientOrderId || '').localeCompare(String(right.clientOrderId || ''))),
    positions: remote.positions.map(position => ({
      symbol: position.symbol,
      providerSymbol: position.providerSymbol ?? null,
      side: position.side,
      quantity: position.quantity,
      entry: position.averageEntryPrice,
    })).sort((left, right) => `${left.symbol}:${left.side}`.localeCompare(`${right.symbol}:${right.side}`)),
    fillIds: remote.fills.map(fill => JSON.stringify(fillDigestIdentity(account, fill))).sort((left, right) => left.localeCompare(right)),
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function compactRemoteSnapshot(account: TradingAccount, remote: RemoteStateWithIdentity): string {
  return JSON.stringify({
    version: 3,
    accountFingerprint: remote.accountFingerprint || null,
    stateDigest: remoteStateDigest(account, remote),
    observedAt: remote.observedAt,
    counts: {
      orders: remote.orders.length,
      positions: remote.positions.length,
      fills: remote.fills.length,
    },
  });
}

async function persistPlan(intent: TradingIntent, plan: TradingPlan): Promise<void> {
  await transaction(async () => {
    const update = await getDatabase().run(
      `UPDATE trading_trade_intents SET status = 'planned', plan_json = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
      [JSON.stringify(plan), Date.now(), intent.id],
    );
    if (Number(update.changes || 0) !== 1) throw new Error('Trade intent is no longer pending.');
    await getDatabase().run(
      `INSERT INTO trading_positions (
         id, intent_id, account_id, strategy_version_id, channel_id, symbol, side,
         status, quantity, average_entry_price, stop_price, realized_pnl,
         opened_at, closed_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'opening', '0', NULL, ?, '0', NULL, NULL, ?)`,
      [randomUUID(), intent.id, intent.accountId, intent.strategyVersionId, intent.channelId, intent.symbol, intent.side, plan.stopPrice, Date.now()],
    );
    for (const order of plan.orders) {
      await getDatabase().run(
        `INSERT INTO trading_orders (
           id, intent_id, account_id, client_order_id, exchange_order_id, role,
           side, order_type, status, price, trigger_price, quantity, filled_quantity,
           reduce_only, request_json, response_json, last_error, created_at, updated_at
         ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 'created', ?, ?, ?, '0', ?, ?, NULL, NULL, ?, ?)`,
        [
          randomUUID(), intent.id, intent.accountId, order.clientOrderId, order.role,
          order.side, order.orderType, order.price, order.triggerPrice, order.quantity,
          order.reduceOnly ? 1 : 0, JSON.stringify(order), plan.createdAt, plan.createdAt,
        ],
      );
    }
  });
}

async function markOrderSubmitting(intentId: string, clientOrderId: string): Promise<void> {
  const update = await getDatabase().run(
    `UPDATE trading_orders SET status = 'submitting', updated_at = ?
     WHERE intent_id = ? AND client_order_id = ? AND status = 'created'`,
    [Date.now(), intentId, clientOrderId],
  );
  if (Number(update.changes || 0) !== 1) throw new Error(`Order ${clientOrderId} is not submit-ready.`);
}

async function submitTrackedOrder(input: {
  adapter: TradingExchangeAdapter;
  account: TradingAccount;
  intent: TradingIntent;
  plan: TradingPlan;
  order: PlannedOrder;
}): Promise<ExchangeOrderResult> {
  if (input.order.role === 'entry') throw new Error('Entries require protected dispatch and final admission.');
  let dispatched = false;
  try {
    const request = requestFromOrder(input.account, input.plan, input.order);
    return await runJournaledExchangeWrite({
      account: input.account, intentId: input.intent.id, kind: 'submit', clientOrderIds: [input.order.clientOrderId], request,
      beforeDispatch: () => markOrderSubmitting(input.intent.id, input.order.clientOrderId),
      guard: () => {},
      send: () => { dispatched = true; return input.adapter.submitOrder(input.account, request); },
      persist: async result => { await storeOrderResult(input.intent.id, input.order.clientOrderId, result); return [result]; },
    });
  } catch (error: any) {
    if (dispatched) await getDatabase().run(
      `UPDATE trading_orders SET status = 'unknown', last_error = ?, updated_at = ?
       WHERE intent_id = ? AND client_order_id = ? AND status IN ('submitting', 'unknown')`,
      [error?.message || 'Order outcome is unknown.', Date.now(), input.intent.id, input.order.clientOrderId],
    );
    throw error;
  }
}

async function cancelTrackedOrder(
  adapter: TradingExchangeAdapter, account: TradingAccount, intentId: string, clientOrderId: string,
  remote?: ExchangeOpenState, permit = claimCancelAttempt(account.id, clientOrderId),
): Promise<ExchangeOrderResult> {
  const authorization = await prepareCancelDispatch(account, intentId, clientOrderId, remote);
  return runJournaledExchangeWrite({
    account, intentId, kind: 'cancel', clientOrderIds: [clientOrderId], request: { clientOrderId },
    beforeDispatch: async () => {
      const update = await getDatabase().run(
        `UPDATE trading_orders SET status = 'cancel_pending', updated_at = ?
         WHERE intent_id = ? AND account_id = ? AND client_order_id = ? AND status IN ('open', 'partially_filled', 'submitting', 'unknown', 'cancel_pending')`,
        [Date.now(), intentId, account.id, clientOrderId],
      );
      if (update.changes !== 1) throw new Error('Order is not eligible for cancellation without reconciliation.');
    },
    beforeSend: authorization.beforeSend,
    guard: authorization.guard,
    send: () => { consumeCancelAttempt(permit, account.id, clientOrderId); return adapter.cancelOrder(account, clientOrderId); },
    persist: async result => {
      await storeOrderResult(intentId, clientOrderId, result);
      return [result];
    },
  });
}

async function resumeTakeProfitCancels(adapter: TradingExchangeAdapter, account: TradingAccount, intentId: string,
  rows: TakeProfitOrderRow[], remote: ExchangeOpenState): Promise<boolean> {
  const pending = rows.filter(row => row.status === 'cancel_pending');
  for (const row of pending) {
    const result = await cancelTrackedOrder(adapter, account, intentId, row.client_order_id, remote);
    if (!['cancelled', 'filled'].includes(result.status)) throw new ReconciliationMismatchError('Take-profit cancellation remains unresolved.');
  }
  return pending.length > 0;
}

async function openLocalPosition(intent: TradingIntent, result: ExchangeOrderResult): Promise<void> {
  if (!['filled', 'partially_filled'].includes(result.status)
    || !result.averagePrice
    || compareDecimal(result.filledQuantity, '0') <= 0) return;
  await getDatabase().run(
    `UPDATE trading_positions SET status = 'open', quantity = ?, average_entry_price = ?,
       opened_at = COALESCE(opened_at, ?), updated_at = ? WHERE intent_id = ?`,
    [result.filledQuantity, result.averagePrice, Date.now(), Date.now(), intent.id],
  );
}

async function completedTakeProfitTargets(intent: TradingIntent, plan: TradingPlan, remote: ExchangeOpenState): Promise<number> {
  try {
    return (await loadTakeProfitAllocation(intent.id, plan, remote))?.completed ?? 0;
  } catch (error) {
    const message = 'Take-profit allocation is unresolved; own stop protection remains independently managed.';
    await recordTradingAccountIncident({ accountId: intent.accountId, category: 'reconciliation_contract', severity: 'critical', message,
      details: { intentId: intent.id, reason: error instanceof Error ? error.message.slice(0, 300) : 'Unknown allocation failure' } });
    await activateAccountKillSwitch(intent.accountId, message);
    // No new tightening based on unproved TP progress. desiredProtectiveStop still preserves the safest existing trigger.
    // ensureTakeProfitCoverage surfaces the allocation error after the independent protective action.
    return 0;
  }
}

async function assertTerminalEntrySlippage(
  intent: TradingIntent,
  plan: TradingPlan,
  averagePrice: string,
  quantity: string,
): Promise<void> {
  const entryState = await getDatabase().get<{ status: string }>(
    `SELECT status FROM trading_orders WHERE intent_id = ? AND role = 'entry'
     ORDER BY created_at LIMIT 1`,
    [intent.id],
  );
  if (!entryState || !['filled', 'cancelled'].includes(entryState.status)) return;
  assertEntrySlippage(intent, plan, {
    clientOrderId: '', exchangeOrderId: '', status: 'filled', filledQuantity: quantity,
    averagePrice, error: null, raw: null,
  });
}

async function createReplacementStop(intent: TradingIntent, plan: TradingPlan, quantity: string, trigger: string): Promise<PlannedOrder> {
  const original = plan.orders.find(order => order.role === 'stop_loss');
  if (!original) throw new Error('Trade plan has no protective stop.');
  return createGeneratedTradingOrder(intent, { ...original, quantity, triggerPrice: trigger });
}

type ProtectiveStopDecision = {
  trigger: string;
  reason: string;
  referenceTargetIndex: number | null;
};

function stopImproves(side: 'LONG' | 'SHORT', candidate: string, current: string): boolean {
  return side === 'LONG'
    ? compareDecimal(candidate, current) > 0
    : compareDecimal(candidate, current) < 0;
}

function configuredStopDecision(
  plan: TradingPlan,
  strategy: NonNullable<Awaited<ReturnType<typeof getTradingStrategyVersion>>>,
  filledTargets: number,
): ProtectiveStopDecision {
  const breakEvenAt = strategy.configuration.exits.moveStopToBreakEvenAfterTarget;
  return breakEvenAt !== null && filledTargets >= breakEvenAt
    ? { trigger: plan.entryPrice, reason: 'configured_break_even', referenceTargetIndex: null }
    : { trigger: plan.stopPrice, reason: 'initial', referenceTargetIndex: null };
}

async function desiredProtectiveStop(input: {
  adapter: TradingExchangeAdapter;
  account: TradingAccount;
  side: 'LONG' | 'SHORT';
  symbol: string;
  plan: TradingPlan;
  strategy: NonNullable<Awaited<ReturnType<typeof getTradingStrategyVersion>>>;
  filledTargets: number;
  currentTrigger: string | null;
}): Promise<ProtectiveStopDecision> {
  const stopLossMode = input.plan.stopLossMode
    ?? input.strategy.configuration.exits.stopLossMode
    ?? 'configured';
  if (!['configured', 'adaptive_targets'].includes(stopLossMode)) {
    throw new TradingRiskError('INVALID_STOP_LOSS_MODE', 'Unsupported stop-loss management mode.');
  }
  let decision: ProtectiveStopDecision = stopLossMode === 'adaptive_targets'
    ? adaptiveStopLossDecision(input.plan, input.filledTargets)
    : configuredStopDecision(input.plan, input.strategy, input.filledTargets);
  if (input.currentTrigger && stopImproves(input.side, input.currentTrigger, decision.trigger)) {
    decision = { trigger: input.currentTrigger, reason: 'existing_safer', referenceTargetIndex: null };
  }
  if (stopLossMode === 'adaptive_targets') return decision;
  const trailingPercent = input.strategy.configuration.exits.trailingStopPercent;
  if (trailingPercent === null) return decision;
  const market = await input.adapter.marketSnapshot(input.account, input.symbol);
  const distance = divideDecimal(multiplyDecimal(market.markPrice, trailingPercent), '100');
  const candidate = quantizeDecimalDown(
    input.side === 'LONG'
      ? subtractDecimal(market.markPrice, distance)
      : addDecimal(market.markPrice, distance),
    market.priceTick,
  );
  return stopImproves(input.side, candidate, decision.trigger)
    ? { trigger: candidate, reason: 'trailing_stop', referenceTargetIndex: null }
    : decision;
}

function matchingActiveStops(
  remote: ExchangeOpenState,
  intentOrderIds: Set<string>,
  local: { account_id: string; intent_id: string; symbol: string; side: 'LONG' | 'SHORT' },
) {
  return remote.orders.filter(order =>
    intentOrderIds.has(order.clientOrderId!)
    && protectiveStopCoverage({ ...order, accountId: local.account_id, intentId: local.intent_id }, {
      accountId: local.account_id, intentId: local.intent_id, symbol: local.symbol, side: local.side,
      quantity: '0', minimumTrigger: null,
    }).protected);
}

type ActiveStop = ReturnType<typeof matchingActiveStops>[number];

function replacementStopExecuted(existing: ActiveStop | undefined, accepted: ActiveStop): boolean {
  return !existing && compareDecimal(accepted.filledQuantity!, '0') > 0;
}

function safestActiveStop(activeStops: ActiveStop[], side: 'LONG' | 'SHORT'): ActiveStop | undefined {
  return activeStops.reduce<ActiveStop | undefined>((best, candidate) => {
    if (!best || !candidate.triggerPrice) return best || candidate;
    if (!best.triggerPrice) return candidate;
    const candidateIsSafer = side === 'LONG'
      ? compareDecimal(candidate.triggerPrice, best.triggerPrice) > 0
      : compareDecimal(candidate.triggerPrice, best.triggerPrice) < 0;
    return candidateIsSafer ? candidate : best;
  }, undefined);
}

export class TradingEngine {
  readonly mutations = new TradingMutationCoordinator();
  private readonly adapters = new Map<TradingExchange, TradingExchangeAdapter>();
  private readonly lastPeriodicReconciliationAt = new Map<string, number>();
  private readonly preparationRecoveryCursors = new Map<string, { id: string; created_at: number }>();
  private readonly safetyObservations = new WeakMap<ExchangeOpenState, SafetyObservation>();
  private readonly protectionObserver = createProtectionObserver(id => this.mutations.entryEpoch(id));

  constructor(
    adapters: TradingExchangeAdapter[],
    private readonly logger: TradingLogger = () => undefined,
    private readonly clockGuard: ClockHealthMonitor = new ClockGuard(),
    private readonly options: TradingEngineOptions = {},
  ) {
    for (const adapter of adapters) this.registerAdapter(adapter);
  }

  registerAdapter(adapter: TradingExchangeAdapter): void {
    const exchange = tradingExchangeId(adapter?.exchange);
    const existing = this.adapters.get(exchange);
    if (existing === adapter) return;
    if (existing) throw new Error(`An adapter is already registered for exchange ${exchange}.`);
    this.adapters.set(exchange, adapter);
  }

  private adapter(exchange: TradingExchange): TradingExchangeAdapter {
    const adapter = this.adapters.get(exchange);
    if (!adapter) throw new Error(`No ${exchange} exchange adapter is configured.`);
    return adapter;
  }

  async processIntent(intentId: string): Promise<void> {
    if (this.options.entryAuthority?.() === false) return;
    const intent = await getTradingIntent(intentId);
    if (!intent || !['pending', 'planned', 'submitting'].includes(intent.status)) return;
    await this.mutations.run(intent.accountId, async context => {
      const current = await getTradingIntent(intentId);
      if (!current || !['pending', 'planned', 'submitting'].includes(current.status)) return;
      if (this.options.entryAuthority?.() === false) return;
      const epoch = this.mutations.entryEpoch(current.accountId);
      try {
        if (current.status !== 'pending' && !await recoverUndispatchedPlan(current)) return;
        await this.assertClockSafeForEntry();
        await this.executePendingIntent(current, context, epoch);
      } catch (error: any) {
        await this.handleIntentFailure(current, error instanceof EntryAdmissionRevokedError
          ? new TradingRiskError(error.code, error.message) : error);
      }
    });
  }

  /** Revoked original preparations retire even while entries are paused. This path cannot call an adapter. */
  async retireUnauthorizedPreparations(accountId: string): Promise<number> {
    return this.mutations.run(accountId, async () => {
      const rows = await this.preparationRecoveryBatch(accountId);
      let retired = 0;
      const failures: unknown[] = [];
      for (const row of rows) {
        try { retired += await this.retireUnauthorizedPreparation(row.id); }
        catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, `Local preparation recovery has ${failures.length} unresolved error(s).`);
      return retired;
    });
  }

  private async preparationRecoveryBatch(accountId: string): Promise<Array<{ id: string; created_at: number }>> {
    const cursor = this.preparationRecoveryCursors.get(accountId);
    const rows = await getDatabase().all<Array<{ id: string; created_at: number }>>(
      `SELECT id, created_at FROM trading_trade_intents WHERE account_id = ? AND status IN ('planned', 'submitting')
       AND (? IS NULL OR created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at, id LIMIT 100`,
      [accountId, cursor?.created_at ?? null, cursor?.created_at ?? null, cursor?.created_at ?? null, cursor?.id ?? null]);
    if (!rows.length && cursor) {
      this.preparationRecoveryCursors.delete(accountId);
      return this.preparationRecoveryBatch(accountId);
    }
    if (rows.length) this.preparationRecoveryCursors.set(accountId, rows[rows.length - 1]!);
    return rows;
  }

  private async retireUnauthorizedPreparation(intentId: string): Promise<number> {
    return transaction(async () => {
      const intent = await getTradingIntent(intentId);
      if (!intent || !await hasUndispatchedPlanProof(intent, true)) return 0;
      const failure = await this.preparationAuthorityFailure(intent);
      if (!failure) return 0;
      await this.handleIntentFailure(intent, failure);
      return 1;
    });
  }

  private async preparationAuthorityFailure(intent: TradingIntent): Promise<TradingRiskError | null> {
    try {
      const [account, runtime, strategy] = await Promise.all([
        getTradingAccount(intent.accountId), getTradingRuntimeState(), getTradingStrategyVersion(intent.strategyVersionId),
      ]);
      assertExecutionPreconditions(account, runtime);
      assertPublishedStrategy(strategy);
      await assertExecutionAuthorization(intent);
      return null;
    } catch (error) {
      if (error instanceof TradingRiskError) return error;
      throw error;
    }
  }

  private async assertClockSafeForEntry(): Promise<void> {
    const clock = this.clockGuard.sample();
    if (clock.healthy) return;
    await updateTradingRuntimeState({
      executionEnabled: false,
      killSwitchActive: true,
      killSwitchReason: 'System clock drift exceeded the trading safety limit',
    });
    throw new TradingRiskError('CLOCK_DRIFT_UNSAFE', clock.reason || 'System clock drift is unsafe.');
  }

  private assertStartupEntryAuthority(): void {
    if (this.options.entryAuthority?.() === false) {
      throw new TradingRiskError('STARTUP_NOT_READY', 'Startup or maintenance authorization blocks new entries.');
    }
  }

  async cancelOpenEntries(accountId?: string, context?: TradingMutationContext): Promise<number> {
    const release = this.mutations.holdEntries(accountId);
    try {
      const accountIds = accountId ? [accountId] : await tradingAccountTargetIds(true);
      let cancelled = 0;
      const failures: unknown[] = [];
      for (const id of accountIds) {
        try {
          cancelled += await this.mutations.run(id, async () => {
            await requestEntryDrain(id, 'Operator requested entry drain');
            return this.drainAndProveEntries(id);
          }, context);
        } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, `Entry drain unresolved for ${failures.length} account(s); cancellation remains pending.`);
      return cancelled;
    } finally { release(); }
  }

  private async drainRequestedEntriesOwned(accountId: string): Promise<number> {
    let cancelled = 0;
    const failures: unknown[] = [];
    for (const row of await requestedEntryDrains(accountId)) {
      try { cancelled += await this.drainEntryCommitment(row); }
      catch (error) { failures.push(error); }
    }
    const pending = await pendingEntryDrainCount(accountId);
    if (pending > 0 || failures.length) {
      await activateAccountKillSwitch(accountId, `Entry drain unresolved for account ${accountId}`);
      throw new AggregateError(failures, `Entry drain unresolved: ${pending} commitment(s) require fresh cancellation evidence.`);
    }
    return cancelled;
  }

  private async drainAndProveEntries(accountId: string, intentIds?: string[]): Promise<number> {
    let cancelled = 0;
    // A failed cancel must not prevent the fresh fill/position read or protection of owned exposure.
    try { cancelled = await this.drainRequestedEntriesOwned(accountId); } catch { /* Prove the resulting state, never the acknowledgement alone. */ }
    try {
      const reconciled = await this.reconcileAccountOwned(accountId, { force: true }, true);
      if (!reconciled) throw new ReconciliationMismatchError('Entry drain lacks a completed authoritative reconciliation.');
      await transaction(async () => {
        const scopes = intentIds?.length ? [...new Set(intentIds)] : [undefined];
        for (const intentId of scopes) {
          const proof = await this.collectLifecycleProof(reconciled.account, reconciled.remote, 'entriesDrained', intentId, reconciled.accountVersion);
          if (cancelled > 0) await riskEvent({ severity: 'info', code: 'ENTRY_DRAIN_PROVED', accountId, intentId, details: { proof } });
          await this.assertLifecycleCommitCurrent(proof);
        }
      });
      return cancelled;
    } catch (error) {
      await activateAccountKillSwitch(accountId, `Entry drain lacks a current safety proof for account ${accountId}`);
      throw error;
    }
  }

  private async drainEntryCommitment(row: EntryCommitment): Promise<number> {
    const permit = claimCancelAttempt(row.account_id, row.client_order_id);
    // Rotate even currently unresolvable obligations so they cannot starve other owned entries.
    await markEntryDrainAttempt(row.account_id, row.client_order_id);
    if (row.status === 'created' || row.status === 'submitting') {
      const intent = await getTradingIntent(row.intent_id);
      if (intent && await transaction(async () => {
        if (!await abandonUndispatchedPlan(intent)) return false;
        await setIntentState(intent.id, 'failed', { error: 'Undispatched entry abandoned by persistent drain request.' });
        return true;
      })) return 1;
    }
    const active = ['open', 'partially_filled'].includes(row.status)
      || (row.status === 'cancel_pending' && await entryCancelRetryAuthorized(row.account_id, row.client_order_id));
    if (!active || !row.exchange_order_id || !row.provider_symbol) {
      throw new ReconciliationMismatchError('Entry cancellation requires a recovered exact active order identity.');
    }
    return this.cancelEntryRow(row, permit);
  }

  async cancelExpiredEntries(now = Date.now()): Promise<number> {
    const candidates = await getDatabase().all<OpenEntryRow[]>(
      `SELECT orders.intent_id, orders.account_id, orders.client_order_id,
              orders.created_at, intent.plan_json, intent.created_at AS intent_created_at,
              intent.signal_run_id, run.created_at AS run_created_at
       FROM trading_orders AS orders
       JOIN trading_trade_intents AS intent ON intent.id = orders.intent_id
       LEFT JOIN workflow_signal_runs AS run ON run.id = intent.signal_run_id AND run.workflow_revision_id = intent.workflow_revision_id
       WHERE orders.role = 'entry' AND orders.status IN ('created', 'submitting', 'open', 'partially_filled', 'cancel_pending', 'unknown')
       ORDER BY orders.created_at`,
    );
    const expired = candidates.map(row => ({ ...row, expiryReason: entryExpirationReason(row, now) }))
      .filter(row => row.expiryReason !== null);
    const cancelled = await this.cancelEntryRows(expired);
    for (const row of expired) {
      await riskEvent({
        severity: 'info', code: row.expiryReason!, accountId: row.account_id, intentId: row.intent_id,
        details: { clientOrderId: row.client_order_id },
      });
    }
    return cancelled;
  }

  private async cancelEntryRows(rows: OpenEntryRow[], context?: TradingMutationContext): Promise<number> {
    let cancelled = 0;
    const failures: unknown[] = [];
    const accounts = new Map<string, Set<string>>();
    for (const row of rows) {
      if (!accounts.has(row.account_id)) accounts.set(row.account_id, new Set());
      accounts.get(row.account_id)!.add(row.intent_id);
    }
    for (const [accountId, intents] of accounts) {
      try {
        cancelled += await this.mutations.run(accountId, async () => {
          for (const intentId of intents) await requestEntryDrain(accountId, 'Entry time-to-live expired', intentId);
          return this.drainAndProveEntries(accountId, [...intents]);
        }, context);
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Entry expiry drain remains unresolved.');
    return cancelled;
  }

  private async cancelEntryRow(row: OpenEntryRow, permit: CancelAttemptPermit): Promise<number> {
      const account = await getTradingAccount(row.account_id);
      if (!account) throw new Error('Open entry references a missing trading account.');
      try {
        const result = await cancelTrackedOrder(this.adapter(account.exchange), account, row.intent_id, row.client_order_id, undefined, permit);
        if (!['cancelled', 'filled', 'rejected'].includes(result.status)) {
          throw new ReconciliationMismatchError(`Entry cancellation remains unresolved (${result.status}).`);
        }
        return 1;
      } catch (error: any) {
        await getDatabase().run(
          `UPDATE trading_orders SET status = 'unknown', last_error = ?, updated_at = ?
           WHERE account_id = ? AND client_order_id = ? AND status IN ('submitting', 'open', 'partially_filled', 'cancel_pending', 'unknown')`,
          [error?.message || String(error), Date.now(), row.account_id, row.client_order_id],
        );
        await activateAccountKillSwitch(row.account_id, `Entry cancellation outcome unknown for account ${row.account_id}`);
        throw error;
      }
  }

  async emergencyFlattenManaged(accountId?: string, context?: TradingMutationContext): Promise<number> {
    const release = this.mutations.holdEntries(accountId);
    try {
      const accounts = accountId ? [{ id: accountId }] : await getDatabase().all<Array<{ id: string }>>(
        "SELECT DISTINCT account_id AS id FROM trading_positions WHERE status IN ('opening', 'open', 'closing', 'emergency') ORDER BY account_id");
      let requested = 0;
      const failures: unknown[] = [];
      const prepared: string[] = [];
      for (const account of accounts) {
        try {
          const count = await this.mutations.run(account.id, () => this.prepareAccountEmergency(account.id), context);
          requested += count;
          if (count > 0) prepared.push(account.id);
        } catch (error) { failures.push(error); }
      }
      // Capture all selected accounts before the first provider call can fail or the process can die in flight.
      for (const id of prepared) {
        try { await this.mutations.run(id, () => this.reconcileAccountOwned(id, { force: true }), context); }
        catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, `Emergency exit remains pending or unresolved on ${failures.length} account(s).`);
      return requested;
    } finally { release(); }
  }

  private async prepareAccountEmergency(accountId: string): Promise<number> {
    const positions = await getDatabase().all<Array<{ intent_id: string }>>(
      "SELECT intent_id FROM trading_positions WHERE account_id = ? AND status IN ('opening', 'open', 'closing', 'emergency')", [accountId]);
    if (!positions.length) return 0;
    await activateAccountKillSwitch(accountId, 'Operator requested emergency exit');
    for (const position of positions) await requestEmergencyExit(accountId, position.intent_id, 'Operator requested emergency exit');
    return positions.length;
  }

  private async preparePendingIntent(intent: TradingIntent, epoch: string) {
    const [account, strategy, runtime, pathConfiguration] = await Promise.all([
      getTradingAccount(intent.accountId),
      getTradingStrategyVersion(intent.strategyVersionId),
      getTradingRuntimeState(),
      executionPathConfiguration(intent),
    ]);
    assertExecutionPreconditions(account, runtime);
    assertPublishedStrategy(strategy);
    if (intent.plan) {
      const original = intent.plan as TradingPlan;
      assertEntryPriceBoundary(original, original.orders.find(order => order.role === 'entry')!);
    }
    await assertExecutionAuthorization(intent);
    const strategyConfiguration = pathConfiguration.strategy;
    const entryExpiresAt = await intentEntryDeadline(intent, strategyConfiguration.safety.entryOrderTtlSeconds);
    assertEntryNotExpired(entryExpiresAt);
    const capacityState = await loadCapacityState(intent);
    assertAccountSafetyState(capacityState);
    const capacitySkipReason = candidateCapacitySkipReason(capacityState, account.maxConcurrentPositions);
    if (capacitySkipReason) throwCapacitySkip(capacitySkipReason);
    const adapter = this.adapter(account.exchange);
    // Establish account health before evaluating market availability. If both
    // calls were raced, a fast symbol miss could incorrectly hide a concurrent
    // account/executor failure and promote the fallback chain.
    const requestedAt = Date.now();
    const reconciled = await this.reconcileEntryCandidate(account, intent);
    const balanceStartedAt = Date.now();
    const accountSnapshot: TradingAccountSnapshot = await adapter.accountSnapshot(account);
    const observation: EntrySafetyObservation = { reconciled, epoch, requestedAt, verificationAccount: account,
      balance: accountSnapshot, balanceStartedAt, balanceCompletedAt: Date.now() };
    await this.assertCandidateCapacityCurrent(intent);
    const accounting = await assertEntryAccountingReady(account, accountSnapshot);
    const entrySafety = await proveEntrySafety(observation, intent.id, intent.plan as TradingPlan | null);
    let market: TradingMarketSnapshot;
    try {
      market = await adapter.marketSnapshot(account, intent.symbol);
    } catch (error) {
      if (error instanceof TradingSymbolUnavailableError) assertEntryNotExpired(entryExpiresAt);
      throw error;
    }
    assertEntryNotExpired(entryExpiresAt);
    const tiers = assertTierEvidence(account, intent.symbol, market);
    await assertLocalTierScope(account.id, intent.id, intent.symbol, tiers.providerSymbol);
    await readEntryModeEvidence(adapter, account, intent.symbol);
    await recordTradingEquitySnapshot(account.id, accountSnapshot);
    const channelRisk = await pathChannelRisk(intent, pathConfiguration, accountSnapshot);
    if (channelRisk.blocked) {
      throw new TradingRiskError('CHANNEL_BLOCKED', channelRisk.reason);
    }
    const sizingFx = await prepareSizingFx(account, accountSnapshot, market, (intent.plan as TradingPlan | null)?.fxSizing);
    const plan = createTradingPlan({
      intentId: intent.id,
      signal: intent.signal,
      strategy: strategyConfiguration,
      account: accountSnapshot,
      market,
      fxConversion: sizingFx,
      effectiveRiskPercent: channelRisk.riskPercent,
      entryOriginAt: intent.createdAt,
      entryExpiresAt,
      entryPriceBoundary: (intent.plan as TradingPlan | null)?.entryPriceBoundary,
      // Recovery revalidates the original plan; it must not renew its creation time.
      now: (intent.plan as TradingPlan | null)?.createdAt,
    });
    assertBoundedEntryProfile(account, plan);
    assertPlanTierDecision(account, plan, market);
    const currentCapacity = await loadCapacityState(intent);
    assertAccountSafetyState(currentCapacity);
    const changedCapacity = candidateCapacitySkipReason(currentCapacity, (await getTradingAccount(account.id))!.maxConcurrentPositions);
    if (changedCapacity) throwCapacitySkip(changedCapacity);
    const riskProof = await createRiskAdmission({ account, intentId: intent.id, plan, market, snapshot: accountSnapshot,
      budget: resolveDailyLossLimit(strategyConfiguration.safety, accountSnapshot.equity), epoch, sizingFx });
    await bindRiskContract(account, intent.id, market);
    if (intent.plan) await persistRevalidatedEntryDeadline(intent, plan);
    else await persistPlan(intent, plan);
    return {
      account,
      adapter,
      plan,
      effectiveRiskPercent: channelRisk.riskPercent,
      accounting,
      riskProof,
      observation,
      entrySafety,
    };
  }

  private async reconcileEntryCandidate(account: TradingAccount, intent: TradingIntent): Promise<ReconciledAccountEvidence> {
    await assertCandidateNeverSent(account, intent.id, intent.plan as TradingPlan | null);
    try {
      const reconciled = await this.reconcileAccountOwned(account.id, { force: true });
      if (!reconciled) throw new Error('ACQUISITION_MISSING');
      return reconciled;
    } catch (error) {
      // Account incidents and isolation have already been persisted. This particular candidate has not been sent.
      const code = reconciliationIncidentCategory(error) === 'reconciliation_transient'
        ? 'ACCOUNT_EXECUTOR_UNAVAILABLE' : 'ENTRY_SAFETY_UNPROVEN';
      throw new TradingRiskError(code, `ACCOUNT_RECONCILIATION_FAILED: ${reconciliationErrorMessage(error)}`);
    }
  }

  private async assertCandidateCapacityCurrent(intent: TradingIntent): Promise<void> {
    const capacity = await loadCapacityState(intent);
    assertAccountSafetyState(capacity);
    const account = await getTradingAccount(intent.accountId);
    if (!account) throw new TradingRiskError('ENTRY_SAFETY_UNPROVEN', 'ACCOUNT_MISSING');
    const reason = candidateCapacitySkipReason(capacity, account.maxConcurrentPositions);
    if (reason) throwCapacitySkip(reason);
  }

  private async executePendingIntent(intent: TradingIntent, context: TradingMutationContext, epoch: string): Promise<void> {
    const { account, adapter, plan, effectiveRiskPercent, accounting, riskProof, observation, entrySafety } = await this.preparePendingIntent(intent, epoch);
    await markWorkflowFallbackSelected(intent.id);
    const entry = plan.orders.find(order => order.role === 'entry')!;
    const protectiveStop = plan.orders.find(order => order.role === 'stop_loss')!;
    await setIntentState(intent.id, 'submitting', { plan });
    await recordTradingExecutionEvent({
      eventType: 'submit_started',
      intentId: intent.id,
      channelId: intent.channelId,
      accountId: intent.accountId,
      exchange: intent.exchange,
      mode: intent.mode,
      details: { symbol: intent.symbol, effectiveRiskPercent },
    });
    let entryMode: ExchangeEntryConstraints | null = null;
    let tierMarket: TradingMarketSnapshot | null = null;
    let dispatchSafety = entrySafety;
    const protectedResult = await submitTrackedProtectedEntry({
      adapter,
      account,
      intent,
      plan,
      entry,
      stop: protectiveStop,
      beforeDispatch: async () => {
        ({ entryMode, tierMarket } = await this.assertFinalEntryAdmission(intent, account, plan, context, epoch, accounting));
      },
      beforeSend: async witness => {
        await verifyRiskAdmission(riskProof, plan);
        dispatchSafety = await proveEntrySafety(observation, intent.id, plan, witness);
      },
      commitDispatch: () => {
        this.mutations.assertEntryEpoch(context, epoch);
        assertEntryNotExpired(plan.entryExpiresAt);
        this.assertStartupEntryAuthority();
        assertEntryModeEvidence(account, intent.symbol, entryMode);
        assertBoundedEntryProfile(account, plan);
        if (!tierMarket) throw new TradingRiskError('LEVERAGE_TIERS_UNPROVEN', 'Final tier read is missing.');
        assertPlanTierDecision(account, plan, tierMarket);
        assertRiskAdmissionFresh(riskProof);
        assertEntrySafetyFresh(dispatchSafety);
      },
    });
    await riskEvent({ severity: 'info', code: 'ENTRY_SAFETY_PROVED', accountId: account.id, intentId: intent.id,
      details: { proof: dispatchSafety, phase: 'protected_dispatch_acknowledged' } });
    const entryResult = protectedResult.entry;
    await recordTradingExecutionEvent({
      eventType: 'exchange_ack',
      intentId: intent.id,
      channelId: intent.channelId,
      accountId: intent.accountId,
      exchange: intent.exchange,
      mode: intent.mode,
      details: { status: entryResult.status, symbol: intent.symbol },
    });
    if (entryResult.filledQuantity !== '0') {
      await recordTradingExecutionEvent({
        eventType: 'first_fill',
        intentId: intent.id,
        channelId: intent.channelId,
        accountId: intent.accountId,
        exchange: intent.exchange,
        mode: intent.mode,
        details: { status: entryResult.status, symbol: intent.symbol },
      });
    }
    if (entryResult.status === 'filled') {
      await recordTradingExecutionEvent({
        eventType: 'fully_filled',
        intentId: intent.id,
        channelId: intent.channelId,
        accountId: intent.accountId,
        exchange: intent.exchange,
        mode: intent.mode,
        details: { symbol: intent.symbol },
      });
    }
    await this.validateProtectedEntryOutcome(
      adapter, account, intent, plan, protectiveStop, protectedResult,
    );
    await this.enforceEntrySlippage(adapter, account, intent, plan, entryResult);
    await this.submitInitialExits(adapter, account, intent, plan, entryResult);
    const current = await getTradingIntent(intent.id);
    if (current && ['submitting', 'unknown'].includes(current.status)) await setIntentState(intent.id, 'monitoring', { plan });
    this.logger(`[TRADING] intent=${intent.id} submitted status=${entryResult.status}`);
  }

  private async assertFinalEntryAdmission(
    intent: TradingIntent, preparedAccount: TradingAccount, plan: TradingPlan,
    context: TradingMutationContext, epoch: string, accounting: TradingAccountingEvidence,
  ): Promise<{ entryMode: ExchangeEntryConstraints | null; tierMarket: TradingMarketSnapshot }> {
    this.assertStartupEntryAuthority();
    this.mutations.assertEntryEpoch(context, epoch);
    await this.assertClockSafeForEntry();
    const [account, runtime, current, strategy] = await Promise.all([
      getTradingAccount(intent.accountId), getTradingRuntimeState(),
      getTradingIntent(intent.id), getTradingStrategyVersion(intent.strategyVersionId),
    ]);
    assertExecutionPreconditions(account, runtime);
    assertPublishedStrategy(strategy);
    if (account.externalAccountId !== preparedAccount.externalAccountId
      || account.credentialGeneration !== preparedAccount.credentialGeneration
      || account.credentialRef !== preparedAccount.credentialRef) {
      throw new TradingRiskError('ACCOUNT_IDENTITY_CHANGED', 'Account identity changed while the entry was prepared.');
    }
    assertBoundedEntryProfile(account, plan);
    if (current?.status !== 'submitting') {
      throw new TradingRiskError('ENTRY_INTENT_EXPIRED', 'Entry is no longer authorized or its original TTL expired.');
    }
    if (JSON.stringify((current.plan as TradingPlan | null)?.entryPriceBoundary ?? null) !== JSON.stringify(plan.entryPriceBoundary ?? null)) {
      throw new TradingRiskError('ENTRY_PRICE_BOUND_UNPROVEN', 'Persisted original entry price boundary changed during admission.');
    }
    if (JSON.stringify((current.plan as TradingPlan | null)?.leverageTierDecision) !== JSON.stringify(plan.leverageTierDecision)) {
      throw new TradingRiskError('LEVERAGE_TIERS_UNPROVEN', 'Persisted original tier decision changed during admission.');
    }
    assertEntryNotExpired(await intentEntryDeadline(current, plan.entryOrderTtlSeconds));
    await assertExecutionAuthorization(intent);
    const capacity = await loadCapacityState(intent);
    assertAccountSafetyState(capacity);
    const skipReason = candidateCapacitySkipReason(capacity, account.maxConcurrentPositions);
    if (skipReason) throwCapacitySkip(skipReason);
    assertAccountingFresh(accounting);
    await assertPersistedMoneyReady(account.id);
    const tierMarket = await this.adapter(account.exchange).marketSnapshot(account, intent.symbol);
    assertPlanTierDecision(account, plan, tierMarket);
    await assertLocalTierScope(account.id, intent.id, intent.symbol, tierMarket.leverageTiers!.providerSymbol);
    const entryMode = await readEntryModeEvidence(this.adapter(account.exchange), account, intent.symbol);
    if (entryMode && entryMode.providerSymbol !== tierMarket.leverageTiers!.providerSymbol) {
      throw new TradingRiskError('LEVERAGE_TIERS_UNPROVEN', 'Mode and tier provider-symbol binding disagree.');
    }
    this.mutations.assertEntryEpoch(context, epoch);
    return { entryMode, tierMarket };
  }

  private async validateProtectedEntryOutcome(
    adapter: TradingExchangeAdapter,
    account: TradingAccount,
    intent: TradingIntent,
    plan: TradingPlan,
    protectiveStop: PlannedOrder,
    protectedResult: { entry: ExchangeOrderResult; protectiveStop: ExchangeOrderResult },
  ): Promise<void> {
    const entryResult = protectedResult.entry;
    if (entryResult.status === 'rejected') {
      // Terminal acknowledgement alone cannot justify removing a stop. Fresh lifecycle cleanup owns this cancellation.
      throw new TradingRiskError('ENTRY_REJECTED', entryResult.error || 'Entry order rejected.');
    }
    const terminalIoc = Boolean(plan.entryPriceBoundary) && entryResult.status === 'cancelled';
    if (!terminalIoc && !['open', 'partially_filled', 'filled'].includes(entryResult.status)) {
      throw new Error(`Protected entry outcome is ${entryResult.status}.`);
    }
    await openLocalPosition(intent, entryResult);
    if (!['open', 'partially_filled', 'filled'].includes(protectedResult.protectiveStop.status)) {
      const error = new Error(
        `Provider-native protective stop status is ${protectedResult.protectiveStop.status}.`,
      );
      await this.emergencyFlatten(adapter, account, intent, plan, error);
      throw error;
    }
  }

  private async enforceEntrySlippage(
    adapter: TradingExchangeAdapter,
    account: TradingAccount,
    intent: TradingIntent,
    plan: TradingPlan,
    entryResult: ExchangeOrderResult,
  ): Promise<void> {
    try {
      assertEntrySlippage(intent, plan, entryResult);
    } catch (error) {
      await this.emergencyFlatten(adapter, account, intent, plan, error);
      throw error;
    }
  }

  private async submitInitialExits(
    adapter: TradingExchangeAdapter,
    account: TradingAccount,
    intent: TradingIntent,
    plan: TradingPlan,
    entryResult: ExchangeOrderResult,
  ): Promise<void> {
    if (entryResult.status === 'filled' || (plan.entryPriceBoundary && entryResult.status === 'cancelled')) {
      // TP quantities require a real fill ledger and current position, not just an entry acknowledgement.
      try { await this.reconcileAccountOwned(account.id, { force: true }); } catch (error) {
        if (!(error instanceof ReconciliationContinuationRequiredError)) throw error;
        // Durable orders remain managed. The transient reconciliation incident blocks other new entries.
      }
    } else if (entryResult.status === 'partially_filled') {
      await this.ensureExitProtection(account);
    }
  }

  private async handleIntentFailure(intent: TradingIntent, error: any): Promise<void> {
    const unresolved = await getDatabase().get(
      `SELECT 1 FROM trading_operations WHERE intent_id = ? AND account_id = ?
       AND phase IN ('dispatching', 'unresolved') LIMIT 1`, [intent.id, intent.accountId]);
    const { code, fallbackReason, knownRisk, message, status } = classifyIntentFailure(error, Boolean(unresolved));
    if (status === 'unknown') await this.isolateUnresolvedDispatch(intent);
    const fallback = await transaction(async () => {
      // A terminal rejection and release of a proven unsent reservation commit together.
      const current = knownRisk ? await getTradingIntent(intent.id) : null;
      if (current) await abandonUndispatchedPlan(current);
      if (fallbackReason) return advanceWorkflowFallbackOnEligibleFailure(intent, fallbackReason, message);
      await setIntentState(intent.id, status, {
        blockReason: knownRisk ? code : undefined,
        error: message,
      });
      await stopWorkflowFallback(intent.id, code);
      return null;
    });
    await recordFallbackAdvanceNotification(intent, fallback);
    await riskEvent({
      severity: knownRisk ? 'warning' : 'critical',
      code,
      accountId: intent.accountId,
      intentId: intent.id,
      details: { message },
    });
    await recordTradingNotificationBestEffort({
      dedupeKey: `${knownRisk ? 'intent-blocked' : 'execution-failed'}:${intent.id}:${code}`,
      eventType: knownRisk ? 'intent_blocked' : 'execution_failed',
      intentId: intent.id,
      channelId: intent.channelId,
      accountId: intent.accountId,
      exchange: intent.exchange,
      mode: intent.mode,
      occurredAt: Date.now(),
      details: { code, symbol: intent.symbol, status },
    });
    this.logger(`[TRADING] intent=${intent.id} ${status}: ${code}`);
  }

  private async isolateUnresolvedDispatch(intent: TradingIntent): Promise<void> {
    const unresolved = await getDatabase().get(
      `SELECT 1 FROM trading_orders WHERE intent_id = ? AND status IN ('submitting', 'unknown', 'cancel_pending') LIMIT 1`,
      [intent.id],
    );
    if (!unresolved) return;
    this.mutations.fenceEntries(intent.accountId);
    const message = 'Exchange order dispatch is unresolved; new entries require managed-order reconciliation.';
    await activateAccountKillSwitch(intent.accountId, message);
    await recordTradingAccountIncident({
      accountId: intent.accountId, category: 'reconciliation_contract', severity: 'critical', message,
      details: { intentId: intent.id, code: 'ORDER_OUTCOME_UNRESOLVED' },
    });
  }

  private async ensureExitProtection(account: TradingAccount): Promise<boolean> {
    try {
      // An acknowledgement is not the final protection decision. The normal lifecycle owns actions and publication.
      await this.reconcileAccountOwned(account.id, { force: true });
      return false;
    } catch (error) {
      if (error instanceof ReconciliationContinuationRequiredError) return true;
      // Missing history/health proof is not authorization to flatten or remove a still useful own stop.
      throw error;
    }
  }

  private async ensureTakeProfitCoverage(
    adapter: TradingExchangeAdapter,
    account: TradingAccount,
    intent: TradingIntent,
    plan: TradingPlan,
    remote: ExchangeOpenState,
  ): Promise<boolean> {
    await recoverPreparedExits(account, intent.id, 'take_profit');
    const allocation = await loadTakeProfitAllocation(intent.id, plan, remote);
    if (!allocation) return false;
    const plannedTargets = plan.orders.filter(order => order.role === 'take_profit');
    if (allocation.rows.some(row => ['submitting', 'unknown'].includes(row.status))) {
      throw new ReconciliationMismatchError('Take-profit coverage contains an unresolved order outcome.');
    }
    if (await resumeTakeProfitCancels(adapter, account, intent.id, allocation.rows, remote)) return true;
    const targets = plannedTargets.map((planned, index) => {
      const rows = allocation.rows.filter(row => targetIndexFromOrderRow(row) === index + 1);
      const coverage = targetOrderCoverage(rows, planned.price!);
      return { planned, rows, coverage, desired: allocation.totals[index]!, remaining: allocation.remaining[index]! };
    });
    try {
      const stale = targets.filter(target => !target.coverage.pricesMatch || compareDecimal(target.coverage.covered, target.desired) !== 0)
        .flatMap(target => target.coverage.active);
      for (const row of stale) {
        const result = await cancelTrackedOrder(adapter, account, intent.id, row.client_order_id, remote);
        if (!['cancelled', 'filled'].includes(result.status)) throw new Error(`Take-profit cancellation status is ${result.status}.`);
      }
      // No replacement anywhere in this trade before a fresh account read proves post-cancel fills/ownership.
      if (stale.length > 0) return true;
      return await this.submitAllocatedTargets(adapter, account, intent, plan, targets);
    } catch (error: any) {
      if (error instanceof CancelBudgetExhaustedError) throw error;
      await riskEvent({
        severity: 'critical',
        code: 'TAKE_PROFIT_REBALANCE_UNRESOLVED',
        accountId: account.id,
        intentId: intent.id,
        details: { message: error?.message || String(error) },
      });
      await activateAccountKillSwitch(account.id, `Take-profit rebalance is unresolved for account ${account.id}`);
      if (error instanceof CancellationEvidenceError) throw error;
      throw new ReconciliationMismatchError(error?.message || 'Take-profit rebalance is unresolved.');
    }
  }

  private async submitAllocatedTargets(
    adapter: TradingExchangeAdapter, account: TradingAccount, intent: TradingIntent, plan: TradingPlan,
    targets: Array<{ planned: PlannedOrder; rows: TakeProfitOrderRow[];
      coverage: ReturnType<typeof targetOrderCoverage>; desired: string; remaining: string }>,
  ): Promise<boolean> {
    const resized: Array<{ targetIndex: number; from: string; to: string }> = [];
    let changed = false;
    for (const target of targets) {
      if (target.coverage.pricesMatch && compareDecimal(target.coverage.covered, target.desired) === 0) continue;
      const order = await prepareTargetOrder(intent, target.planned, target.remaining, target.rows);
      if (!order) continue;
      const result = await submitTrackedOrder({ adapter, account, intent, plan, order });
      if (!['open', 'partially_filled', 'filled'].includes(result.status)) throw new Error(`Take-profit submission status is ${result.status}.`);
      changed = true;
      if (order.clientOrderId !== target.planned.clientOrderId) {
        resized.push({ targetIndex: target.planned.targetIndex!, from: target.coverage.covered, to: target.desired });
      }
      if (compareDecimal(result.filledQuantity, '0') > 0) break;
    }
    if (resized.length > 0) {
      await riskEvent({ severity: 'info', code: 'TAKE_PROFIT_COVERAGE_RESIZED', accountId: account.id,
        intentId: intent.id, details: { targets: resized } });
    }
    return changed;
  }

  private async emergencyFlatten(
    adapter: TradingExchangeAdapter,
    account: TradingAccount,
    intent: TradingIntent,
    plan: TradingPlan,
    cause: unknown,
  ): Promise<void> {
    this.mutations.fenceEntries(account.id);
    await activateAccountKillSwitch(account.id, `Emergency exit requested for intent ${intent.id}`);
    const message = cause instanceof Error ? cause.message : String(cause);
    if (!await requestEmergencyExit(account.id, intent.id, message)) {
      throw new ReconciliationMismatchError('Emergency exit has no active recoverable managed position.');
    }
    try { await this.drainRequestedEntriesOwned(account.id); } catch { /* Own reduction is independent of incomplete entry drain. */ }
    const remote = await this.observeSafetyState(account, adapter);
    await this.assertRemoteAccountIdentity(account, remote);
    await this.ingestOwnedState(account, remote);
    const position = remote.positions.find(candidate => candidate.symbol === intent.symbol);
    if (!position || compareDecimal(position.quantity, '0') <= 0) return;
    await this.submitEmergencyReduction(adapter, account, intent, plan, position.quantity, message);
  }

  private async submitEmergencyReduction(
    adapter: TradingExchangeAdapter, account: TradingAccount, intent: TradingIntent, plan: TradingPlan, quantity: string, cause: string,
  ): Promise<void> {
    try {
      const order = await prepareEmergencyReduction(account, intent, quantity);
      const result = await submitTrackedOrder({ adapter, account, intent, plan, order });
      if (result.status !== 'filled') throw new Error(`Emergency flatten status is ${result.status}.`);
      await activateAccountKillSwitch(account.id, `Emergency flatten for intent ${intent.id} awaits exchange reconciliation`);
      await riskEvent({
        severity: 'critical', code: 'EMERGENCY_FLATTEN_PENDING_RECONCILIATION', accountId: account.id, intentId: intent.id,
        details: { cause, clientOrderId: order.clientOrderId },
      });
    } catch (flattenError: any) {
      await activateAccountKillSwitch(account.id, `Emergency flatten unresolved for intent ${intent.id}`);
      await riskEvent({
        severity: 'critical', code: 'EMERGENCY_FLATTEN_UNKNOWN', accountId: account.id, intentId: intent.id,
        details: { error: flattenError?.message || String(flattenError) },
      });
      throw flattenError;
    }
  }

  async reconcileAccount(accountId: string, options?: ReconciliationOptions): Promise<ReconciledAccountEvidence | undefined> {
    return this.mutations.run(accountId, () => this.reconcileAccountOwned(accountId, options), options?.mutation);
  }

  private async reconcileAccountOwned(accountId: string, options?: ReconciliationOptions, entryDrainAttempted = false): Promise<ReconciledAccountEvidence | undefined> {
    const force = options?.force !== false;
    const now = Date.now();
    if (await this.skipPeriodicReconciliation(accountId, force, now)) return;
    const account = await getTradingAccount(accountId);
    if (!account) throw new Error('Trading account does not exist.');
    const adapter = this.adapter(account.exchange);
    const runId = randomUUID();
    const startedAt = Date.now();
    try {
      const runtime = await getTradingRuntimeState();
      if (runtime.killSwitchActive || account.killSwitchActive) await requestEntryDrain(accountId, 'Active kill switch');
      // A pending cancellation must not skip fresh fills or protection of already-owned exposure.
      if (!entryDrainAttempted) {
        try { await this.drainRequestedEntriesOwned(accountId); } catch { /* Persistent obligation is checked after reconciliation. */ }
      }
      const remote = await this.acquireAndReconcile(account, adapter);
      await this.refreshAccountRiskAfterProtection(account, adapter, remote);
      if (await pendingEntryDrainCount(accountId) > 0) {
        throw new ReconciliationMismatchError('Entry drain remains unresolved; fresh order evidence and bounded retry are required.');
      }
      if (await getDatabase().get(
        "SELECT id FROM trading_positions WHERE account_id = ? AND emergency_requested_at IS NOT NULL AND status <> 'closed' LIMIT 1", [accountId])) {
        throw new ReconciliationMismatchError('Persistent emergency exit is not yet proved closed.');
      }
      const accountVersion = await this.recordReconciliationSuccess(account, runId, startedAt, remote);
      return { account, accountVersion, remote };
    } catch (error) {
      await this.recordReconciliationFailure(accountId, runId, startedAt, error);
      throw error;
    }
  }

  private async acquireAndReconcile(account: TradingAccount, adapter: TradingExchangeAdapter): Promise<RemoteStateWithIdentity> {
    for (let pass = 0; pass < 3; pass += 1) {
      const remote = await this.observeSafetyState(account, adapter);
      try {
        await this.assertRemoteAccountIdentity(account, remote);
        if (!await this.applyRemoteState(account, adapter, remote)) return remote;
      } catch (error) {
        if (remote.acquisition?.recoverySchedule) {
          await failScheduledRecovery(account, remote.acquisition.recoverySchedule.attemptId, 'read_failed');
        }
        throw error;
      }
    }
    throw new ReconciliationContinuationRequiredError();
  }

  private async refreshAccountRiskAfterProtection(account: TradingAccount, adapter: TradingExchangeAdapter, remote: ExchangeOpenState): Promise<void> {
    try {
      const exceeded = await refreshReconciledRisk({ account, remote, epoch: this.mutations.entryEpoch(account.id),
        readBalance: () => adapter.accountSnapshot(account), budgetForIntent: async (id, equity) => {
          const intent = await getTradingIntent(id);
          if (!intent) throw new Error('Risk intent source is missing.');
          return resolveDailyLossLimit((await executionPathConfiguration(intent)).strategy.safety, equity);
        } });
      if (exceeded) {
        await requestEntryDrain(account.id, 'Current proved daily risk exceeds configured budget.');
        // The next regular lifecycle pass shares the original five-attempt budget; never start a second cancel series here.
      }
    } catch (error) {
      // Accounting must never turn successful protection into an unavailable stop/exit path.
      this.logger(`[TRADING] account=${account.id} risk evidence unresolved: ${String(error)}`);
    }
  }

  private async observeSafetyState(account: TradingAccount, adapter: TradingExchangeAdapter): Promise<RemoteStateWithIdentity> {
    const version = await getDatabase().get<{ state_version: number }>('SELECT state_version FROM trading_accounts WHERE id = ?', [account.id]);
    // Invalidate the prior receipt before awaiting transport, including a timeout with no new response.
    const observation = this.protectionObserver.begin(account.id, version?.state_version ?? -1);
    const remote = await adapter.openState(account) as RemoteStateWithIdentity;
    this.safetyObservations.set(remote, observation);
    return remote;
  }

  private async collectLifecycleProof(
    account: TradingAccount, remote: ExchangeOpenState, purpose: SafetyPurpose, intentId?: string, accountVersion?: number,
  ): Promise<TradingSafetyProof> {
    const observation = this.safetyObservations.get(remote);
    if (!observation || observation.accountId !== account.id) throw new ReconciliationMismatchError('Lifecycle safety requires a newly acquired account observation.');
    const current = await getTradingAccount(account.id);
    if (!current) throw new ReconciliationMismatchError('Lifecycle safety account no longer exists.');
    const evidence = await collectAccountSafetyEvidence({ current, epoch: observation.epoch, requestedAt: observation.requestedAt,
      runtimeCurrent: this.mutations.entryEpoch(account.id) === observation.epoch,
      reconciled: { account, remote, accountVersion: accountVersion ?? observation.accountVersion } });
    const proof = evaluateTradingSafety(evidence, purpose, intentId);
    assertTradingSafety(proof);
    return proof;
  }

  private async assertLifecycleCommitCurrent(proof: TradingSafetyProof): Promise<void> {
    const current = await getDatabase().get<{ state_version: number }>(
      'SELECT state_version FROM trading_accounts WHERE id = ?', [proof.binding.accountId]);
    if (current?.state_version !== proof.binding.accountVersion) {
      throw new ReconciliationMismatchError('ACCOUNT_STATE_CHANGED: lifecycle decision changed before commit.');
    }
    const now = Date.now();
    if (proof.acquisitionStartedAt === null || proof.acquisitionCompletedAt === null || proof.acquisitionCompletedAt > now
      || now - proof.acquisitionStartedAt > 30_000 || proof.evaluatedAt > now) {
      throw new ReconciliationMismatchError('ACQUISITION_NOT_FRESH: lifecycle evidence expired before commit.');
    }
    if (this.mutations.entryEpoch(proof.binding.accountId) !== proof.binding.runtimeEpoch) throw new EntryAdmissionRevokedError();
  }

  private async skipPeriodicReconciliation(accountId: string, force: boolean, now: number): Promise<boolean> {
    if (force) return false;
    const account = await getTradingAccount(accountId);
    if (account && usesScheduledFxRecovery(account) && await scheduledRecoveryDue(account, now)) {
      this.lastPeriodicReconciliationAt.set(accountId, now);
      return false;
    }
    const inMemory = this.lastPeriodicReconciliationAt.get(accountId) || 0;
    if (now - inMemory < MIN_PERIODIC_RECONCILIATION_MS) return true;
    this.lastPeriodicReconciliationAt.set(accountId, now);
    const latest = await getDatabase().get<{ completed_at: number | null }>(
      `SELECT MAX(completed_at) AS completed_at FROM trading_reconciliation_runs
       WHERE account_id = ? AND status = 'succeeded'`,
      [accountId],
    );
    if (!latest?.completed_at || now - latest.completed_at >= MIN_PERIODIC_RECONCILIATION_MS) return false;
    this.lastPeriodicReconciliationAt.set(accountId, latest.completed_at);
    return true;
  }

  private async recordReconciliationFailure(
    accountId: string,
    runId: string,
    startedAt: number,
    error: unknown,
  ): Promise<void> {
    this.protectionObserver.invalidate(accountId);
    const category = reconciliationIncidentCategory(error);
    const message = reconciliationErrorMessage(error);
    await recordTradingAccountIncident({
      accountId,
      category,
      severity: category === 'reconciliation_transient' ? 'warning' : 'critical',
      message,
      details: { errorName: error instanceof Error ? error.name : 'Error' },
    });
    if (category !== 'reconciliation_transient') await this.activateReconciliationProtection(accountId, message);
    await getDatabase().run(
      `INSERT INTO trading_reconciliation_runs (
         id, account_id, status, last_error, started_at, completed_at, local_snapshot_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, last_error = excluded.last_error,
         completed_at = excluded.completed_at, local_snapshot_json = excluded.local_snapshot_json`,
      [
        runId,
        accountId,
        error instanceof ReconciliationMismatchError ? 'mismatch' : 'failed',
        message,
        startedAt,
        Date.now(),
        error instanceof ProtectionProofRejectedError ? JSON.stringify(error.receipt) : null,
      ],
    );
    const account = await getTradingAccount(accountId);
    await recordTradingNotificationBestEffort({
      dedupeKey: `reconciliation-failed:${accountId}:${runId}`,
      eventType: 'reconciliation_failed',
      accountId,
      exchange: account?.exchange,
      mode: account?.mode,
      occurredAt: Date.now(),
      details: {
        category,
        failureKind: error instanceof ReconciliationMismatchError ? 'mismatch' : 'failed',
        errorName: error instanceof Error ? error.name : 'Error',
      },
    });
    await this.pruneReconciliationRuns(accountId);
  }

  private async activateReconciliationProtection(accountId: string, message: string): Promise<void> {
    const protection = await getDatabase().get<{ kill_switch_active: number }>(
      'SELECT kill_switch_active FROM trading_accounts WHERE id = ?',
      [accountId],
    );
    if (protection?.kill_switch_active === 1) return;
    await activateAccountKillSwitch(
      accountId,
      `Authoritative reconciliation is unsafe for account ${accountId}: ${message}`.slice(0, 500),
    );
  }

  private async assertRemoteAccountIdentity(
    account: TradingAccount,
    remote: RemoteStateWithIdentity,
  ): Promise<void> {
    if (account.exchange === 'paper') return;
    const current = remote.accountFingerprint;
    if (typeof current !== 'string' || !/^[a-f0-9]{64}$/.test(current)) {
      await this.failRemoteAccountIdentity(account, 'Exchange snapshot omitted a valid account fingerprint.');
    }
    if (account.externalAccountId && account.externalAccountId !== current) {
      await this.failRemoteAccountIdentity(account, 'Exchange snapshot does not match the bound external account identity.', {
        boundPrefix: account.externalAccountId.slice(0, 12),
        currentPrefix: current!.slice(0, 12),
      });
    }
    const previous = await getDatabase().get<{ remote_snapshot_json: string | null }>(
      `SELECT remote_snapshot_json FROM trading_reconciliation_runs
       WHERE account_id = ? AND status = 'succeeded' AND remote_snapshot_json IS NOT NULL
       ORDER BY completed_at DESC LIMIT 1`,
      [account.id],
    );
    if (!previous?.remote_snapshot_json) return;
    let priorFingerprint: string | null = null;
    try {
      const parsed = JSON.parse(previous.remote_snapshot_json) as { accountFingerprint?: unknown };
      if (typeof parsed.accountFingerprint === 'string') priorFingerprint = parsed.accountFingerprint;
    } catch {
      return;
    }
    if (!priorFingerprint || priorFingerprint === current) return;
    await this.failRemoteAccountIdentity(account, 'Exchange account fingerprint changed.', {
      previousPrefix: priorFingerprint.slice(0, 12),
      currentPrefix: current!.slice(0, 12),
    });
  }

  private async failRemoteAccountIdentity(
    account: TradingAccount,
    message: string,
    details: Record<string, unknown> = {},
  ): Promise<never> {
    await riskEvent({
      severity: 'critical',
      code: 'REMOTE_ACCOUNT_IDENTITY_MISMATCH',
      accountId: account.id,
      details: { message, ...details },
    });
    await activateAccountKillSwitch(account.id, `Remote account identity is untrusted for account ${account.id}`);
    throw new ReconciliationMismatchError(message, 'remote_identity');
  }

  private async recordReconciliationSuccess(
    account: TradingAccount,
    runId: string,
    startedAt: number,
    remote: RemoteStateWithIdentity,
  ): Promise<number> {
    const accountId = account.id;
    const observation = this.safetyObservations.get(remote);
    if (!observation) throw new ReconciliationMismatchError('Protection publication requires its original observation.');
    const publication = await transaction(async () => {
      const receipt = await collectProtectionReceipt({ account, remote, accountVersion: observation.accountVersion }, observation);
      const before = await protectionAccountSource(accountId);
      if (before.version !== observation.accountVersion) throw new ReconciliationMismatchError('ACCOUNT_STATE_CHANGED');
      await resolveTradingAccountIncidents(accountId, [
        'reconciliation_transient', 'reconciliation_contract', 'remote_identity', 'unmanaged_remote',
      ]);
      await updateTradingAccountConfiguration(accountId, { lastReconciledAt: Date.now() });
      const after = await protectionAccountSource(accountId);
      if (after.version !== before.version + 1 || after.digest !== before.digest) {
        throw new ReconciliationMismatchError('ACCOUNT_STATE_CHANGED: unexpected reconciliation metadata delta.');
      }
      receipt.commit = { accountVersion: after.version, at: Date.now() };
      const localSnapshot = JSON.stringify(receipt);
      await this.storeReconciliationSuccess(accountId, runId, startedAt, remote, localSnapshot);
      if (receipt.sourceDigest !== await protectionSourceDigest(accountId)) throw new ReconciliationMismatchError('PROTECTION_SOURCE_CHANGED');
      if ((await protectionAccountSource(accountId)).version !== after.version) throw new ReconciliationMismatchError('ACCOUNT_STATE_CHANGED');
      assertProtectionObservationFresh(observation);
      return { accountVersion: after.version, localSnapshot };
    });
    this.protectionObserver.publish(observation, publication.localSnapshot);
    return publication.accountVersion;
  }

  private async storeReconciliationSuccess(
    accountId: string, runId: string, startedAt: number, remote: RemoteStateWithIdentity, localSnapshot: string,
  ): Promise<void> {
    const account = await getTradingAccount(accountId);
    if (!account) throw new Error('Reconciliation account disappeared before snapshot.');
    const snapshot = compactRemoteSnapshot(account, remote);
    const previous = await getDatabase().get<{ id: string; remote_snapshot_json: string | null }>(
      `SELECT id, remote_snapshot_json FROM trading_reconciliation_runs
       WHERE account_id = ? AND status = 'succeeded'
       ORDER BY completed_at DESC LIMIT 1`,
      [accountId],
    );
    let coalesce = false;
    if (previous?.remote_snapshot_json) {
      try {
        const before = JSON.parse(previous.remote_snapshot_json) as { version?: unknown; stateDigest?: unknown; accountFingerprint?: unknown };
        const after = JSON.parse(snapshot) as { stateDigest: string; accountFingerprint: string | null };
        coalesce = before.version === 3 && before.stateDigest === after.stateDigest
          && before.accountFingerprint === after.accountFingerprint;
      } catch {
        coalesce = false;
      }
    }
    if (coalesce && previous) {
      await getDatabase().run(
        `UPDATE trading_reconciliation_runs SET started_at = ?, completed_at = ?, remote_snapshot_json = ?, local_snapshot_json = ?
         WHERE id = ?`,
        [startedAt, Date.now(), snapshot, localSnapshot, previous.id],
      );
    } else {
      await getDatabase().run(
        `INSERT INTO trading_reconciliation_runs (
           id, account_id, status, remote_snapshot_json, started_at, completed_at, local_snapshot_json
         ) VALUES (?, ?, 'succeeded', ?, ?, ?, ?)`,
        [runId, accountId, snapshot, startedAt, Date.now(), localSnapshot],
      );
    }
    await this.pruneReconciliationRuns(accountId);
  }

  private async pruneReconciliationRuns(accountId: string): Promise<void> {
    await getDatabase().run(
      `DELETE FROM trading_reconciliation_runs
       WHERE account_id = ? AND id NOT IN (
         SELECT id FROM trading_reconciliation_runs
         WHERE account_id = ? ORDER BY started_at DESC LIMIT ?
       )`,
      [accountId, accountId, MAX_RECONCILIATION_ROWS_PER_ACCOUNT],
    );
  }

  private async applyRemoteState(
    account: TradingAccount,
    adapter: TradingExchangeAdapter,
    remote: ExchangeOpenState,
  ): Promise<boolean> {
    const localPositions = await this.ingestOwnedState(account, remote, true);
    let cleanupChanged = false;
    let cancelBudgetExhausted = false;
    for (const local of localPositions) {
      try {
        const position = remote.positions.find(candidate => candidate.symbol === local.symbol);
        if (position) cleanupChanged = await this.reconcileOpenRemotePosition(account, adapter, remote, local, position) || cleanupChanged;
        else cleanupChanged = await this.reconcileMissingRemotePosition(account, adapter, remote, local) || cleanupChanged;
      } catch (error) {
        if (!(error instanceof CancelBudgetExhaustedError)) throw error;
        cancelBudgetExhausted = true;
      }
    }
    // Exhausted cancellation work cannot skip independent protection of another owned position.
    if (cancelBudgetExhausted) throw new ReconciliationContinuationRequiredError();
    if (cleanupChanged) return true;
    if (await unresolvedEvidenceCount(account.id) > 0) {
      throw new ReconciliationMismatchError('Account has unresolved remote execution evidence; ownership and closure remain unproved.', 'unresolved_fill');
    }
    if (await unresolvedOperationCount(account.id) > 0) {
      throw new ReconciliationMismatchError('Exchange operation outcome remains unresolved; exact order evidence is required.');
    }
    return false;
  }

  private async ingestOwnedState(account: TradingAccount, remote: ExchangeOpenState, protectKnownPositions = false): Promise<any[]> {
    const localOrders = await getDatabase().all<LocalCorrelationOrder[]>(
      `SELECT orders.*, intent.symbol FROM trading_orders AS orders
       JOIN trading_trade_intents AS intent ON intent.id = orders.intent_id WHERE orders.account_id = ?`, [account.id]);
    remote.orders = correlateRemoteOrders(localOrders, remote.orders);
    remote.fills = correlateRemoteFills(localOrders, remote.fills);
    await this.persistRemoteExecutions(account, remote);
    await resolveObservedOperations(account, remote.orders);
    await resolveActiveCancelAttempts(account, remote);
    await this.detectUnmanagedExposure(account, remote);
    await observeAccountBaseline(account, remote);
    const unresolved = await unresolvedEvidenceCount(account.id);
    if (unresolved > 0 && !protectKnownPositions) {
      throw new ReconciliationMismatchError('Account has unresolved remote execution evidence; ownership and closure remain unproved.', 'unresolved_fill');
    }
    if (unresolved === 0) await resolveTradingAccountIncidents(account.id, ['unresolved_fill']);
    const localPositions = await getDatabase().all<any[]>(
      `SELECT position.*, intent.plan_json FROM trading_positions AS position
       JOIN trading_trade_intents AS intent ON intent.id = position.intent_id
       WHERE position.account_id = ? AND position.status IN ('opening', 'open', 'closing', 'emergency')`,
      [account.id],
    );
    // Verify all owned quantities before changing any position or protection.
    // A same-symbol/same-side remote balance can include a manual trade.
    await assertAccountOwnership(localPositions, remote.positions);
    return localPositions;
  }

  private async persistRemoteExecutions(account: TradingAccount, remote: ExchangeOpenState): Promise<void> {
    let incompleteManagedExecution = false;
    for (const event of remote.unresolvedEvents || []) await recordRemoteEvidence(account, event);
    for (const order of remote.orders) {
      const local = await getDatabase().get<{ intent_id: string }>(
        'SELECT intent_id FROM trading_orders WHERE account_id = ? AND client_order_id = ?',
        [account.id, order.clientOrderId],
      );
      if (!local) {
        // A terminal history row is still economic evidence. Advancing the history cursor
        // must not discard it merely because ownership/baseline classification is pending.
        await recordRemoteEvidence(account, {
          kind: 'order', source: 'fetchOrders', reason: 'unmanaged_order', providerId: order.exchangeOrderId,
          providerSymbol: order.providerSymbol ?? order.symbol, evidence: economicEvidence(order),
        });
        continue;
      }
      if (!order.clientOrderId) throw new Error('Managed order correlation omitted its local identity.');
      await persistTradingRemoteOrder(local.intent_id, order.clientOrderId, order, remote.observedAt);
      incompleteManagedExecution ||= order.filledQuantity === null;
    }
    for (const fill of remote.fills) {
      await this.persistRemoteFill(account, fill, remote.acquisition);
    }
    await projectAccountFillAccounting(account.id);
    await resolveManagedHistoricalEvidence(account.id);
    if (remote.acquisition) await recordAcquisitionEvidence(account, remote.acquisition);
    if (remote.acquisition?.accountLogs) await projectAccountLogMoney(account);
    if (incompleteManagedExecution) {
      throw new ReconciliationMismatchError('Managed remote orders omit cumulative execution; protection and closure cannot be proved.');
    }
  }

  private async persistRemoteFill(account: TradingAccount, fill: ExchangeOpenState['fills'][number], read?: ExchangeOpenState['acquisition']): Promise<void> {
    const { order: localOrder, inserted, fillId } = await persistCorrelatedFill(account, fill, read);
    if (!localOrder || !inserted) return;
    const intent = await getTradingIntent(localOrder.intent_id);
    if (!intent) return;
    const notificationType = localOrder.role === 'entry'
      ? 'partial_fill'
      : localOrder.role === 'take_profit'
        ? 'take_profit_filled'
        : localOrder.role === 'stop_loss'
          ? 'stop_loss_filled'
          : null;
    if (notificationType) {
      await recordTradingNotificationBestEffort({
        dedupeKey: `fill:${account.id}:${fillId}`,
        eventType: notificationType,
        intentId: intent.id,
        channelId: intent.channelId,
        accountId: account.id,
        exchange: account.exchange,
        mode: account.mode,
        occurredAt: fill.filledAt,
        details: {
          exchangeFillId: fill.exchangeFillId,
          orderId: localOrder.id,
          role: localOrder.role,
          symbol: intent.symbol,
          price: fill.price,
          quantity: fill.quantity,
          fee: fill.fee,
          feeAsset: fill.feeAsset,
        },
      });
    }
    if (localOrder.role !== 'entry') return;
    await this.recordEntryFillEvents(intent, fill.filledAt, localOrder.status === 'filled');
  }

  private async recordEntryFillEvents(
    intent: TradingIntent,
    occurredAt: number,
    fullyFilled: boolean,
  ): Promise<void> {
    const event = {
      occurredAt,
      intentId: intent.id,
      channelId: intent.channelId,
      accountId: intent.accountId,
      exchange: intent.exchange,
      mode: intent.mode,
      details: { symbol: intent.symbol },
    };
    await recordTradingExecutionEvent({ ...event, eventType: 'first_fill' });
    if (fullyFilled) await recordTradingExecutionEvent({ ...event, eventType: 'fully_filled' });
  }

  private async reconcileMissingRemotePosition(
    account: TradingAccount,
    adapter: TradingExchangeAdapter,
    remote: ExchangeOpenState,
    local: any,
  ): Promise<boolean> {
    const proof = await loadTradeLifecycle(local.intent_id, local.side);
    if (!proof.flat) throw new ReconciliationMismatchError('Missing remote position does not prove a zero owned quantity.');
    if (!proof.entriesTerminal) {
      if (compareDecimal(proof.ownership.entryQuantity, '0') > 0) {
        await requestEntryDrain(account.id, 'Exit filled while entry can still fill', local.intent_id);
        throw new ReconciliationMismatchError('Entry remains active after exit fills; closure is blocked until entry drain is proved.');
      }
      return false;
    }
    if (!proof.ordersTerminal) return this.cleanupExitSiblings(account, adapter, local.intent_id, proof, remote);
    if (!proof.operationsResolved) throw new ReconciliationMismatchError('Unresolved exchange operation prevents terminal closure.');
    if (compareDecimal(proof.ownership.entryQuantity, '0') > 0) {
      await this.closeRemotelyAbsentPosition(account, remote, local);
      return false;
    }
    const entry = await getDatabase().get<{ status: string }>(
      `SELECT status FROM trading_orders
       WHERE intent_id = ? AND role = 'entry' ORDER BY created_at LIMIT 1`,
      [local.intent_id],
    );
    if (entry && ['cancelled', 'rejected'].includes(entry.status)) {
      await transaction(async () => {
        const safety = await this.collectLifecycleProof(account, remote, 'tradeClosed', local.intent_id);
        await getDatabase().run(
          `UPDATE trading_positions SET status = 'closed', quantity = '0', closed_at = ?, updated_at = ? WHERE id = ?`,
          [remote.observedAt, remote.observedAt, local.id]);
        const intent = await getTradingIntent(local.intent_id);
        if (intent && !['completed', 'blocked', 'failed'].includes(intent.status)) {
          await setIntentState(local.intent_id, 'failed', { error: `Entry order ${entry.status} before opening a position.` });
        }
        await riskEvent({ severity: 'info', code: 'TRADE_CLOSURE_PROVED', accountId: account.id,
          intentId: local.intent_id, details: { proof: safety, entryStatus: entry.status } });
        await this.assertLifecycleCommitCurrent(safety);
      });
    }
    return false;
  }

  private async cleanupExitSiblings(
    account: TradingAccount, adapter: TradingExchangeAdapter, intentId: string, proof: Awaited<ReturnType<typeof loadTradeLifecycle>>,
    remote: ExchangeOpenState,
  ): Promise<boolean> {
    const siblings = proof.orders.filter(order => order.role !== 'entry' && !['filled', 'cancelled', 'rejected'].includes(order.status));
    let changed = false;
    for (const order of siblings) {
      const permit = claimCancelAttempt(account.id, order.client_order_id);
      if (order.status === 'created' && await retireUndispatchedExit(intentId, order.client_order_id)) { changed = true; continue; }
      if (!['open', 'partially_filled', 'cancel_pending'].includes(order.status) || !order.exchange_order_id || !order.provider_symbol) {
        throw new ReconciliationMismatchError('Exit sibling outcome remains unresolved; no terminal closure is permitted.');
      }
      const result = await cancelTrackedOrder(adapter, account, intentId, order.client_order_id, remote, permit);
      if (!['filled', 'cancelled', 'rejected'].includes(result.status)) {
        throw new ReconciliationMismatchError('Exit sibling cancellation remains unresolved; no terminal closure is permitted.');
      }
      changed = true;
    }
    return changed;
  }

  private async closeRemotelyAbsentPosition(
    account: TradingAccount,
    remote: ExchangeOpenState,
    local: any,
  ): Promise<void> {
    const proof = await loadTradeLifecycle(local.intent_id, local.side);
    if (!proof.flat || !proof.ordersTerminal || !proof.operationsResolved) {
      await riskEvent({
        severity: 'critical', code: 'REMOTE_POSITION_ABSENCE_UNCONFIRMED',
        accountId: account.id, intentId: local.intent_id,
        details: { symbol: local.symbol, observedAt: remote.observedAt },
      });
      await activateAccountKillSwitch(account.id, `Remote position absence is unconfirmed for account ${account.id}`);
      throw new ReconciliationMismatchError(
        `Remote position ${local.symbol} is absent without terminal fill proof.`,
      );
    }
    const entryAverage = await provedEntryAverage(local.intent_id);
    await projectAccountFillAccounting(account.id);
    const accounting = await getDatabase().get<{ reporting_currency: string | null; status: string }>(
      'SELECT reporting_currency, status FROM trading_accounting_projections WHERE intent_id = ?', [local.intent_id]);
    const money = await intentMoneyTotals(local.intent_id);
    const moneyReady = accounting?.status === 'complete' && money.value !== null && money.currency === accounting.reporting_currency;
    const realizedPnl = moneyReady ? money.amount : null;
    await transaction(async () => {
      const safety = await this.collectLifecycleProof(account, remote, 'tradeClosed', local.intent_id);
      await getDatabase().run(
        `UPDATE trading_positions SET status = 'closed', quantity = '0', realized_pnl = COALESCE(?, realized_pnl), average_entry_price = ?,
           closed_at = ?, updated_at = ? WHERE id = ?`,
        [realizedPnl, entryAverage, remote.observedAt, remote.observedAt, local.id]);
      const intent = await getTradingIntent(local.intent_id);
      if (intent && !['completed', 'blocked', 'failed'].includes(intent.status)) await setIntentState(local.intent_id, 'completed');
      await riskEvent({ severity: 'info', code: 'TRADE_CLOSURE_PROVED', accountId: account.id,
        intentId: local.intent_id, details: { proof: safety } });
      await this.assertLifecycleCommitCurrent(safety);
    });
    const intent = await getTradingIntent(local.intent_id);
    if (intent) {
      await recordTradingExecutionEvent({
        eventType: 'position_closed',
        occurredAt: remote.observedAt,
        intentId: intent.id,
        channelId: intent.channelId,
        accountId: intent.accountId,
        exchange: intent.exchange,
        mode: intent.mode,
        details: { symbol: intent.symbol, realizedPnl, realizedPnlValue: moneyReady ? money.value : null,
          reportingCurrency: accounting?.reporting_currency ?? null, accountingStatus: moneyReady ? 'complete' : 'unresolved' },
      });
    }
  }

  async pollAccountStream(
    accountId: string,
    cursor: number,
    symbols: string[],
  ): Promise<{ account: TradingAccount; batch: ExchangeStreamBatch } | null> {
    const account = await getTradingAccount(accountId);
    if (!account) throw new Error('Trading account does not exist.');
    const stream = this.adapter(account.exchange).streamEvents;
    if (!stream || account.exchange === 'paper') return null;
    return {
      account,
      batch: await stream.call(this.adapter(account.exchange), account, cursor, symbols),
    };
  }

  private async reconcileOpenRemotePosition(
    account: TradingAccount,
    adapter: TradingExchangeAdapter,
    remote: ExchangeOpenState,
    local: any,
    position: ExchangeOpenState['positions'][number],
  ): Promise<boolean> {
    await getDatabase().run(
      `UPDATE trading_positions SET status = CASE WHEN emergency_requested_at IS NOT NULL THEN 'emergency' ELSE 'open' END,
         quantity = ?, average_entry_price = ?,
         opened_at = COALESCE(opened_at, ?), updated_at = ? WHERE id = ?`,
      [position.quantity, position.averageEntryPrice, remote.observedAt, remote.observedAt, local.id],
    );
    const recoverableIntent = await getTradingIntent(local.intent_id);
    if (!recoverableIntent || !local.plan_json) throw new Error('Remote position has no recoverable trade plan.');
    const recoverablePlan = JSON.parse(local.plan_json) as TradingPlan;
    if (typeof local.emergency_requested_at === 'number') {
      await this.submitEmergencyReduction(adapter, account, recoverableIntent, recoverablePlan, position.quantity, local.emergency_reason || 'Persistent emergency exit');
      return true;
    }
    try {
      await assertTerminalEntrySlippage(
        recoverableIntent, recoverablePlan, position.averageEntryPrice, position.quantity,
      );
    } catch (error) {
      await this.emergencyFlatten(adapter, account, recoverableIntent, recoverablePlan, error);
      throw error;
    }
    if (await this.ensureProtectiveStop(account, adapter, local, position.quantity, remote)) return true;
    if (await this.ensureTakeProfitCoverage(adapter, account, recoverableIntent, recoverablePlan, remote)) return true;
    if (['submitting', 'unknown'].includes(recoverableIntent.status)) await setIntentState(recoverableIntent.id, 'monitoring');
    return false;
  }

  private async detectUnmanagedExposure(account: TradingAccount, remote: ExchangeOpenState): Promise<void> {
    const [localOrders, localPositions] = await Promise.all([
      getDatabase().all<Array<{ client_order_id: string }>>(
        'SELECT client_order_id FROM trading_orders WHERE account_id = ?',
        [account.id],
      ),
      getDatabase().all<Array<{ symbol: string; side: string }>>(
        `SELECT symbol, side FROM trading_positions
         WHERE account_id = ? AND status IN ('opening', 'open', 'closing', 'emergency')`,
        [account.id],
      ),
    ]);
    const orderIds = new Set(localOrders.map(order => order.client_order_id));
    const externalOrders = remote.orders.filter(order =>
      !['filled', 'cancelled', 'rejected'].includes(order.status) && !orderIds.has(order.clientOrderId));
    const unknownOrders = remote.orders.filter(order => order.status === 'unknown');
    const externalPositions = remote.positions.filter(position =>
      !localPositions.some(local => local.symbol === position.symbol && local.side === position.side));
    if (externalOrders.length === 0 && externalPositions.length === 0 && unknownOrders.length === 0) return;
    const details = {
      externalOrderIds: externalOrders.map(order => order.clientOrderId || `exchange:${order.exchangeOrderId}`),
      externalPositions: externalPositions.map(position => ({ symbol: position.symbol, side: position.side })),
      unknownOrderIds: unknownOrders.map(order => order.clientOrderId || `exchange:${order.exchangeOrderId}`),
    };
    await riskEvent({
      severity: 'critical',
      code: 'UNMANAGED_REMOTE_EXPOSURE',
      accountId: account.id,
      details,
    });
    await activateAccountKillSwitch(account.id, `Unmanaged remote exposure detected for account ${account.id}`);
    throw new ReconciliationMismatchError('Unmanaged remote order or position detected.', 'unmanaged_remote');
  }

  private async ensureProtectiveStop(
    account: TradingAccount,
    adapter: TradingExchangeAdapter,
    local: any,
    quantity: string,
    remote: ExchangeOpenState,
  ): Promise<boolean> {
    const intent = await getTradingIntent(local.intent_id);
    if (!intent || !local.plan_json) throw new Error('Open position has no recoverable intent and plan.');
    const plan = JSON.parse(local.plan_json) as TradingPlan;
    await recoverPreparedExits(account, intent.id, 'stop_loss');
    const strategy = await getTradingStrategyVersion(intent.strategyVersionId);
    if (!strategy) throw new Error('Open position strategy version is missing.');
    const intentOrders = await loadProtectionOrders(account.id, intent.id);
    const intentOrderIds = new Set(intentOrders.map(order => order.clientOrderId!));
    if (intentOrders.some(order => order.role === 'stop_loss' && order.status === 'filled')) {
      await requestEntryDrain(account.id, 'Filled protective stop cannot protect future entry fills.', intent.id);
    }
    const filledTargets = await completedTakeProfitTargets(intent, plan, remote);
    const activeStops = matchingActiveStops(remote, intentOrderIds, local);
    const cancellingStops = await pendingCancelOrderIds(account.id, intent.id);
    const durableStops = activeStops.filter(stop => !cancellingStops.has(stop.clientOrderId!));
    const activeStop = safestActiveStop(durableStops, local.side);
    const protectiveQuantity = requiredStopQuantity(quantity, intentOrders.filter(order => order.role === 'entry'));
    const currentTrigger = activeStop?.triggerPrice && stopImproves(local.side, activeStop.triggerPrice, local.stop_price)
      ? activeStop.triggerPrice : local.stop_price;
    const decision = await desiredProtectiveStop({
      adapter,
      account,
      side: local.side,
      symbol: local.symbol,
      plan,
      strategy,
      filledTargets,
      currentTrigger,
    });
    const exactStop = durableStops.find(stop => compareDecimal(subtractDecimal(stop.quantity, stop.filledQuantity!), protectiveQuantity) === 0
      && compareDecimal(stop.triggerPrice!, decision.trigger) === 0);
    const protectedStop = await this.activateProtectiveStop({
      adapter,
      account,
      intent,
      plan,
      symbol: local.symbol,
      quantity: protectiveQuantity,
      trigger: decision.trigger,
      existing: exactStop,
    });
    await getDatabase().run(
      'UPDATE trading_positions SET stop_price = ?, updated_at = ? WHERE intent_id = ?',
      [decision.trigger, remote.observedAt, intent.id],
    );
    // An executing replacement requires fresh ownership before any further lifecycle action.
    if (replacementStopExecuted(exactStop, protectedStop)) {
      if (protectedStop.status === 'filled') {
        await requestEntryDrain(account.id, 'Replacement stop consumed; drain outstanding entry.', intent.id);
      }
      return true;
    }
    if (activeStop?.triggerPrice && activeStop.triggerPrice !== decision.trigger) {
      await riskEvent({
        severity: 'info',
        code: 'STOP_LOSS_MOVED',
        accountId: account.id,
        intentId: intent.id,
        details: {
          fromTrigger: activeStop.triggerPrice,
          toTrigger: decision.trigger,
          filledTargets,
          reason: decision.reason,
          referenceTargetIndex: decision.referenceTargetIndex,
        },
      });
      await recordTradingNotificationBestEffort({
        dedupeKey: `stop-move:${intent.id}:${decision.trigger}:${protectedStop.exchangeOrderId || protectedStop.clientOrderId}`,
        eventType: 'stop_moved',
        intentId: intent.id,
        channelId: intent.channelId,
        accountId: account.id,
        exchange: account.exchange,
        mode: account.mode,
        occurredAt: remote.observedAt,
        details: {
          symbol: intent.symbol,
          fromTrigger: activeStop.triggerPrice,
          toTrigger: decision.trigger,
          filledTargets,
          reason: decision.reason,
          referenceTargetIndex: decision.referenceTargetIndex,
        },
      });
    }
    // An acknowledgement is not independent replacement evidence. Re-read before touching siblings or TPs.
    if (!exactStop) return true;
    return this.cancelStaleProtectiveStops(account, adapter, intent, activeStops, protectedStop, remote);
  }

  private async activateProtectiveStop(input: {
    adapter: TradingExchangeAdapter;
    account: TradingAccount;
    intent: TradingIntent;
    plan: TradingPlan;
    symbol: string;
    quantity: string;
    trigger: string;
    existing: ActiveStop | undefined;
  }): Promise<ActiveStop> {
    const { adapter, account, intent, plan, symbol, quantity, trigger, existing } = input;
    if (existing) return existing;
    try {
      const replacement = await createReplacementStop(intent, plan, quantity, trigger);
      const result = await submitTrackedOrder({ adapter, account, intent, plan, order: replacement });
      if (!['open', 'partially_filled', 'filled'].includes(result.status)) throw new Error(`Replacement stop status is ${result.status}.`);
      if (result.status === 'filled' && compareDecimal(result.filledQuantity, quantity) !== 0) {
        throw new Error('Replacement stop full-fill status lacks complete executed quantity.');
      }
      return { ...replacement, ...result, symbol } as ActiveStop;
    } catch (error) {
      await this.emergencyFlatten(adapter, account, intent, plan, error);
      throw error;
    }
  }

  private async cancelStaleProtectiveStops(
    account: TradingAccount,
    adapter: TradingExchangeAdapter,
    intent: TradingIntent,
    activeStops: ActiveStop[],
    protectedStop: ActiveStop,
    remote: ExchangeOpenState,
  ): Promise<boolean> {
    let cancelledAny = false;
    for (const stale of activeStops) {
      if (stale.clientOrderId === protectedStop.clientOrderId) continue;
      try {
        const cancelled = await cancelTrackedOrder(adapter, account, intent.id, stale.clientOrderId, remote);
        if (!['cancelled', 'filled'].includes(cancelled.status)) {
          throw new Error(`Stale protective stop cancellation status is ${cancelled.status}.`);
        }
        cancelledAny = true;
      } catch (error: any) {
        if (error instanceof CancelBudgetExhaustedError) throw error;
        await riskEvent({
          severity: 'critical',
          code: 'STOP_REPLACEMENT_CANCEL_UNRESOLVED',
          accountId: account.id,
          intentId: intent.id,
          details: {
            protectedStopId: protectedStop.clientOrderId,
            staleStopId: stale.clientOrderId,
            message: error?.message || String(error),
          },
        });
        await activateAccountKillSwitch(account.id, `Protective stop cancellation is unresolved for account ${account.id}`);
        if (error instanceof CancellationEvidenceError) throw error;
        throw new ReconciliationMismatchError('Replacement stop is active but the stale stop outcome is unresolved.');
      }
    }
    return cancelledAny;
  }
}

async function submitTrackedProtectedEntry(input: {
  adapter: TradingExchangeAdapter;
  account: TradingAccount;
  intent: TradingIntent;
  plan: TradingPlan;
  entry: PlannedOrder;
  stop: PlannedOrder;
  beforeDispatch: () => Promise<void>;
  beforeSend: (witness: TradingDispatchWitness) => Promise<void>;
  commitDispatch: () => void;
}): Promise<{ entry: ExchangeOrderResult; protectiveStop: ExchangeOrderResult }> {
  if (!input.adapter.submitProtectedEntry) {
    throw new Error(`Exchange adapter ${input.account.exchange} lacks atomic protected-entry support.`);
  }
  let dispatched = false;
  try {
    const { entry: entryRequest, protectiveStop: stopRequest } = await prepareProtectedOrderIdentityRequests(
      input.account, input.intent.id, requestFromOrder(input.account, input.plan, input.entry),
      requestFromOrder(input.account, input.plan, input.stop),
    );
    const originalBoundary = JSON.stringify(input.plan.entryPriceBoundary ?? null);
    const originalTierDecision = JSON.stringify(input.plan.leverageTierDecision);
    assertEntryPriceBoundary(input.plan, entryRequest);
    return await runJournaledExchangeWrite({
      account: input.account, intentId: input.intent.id, kind: 'protected_entry',
      beforeSend: input.beforeSend,
      clientOrderIds: [input.entry.clientOrderId, input.stop.clientOrderId],
      request: { entry: entryRequest, protectiveStop: stopRequest },
      beforeDispatch: async () => {
        await markOrderSubmitting(input.intent.id, input.stop.clientOrderId);
        await markOrderSubmitting(input.intent.id, input.entry.clientOrderId);
        await input.beforeDispatch();
      },
      guard: () => {
        input.commitDispatch();
        if (JSON.stringify(input.plan.entryPriceBoundary ?? null) !== originalBoundary
          || JSON.stringify(entryRequest.entryPriceBoundary ?? null) !== originalBoundary) {
          throw new TradingRiskError('ENTRY_PRICE_BOUND_UNPROVEN', 'Original entry price boundary changed before dispatch.');
        }
        assertEntryPriceBoundary(input.plan, entryRequest);
        if (JSON.stringify(input.plan.leverageTierDecision) !== originalTierDecision
          || JSON.stringify(entryRequest.leverageTierDecision) !== originalTierDecision
          || entryRequest.quantity !== input.plan.quantity || entryRequest.leverage !== input.plan.leverage) {
          throw new TradingRiskError('LEVERAGE_TIERS_UNPROVEN', 'Original tier decision changed before dispatch.');
        }
      },
      send: () => {
        dispatched = true;
        return input.adapter.submitProtectedEntry!(input.account, entryRequest, stopRequest);
      },
      persist: async results => {
        await storeOrderResult(input.intent.id, input.stop.clientOrderId, results.protectiveStop);
        await storeOrderResult(input.intent.id, input.entry.clientOrderId, results.entry);
        return [results.entry, results.protectiveStop];
      },
    });
  } catch (error: any) {
    if (!dispatched && error instanceof OrderIdentityBindingError) throw new TradingRiskError(error.code, error.message);
    if (dispatched) await getDatabase().run(
      `UPDATE trading_orders SET status = 'unknown', last_error = ?, updated_at = ?
       WHERE intent_id = ? AND client_order_id IN (?, ?)
         AND status IN ('created', 'submitting', 'unknown')`,
      [
        error?.message || 'Protected entry outcome is unknown.',
        Date.now(),
        input.intent.id,
        input.entry.clientOrderId,
        input.stop.clientOrderId,
      ],
    );
    if (dispatched && error instanceof TradingUnresolvedOrderError) {
      await withDatabaseTransaction(async () => {
        for (const evidence of error.confirmedOrders) {
          if (![input.entry.clientOrderId, input.stop.clientOrderId].includes(evidence.clientOrderId)) {
            throw new Error('Unresolved order evidence does not belong to this protected dispatch.');
          }
          await storeOrderResult(input.intent.id, evidence.clientOrderId, evidence);
        }
      });
    }
    if (!dispatched) {
      const current = await getTradingIntent(input.intent.id);
      if (current) await abandonUndispatchedPlan(current);
    }
    throw error;
  }
}
