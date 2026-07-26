import { randomUUID } from 'node:crypto';
import { getDatabase, withDatabaseTransaction } from './db.js';
import {
  addSignedDecimal,
  compareDecimal,
  decimal,
  divideDecimal,
  multiplyDecimal,
  signedDecimal,
} from './trading_decimal.js';
import { recordTradingExecutionEvent } from './trading_telemetry.js';
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
    realizedPnl: signedDecimal(String(row.realized_pnl)),
    startingEquity: decimal(String(row.starting_equity), { positive: true }),
    returnPercent: signedDecimal(String(row.return_percent)),
    previousTier: Number(row.previous_tier),
    recommendedTier: Number(row.recommended_tier),
    appliedTier: Number(row.applied_tier),
    action: row.action,
    reason: String(row.reason),
    createdAt: Number(row.created_at),
  };
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
  const blocked = manuallyBlocked ? true : false;
  const blockReason = manuallyBlocked ? 'Manually blocked by operator' : null;
  return {
    channelId,
    mode: input.mode,
    tiers,
    currentTier,
    lookbackWeeks: integer(input.lookbackWeeks, 'Risk lookback weeks', 1, 12),
    minimumClosedTrades: integer(input.minimumClosedTrades, 'Minimum closed trades', 1, 1_000),
    lossThresholdPercent: decimal(String(input.lossThresholdPercent), { positive: true, max: '100' }),
    profitThresholdPercent: decimal(String(input.profitThresholdPercent), { positive: true, max: '100' }),
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

function signedPercent(numerator: string, denominator: string): string {
  const normalized = signedDecimal(numerator);
  const negative = normalized.startsWith('-');
  const magnitude = negative ? normalized.slice(1) : normalized;
  const percent = divideDecimal(multiplyDecimal(magnitude, '100'), denominator);
  return negative && percent !== '0' ? `-${percent}` : percent;
}

async function closedPerformance(channelId: string, since: number, until: number): Promise<{
  closedTrades: number;
  wins: number;
  losses: number;
  realizedPnl: string;
}> {
  const rows = await getDatabase().all<Array<{ realized_pnl: string }>>(
    `SELECT realized_pnl FROM trading_positions
     WHERE channel_id = ? AND status = 'closed' AND closed_at >= ? AND closed_at < ?
     ORDER BY closed_at`,
    [channelId, since, until],
  );
  let realizedPnl = '0';
  let wins = 0;
  let losses = 0;
  for (const row of rows) {
    const pnl = signedDecimal(row.realized_pnl);
    realizedPnl = addSignedDecimal(realizedPnl, pnl);
    if (pnl.startsWith('-')) losses += 1;
    else if (pnl !== '0') wins += 1;
  }
  return { closedTrades: rows.length, wins, losses, realizedPnl };
}

async function startingEquity(channelId: string, since: number, fallback: string): Promise<string> {
  const row = await getDatabase().get<{ equity: string }>(
    `SELECT snapshot.equity
     FROM trading_routes AS route
     JOIN trading_equity_snapshots AS snapshot ON snapshot.account_id = route.account_id
     WHERE route.channel_id = ? AND snapshot.observed_at >= ?
     ORDER BY snapshot.observed_at LIMIT 1`,
    [channelId, since],
  );
  return row ? decimal(row.equity, { positive: true }) : decimal(fallback, { positive: true });
}

function recommendation(policy: ChannelRiskPolicy, performance: {
  closedTrades: number;
  realizedPnl: string;
  returnPercent: string;
}): { tier: number; action: ChannelRiskEvaluation['action']; reason: string } {
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
  if (performance.realizedPnl.startsWith('-')) {
    const magnitude = performance.returnPercent.slice(1);
    if (compareDecimal(magnitude, policy.lossThresholdPercent) >= 0) {
      return {
        tier: Math.max(0, policy.currentTier - 1),
        action: 'decrease',
        reason: `Loss threshold ${policy.lossThresholdPercent}% reached.`,
      };
    }
  } else if (compareDecimal(performance.returnPercent, policy.profitThresholdPercent) >= 0) {
    return {
      tier: Math.min(policy.tiers.length - 1, policy.currentTier + 1),
      action: 'increase',
      reason: `Profit threshold ${policy.profitThresholdPercent}% reached.`,
    };
  }
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
  currentEquity: string,
  now: number,
): Promise<ChannelRiskEvaluation> {
  const weekEndedAt = currentWeekStart(now);
  const weekStartedAt = weekEndedAt - policy.lookbackWeeks * WEEK_MS;
  const existing = await getDatabase().get<any>(
    `SELECT * FROM trading_channel_risk_evaluations
     WHERE channel_id = ? AND policy_version = ? AND week_started_at = ?`,
    [policy.channelId, policy.policyVersion, weekStartedAt],
  );
  if (existing) return evaluationFromRow(existing);
  const performance = await closedPerformance(policy.channelId, weekStartedAt, weekEndedAt);
  const equity = await startingEquity(policy.channelId, weekStartedAt, currentEquity);
  const returnPercent = signedPercent(performance.realizedPnl, equity);
  let suggested = recommendation(policy, { ...performance, returnPercent });
  if (await shouldBlockWeakChannel(policy, suggested.action)) {
    suggested = { ...suggested, action: 'block', reason: `${policy.weakWeeksBeforeBlock} consecutive weak evaluations.` };
  }
  let appliedTier = policy.currentTier;
  let blocked = policy.blocked;
  let blockReason = policy.blockReason;
  if (policy.mode === 'automatic') {
    appliedTier = suggested.tier;
    if (suggested.action === 'block') {
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
    startingEquity: equity,
    returnPercent,
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
         previous_tier, recommended_tier, applied_tier, action, reason, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        evaluation.id, evaluation.channelId, evaluation.policyVersion,
        evaluation.weekStartedAt, evaluation.weekEndedAt, evaluation.closedTrades,
        evaluation.wins, evaluation.losses, evaluation.realizedPnl, evaluation.startingEquity,
        evaluation.returnPercent, evaluation.previousTier, evaluation.recommendedTier,
        evaluation.appliedTier, evaluation.action, evaluation.reason, evaluation.createdAt,
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
  if (policy.mode !== 'fixed') {
    await evaluatePolicy(policy, input.currentEquity, input.now ?? Date.now());
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
  return { riskPercent, blocked: false, reason: `Channel policy ${policy.mode} tier ${tier}.`, policy };
}
