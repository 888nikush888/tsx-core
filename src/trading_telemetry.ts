import { randomUUID } from 'node:crypto';
import { getDatabase } from './db.js';
import { decimal, signedDecimal } from './trading_decimal.js';
import type { TradingAccountSnapshot, TradingEquityPoint } from './trading_types.js';
import { tradingExchangeId } from './trading_types.js';

export const TRADING_EVENT_TYPES = [
  'signal_received',
  'signal_validated',
  'intent_created',
  'submit_started',
  'exchange_ack',
  'first_fill',
  'fully_filled',
  'position_closed',
  'kill_switch_activated',
  'contract_changed',
  'risk_policy_changed',
] as const;

export type TradingEventType = typeof TRADING_EVENT_TYPES[number];

function identifier(value: unknown, label: string, maximum = 128): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum || /[\r\n\0]/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value.trim();
}

export async function recordTradingEquitySnapshot(
  accountId: string,
  snapshot: TradingAccountSnapshot,
  observedAt = Date.now(),
): Promise<void> {
  const id = identifier(accountId, 'Trading account identifier', 64)!;
  if (!Number.isSafeInteger(observedAt) || observedAt <= 0) throw new Error('Equity observation timestamp is invalid.');
  const bucketMinute = Math.floor(observedAt / 60_000);
  await getDatabase().run(
    `INSERT INTO trading_equity_snapshots (
       id, account_id, equity, available_balance, unrealized_pnl, margin_used, observed_at, bucket_minute
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, bucket_minute) DO UPDATE SET
       equity = excluded.equity,
       available_balance = excluded.available_balance,
       unrealized_pnl = excluded.unrealized_pnl,
       margin_used = excluded.margin_used,
       observed_at = excluded.observed_at`,
    [
      randomUUID(),
      id,
      decimal(snapshot.equity, { positive: true }),
      decimal(snapshot.availableBalance),
      signedDecimal(snapshot.unrealizedPnl),
      decimal(snapshot.marginUsed),
      observedAt,
      bucketMinute,
    ],
  );
}

export async function listTradingEquityPoints(
  accountId?: string,
  since = Date.now() - 90 * 24 * 60 * 60 * 1_000,
  limit = 20_000,
): Promise<TradingEquityPoint[]> {
  if (!Number.isSafeInteger(since) || since < 0) throw new Error('Equity history start is invalid.');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000) throw new Error('Equity history limit is invalid.');
  const parameters: unknown[] = [since];
  let accountFilter = '';
  if (accountId) {
    accountFilter = ' AND account_id = ?';
    parameters.push(identifier(accountId, 'Trading account identifier', 64));
  }
  parameters.push(limit);
  const rows = await getDatabase().all<any[]>(
    `SELECT account_id AS accountId, equity, available_balance AS availableBalance,
            unrealized_pnl AS unrealizedPnl, margin_used AS marginUsed, observed_at AS observedAt
     FROM trading_equity_snapshots
     WHERE observed_at >= ?${accountFilter}
     ORDER BY observed_at LIMIT ?`,
    parameters,
  );
  return rows.map(row => ({
    accountId: String(row.accountId),
    equity: decimal(String(row.equity), { positive: true }),
    availableBalance: decimal(String(row.availableBalance)),
    unrealizedPnl: signedDecimal(String(row.unrealizedPnl)),
    marginUsed: decimal(String(row.marginUsed)),
    observedAt: Number(row.observedAt),
  }));
}

export async function recordTradingExecutionEvent(input: {
  eventType: TradingEventType;
  occurredAt?: number;
  intentId?: string | null;
  channelId?: string | null;
  accountId?: string | null;
  exchange?: string | null;
  mode?: string | null;
  details?: Record<string, unknown>;
  correlationId?: string | null;
}): Promise<boolean> {
  if (!TRADING_EVENT_TYPES.includes(input.eventType)) throw new Error('Trading execution event type is invalid.');
  const occurredAt = input.occurredAt ?? Date.now();
  if (!Number.isSafeInteger(occurredAt) || occurredAt <= 0) throw new Error('Trading event timestamp is invalid.');
  const details = input.details ?? {};
  const serialized = JSON.stringify(details);
  if (serialized.length > 16 * 1024) throw new Error('Trading event details exceed 16 KiB.');
  const exchange = input.exchange === undefined || input.exchange === null || input.exchange === ''
    ? null
    : tradingExchangeId(input.exchange);
  const result = await getDatabase().run(
    `INSERT OR IGNORE INTO trading_execution_events (
       id, intent_id, channel_id, account_id, exchange, mode, event_type,
       occurred_at, details_json, correlation_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      identifier(input.intentId, 'Trading intent identifier'),
      identifier(input.channelId, 'Trading channel identifier'),
      identifier(input.accountId, 'Trading account identifier', 64),
      exchange,
      identifier(input.mode, 'Trading account mode', 32),
      input.eventType,
      occurredAt,
      serialized,
      identifier(input.correlationId, 'Trading correlation identifier'),
    ],
  );
  return Number(result.changes || 0) === 1;
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index]!;
}

type ExecutionEventRow = {
  intentId: string | null;
  channelId: string | null;
  accountId: string | null;
  exchange: string | null;
  mode: string | null;
  eventType: TradingEventType;
  occurredAt: number;
  detailsJson: string;
};

function eventTimeline(rows: ExecutionEventRow[]): {
  funnel: Record<TradingEventType, number>;
  byIntent: Map<string, Map<TradingEventType, number>>;
} {
  const funnel = Object.fromEntries(TRADING_EVENT_TYPES.map(type => [type, 0])) as Record<TradingEventType, number>;
  const byIntent = new Map<string, Map<TradingEventType, number>>();
  for (const row of rows) {
    funnel[row.eventType] += 1;
    if (!row.intentId) continue;
    const events = byIntent.get(row.intentId) ?? new Map<TradingEventType, number>();
    events.set(row.eventType, Number(row.occurredAt));
    addReceivedTimestamp(row, events);
    byIntent.set(row.intentId, events);
  }
  return { funnel, byIntent };
}

function addReceivedTimestamp(row: ExecutionEventRow, events: Map<TradingEventType, number>): void {
  if (row.eventType !== 'intent_created') return;
  try {
    const receivedAt = Number(JSON.parse(row.detailsJson).signalReceivedAt);
    if (Number.isSafeInteger(receivedAt) && receivedAt > 0) events.set('signal_received', receivedAt);
  } catch {
    // Invalid stored event details are surfaced in the recent event projection.
  }
}

function latencySummary(values: number[]) {
  return {
    count: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
  };
}

function executionLatencies(byIntent: Map<string, Map<TradingEventType, number>>) {
  const signalToSubmit: number[] = [];
  const signalToFirstFill: number[] = [];
  for (const events of byIntent.values()) {
    const received = events.get('signal_received') ?? events.get('intent_created');
    const submitted = events.get('submit_started');
    const firstFill = events.get('first_fill');
    if (received && submitted && submitted >= received) signalToSubmit.push(submitted - received);
    if (received && firstFill && firstFill >= received) signalToFirstFill.push(firstFill - received);
  }
  return {
    signalToSubmit: latencySummary(signalToSubmit),
    signalToFirstFill: latencySummary(signalToFirstFill),
  };
}

function recentExecutionEvent(row: ExecutionEventRow): Record<string, unknown> {
  return {
    intentId: row.intentId || null,
    channelId: row.channelId || null,
    accountId: row.accountId || null,
    exchange: row.exchange || null,
    mode: row.mode || null,
    eventType: row.eventType,
    occurredAt: Number(row.occurredAt),
    details: JSON.parse(row.detailsJson),
  };
}

export async function getTradingExecutionAnalytics(since = Date.now() - 30 * 24 * 60 * 60 * 1_000): Promise<{
  generatedAt: number;
  funnel: Record<TradingEventType, number>;
  latencyMs: {
    signalToSubmit: { count: number; p50: number | null; p95: number | null; p99: number | null };
    signalToFirstFill: { count: number; p50: number | null; p95: number | null; p99: number | null };
  };
  recent: Array<Record<string, unknown>>;
}> {
  const rows = await getDatabase().all<ExecutionEventRow[]>(
    `SELECT intent_id AS intentId, channel_id AS channelId, account_id AS accountId,
            exchange, mode, event_type AS eventType, occurred_at AS occurredAt, details_json AS detailsJson
     FROM trading_execution_events WHERE occurred_at >= ?
     ORDER BY occurred_at DESC LIMIT 20000`,
    [since],
  );
  const timeline = eventTimeline(rows);
  return {
    generatedAt: Date.now(),
    funnel: timeline.funnel,
    latencyMs: executionLatencies(timeline.byIntent),
    recent: rows.slice(0, 200).map(recentExecutionEvent),
  };
}

export interface TradingAnalyticsFilters {
  since: number;
  until: number;
  channelIds: string[];
  accountIds: string[];
  exchanges: string[];
  modes: string[];
  statuses: string[];
}

function analyticsTimestamp(row: any): number {
  const values = [row.occurredAt, row.closedAt, row.createdAt, row.filledAt];
  const selected = values.find(value => value !== undefined && value !== null);
  return Number(selected ?? 0);
}

function analyticsTimestampMatches(timestamp: number, filters: TradingAnalyticsFilters): boolean {
  if (timestamp <= 0) return true;
  if (timestamp < filters.since) return false;
  return timestamp <= filters.until;
}

function analyticsDimensionMatches(allowed: string[], value: unknown): boolean {
  if (allowed.length === 0) return true;
  return allowed.includes(String(value));
}

function analyticsRowMatches(row: any, filters: TradingAnalyticsFilters): boolean {
  const dimensions: Array<[string[], unknown]> = [
    [filters.channelIds, row.channelId],
    [filters.accountIds, row.accountId],
    [filters.exchanges, row.exchange],
    [filters.modes, row.mode],
    [filters.statuses, row.intentStatus ?? row.status ?? ''],
  ];
  return analyticsTimestampMatches(analyticsTimestamp(row), filters)
    && dimensions.every(([allowed, value]) => analyticsDimensionMatches(allowed, value));
}

async function filteredExecutionAnalytics(filters: TradingAnalyticsFilters): Promise<{
  generatedAt: number;
  funnel: Record<TradingEventType, number>;
  latencyMs: {
    signalToSubmit: { count: number; p50: number | null; p95: number | null; p99: number | null };
    signalToFirstFill: { count: number; p50: number | null; p95: number | null; p99: number | null };
  };
  recent: Array<Record<string, unknown>>;
}> {
  const rows = (await getDatabase().all<ExecutionEventRow[]>(
    `SELECT intent_id AS intentId, channel_id AS channelId, account_id AS accountId,
            exchange, mode, event_type AS eventType, occurred_at AS occurredAt, details_json AS detailsJson
     FROM trading_execution_events WHERE occurred_at >= ? AND occurred_at <= ?
     ORDER BY occurred_at DESC LIMIT 20000`,
    [filters.since, filters.until],
  )).filter(row => analyticsRowMatches(row, filters));
  const timeline = eventTimeline(rows);
  return {
    generatedAt: Date.now(),
    funnel: timeline.funnel,
    latencyMs: executionLatencies(timeline.byIntent),
    recent: rows.slice(0, 200).map(recentExecutionEvent),
  };
}

async function filteredFallbackAnalytics(filters: TradingAnalyticsFilters): Promise<{
  runs: number;
  candidates: number;
  selected: number;
  exhausted: number;
  stopped: number;
  unavailableCandidates: number;
  selectionRatePercent: number | null;
  exhaustionRatePercent: number | null;
  averageSelectedRank: number | null;
  byAccount: Array<Record<string, unknown>>;
}> {
  const rows = (await getDatabase().all<any[]>(
    `SELECT run.id AS runId, run.channel_id AS channelId, run.status AS fallbackStatus,
            run.current_rank AS currentRank, run.created_at AS createdAt,
            candidate.rank, candidate.status AS candidateStatus,
            candidate.account_id AS accountId, intent.status AS intentStatus,
            account.exchange, account.mode
     FROM trading_fallback_runs AS run
     JOIN trading_fallback_candidates AS candidate ON candidate.fallback_run_id = run.id
     JOIN trading_accounts AS account ON account.id = candidate.account_id
     LEFT JOIN trading_trade_intents AS intent ON intent.id = candidate.intent_id
     WHERE run.created_at >= ? AND run.created_at <= ?
     ORDER BY run.created_at, run.id, candidate.rank`,
    [filters.since, filters.until],
  )).filter(row => analyticsRowMatches(row, filters));
  const runs = new Map<string, any[]>();
  const accounts = new Map<string, {
    accountId: string;
    exchange: string;
    mode: string;
    attempts: number;
    unavailable: number;
    selected: number;
  }>();
  for (const row of rows) {
    runs.set(String(row.runId), [...(runs.get(String(row.runId)) ?? []), row]);
    const aggregate = accounts.get(String(row.accountId)) ?? {
      accountId: String(row.accountId), exchange: String(row.exchange), mode: String(row.mode),
      attempts: 0, unavailable: 0, selected: 0,
    };
    if (row.candidateStatus !== 'waiting' && row.candidateStatus !== 'stopped') aggregate.attempts += 1;
    if (row.candidateStatus === 'unavailable') aggregate.unavailable += 1;
    if (row.candidateStatus === 'selected') aggregate.selected += 1;
    accounts.set(aggregate.accountId, aggregate);
  }
  const selectedRuns = [...runs.values()].filter(candidates =>
    candidates.some(candidate => candidate.candidateStatus === 'selected'));
  const exhausted = [...runs.values()].filter(candidates => candidates[0]?.fallbackStatus === 'exhausted').length;
  const stopped = [...runs.values()].filter(candidates => candidates[0]?.fallbackStatus === 'stopped').length;
  const selectedRanks = selectedRuns.map(candidates =>
    Number(candidates.find(candidate => candidate.candidateStatus === 'selected')!.rank));
  const runCount = runs.size;
  return {
    runs: runCount,
    candidates: rows.length,
    selected: selectedRuns.length,
    exhausted,
    stopped,
    unavailableCandidates: rows.filter(row => row.candidateStatus === 'unavailable').length,
    selectionRatePercent: runCount > 0 ? selectedRuns.length / runCount * 100 : null,
    exhaustionRatePercent: runCount > 0 ? exhausted / runCount * 100 : null,
    averageSelectedRank: selectedRanks.length > 0
      ? selectedRanks.reduce((sum, rank) => sum + rank, 0) / selectedRanks.length
      : null,
    byAccount: [...accounts.values()].sort((left, right) => left.accountId.localeCompare(right.accountId)),
  };
}

function finite(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) throw new Error('Trading analytics produced a non-finite value.');
  return parsed;
}

type PerformanceAggregate = {
  id: string;
  trades: number;
  wins: number;
  losses: number;
  breakeven: number;
  pnl: number;
  grossWin: number;
  grossLoss: number;
  intents: number;
  completed: number;
  rejected: number;
  slippageWeighted: number;
  slippageWeight: number;
};

function emptyAggregate(id: string): PerformanceAggregate {
  return {
    id,
    trades: 0,
    wins: 0,
    losses: 0,
    breakeven: 0,
    pnl: 0,
    grossWin: 0,
    grossLoss: 0,
    intents: 0,
    completed: 0,
    rejected: 0,
    slippageWeighted: 0,
    slippageWeight: 0,
  };
}

function aggregate(map: Map<string, PerformanceAggregate>, key: string): PerformanceAggregate {
  const value = map.get(key) ?? emptyAggregate(key);
  map.set(key, value);
  return value;
}

function dimensionValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value.toString();
  return 'unknown';
}

function channelAggregate(map: Map<string, PerformanceAggregate>, id: unknown): PerformanceAggregate {
  return aggregate(map, dimensionValue(id));
}

function exchangeAggregate(
  map: Map<string, PerformanceAggregate>,
  name: unknown,
  mode: unknown,
): PerformanceAggregate {
  return aggregate(map, `${dimensionValue(name)}/${dimensionValue(mode)}`);
}

function aggregatePositions(rows: any[], channels: Map<string, PerformanceAggregate>): void {
  for (const row of rows) {
    const value = finite(row.realizedPnl);
    const target = channelAggregate(channels, row.channelId);
    target.trades += 1;
    target.pnl += value;
    if (value > 0) {
      target.wins += 1;
      target.grossWin += value;
    } else if (value < 0) {
      target.losses += 1;
      target.grossLoss += Math.abs(value);
    } else {
      target.breakeven += 1;
    }
  }
}

function aggregateIntents(
  rows: any[],
  channels: Map<string, PerformanceAggregate>,
  exchanges: Map<string, PerformanceAggregate>,
): void {
  for (const row of rows) {
    const targets = [
      channelAggregate(channels, row.channelId),
      exchangeAggregate(exchanges, row.exchange, row.mode),
    ];
    for (const target of targets) {
      target.intents += 1;
      if (row.status === 'completed') target.completed += 1;
      if (['blocked', 'failed', 'unknown'].includes(row.status)) target.rejected += 1;
    }
  }
}

function plannedFillPrice(row: any): number {
  const stored = finite(row.plannedPrice);
  if (stored > 0 || !row.planJson) return stored;
  try {
    return finite(JSON.parse(row.planJson).entryPrice);
  } catch {
    return 0;
  }
}

function aggregateFills(
  rows: any[],
  channels: Map<string, PerformanceAggregate>,
  exchanges: Map<string, PerformanceAggregate>,
): void {
  for (const row of rows) {
    const plannedPrice = plannedFillPrice(row);
    const fillPrice = finite(row.fillPrice);
    const quantity = finite(row.quantity);
    if (plannedPrice <= 0 || fillPrice <= 0 || quantity <= 0) continue;
    const notional = fillPrice * quantity;
    const slippageBps = Math.abs(fillPrice - plannedPrice) / plannedPrice * 10_000;
    const targets = [
      channelAggregate(channels, row.channelId),
      exchangeAggregate(exchanges, row.exchange, row.mode),
    ];
    for (const target of targets) {
      target.slippageWeighted += slippageBps * notional;
      target.slippageWeight += notional;
    }
  }
}

function presentedAggregate(value: PerformanceAggregate): Record<string, unknown> {
  return {
    id: value.id,
    closedTrades: value.trades,
    wins: value.wins,
    losses: value.losses,
    breakeven: value.breakeven,
    winRatePercent: value.wins + value.losses > 0 ? value.wins / (value.wins + value.losses) * 100 : null,
    payoffRatio: value.wins > 0 && value.losses > 0
      ? (value.grossWin / value.wins) / (value.grossLoss / value.losses)
      : null,
    realizedPnl: value.pnl,
    intents: value.intents,
    completedIntents: value.completed,
    rejectedIntents: value.rejected,
    averageEntrySlippageBps: value.slippageWeight > 0
      ? value.slippageWeighted / value.slippageWeight
      : null,
  };
}

function equityPerformance(points: TradingEquityPoint[]): Array<Record<string, unknown>> {
  const byAccount = new Map<string, TradingEquityPoint[]>();
  for (const point of points) {
    byAccount.set(point.accountId, [...(byAccount.get(point.accountId) ?? []), point]);
  }
  return [...byAccount.entries()].flatMap(([accountId, accountPoints]) => {
    let peak = 0;
    return accountPoints.map(point => {
      const value = finite(point.equity);
      peak = Math.max(peak, value);
      return {
        accountId,
        observedAt: point.observedAt,
        equity: value,
        drawdownPercent: peak > 0 ? (peak - value) / peak * 100 : 0,
      };
    });
  });
}

async function performanceRows(since: number): Promise<[any[], any[], any[], TradingEquityPoint[]]> {
  return Promise.all([
    getDatabase().all<any[]>(
      `SELECT position.channel_id AS channelId, position.account_id AS accountId,
              account.exchange, account.mode, intent.status AS intentStatus,
              position.realized_pnl AS realizedPnl, position.closed_at AS closedAt
       FROM trading_positions AS position
       JOIN trading_accounts AS account ON account.id = position.account_id
       JOIN trading_trade_intents AS intent ON intent.id = position.intent_id
       WHERE position.status = 'closed' AND position.closed_at >= ?
       ORDER BY position.closed_at`,
      [since],
    ),
    getDatabase().all<any[]>(
      `SELECT channel_id AS channelId, account_id AS accountId, exchange, mode, status, created_at AS createdAt
       FROM trading_trade_intents WHERE created_at >= ?`,
      [since],
    ),
    getDatabase().all<any[]>(
      `SELECT intent.channel_id AS channelId, intent.account_id AS accountId,
              intent.exchange, intent.mode, intent.status AS intentStatus,
              fill.price AS fillPrice, fill.quantity, order_row.price AS plannedPrice,
              intent.plan_json AS planJson, fill.filled_at AS filledAt
       FROM trading_fills AS fill
       JOIN trading_orders AS order_row ON order_row.id = fill.order_id
       JOIN trading_trade_intents AS intent ON intent.id = order_row.intent_id
       WHERE order_row.role = 'entry' AND fill.filled_at >= ?`,
      [since],
    ),
    listTradingEquityPoints(undefined, since),
  ]);
}

export async function getChannelPerformanceAnalytics(
  since = Date.now() - 90 * 24 * 60 * 60 * 1_000,
): Promise<{
  generatedAt: number;
  channels: Array<Record<string, unknown>>;
  exchanges: Array<Record<string, unknown>>;
  equity: Array<Record<string, unknown>>;
}> {
  const detailed = await getFilteredTradingAnalytics({
    since,
    until: Date.now(),
    channelIds: [],
    accountIds: [],
    exchanges: [],
    modes: [],
    statuses: [],
  });
  return detailed.performance;
}

export async function getFilteredTradingAnalytics(filters: TradingAnalyticsFilters): Promise<{
  generatedAt: number;
  filters: TradingAnalyticsFilters;
  performance: {
    generatedAt: number;
    channels: Array<Record<string, unknown>>;
    exchanges: Array<Record<string, unknown>>;
    equity: Array<Record<string, unknown>>;
  };
  execution: Awaited<ReturnType<typeof filteredExecutionAnalytics>>;
  fallback: Awaited<ReturnType<typeof filteredFallbackAnalytics>>;
}> {
  const [rawPositions, rawIntents, rawFills, equityPoints] = await performanceRows(filters.since);
  const positions = rawPositions.filter(row => analyticsRowMatches(row, filters));
  const intents = rawIntents.filter(row => analyticsRowMatches(row, filters));
  const fills = rawFills.filter(row => analyticsRowMatches(row, filters));
  const channels = new Map<string, PerformanceAggregate>();
  const exchanges = new Map<string, PerformanceAggregate>();
  aggregatePositions(positions, channels);
  aggregateIntents(intents, channels, exchanges);
  aggregateFills(fills, channels, exchanges);
  const selectedAccounts = new Set(
    filters.accountIds.length > 0
      ? filters.accountIds
      : intents.map(row => String(row.accountId)),
  );
  const filteredEquity = equityPoints.filter(point =>
    point.observedAt >= filters.since
    && point.observedAt <= filters.until
    && (selectedAccounts.size === 0 || selectedAccounts.has(point.accountId)));
  const generatedAt = Date.now();
  const [execution, fallback] = await Promise.all([
    filteredExecutionAnalytics(filters),
    filteredFallbackAnalytics(filters),
  ]);
  return {
    generatedAt,
    filters,
    performance: {
      generatedAt,
      channels: [...channels.values()]
        .map(presentedAggregate)
        .sort((left, right) => finite(right.realizedPnl) - finite(left.realizedPnl)),
      exchanges: [...exchanges.values()]
        .map(presentedAggregate)
        .sort((left, right) => dimensionValue(left.id).localeCompare(dimensionValue(right.id))),
      equity: equityPerformance(filteredEquity),
    },
    execution,
    fallback,
  };
}
