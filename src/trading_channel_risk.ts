import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { getDatabase, withDatabaseTransaction } from './db.js';
import {
  compareDecimal,
  decimal,
  signedDecimal,
} from './trading_decimal.js';
import { recordTradingExecutionEvent } from './trading_telemetry.js';
import { channelClosedMoneyValuePerformance } from './trading_money_reporting.js';
import { intentMoneyTotals } from './trading_fill_accounting.js';
import { moneyValueFromDecimal, validateMoneyValue, type MoneyValue } from './trading_money_value.js';
import { channelReturnThreshold, channelReturnValue } from './trading_channel_risk_math.js';
import type {
  ChannelRiskEvaluation,
  ChannelRiskMode,
  ChannelRiskPolicy,
  ChannelRiskTier,
  StrategyConfiguration,
  WeakChannelAction,
} from './trading_types.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;
const MODES = new Set<ChannelRiskMode>(['fixed', 'shadow', 'automatic']);
const WEAK_ACTIONS = new Set<WeakChannelAction>(['none', 'reduce', 'block']);

type ChannelRiskPolicyInput = {
  channelId: unknown;
  mode: unknown;
  tiers: unknown;
  currentTier?: unknown;
  lookbackWeeks: unknown;
  minimumClosedTrades: unknown;
  lossThresholdPercent: unknown;
  profitThresholdPercent: unknown;
  weakChannelAction: unknown;
  weakWeeksBeforeBlock: unknown;
  manuallyBlocked?: unknown;
  lockedTier?: unknown;
};

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return Number(value);
}

function decimalInput(value: unknown, label: string, maximum: string): string {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new TypeError(`${label} must be a decimal number.`);
  }
  const serialized = typeof value === 'string' ? value : value.toString();
  return decimal(serialized, { positive: true, max: maximum });
}

function identifier(value: unknown, label = 'Channel identifier'): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 128 || /[\r\n\0]/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value.trim();
}

function validateTiers(value: unknown): ChannelRiskTier[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new Error('Risk policy requires between one and twenty tiers.');
  }
  const tiers = value.map((tier, index) => {
    if (!tier || typeof tier !== 'object' || Array.isArray(tier)) throw new Error(`Risk tier ${index + 1} is invalid.`);
    return { riskPercent: decimal(String((tier as any).riskPercent), { positive: true, max: '10' }) };
  });
  tiers.forEach((tier, index) => {
    if (index > 0 && compareDecimal(tier.riskPercent, tiers[index - 1]!.riskPercent) <= 0) {
      throw new Error('Risk tiers must be strictly increasing.');
    }
  });
  return tiers;
}

function policyFromRow(row: any): ChannelRiskPolicy {
  const tiers = validateTiers(JSON.parse(row.tiers_json));
  const currentTier = integer(Number(row.current_tier), 'Stored current risk tier', 0, tiers.length - 1);
  const lockedTier = row.locked_tier === null
    ? null
    : integer(Number(row.locked_tier), 'Stored locked risk tier', 0, tiers.length - 1);
  return {
    channelId: String(row.channel_id),
    mode: row.mode,
    tiers,
    currentTier,
    lookbackWeeks: Number(row.lookback_weeks),
    minimumClosedTrades: Number(row.minimum_closed_trades),
    lossThresholdPercent: decimal(String(row.loss_threshold_percent), { positive: true, max: '100' }),
    profitThresholdPercent: decimal(String(row.profit_threshold_percent), { positive: true, max: '100' }),
    weakChannelAction: row.weak_channel_action,
    weakWeeksBeforeBlock: Number(row.weak_weeks_before_block),
    manuallyBlocked: Number(row.manually_blocked) === 1,
    blocked: Number(row.blocked) === 1,
    blockReason: row.block_reason || null,
    lockedTier,
    policyVersion: Number(row.policy_version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function evaluationFromRow(row: any): ChannelRiskEvaluation {
  return {
    id: String(row.id),
    channelId: String(row.channel_id),
    policyVersion: Number(row.policy_version),
    weekStartedAt: Number(row.week_started_at),
    weekEndedAt: Number(row.week_ended_at),
    closedTrades: Number(row.closed_trades),
    wins: Number(row.wins),
    losses: Number(row.losses),
    ...evaluationMoneyFields(row),
    startingEquity: decimal(String(row.starting_equity), { positive: true }),
    previousTier: Number(row.previous_tier),
    recommendedTier: Number(row.recommended_tier),
    appliedTier: Number(row.applied_tier),
    action: row.action,
    reason: String(row.reason),
    createdAt: Number(row.created_at),
  };
}

function storedMoneyValue(encoded: string | null, scalar: string | null): MoneyValue | null {
  if (!encoded) return scalar === null ? null : moneyValueFromDecimal(scalar);
  const value = validateMoneyValue(JSON.parse(encoded));
  if (value.decimal !== scalar) throw new Error('Stored adaptive-risk scalar differs from its exact value.');
  return value;
}

function evaluationMoneyFields(row: any) {
  const realizedPnl = row.realized_pnl === null ? null : signedDecimal(String(row.realized_pnl));
  const returnPercent = row.return_percent === null ? null : signedDecimal(String(row.return_percent));
  const source = row.source_json ? JSON.parse(row.source_json) : null;
  return { realizedPnl, returnPercent, realizedPnlValue: storedMoneyValue(row.realized_pnl_value_json, realizedPnl),
    returnPercentValue: storedMoneyValue(row.return_percent_value_json, returnPercent),
    returnPercentReason: source?.returnPercentReason ?? null, reportingCurrency: row.reporting_currency ?? null,
    sourceHash: row.source_hash ?? null, invalidatedAt: row.invalidated_at ?? null, invalidationReason: row.invalidation_reason ?? null };
}

export async function listChannelRiskPolicies(): Promise<ChannelRiskPolicy[]> {
  const rows = await getDatabase().all<any[]>(
    'SELECT * FROM trading_channel_risk_policies ORDER BY channel_id',
  );
  return rows.map(policyFromRow);
}

export async function listChannelRiskEvaluations(limit = 500): Promise<ChannelRiskEvaluation[]> {
  const safeLimit = integer(limit, 'Risk evaluation limit', 1, 5_000);
  const rows = await getDatabase().all<any[]>(
    `SELECT * FROM trading_channel_risk_evaluations
     ORDER BY week_ended_at DESC, channel_id LIMIT ?`,
    [safeLimit],
  );
  return rows.map(evaluationFromRow);
}

function normalizedRiskPolicy(
  input: ChannelRiskPolicyInput,
  existing: any,
  now: number,
) {
  const channelId = identifier(input.channelId);
  if (!MODES.has(input.mode as ChannelRiskMode)) throw new Error('Risk policy mode is invalid.');
  if (!WEAK_ACTIONS.has(input.weakChannelAction as WeakChannelAction)) throw new Error('Weak-channel action is invalid.');
  const tiers = validateTiers(input.tiers);
  const currentTier = input.currentTier === undefined
    ? 0
    : integer(input.currentTier, 'Current risk tier', 0, tiers.length - 1);
  const lockedTier = input.lockedTier === undefined || input.lockedTier === null
    ? null
    : integer(input.lockedTier, 'Locked risk tier', 0, tiers.length - 1);
  if (input.manuallyBlocked !== undefined && typeof input.manuallyBlocked !== 'boolean') {
    throw new Error('Manual channel block state must be boolean.');
  }
  const version = Number(existing?.policy_version || 0) + 1;
  const manuallyBlocked = input.manuallyBlocked ?? Boolean(existing?.manually_blocked);
  const blocked = manuallyBlocked;
  const blockReason = manuallyBlocked ? 'Manually blocked by operator' : null;
  return {
    channelId,
    mode: input.mode,
    tiers,
    currentTier,
    lookbackWeeks: integer(input.lookbackWeeks, 'Risk lookback weeks', 1, 12),
    minimumClosedTrades: integer(input.minimumClosedTrades, 'Minimum closed trades', 1, 1_000),
    lossThresholdPercent: decimalInput(input.lossThresholdPercent, 'Loss threshold percent', '100'),
    profitThresholdPercent: decimalInput(input.profitThresholdPercent, 'Profit threshold percent', '100'),
    weakChannelAction: input.weakChannelAction,
    weakWeeksBeforeBlock: integer(input.weakWeeksBeforeBlock, 'Weak weeks before block', 1, 52),
    manuallyBlocked,
    blocked,
    blockReason,
    lockedTier,
    version,
    createdAt: existing ? Number(existing.created_at) : now,
  };
}

export function validateChannelRiskPolicyInput(input: unknown): void {
  normalizedRiskPolicy(input as ChannelRiskPolicyInput, null, 0);
}

export async function upsertChannelRiskPolicy(
  input: ChannelRiskPolicyInput,
  now = Date.now(),
): Promise<ChannelRiskPolicy> {
  const requestedChannelId = identifier(input.channelId);
  const existing = await getDatabase().get<any>(
    'SELECT * FROM trading_channel_risk_policies WHERE channel_id = ?',
    [requestedChannelId],
  );
  const policy = normalizedRiskPolicy(input, existing, now);
  await getDatabase().run(
    `INSERT INTO trading_channel_risk_policies (
       channel_id, mode, tiers_json, current_tier, lookback_weeks, minimum_closed_trades,
       loss_threshold_percent, profit_threshold_percent, weak_channel_action,
       weak_weeks_before_block, manually_blocked, blocked, block_reason, locked_tier,
       policy_version, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel_id) DO UPDATE SET
       mode = excluded.mode,
       tiers_json = excluded.tiers_json,
       current_tier = excluded.current_tier,
       lookback_weeks = excluded.lookback_weeks,
       minimum_closed_trades = excluded.minimum_closed_trades,
       loss_threshold_percent = excluded.loss_threshold_percent,
       profit_threshold_percent = excluded.profit_threshold_percent,
       weak_channel_action = excluded.weak_channel_action,
       weak_weeks_before_block = excluded.weak_weeks_before_block,
       manually_blocked = excluded.manually_blocked,
       blocked = excluded.blocked,
       block_reason = excluded.block_reason,
       locked_tier = excluded.locked_tier,
       policy_version = excluded.policy_version,
       updated_at = excluded.updated_at`,
    [
      policy.channelId,
      policy.mode,
      JSON.stringify(policy.tiers),
      policy.currentTier,
      policy.lookbackWeeks,
      policy.minimumClosedTrades,
      policy.lossThresholdPercent,
      policy.profitThresholdPercent,
      policy.weakChannelAction,
      policy.weakWeeksBeforeBlock,
      policy.manuallyBlocked ? 1 : 0,
      policy.blocked ? 1 : 0,
      policy.blockReason,
      policy.lockedTier,
      policy.version,
      policy.createdAt,
      now,
    ],
  );
  await recordTradingExecutionEvent({
    eventType: 'risk_policy_changed',
    channelId: policy.channelId,
    occurredAt: now,
    details: {
      policyVersion: policy.version,
      mode: policy.mode,
      blocked: policy.blocked,
      tierCount: policy.tiers.length,
    },
  });
  return policyFromRow(await getDatabase().get(
    'SELECT * FROM trading_channel_risk_policies WHERE channel_id = ?',
    [policy.channelId],
  ));
}

export async function deleteChannelRiskPolicy(channelId: unknown): Promise<boolean> {
  const result = await getDatabase().run(
    'DELETE FROM trading_channel_risk_policies WHERE channel_id = ?',
    [identifier(channelId)],
  );
  return Number(result.changes || 0) === 1;
}

function currentWeekStart(now: number): number {
  const date = new Date(now);
  const day = (date.getUTCDay() + 6) % 7;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - day * 24 * 60 * 60 * 1_000;
}

type Performance = Awaited<ReturnType<typeof channelClosedMoneyValuePerformance>>;
type CapitalRequest = { channelId: string; accountId?: string; reportingCurrency?: string; currentEquity: string;
  since: number; until: number; now: number; performanceAccountId: string | null };
type CapitalProof = { accountId: string; fingerprint: string; generation: string | null; exchange: string;
  reportingCurrency: string; equity: string; basis: string; observedAt: number; snapshotId: string | null };
type ChannelEvidence = { version: 1; scope: { channelId: string; accountId: string | null; since: number; until: number };
  capital: CapitalProof; performance: Performance; positions: unknown[]; returnPercentReason: string | null };
const sourceHash = (value: string) => createHash('sha256').update(value).digest('hex');
const unresolvedRisk = (reason: string): never => { throw new Error(`Adaptive risk is unresolved: ${reason}`); };

async function performanceSources(request: CapitalRequest) {
  const rows = await getDatabase().all<any[]>(`SELECT p.id,p.intent_id,p.account_id,p.closed_at,p.reporting_currency,
    p.accounting_status,p.ledger_realized_pnl,p.ledger_realized_value_json,projection.evidence_hash
    FROM trading_positions p LEFT JOIN trading_accounting_projections projection ON projection.intent_id=p.intent_id
    WHERE p.channel_id=? AND (? IS NULL OR p.account_id=?) AND p.status='closed' AND p.closed_at>=? AND p.closed_at<?
    ORDER BY p.id LIMIT 1001`, [request.channelId, request.performanceAccountId, request.performanceAccountId, request.since, request.until]);
  if (rows.length > 1000) unresolvedRisk('closed-position source budget exceeded; no source was omitted.');
  const sources = [];
  for (const row of rows) {
    const totals = await intentMoneyTotals(row.intent_id);
    if (row.accounting_status !== 'complete' || !row.evidence_hash || !totals.value || totals.currency !== row.reporting_currency) {
      unresolvedRisk('closed-position original valuation is incomplete.');
    }
    const value = row.ledger_realized_value_json ? validateMoneyValue(JSON.parse(row.ledger_realized_value_json)) : null;
    if (value ? !isDeepStrictEqual(value, totals.value) : row.ledger_realized_pnl !== totals.amount) unresolvedRisk('closed-position valuation changed.');
    sources.push({ id: row.id, intentId: row.intent_id, accountId: row.account_id, closedAt: row.closed_at,
      projectionHash: row.evidence_hash, valuationHash: totals.valuationHash });
  }
  return sources;
}

async function capitalAccount(request: CapitalRequest, positions: Array<{ accountId: string }>) {
  const ids = new Set(positions.map(row => row.accountId));
  if (request.accountId) ids.add(request.accountId);
  if (!ids.size) {
    const routes = await getDatabase().all<Array<{ account_id: string }>>('SELECT DISTINCT account_id FROM trading_routes WHERE channel_id=? LIMIT 2', [request.channelId]);
    routes.forEach(row => ids.add(row.account_id));
  }
  if (ids.size !== 1) return unresolvedRisk('ambiguous account/equity context for channel history.');
  const accountId = [...ids][0]!;
  const row = await getDatabase().get<any>(`SELECT a.exchange,a.mode,a.external_account_id,a.credential_generation,b.reporting_currency
    FROM trading_accounts a JOIN trading_money_bindings b ON b.account_id=a.id AND b.account_fingerprint=
    CASE WHEN a.exchange='paper' THEN 'paper:'||a.id ELSE a.external_account_id END WHERE a.id=?`, [accountId]);
  if (!row || (!request.reportingCurrency && (row.exchange !== 'paper' || row.reporting_currency !== 'USDT'))
    || (request.reportingCurrency && request.reportingCurrency !== row.reporting_currency)) return unresolvedRisk('reporting currency is not bound to the input capital.');
  return { accountId, fingerprint: row.exchange === 'paper' ? `paper:${accountId}` : row.external_account_id,
    generation: row.credential_generation, exchange: row.exchange, reportingCurrency: row.reporting_currency };
}

async function capitalEvidence(request: CapitalRequest, positions: Array<{ accountId: string }>, pinned?: CapitalProof): Promise<CapitalProof> {
  const binding = await capitalAccount(request, positions);
  if (pinned?.basis === 'current_bound_input') return { ...binding, equity: decimal(pinned.equity, { positive: true }),
    basis: pinned.basis, observedAt: pinned.observedAt, snapshotId: null };
  // Legacy live snapshots have no historical currency/fingerprint and cannot be relabelled using today's account.
  const row = binding.exchange === 'paper' && binding.reportingCurrency === 'USDT'
    ? await getDatabase().get<{ id: string; equity: string; observed_at: number }>(`SELECT id,equity,observed_at FROM trading_equity_snapshots
      WHERE account_id=? AND observed_at>=? AND observed_at<? ORDER BY observed_at,id LIMIT 1`, [binding.accountId, request.since, request.until]) : undefined;
  if (row) return { ...binding, equity: decimal(row.equity, { positive: true }), basis: 'paper_native_historical', observedAt: row.observed_at, snapshotId: row.id };
  return { ...binding, equity: decimal(request.currentEquity, { positive: true }), basis: 'current_bound_input', observedAt: request.now, snapshotId: null };
}

async function collectChannelEvidence(request: CapitalRequest, pinned?: CapitalProof) {
  const performance = await channelClosedMoneyValuePerformance(request.channelId, request.performanceAccountId, request.since, request.until);
  if (performance.accountingStatus !== 'complete' || !performance.realizedPnlValue) unresolvedRisk('closed history is incomplete or mixes reporting currencies.');
  const positions = await performanceSources(request), capital = await capitalEvidence(request, positions, pinned);
  if (performance.reportingCurrency !== null && performance.reportingCurrency !== capital.reportingCurrency) unresolvedRisk('performance and capital reporting currencies differ.');
  const percent = channelReturnValue(performance.realizedPnlValue!, capital.equity);
  const source: ChannelEvidence = { version: 1, scope: { channelId: request.channelId, accountId: request.performanceAccountId,
    since: request.since, until: request.until }, capital, performance, positions, returnPercentReason: percent.reason };
  const json = JSON.stringify(source);
  if (Buffer.byteLength(json) >= 262144) unresolvedRisk('original source byte budget exceeded; no source was omitted.');
  return { source, json, hash: sourceHash(json), percent };
}

async function assertCachedEvidence(row: any, request: CapitalRequest): Promise<void> {
  if (row.invalidated_at !== null && row.invalidated_at !== undefined) unresolvedRisk(row.invalidation_reason ?? 'previous evaluation is invalidated.');
  if (!row.source_json || !row.source_hash || Buffer.byteLength(row.source_json) >= 262144
    || row.source_json.includes('\0') || sourceHash(row.source_json) !== row.source_hash) unresolvedRisk('original evaluation provenance is missing or invalid.');
  const original = JSON.parse(row.source_json) as ChannelEvidence;
  if (original.version !== 1 || !original.capital) unresolvedRisk('original evaluation provenance is invalid.');
  const current = await collectChannelEvidence(request, original.capital);
  if (current.hash !== row.source_hash) unresolvedRisk('original evaluation sources changed; a new explicit policy is required.');
  assertOriginalEvaluationAmounts(row, current);
}

function assertOriginalEvaluationAmounts(row: any, evidence: Awaited<ReturnType<typeof collectChannelEvidence>>): void {
  const { performance, capital } = evidence.source;
  if (row.starting_equity !== capital.equity || row.reporting_currency !== capital.reportingCurrency
    || row.realized_pnl !== performance.realizedPnl || row.return_percent !== (evidence.percent.value?.decimal ?? null)
    || !isDeepStrictEqual(storedMoneyValue(row.realized_pnl_value_json, row.realized_pnl), performance.realizedPnlValue)
    || !isDeepStrictEqual(storedMoneyValue(row.return_percent_value_json, row.return_percent), evidence.percent.value)) {
    unresolvedRisk('stored evaluation values disagree with their original source.');
  }
}

function recommendation(policy: ChannelRiskPolicy, performance: {
  closedTrades: number;
  realizedPnlValue: MoneyValue;
  equity: string;
}): { tier: number; action: ChannelRiskEvaluation['action']; reason: string; uncertain?: boolean } {
  if (policy.lockedTier !== null) {
    return { tier: policy.lockedTier, action: 'hold', reason: `Tier is manually locked at ${policy.lockedTier}.` };
  }
  if (performance.closedTrades < policy.minimumClosedTrades) {
    return {
      tier: policy.currentTier,
      action: 'hold',
      reason: `Only ${performance.closedTrades} closed trades; ${policy.minimumClosedTrades} required.`,
    };
  }
  const loss = channelReturnThreshold(performance.realizedPnlValue, performance.equity, policy.lossThresholdPercent, true);
  const profit = channelReturnThreshold(performance.realizedPnlValue, performance.equity, policy.profitThresholdPercent);
  if (loss === 'reached') {
      return {
        tier: Math.max(0, policy.currentTier - 1),
        action: 'decrease',
        reason: `Loss threshold ${policy.lossThresholdPercent}% reached.`,
      };
  } else if (profit === 'reached') {
    return {
      tier: Math.min(policy.tiers.length - 1, policy.currentTier + 1),
      action: 'increase',
      reason: `Profit threshold ${policy.profitThresholdPercent}% reached.`,
    };
  }
  if (loss === 'uncertain' || profit === 'uncertain') return { tier: policy.currentTier, action: 'hold', uncertain: true,
    reason: 'RISK_PRECISION_UNCERTAIN: the original monetary interval overlaps a policy threshold.' };
  return { tier: policy.currentTier, action: 'hold', reason: 'Weekly performance remained inside the neutral band.' };
}

async function shouldBlockWeakChannel(policy: ChannelRiskPolicy, action: ChannelRiskEvaluation['action']): Promise<boolean> {
  if (policy.weakChannelAction !== 'block' || action !== 'decrease') return false;
  const rows = await getDatabase().all<Array<{ action: string }>>(
    `SELECT action FROM trading_channel_risk_evaluations
     WHERE channel_id = ? ORDER BY week_ended_at DESC LIMIT ?`,
    [policy.channelId, policy.weakWeeksBeforeBlock - 1],
  );
  return rows.length === policy.weakWeeksBeforeBlock - 1
    && rows.every(row => row.action === 'decrease' || row.action === 'block');
}

async function evaluatePolicy(
  policy: ChannelRiskPolicy,
  request: CapitalRequest,
): Promise<ChannelRiskEvaluation> {
  const now = request.now, weekEndedAt = request.until;
  const weekStartedAt = weekEndedAt - policy.lookbackWeeks * WEEK_MS;
  const existing = await getDatabase().get<any>(
    `SELECT * FROM trading_channel_risk_evaluations
     WHERE channel_id = ? AND policy_version = ? AND week_started_at = ?`,
    [policy.channelId, policy.policyVersion, weekStartedAt],
  );
  if (existing) { await assertCachedEvidence(existing, request); return evaluationFromRow(existing); }
  const evidence = await collectChannelEvidence(request);
  const { performance, capital } = evidence.source, equity = capital.equity;
  let suggested = recommendation(policy, { closedTrades: performance.closedTrades, realizedPnlValue: performance.realizedPnlValue!, equity });
  if (await shouldBlockWeakChannel(policy, suggested.action)) {
    suggested = { ...suggested, action: 'block', reason: `${policy.weakWeeksBeforeBlock} consecutive weak evaluations.` };
  }
  let appliedTier = policy.currentTier;
  let blocked = policy.blocked;
  let blockReason = policy.blockReason;
  if (policy.mode === 'automatic') {
    appliedTier = suggested.tier;
    if (suggested.action === 'block' || suggested.uncertain) {
      blocked = true;
      blockReason = suggested.reason;
    }
  }
  const evaluation: ChannelRiskEvaluation = {
    id: randomUUID(),
    channelId: policy.channelId,
    policyVersion: policy.policyVersion,
    weekStartedAt,
    weekEndedAt,
    closedTrades: performance.closedTrades,
    wins: performance.wins,
    losses: performance.losses,
    realizedPnl: performance.realizedPnl,
    realizedPnlValue: performance.realizedPnlValue,
    startingEquity: equity,
    returnPercent: evidence.percent.value?.decimal ?? null,
    returnPercentValue: evidence.percent.value,
    returnPercentReason: evidence.percent.reason,
    reportingCurrency: capital.reportingCurrency,
    sourceHash: evidence.hash,
    invalidatedAt: null,
    invalidationReason: null,
    previousTier: policy.currentTier,
    recommendedTier: suggested.tier,
    appliedTier,
    action: suggested.action,
    reason: policy.mode === 'shadow' ? `Shadow only: ${suggested.reason}` : suggested.reason,
    createdAt: now,
  };
  await withDatabaseTransaction(async database => {
    await database.run(
      `INSERT INTO trading_channel_risk_evaluations (
         id, channel_id, policy_version, week_started_at, week_ended_at,
         closed_trades, wins, losses, realized_pnl, starting_equity, return_percent,
         previous_tier, recommended_tier, applied_tier, action, reason, created_at,
         realized_pnl_value_json,return_percent_value_json,reporting_currency,source_hash,source_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        evaluation.id, evaluation.channelId, evaluation.policyVersion,
        evaluation.weekStartedAt, evaluation.weekEndedAt, evaluation.closedTrades,
        evaluation.wins, evaluation.losses, evaluation.realizedPnl, evaluation.startingEquity,
        evaluation.returnPercent, evaluation.previousTier, evaluation.recommendedTier,
        evaluation.appliedTier, evaluation.action, evaluation.reason, evaluation.createdAt,
        JSON.stringify(evaluation.realizedPnlValue), evaluation.returnPercentValue ? JSON.stringify(evaluation.returnPercentValue) : null,
        evaluation.reportingCurrency, evidence.hash, evidence.json,
      ],
    );
    if (policy.mode === 'automatic') {
      await database.run(
        `UPDATE trading_channel_risk_policies
         SET current_tier = ?, blocked = ?, block_reason = ?, updated_at = ?
         WHERE channel_id = ? AND policy_version = ?`,
        [appliedTier, blocked ? 1 : 0, blockReason, now, policy.channelId, policy.policyVersion],
      );
    }
  });
  return evaluation;
}

export async function resolveEffectiveChannelRisk(input: {
  channelId: string;
  strategy: StrategyConfiguration;
  currentEquity: string;
  accountId?: string;
  reportingCurrency?: string;
  now?: number;
}): Promise<{ riskPercent: string; blocked: boolean; reason: string; policy: ChannelRiskPolicy | null }> {
  const row = await getDatabase().get<any>(
    'SELECT * FROM trading_channel_risk_policies WHERE channel_id = ?',
    [identifier(input.channelId)],
  );
  if (!row) {
    return {
      riskPercent: input.strategy.sizing.riskPerTradePercent,
      blocked: false,
      reason: 'No channel policy; strategy baseline applies.',
      policy: null,
    };
  }
  let policy = policyFromRow(row);
  if (policy.blocked || policy.manuallyBlocked) {
    return {
      riskPercent: policy.tiers[policy.currentTier]!.riskPercent,
      blocked: true,
      reason: policy.blockReason || 'Channel is blocked by its risk policy.',
      policy,
    };
  }
  let warning: string | null = null;
  if (policy.mode !== 'fixed' && policy.lockedTier === null) {
    warning = await evaluateChannelPolicySafely(policy, input);
    policy = policyFromRow(await getDatabase().get(
      'SELECT * FROM trading_channel_risk_policies WHERE channel_id = ?',
      [policy.channelId],
    ));
  }
  if (policy.blocked || policy.manuallyBlocked) {
    return {
      riskPercent: policy.tiers[policy.currentTier]!.riskPercent,
      blocked: true,
      reason: policy.blockReason || 'Channel is blocked by its risk policy.',
      policy,
    };
  }
  const tier = policy.lockedTier ?? policy.currentTier;
  const riskPercent = policy.mode === 'shadow' || policy.mode === 'fixed'
    ? input.strategy.sizing.riskPerTradePercent
    : policy.tiers[tier]!.riskPercent;
  return { riskPercent, blocked: false, reason: warning ?? `Channel policy ${policy.mode} tier ${tier}.`, policy };
}

async function evaluateChannelPolicySafely(policy: ChannelRiskPolicy, input: { channelId: string; currentEquity: string;
  accountId?: string; reportingCurrency?: string; now?: number }): Promise<string | null> {
  const now = input.now ?? Date.now(), until = currentWeekStart(now);
  const request = { ...input, now, until, since: until - policy.lookbackWeeks * WEEK_MS, performanceAccountId: null };
  try {
    const evaluation = await withDatabaseTransaction(() => evaluatePolicy(policy, request));
    return evaluation.reason.includes('RISK_PRECISION_UNCERTAIN') ? evaluation.reason : null;
  } catch (error) { return invalidateChannelEvaluation(policy, request, error); }
}

function failureReason(error: unknown): string {
  const reason = error instanceof Error ? error.message : 'Unproved monetary history.';
  return (reason.startsWith('Adaptive risk is unresolved:') ? reason : `Adaptive risk is unresolved: ${reason}`).slice(0, 2048);
}

async function invalidateChannelEvaluation(policy: ChannelRiskPolicy, request: CapitalRequest, error: unknown): Promise<string> {
  const reason = failureReason(error);
  await withDatabaseTransaction(async db => {
    await db.run(`UPDATE trading_channel_risk_evaluations SET invalidated_at=COALESCE(invalidated_at,?),
      invalidation_reason=COALESCE(invalidation_reason,?) WHERE channel_id=? AND policy_version=? AND week_started_at=?`,
    [request.now, reason, policy.channelId, policy.policyVersion, request.since]);
    if (policy.mode === 'automatic') await db.run(`UPDATE trading_channel_risk_policies SET blocked=1,block_reason=?,updated_at=?
      WHERE channel_id=? AND policy_version=?`, [reason, request.now, policy.channelId, policy.policyVersion]);
  });
  return policy.mode === 'shadow' ? `Shadow only: ${reason}` : reason;
}

type WorkflowAdaptiveRiskConfiguration = {
  enabled: boolean;
  mode: ChannelRiskMode;
  tiers: ChannelRiskTier[];
  startingTier: number;
  lockedTier: number | null;
  lookbackWeeks: number;
  minimumClosedTrades: number;
  lossThresholdPercent: string;
  profitThresholdPercent: string;
  weakChannelAction: WeakChannelAction;
  weakWeeksBeforeBlock: number;
  manuallyBlocked: boolean;
};

function workflowPolicyHash(configuration: WorkflowAdaptiveRiskConfiguration): string {
  return createHash('sha256').update(JSON.stringify(configuration)).digest('hex');
}

type WorkflowAdaptiveRiskInput = {
  channelId: string;
  accountId: string;
  adaptiveResourceVersionId: string;
  configuration: WorkflowAdaptiveRiskConfiguration;
  strategy: StrategyConfiguration;
  currentEquity: string;
  reportingCurrency?: string;
  now?: number;
};

async function workflowAdaptiveResourceId(versionId: string): Promise<string> {
  const resource = await getDatabase().get<{ resource_id: string }>(
    'SELECT resource_id FROM workflow_resource_versions WHERE id = ? AND kind = ?',
    [versionId, 'adaptive_risk'],
  );
  if (!resource) throw new Error('Adaptive workflow resource is unavailable.');
  return resource.resource_id;
}

async function loadWorkflowRiskState(input: {
  request: WorkflowAdaptiveRiskInput;
  resourceId: string;
  stateKey: string;
  policyHash: string;
  now: number;
}): Promise<any> {
  const { request, resourceId, stateKey, policyHash, now } = input;
  let state = await getDatabase().get<any>(
    'SELECT * FROM workflow_adaptive_risk_state WHERE state_key = ?', [stateKey],
  );
  if (!state) {
    await getDatabase().run(
      `INSERT INTO workflow_adaptive_risk_state (
         state_key, channel_id, account_id, resource_id, current_tier, locked_tier,
         blocked, block_reason, policy_sha256, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [stateKey, request.channelId, request.accountId, resourceId,
        request.configuration.startingTier, request.configuration.lockedTier,
        request.configuration.manuallyBlocked ? 1 : 0,
        request.configuration.manuallyBlocked ? 'Blocked by workflow policy.' : null,
        policyHash, now],
    );
    state = await getDatabase().get<any>('SELECT * FROM workflow_adaptive_risk_state WHERE state_key = ?', [stateKey]);
  } else if (state.policy_sha256 !== policyHash) {
    const nextTier = Math.min(Number(state.current_tier), request.configuration.tiers.length - 1);
    await getDatabase().run(
      `UPDATE workflow_adaptive_risk_state
       SET current_tier = ?, locked_tier = ?, blocked = ?, block_reason = ?, policy_sha256 = ?, updated_at = ?
       WHERE state_key = ?`,
      [nextTier, request.configuration.lockedTier, request.configuration.manuallyBlocked ? 1 : 0,
        request.configuration.manuallyBlocked ? 'Blocked by workflow policy.' : null,
        policyHash, now, stateKey],
    );
    state = await getDatabase().get<any>('SELECT * FROM workflow_adaptive_risk_state WHERE state_key = ?', [stateKey]);
  }
  return state;
}

function syntheticWorkflowPolicy(input: WorkflowAdaptiveRiskInput, currentTier: number, now: number): ChannelRiskPolicy {
  return {
    channelId: input.channelId,
    mode: input.configuration.mode,
    tiers: input.configuration.tiers,
    currentTier,
    lookbackWeeks: input.configuration.lookbackWeeks,
    minimumClosedTrades: input.configuration.minimumClosedTrades,
    lossThresholdPercent: input.configuration.lossThresholdPercent,
    profitThresholdPercent: input.configuration.profitThresholdPercent,
    weakChannelAction: input.configuration.weakChannelAction,
    weakWeeksBeforeBlock: input.configuration.weakWeeksBeforeBlock,
    manuallyBlocked: input.configuration.manuallyBlocked,
    blocked: false,
    blockReason: null,
    lockedTier: input.configuration.lockedTier,
    policyVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
}

async function applyWorkflowWeakStreak(
  stateKey: string,
  configuration: WorkflowAdaptiveRiskConfiguration,
  suggested: ReturnType<typeof recommendation>,
): Promise<ReturnType<typeof recommendation>> {
  if (configuration.weakChannelAction !== 'block' || suggested.action !== 'decrease') return suggested;
  const previous = await getDatabase().all<Array<{ action: string }>>(
    `SELECT action FROM workflow_adaptive_risk_evaluations
     WHERE state_key = ? ORDER BY week_ended_at DESC LIMIT ?`,
    [stateKey, configuration.weakWeeksBeforeBlock - 1],
  );
  const completesStreak = previous.length === configuration.weakWeeksBeforeBlock - 1
    && previous.every(row => row.action === 'decrease' || row.action === 'block');
  if (!completesStreak) return suggested;
  return { ...suggested, action: 'block', reason: `${configuration.weakWeeksBeforeBlock} consecutive weak evaluations.` };
}

async function persistWorkflowRiskEvaluation(input: {
  stateKey: string;
  policyHash: string;
  weekStartedAt: number;
  weekEndedAt: number;
  evidence: Awaited<ReturnType<typeof collectChannelEvidence>>;
  currentTier: number;
  suggested: ReturnType<typeof recommendation>;
  appliedTier: number;
  blocked: boolean;
  mode: ChannelRiskMode;
  now: number;
}): Promise<void> {
  const value = input;
  const { performance, capital } = value.evidence.source;
  await withDatabaseTransaction(async database => {
    await database.run(
      `INSERT INTO workflow_adaptive_risk_evaluations (
         id, state_key, policy_sha256, week_started_at, week_ended_at, closed_trades,
         wins, losses, realized_pnl, starting_equity, return_percent, previous_tier,
         recommended_tier, applied_tier, action, reason, created_at,
         realized_pnl_value_json,return_percent_value_json,reporting_currency,source_hash,source_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), value.stateKey, value.policyHash, value.weekStartedAt, value.weekEndedAt,
        performance.closedTrades, performance.wins, performance.losses,
        performance.realizedPnl, capital.equity, value.evidence.percent.value?.decimal ?? null, value.currentTier,
        value.suggested.tier, value.appliedTier, value.suggested.action,
        value.mode === 'shadow' ? `Shadow only: ${value.suggested.reason}` : value.suggested.reason, value.now,
        JSON.stringify(performance.realizedPnlValue), value.evidence.percent.value ? JSON.stringify(value.evidence.percent.value) : null,
        capital.reportingCurrency, value.evidence.hash, value.evidence.json],
    );
    if (value.mode === 'automatic') {
      await database.run(
        `UPDATE workflow_adaptive_risk_state
         SET current_tier = ?, blocked = ?, block_reason = ?, updated_at = ? WHERE state_key = ?`,
        [value.appliedTier, value.blocked ? 1 : 0, value.blocked ? value.suggested.reason : null, value.now, value.stateKey],
      );
    }
  });
}

async function evaluateWorkflowRiskState(input: {
  request: WorkflowAdaptiveRiskInput;
  state: any;
  stateKey: string;
  policyHash: string;
  now: number;
}): Promise<any> {
  const { request, state, stateKey, policyHash, now } = input;
  if (request.configuration.mode === 'fixed' || request.configuration.lockedTier !== null || request.configuration.manuallyBlocked) return state;
  const currentTier = Math.min(Number(state.current_tier), request.configuration.tiers.length - 1);
  const weekEndedAt = currentWeekStart(now);
  const weekStartedAt = weekEndedAt - request.configuration.lookbackWeeks * WEEK_MS;
  const existing = await getDatabase().get(
    `SELECT * FROM workflow_adaptive_risk_evaluations
     WHERE state_key = ? AND policy_sha256 = ? AND week_started_at = ?`,
    [stateKey, policyHash, weekStartedAt],
  );
  const capitalRequest = { ...request, now, since: weekStartedAt, until: weekEndedAt, performanceAccountId: request.accountId };
  if (existing) {
    await assertCachedEvidence(existing, capitalRequest);
    return { ...state, warning: String((existing as any).reason).includes('RISK_PRECISION_UNCERTAIN') ? (existing as any).reason : undefined };
  }
  const evidence = await collectChannelEvidence(capitalRequest);
  const { performance, capital } = evidence.source;
  const policy = syntheticWorkflowPolicy(request, currentTier, now);
  const initialSuggestion = recommendation(policy, { closedTrades: performance.closedTrades, realizedPnlValue: performance.realizedPnlValue!, equity: capital.equity });
  const suggested = await applyWorkflowWeakStreak(stateKey, request.configuration, initialSuggestion);
  const appliedTier = request.configuration.mode === 'automatic' ? suggested.tier : currentTier;
  const blocked = request.configuration.mode === 'automatic' && (suggested.action === 'block' || suggested.uncertain === true);
  await persistWorkflowRiskEvaluation({
    stateKey, policyHash, weekStartedAt, weekEndedAt, evidence,
    currentTier, suggested, appliedTier, blocked, mode: request.configuration.mode, now,
  });
  return {
    ...state,
    current_tier: appliedTier,
    blocked: blocked ? 1 : 0,
    block_reason: blocked ? suggested.reason : null,
    warning: suggested.uncertain ? `${request.configuration.mode === 'shadow' ? 'Shadow only: ' : ''}${suggested.reason}` : undefined,
  };
}

function resolvedWorkflowRisk(input: WorkflowAdaptiveRiskInput, state: any): {
  riskPercent: string; blocked: boolean; reason: string;
} {
  if (input.configuration.manuallyBlocked || Number(state.blocked) === 1) {
    return {
      riskPercent: input.strategy.sizing.riskPerTradePercent,
      blocked: true,
      reason: state.block_reason || 'Workflow adaptive-risk path is blocked.',
    };
  }
  const currentTier = Math.min(Number(state.current_tier), input.configuration.tiers.length - 1);
  const selectedTier = input.configuration.lockedTier ?? currentTier;
  const tierRisk = input.configuration.mode === 'automatic'
    ? input.configuration.tiers[selectedTier]!.riskPercent
    : input.strategy.sizing.riskPerTradePercent;
  const maximum = input.strategy.sizing.maxAdaptiveRiskPercent || input.strategy.sizing.riskPerTradePercent;
  const riskPercent = compareDecimal(tierRisk, maximum) > 0 ? maximum : tierRisk;
  return {
    riskPercent,
    blocked: false,
    reason: state.warning ?? `Workflow adaptive-risk ${input.configuration.mode} tier ${selectedTier} for account ${input.accountId}.`,
  };
}

export async function resolveWorkflowAdaptiveRisk(input: WorkflowAdaptiveRiskInput): Promise<{
  riskPercent: string; blocked: boolean; reason: string;
}> {
  const now = input.now ?? Date.now();
  const resourceId = await workflowAdaptiveResourceId(input.adaptiveResourceVersionId);
  const policyHash = workflowPolicyHash(input.configuration);
  const stateKey = createHash('sha256').update(`${input.channelId}\0${input.accountId}\0${resourceId}`).digest('hex');
  const initialState = await loadWorkflowRiskState({ request: input, resourceId, stateKey, policyHash, now });
  if (Number(initialState.blocked) === 1 && String(initialState.block_reason).startsWith('Adaptive risk is unresolved:')) {
    return resolvedWorkflowRisk(input, initialState);
  }
  let state;
  try { state = await withDatabaseTransaction(() => evaluateWorkflowRiskState({ request: input, state: initialState, stateKey, policyHash, now })); }
  catch (error) { state = await invalidateWorkflowEvaluation(input, initialState, stateKey, policyHash, now, error); }
  return resolvedWorkflowRisk(input, state);
}

async function invalidateWorkflowEvaluation(request: WorkflowAdaptiveRiskInput, state: any, stateKey: string,
  policyHash: string, now: number, error: unknown) {
  const reason = failureReason(error), blocked = request.configuration.mode === 'automatic';
  await withDatabaseTransaction(async db => {
    await db.run(`UPDATE workflow_adaptive_risk_evaluations SET invalidated_at=COALESCE(invalidated_at,?),
      invalidation_reason=COALESCE(invalidation_reason,?) WHERE state_key=? AND policy_sha256=? AND week_started_at=?`,
    [now, reason, stateKey, policyHash, currentWeekStart(now) - request.configuration.lookbackWeeks * WEEK_MS]);
    if (blocked) await db.run('UPDATE workflow_adaptive_risk_state SET blocked=1,block_reason=?,updated_at=? WHERE state_key=? AND policy_sha256=?',
      [reason, now, stateKey, policyHash]);
  });
  return { ...state, blocked: blocked ? 1 : state.blocked, block_reason: blocked ? reason : state.block_reason,
    warning: blocked ? reason : `Shadow only: ${reason}` };
}

interface WorkflowRiskStateAnalytics {
  stateKey: string; channelId: string; accountId: string; resourceId: string; resourceName: string;
  currentTier: number; lockedTier: number | null; blocked: boolean; blockReason: string | null;
  policySha256: string; updatedAt: number;
}

interface WorkflowRiskEvaluationAnalytics {
  id: string; stateKey: string; channelId: string; accountId: string; resourceId: string; resourceName: string;
  weekStartedAt: number; weekEndedAt: number; closedTrades: number; wins: number; losses: number;
  realizedPnl: string | null; realizedPnlValue: MoneyValue | null; startingEquity: string; returnPercent: string | null;
  returnPercentValue: MoneyValue | null; returnPercentReason: string | null; reportingCurrency: string | null;
  sourceHash: string | null; invalidatedAt: number | null; invalidationReason: string | null; previousTier: number;
  recommendedTier: number; appliedTier: number; action: string; reason: string; createdAt: number;
}

function workflowRiskStateAnalytics(row: any): WorkflowRiskStateAnalytics {
  return {
    stateKey: String(row.state_key), channelId: String(row.channel_id), accountId: String(row.account_id),
    resourceId: String(row.resource_id), resourceName: String(row.resource_name), currentTier: Number(row.current_tier),
    lockedTier: row.locked_tier === null ? null : Number(row.locked_tier), blocked: Number(row.blocked) === 1,
    blockReason: row.block_reason === null ? null : String(row.block_reason), policySha256: String(row.policy_sha256),
    updatedAt: Number(row.updated_at),
  };
}

function workflowRiskEvaluationAnalytics(row: any): WorkflowRiskEvaluationAnalytics {
  return {
    id: String(row.id), stateKey: String(row.state_key), channelId: String(row.channel_id),
    accountId: String(row.account_id), resourceId: String(row.resource_id), resourceName: String(row.resource_name),
    weekStartedAt: Number(row.week_started_at), weekEndedAt: Number(row.week_ended_at),
    closedTrades: Number(row.closed_trades), wins: Number(row.wins), losses: Number(row.losses),
    ...evaluationMoneyFields(row), startingEquity: decimal(row.starting_equity, { positive: true }), previousTier: Number(row.previous_tier),
    recommendedTier: Number(row.recommended_tier), appliedTier: Number(row.applied_tier), action: String(row.action),
    reason: String(row.reason), createdAt: Number(row.created_at),
  };
}

export async function getWorkflowAdaptiveRiskAnalytics(limit = 200): Promise<{
  states: WorkflowRiskStateAnalytics[]; evaluations: WorkflowRiskEvaluationAnalytics[];
}> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error('Workflow adaptive-risk analytics limit must be between 1 and 1000.');
  }
  const [stateRows, evaluationRows] = await Promise.all([
    getDatabase().all<any[]>(
      `SELECT state.*,
              COALESCE((
                SELECT resource.name FROM workflow_resource_versions AS resource
                WHERE resource.resource_id = state.resource_id
                ORDER BY resource.version DESC LIMIT 1
              ), state.resource_id) AS resource_name
       FROM workflow_adaptive_risk_state AS state
       ORDER BY state.updated_at DESC LIMIT ?`,
      [limit],
    ),
    getDatabase().all<any[]>(
      `SELECT evaluation.*, state.channel_id, state.account_id, state.resource_id,
              COALESCE((
                SELECT resource.name FROM workflow_resource_versions AS resource
                WHERE resource.resource_id = state.resource_id
                ORDER BY resource.version DESC LIMIT 1
              ), state.resource_id) AS resource_name
       FROM workflow_adaptive_risk_evaluations AS evaluation
       JOIN workflow_adaptive_risk_state AS state ON state.state_key = evaluation.state_key
       ORDER BY evaluation.week_ended_at DESC, evaluation.created_at DESC LIMIT ?`,
      [limit],
    ),
  ]);
  return {
    states: stateRows.map(workflowRiskStateAnalytics),
    evaluations: evaluationRows.map(workflowRiskEvaluationAnalytics),
  };
}
