import { createHash, randomUUID } from 'node:crypto';
import { getDatabase, withDatabaseTransaction } from './db.js';
import {
  getTradingAccount,
  getTradingIntent,
  getTradingRuntimeState,
  getTradingStrategyVersion,
  updateTradingRuntimeState,
} from './trading_repository.js';
import {
  addSignedDecimal,
  compareDecimal,
  divideDecimal,
  multiplyDecimal,
  signedDecimal,
  signedDifference,
  subtractDecimal,
  addDecimal,
  quantizeDecimalDown,
} from './trading_decimal.js';
import {
  adaptiveStopLossDecision,
  allocateTargetQuantities,
  createTradingPlan,
  resolveDailyLossLimit,
  TradingRiskError,
} from './trading_risk.js';
import { ClockGuard, type ClockHealthMonitor } from './clock_guard.js';
import { resolveEffectiveChannelRisk } from './trading_channel_risk.js';
import { recordTradingEquitySnapshot, recordTradingExecutionEvent } from './trading_telemetry.js';
import type {
  ExchangeOpenState,
  ExchangeOrderRequest,
  ExchangeOrderResult,
  ExchangeStreamBatch,
  PlannedOrder,
  TradingAccount,
  TradingAccountSnapshot,
  TradingExchange,
  TradingExchangeAdapter,
  TradingIntent,
  TradingMarketSnapshot,
  TradingPlan,
} from './trading_types.js';

type TradingLogger = (message: string) => void;
type ReconciliationOptions = { force?: boolean };
export interface TradingEngineOptions {
  isolateUnavailableMarketFailures?: boolean;
}
type RemoteStateWithIdentity = ExchangeOpenState & { accountFingerprint?: string };
type OpenEntryRow = {
  intent_id: string;
  account_id: string;
  client_order_id: string;
  created_at?: number;
  plan_json?: string;
};

const MIN_PERIODIC_RECONCILIATION_MS = 10_000;
const MAX_RECONCILIATION_ROWS_PER_ACCOUNT = 256;

class ReconciliationMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReconciliationMismatchError';
  }
}

function unavailableMarketMessage(error: unknown, symbol: string): string | null {
  const message = error instanceof Error ? error.message : String(error);
  const normalizedSymbol = symbol.toUpperCase();
  const hyperliquidCoin = normalizedSymbol.replace(/(?:USDT|USDC|USD)$/, '');
  const accepted = new Set([
    `Exchange executor request failed (400): Hyperliquid symbol ${hyperliquidCoin} is unavailable.`,
    `Exchange executor request failed (400): Bybit symbol ${normalizedSymbol} is unavailable or ambiguous.`,
  ]);
  return accepted.has(message) ? message : null;
}

function replacementStopId(intentId: string, quantity: string, trigger: string): string {
  const identity = `${intentId}:stop:${quantity}:${trigger}`;
  return `0x${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
}

async function transaction<T>(operation: () => Promise<T>): Promise<T> {
  return withDatabaseTransaction(operation);
}

function requestFromOrder(
  account: TradingAccount,
  plan: TradingPlan,
  order: PlannedOrder,
): ExchangeOrderRequest & { maxSlippagePercent: string } {
  return {
    ...order,
    accountId: account.id,
    symbol: plan.symbol,
    leverage: plan.leverage,
    timeoutSeconds: order.role === 'entry' ? plan.entryTimeoutSeconds : 12,
    maxSlippagePercent: plan.maxSlippagePercent,
  };
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

async function setIntentState(id: string, status: string, options: { plan?: TradingPlan; blockReason?: string; error?: string } = {}): Promise<void> {
  await getDatabase().run(
    `UPDATE trading_trade_intents SET status = ?, plan_json = COALESCE(?, plan_json),
       block_reason = ?, last_error = ?, updated_at = ? WHERE id = ?`,
    [status, options.plan ? JSON.stringify(options.plan) : null, options.blockReason || null, options.error || null, Date.now(), id],
  );
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

async function realizedPnlSince(accountId: string, since: number): Promise<string> {
  const rows = await getDatabase().all<Array<{ realized_pnl: string }>>(
    `SELECT realized_pnl FROM trading_positions
     WHERE account_id = ? AND closed_at IS NOT NULL AND closed_at >= ?`,
    [accountId, since],
  );
  return rows.reduce((total, row) => addSignedDecimal(total, row.realized_pnl), '0');
}

interface CapacityState {
  strategyPositionCount: number;
  symbolOwned: boolean;
  unknownOrderCount: number;
  criticalRiskCount: number;
  activePlans: Array<{ plan_json: string | null }>;
}

async function loadCapacityState(intent: TradingIntent): Promise<CapacityState> {
  const database = getDatabase();
  const [strategyPositions, owner, unknownOrders, criticalRisks, activePlans] = await Promise.all([
    database.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM trading_positions
       WHERE strategy_version_id = ? AND status IN ('opening', 'open', 'closing', 'emergency')`,
      [intent.strategyVersionId],
    ),
    database.get<{ id: string }>(
      `SELECT id FROM trading_positions
       WHERE account_id = ? AND symbol = ? AND status IN ('opening', 'open', 'closing', 'emergency') LIMIT 1`,
      [intent.accountId, intent.symbol],
    ),
    database.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM trading_orders WHERE account_id = ? AND status = 'unknown'`,
      [intent.accountId],
    ),
    database.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM trading_risk_events
       WHERE account_id = ? AND severity = 'critical' AND acknowledged_at IS NULL`,
      [intent.accountId],
    ),
    database.all<Array<{ plan_json: string | null }>>(
      `SELECT intent.plan_json FROM trading_positions AS position
       JOIN trading_trade_intents AS intent ON intent.id = position.intent_id
       WHERE position.account_id = ? AND position.status IN ('opening', 'open', 'closing', 'emergency')`,
      [intent.accountId],
    ),
  ]);
  return {
    strategyPositionCount: Number(strategyPositions?.count || 0),
    symbolOwned: Boolean(owner),
    unknownOrderCount: Number(unknownOrders?.count || 0),
    criticalRiskCount: Number(criticalRisks?.count || 0),
    activePlans,
  };
}

function assertCapacityState(state: CapacityState, maxConcurrent: number): void {
  if (state.strategyPositionCount >= maxConcurrent) {
    throw new TradingRiskError('MAX_CONCURRENT_POSITIONS', 'Strategy concurrent-position limit is reached.');
  }
  if (state.symbolOwned) throw new TradingRiskError('SYMBOL_ALREADY_OWNED', 'Another route already owns this account and symbol.');
  if (state.unknownOrderCount > 0) {
    throw new TradingRiskError('UNRESOLVED_ORDER', 'Account has an order with unknown outcome; new entries are fail-closed.');
  }
  if (state.criticalRiskCount > 0) {
    throw new TradingRiskError('UNACKNOWLEDGED_CRITICAL_RISK', 'Account has an unacknowledged critical risk event.');
  }
}

function reservedPlanRisk(activePlans: CapacityState['activePlans'], maxDailyLoss: string): string {
  return activePlans.reduce((total, row) => {
    if (!row.plan_json) return total;
    try {
      return addDecimal(total, (JSON.parse(row.plan_json) as TradingPlan).riskAmount);
    } catch {
      return addDecimal(total, maxDailyLoss);
    }
  }, '0');
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

async function assertCapacity(
  intent: TradingIntent,
  maxConcurrent: number,
  maxDailyLoss: string,
  newRiskAmount: string,
  unrealizedPnl = '0',
  fundingPnlToday = '0',
): Promise<void> {
  const state = await loadCapacityState(intent);
  assertCapacityState(state, maxConcurrent);
  const startOfDay = new Date().setUTCHours(0, 0, 0, 0);
  const pnl = signedDecimal(addSignedDecimal(
    addSignedDecimal(await realizedPnlSince(intent.accountId, startOfDay), unrealizedPnl),
    fundingPnlToday,
  ));
  const loss = pnl.startsWith('-') ? pnl.slice(1) : '0';
  if (compareDecimal(loss, maxDailyLoss) >= 0) {
    throw new TradingRiskError('MAX_DAILY_LOSS', 'Account daily-loss limit is reached.');
  }
  const reservedRisk = reservedPlanRisk(state.activePlans, maxDailyLoss);
  if (compareDecimal(addDecimal(addDecimal(loss, reservedRisk), newRiskAmount), maxDailyLoss) > 0) {
    throw new TradingRiskError('MAX_DAILY_RISK', 'Account loss plus reserved trade risk exceeds the daily-loss budget.');
  }
}

async function calculateIntentPnl(intentId: string, side: 'LONG' | 'SHORT', entryPrice: string): Promise<string> {
  const fills = await getDatabase().all<Array<{ role: string; price: string; quantity: string; fee: string }>>(
    `SELECT orders.role, fills.price, fills.quantity, fills.fee
     FROM trading_fills AS fills JOIN trading_orders AS orders ON orders.id = fills.order_id
     WHERE orders.intent_id = ?`,
    [intentId],
  );
  return fills.reduce((total, fill) => {
    if (fill.role === 'entry') return addSignedDecimal(total, `-${fill.fee}`);
    const difference = side === 'LONG'
      ? signedDifference(fill.price, entryPrice)
      : signedDifference(entryPrice, fill.price);
    const gross = multiplyDecimal(difference.startsWith('-') ? difference.slice(1) : difference, fill.quantity);
    const signedGross = difference.startsWith('-') && gross !== '0' ? `-${gross}` : gross;
    return addSignedDecimal(addSignedDecimal(total, signedGross), `-${fill.fee}`);
  }, '0');
}

async function hasTerminalClosureProof(intentId: string): Promise<boolean> {
  const [fills, terminalExit, unresolved] = await Promise.all([
    getDatabase().all<Array<{ role: string; quantity: string }>>(
      `SELECT orders.role, fills.quantity FROM trading_fills AS fills
       JOIN trading_orders AS orders ON orders.id = fills.order_id
       WHERE orders.intent_id = ?`,
      [intentId],
    ),
    getDatabase().get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM trading_orders
       WHERE intent_id = ? AND role <> 'entry' AND status = 'filled'`,
      [intentId],
    ),
    getDatabase().get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM trading_orders
       WHERE intent_id = ? AND role IN ('entry', 'flatten')
         AND status IN ('submitting', 'unknown', 'cancel_pending')`,
      [intentId],
    ),
  ]);
  if (Number(terminalExit?.count || 0) === 0 || Number(unresolved?.count || 0) > 0) return false;
  let opened = '0';
  let closed = '0';
  for (const fill of fills) {
    if (fill.role === 'entry') opened = addDecimal(opened, fill.quantity);
    else closed = addDecimal(closed, fill.quantity);
  }
  return compareDecimal(opened, '0') > 0 && compareDecimal(closed, opened) >= 0;
}

function remoteStateDigest(remote: ExchangeOpenState): string {
  const stable = {
    orders: remote.orders.map(order => ({
      id: order.clientOrderId,
      status: order.status,
      filled: order.filledQuantity,
      quantity: order.quantity,
      trigger: order.triggerPrice,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    positions: remote.positions.map(position => ({
      symbol: position.symbol,
      side: position.side,
      quantity: position.quantity,
      entry: position.averageEntryPrice,
    })).sort((left, right) => `${left.symbol}:${left.side}`.localeCompare(`${right.symbol}:${right.side}`)),
    fillIds: remote.fills.map(fill => fill.exchangeFillId).sort((left, right) => left.localeCompare(right)),
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function compactRemoteSnapshot(remote: RemoteStateWithIdentity): string {
  return JSON.stringify({
    version: 2,
    accountFingerprint: remote.accountFingerprint || null,
    stateDigest: remoteStateDigest(remote),
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

async function storeOrderResult(intentId: string, result: ExchangeOrderResult): Promise<void> {
  await getDatabase().run(
    `UPDATE trading_orders SET exchange_order_id = ?, status = ?, filled_quantity = ?,
       response_json = ?, last_error = ?, updated_at = ?
     WHERE intent_id = ? AND client_order_id = ?`,
    [
      result.exchangeOrderId || null,
      result.status,
      result.filledQuantity,
      JSON.stringify(result.raw),
      result.error,
      Date.now(),
      intentId,
      result.clientOrderId,
    ],
  );
}

async function markOrderSubmitting(intentId: string, clientOrderId: string): Promise<void> {
  const update = await getDatabase().run(
    `UPDATE trading_orders SET status = 'submitting', updated_at = ?
     WHERE intent_id = ? AND client_order_id = ? AND status IN ('created', 'rejected')`,
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
  await markOrderSubmitting(input.intent.id, input.order.clientOrderId);
  try {
    const result = await input.adapter.submitOrder(
      input.account,
      requestFromOrder(input.account, input.plan, input.order),
    );
    await storeOrderResult(input.intent.id, result);
    return result;
  } catch (error: any) {
    await getDatabase().run(
      `UPDATE trading_orders SET status = 'unknown', last_error = ?, updated_at = ?
       WHERE intent_id = ? AND client_order_id = ?`,
      [error?.message || 'Order outcome is unknown.', Date.now(), input.intent.id, input.order.clientOrderId],
    );
    throw error;
  }
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

async function adjustedTakeProfits(intentId: string, plan: TradingPlan, quantity: string): Promise<PlannedOrder[]> {
  const takeProfits = plan.orders.filter(order => order.role === 'take_profit');
  const states = await getDatabase().all<Array<{ client_order_id: string; status: string }>>(
    `SELECT client_order_id, status FROM trading_orders
     WHERE intent_id = ? AND role = 'take_profit'`,
    [intentId],
  );
  if (states.length !== takeProfits.length) {
    throw new Error('Take-profit order state does not match the immutable trade plan.');
  }
  if (states.some(state => state.status !== 'created')) {
    return takeProfits;
  }
  const quantities = allocateTargetQuantities(quantity, plan.targetAllocationsPercent, plan.quantityStep);
  const adjusted = takeProfits.map((order, index) => ({ ...order, quantity: quantities[index]! }));
  for (const order of adjusted) {
    await getDatabase().run(
      `UPDATE trading_orders SET quantity = ?, request_json = ?, updated_at = ?
       WHERE intent_id = ? AND client_order_id = ? AND status = 'created'`,
      [order.quantity, JSON.stringify(order), Date.now(), intentId, order.clientOrderId],
    );
  }
  return adjusted;
}

async function requiredProtectiveQuantity(intentId: string, plan: TradingPlan, positionQuantity: string): Promise<string> {
  const entryState = await getDatabase().get<{ status: string }>(
    `SELECT status FROM trading_orders WHERE intent_id = ? AND role = 'entry'
     ORDER BY created_at LIMIT 1`,
    [intentId],
  );
  return entryState && ['open', 'partially_filled'].includes(entryState.status)
    ? plan.quantity
    : positionQuantity;
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
  const replacement: PlannedOrder = {
    ...original,
    clientOrderId: replacementStopId(intent.id, quantity, trigger),
    quantity,
    triggerPrice: trigger,
  };
  await getDatabase().run(
    `INSERT OR IGNORE INTO trading_orders (
       id, intent_id, account_id, client_order_id, exchange_order_id, role,
       side, order_type, status, price, trigger_price, quantity, filled_quantity,
       reduce_only, request_json, response_json, last_error, created_at, updated_at
     ) VALUES (?, ?, ?, ?, NULL, 'stop_loss', ?, 'stop_market', 'created', NULL, ?, ?, '0', 1, ?, NULL, NULL, ?, ?)`,
    [
      randomUUID(), intent.id, intent.accountId, replacement.clientOrderId, replacement.side,
      replacement.triggerPrice, replacement.quantity, JSON.stringify(replacement), Date.now(), Date.now(),
    ],
  );
  return replacement;
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
  symbol: string,
) {
  return remote.orders.filter(order =>
    intentOrderIds.has(order.clientOrderId)
    && (order.role === 'stop_loss' || (order.reduceOnly && order.triggerPrice !== null))
    && order.status === 'open'
    && order.symbol === symbol);
}

type ActiveStop = ReturnType<typeof matchingActiveStops>[number];

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
  private readonly adapters = new Map<TradingExchange, TradingExchangeAdapter>();
  private readonly lastPeriodicReconciliationAt = new Map<string, number>();

  constructor(
    adapters: TradingExchangeAdapter[],
    private readonly logger: TradingLogger = () => undefined,
    private readonly clockGuard: ClockHealthMonitor = new ClockGuard(),
    private readonly options: TradingEngineOptions = {},
  ) {
    for (const adapter of adapters) this.adapters.set(adapter.exchange, adapter);
  }

  private adapter(exchange: TradingExchange): TradingExchangeAdapter {
    const adapter = this.adapters.get(exchange);
    if (!adapter) throw new Error(`No ${exchange} exchange adapter is configured.`);
    return adapter;
  }

  async processIntent(intentId: string): Promise<void> {
    const intent = await getTradingIntent(intentId);
    if (intent?.status !== 'pending') return;
    try {
      await this.assertClockSafeForEntry();
      await this.executePendingIntent(intent);
    } catch (error: any) {
      await this.handleIntentFailure(intent, error);
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

  async cancelOpenEntries(accountId?: string): Promise<number> {
    const parameters: unknown[] = [];
    const accountFilter = accountId ? ' AND orders.account_id = ?' : '';
    if (accountId) parameters.push(accountId);
    const rows = await getDatabase().all<OpenEntryRow[]>(
      `SELECT orders.intent_id, orders.account_id, orders.client_order_id
       FROM trading_orders AS orders
       WHERE orders.role = 'entry' AND orders.status IN ('open', 'partially_filled')${accountFilter}
       ORDER BY orders.created_at`,
      parameters,
    );
    return this.cancelEntryRows(rows);
  }

  async cancelExpiredEntries(now = Date.now()): Promise<number> {
    const candidates = await getDatabase().all<OpenEntryRow[]>(
      `SELECT orders.intent_id, orders.account_id, orders.client_order_id,
              orders.created_at, intent.plan_json
       FROM trading_orders AS orders
       JOIN trading_trade_intents AS intent ON intent.id = orders.intent_id
       WHERE orders.role = 'entry' AND orders.status IN ('open', 'partially_filled')
       ORDER BY orders.created_at`,
    );
    const expired = candidates.filter(row => {
      if (!row.plan_json || row.created_at === undefined) return false;
      const plan = JSON.parse(row.plan_json) as TradingPlan;
      return now - Number(row.created_at) >= plan.entryOrderTtlSeconds * 1_000;
    });
    const cancelled = await this.cancelEntryRows(expired);
    for (const row of expired) {
      await riskEvent({
        severity: 'info', code: 'ENTRY_TTL_EXPIRED', accountId: row.account_id, intentId: row.intent_id,
        details: { clientOrderId: row.client_order_id },
      });
    }
    return cancelled;
  }

  private async cancelEntryRows(rows: OpenEntryRow[]): Promise<number> {
    let cancelled = 0;
    for (const row of rows) {
      const account = await getTradingAccount(row.account_id);
      if (!account) throw new Error('Open entry references a missing trading account.');
      try {
        const result = await this.adapter(account.exchange).cancelOrder(account, row.client_order_id);
        await storeOrderResult(row.intent_id, result);
        if (result.status === 'cancelled' || result.status === 'filled') cancelled += 1;
      } catch (error: any) {
        await getDatabase().run(
          `UPDATE trading_orders SET status = 'unknown', last_error = ?, updated_at = ?
           WHERE account_id = ? AND client_order_id = ?`,
          [error?.message || String(error), Date.now(), row.account_id, row.client_order_id],
        );
        await updateTradingRuntimeState({
          executionEnabled: false,
          killSwitchActive: true,
          killSwitchReason: `Entry cancellation outcome unknown for account ${row.account_id}`,
        });
        throw error;
      }
    }
    return cancelled;
  }

  async emergencyFlattenManaged(accountId?: string): Promise<number> {
    const parameters: unknown[] = [];
    const accountFilter = accountId ? ' AND position.account_id = ?' : '';
    if (accountId) parameters.push(accountId);
    const positions = await getDatabase().all<Array<{
      intent_id: string;
      account_id: string;
      plan_json: string;
    }>>(
      `SELECT position.intent_id, position.account_id, intent.plan_json
       FROM trading_positions AS position
       JOIN trading_trade_intents AS intent ON intent.id = position.intent_id
       WHERE position.status IN ('opening', 'open', 'closing', 'emergency')
         AND position.quantity <> '0'${accountFilter}
       ORDER BY position.updated_at`,
      parameters,
    );
    let flattened = 0;
    for (const position of positions) {
      const [account, intent] = await Promise.all([
        getTradingAccount(position.account_id),
        getTradingIntent(position.intent_id),
      ]);
      if (!account || !intent || !position.plan_json) {
        throw new Error('Managed position is missing its recoverable account, intent or plan.');
      }
      await this.emergencyFlatten(
        this.adapter(account.exchange),
        account,
        intent,
        JSON.parse(position.plan_json) as TradingPlan,
        'Operator requested emergency flatten through the dashboard.',
      );
      flattened += 1;
    }
    return flattened;
  }

  private async preparePendingIntent(intent: TradingIntent) {
    const [account, strategy, runtime] = await Promise.all([
      getTradingAccount(intent.accountId),
      getTradingStrategyVersion(intent.strategyVersionId),
      getTradingRuntimeState(),
    ]);
    assertExecutionPreconditions(account, runtime);
    assertPublishedStrategy(strategy);
    const maximumPendingAgeMs = strategy.configuration.safety.entryOrderTtlSeconds * 1_000;
    const pendingAgeMs = Date.now() - intent.createdAt;
    if (pendingAgeMs >= maximumPendingAgeMs) {
      throw new TradingRiskError(
        'ENTRY_INTENT_EXPIRED',
        `Trading intent exceeded its ${strategy.configuration.safety.entryOrderTtlSeconds}s entry TTL before execution.`,
      );
    }
    const adapter = this.adapter(account.exchange);
    let accountSnapshot: TradingAccountSnapshot;
    let market: TradingMarketSnapshot;
    try {
      [accountSnapshot, market] = await Promise.all([
        adapter.accountSnapshot(account),
        adapter.marketSnapshot(account, intent.symbol),
      ]);
    } catch (error) {
      const unavailable = unavailableMarketMessage(error, intent.symbol);
      if (this.options.isolateUnavailableMarketFailures && unavailable) {
        throw new TradingRiskError('SYMBOL_UNAVAILABLE', unavailable);
      }
      throw error;
    }
    await recordTradingEquitySnapshot(account.id, accountSnapshot);
    const channelRisk = await resolveEffectiveChannelRisk({
      channelId: intent.channelId,
      strategy: strategy.configuration,
      currentEquity: accountSnapshot.equity,
    });
    if (channelRisk.blocked) {
      throw new TradingRiskError('CHANNEL_BLOCKED', channelRisk.reason);
    }
    const plan = createTradingPlan({
      intentId: intent.id,
      signal: intent.signal,
      strategy: strategy.configuration,
      account: accountSnapshot,
      market,
      effectiveRiskPercent: channelRisk.riskPercent,
    });
    await assertCapacity(
      intent,
      strategy.configuration.safety.maxConcurrentPositions,
      resolveDailyLossLimit(strategy.configuration.safety, accountSnapshot.equity),
      plan.riskAmount,
      accountSnapshot.unrealizedPnl,
      accountSnapshot.fundingPnlToday,
    );
    await persistPlan(intent, plan);
    return {
      account,
      adapter,
      plan,
      effectiveRiskPercent: channelRisk.riskPercent,
    };
  }

  private async executePendingIntent(intent: TradingIntent): Promise<void> {
    const { account, adapter, plan, effectiveRiskPercent } = await this.preparePendingIntent(intent);
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
    const protectedResult = await submitTrackedProtectedEntry({
      adapter,
      account,
      intent,
      plan,
      entry,
      stop: protectiveStop,
    });
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
    await setIntentState(intent.id, 'monitoring', { plan });
    this.logger(`[TRADING] intent=${intent.id} submitted status=${entryResult.status}`);
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
      if (['open', 'partially_filled'].includes(protectedResult.protectiveStop.status)) {
        const cancelled = await adapter.cancelOrder(account, protectiveStop.clientOrderId);
        await storeOrderResult(intent.id, cancelled);
      }
      throw new TradingRiskError('ENTRY_REJECTED', entryResult.error || 'Entry order rejected.');
    }
    if (!['open', 'partially_filled', 'filled'].includes(entryResult.status)) {
      throw new Error(`Protected entry outcome is ${entryResult.status}.`);
    }
    await openLocalPosition(intent, entryResult);
    if (!['open', 'filled'].includes(protectedResult.protectiveStop.status)) {
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
    if (entryResult.status === 'filled') {
      await this.submitExits(adapter, account, intent, plan);
    } else if (entryResult.status === 'partially_filled') {
      await this.ensureExitProtection(adapter, account, intent, plan);
    }
  }

  private async handleIntentFailure(intent: TradingIntent, error: any): Promise<void> {
    const knownRisk = error instanceof TradingRiskError;
    const code = knownRisk ? error.code : 'ORDER_OUTCOME_UNKNOWN';
    const status = knownRisk ? 'blocked' : 'unknown';
    await setIntentState(intent.id, status, {
      blockReason: knownRisk ? code : undefined,
      error: error?.message || String(error),
    });
    await riskEvent({
      severity: knownRisk ? 'warning' : 'critical',
      code,
      accountId: intent.accountId,
      intentId: intent.id,
      details: { message: error?.message || String(error) },
    });
    this.logger(`[TRADING] intent=${intent.id} ${status}: ${code}`);
  }

  private async ensureExitProtection(
    adapter: TradingExchangeAdapter,
    account: TradingAccount,
    intent: TradingIntent,
    plan: TradingPlan,
  ): Promise<boolean> {
    const stop = plan.orders.find(order => order.role === 'stop_loss')!;
    const [stopState, activeStopState] = await Promise.all([
      getDatabase().get<{ status: string }>(
        'SELECT status FROM trading_orders WHERE intent_id = ? AND client_order_id = ?',
        [intent.id, stop.clientOrderId],
      ),
      getDatabase().get<{ status: string }>(
        `SELECT status FROM trading_orders
         WHERE intent_id = ? AND role = 'stop_loss' AND status = 'open'
         ORDER BY created_at DESC LIMIT 1`,
        [intent.id],
      ),
    ]);
    try {
      if (!activeStopState && (!stopState || !['created', 'filled'].includes(stopState.status))) {
        throw new Error(`Protective stop has unsafe local status ${stopState?.status || 'missing'}.`);
      }
      const stopResult = !activeStopState && stopState?.status === 'created'
        ? await submitTrackedOrder({ adapter, account, intent, plan, order: stop })
        : { status: activeStopState?.status || stopState?.status } as ExchangeOrderResult;
      if (!['open', 'filled'].includes(stopResult.status)) throw new Error(`Protective stop status is ${stopResult.status}.`);
      return stopResult.status === 'filled';
    } catch (error) {
      await this.emergencyFlatten(adapter, account, intent, plan, error);
      throw error;
    }
  }

  private async submitExits(
    adapter: TradingExchangeAdapter,
    account: TradingAccount,
    intent: TradingIntent,
    plan: TradingPlan,
  ): Promise<void> {
    if (await this.ensureExitProtection(adapter, account, intent, plan)) return;
    const [entryState, position] = await Promise.all([
      getDatabase().get<{ status: string }>(
        `SELECT status FROM trading_orders WHERE intent_id = ? AND role = 'entry'
         ORDER BY created_at LIMIT 1`,
        [intent.id],
      ),
      getDatabase().get<{ quantity: string }>(
        'SELECT quantity FROM trading_positions WHERE intent_id = ?',
        [intent.id],
      ),
    ]);
    if (!entryState || !['filled', 'cancelled'].includes(entryState.status)) return;
    if (!position || compareDecimal(position.quantity, '0') <= 0) return;
    const takeProfits = await adjustedTakeProfits(intent.id, plan, position.quantity);
    for (const takeProfit of takeProfits) {
      const state = await getDatabase().get<{ status: string }>(
        'SELECT status FROM trading_orders WHERE intent_id = ? AND client_order_id = ?',
        [intent.id, takeProfit.clientOrderId],
      );
      if (state?.status !== 'created') continue;
      const result = await submitTrackedOrder({ adapter, account, intent, plan, order: takeProfit });
      if (result.status === 'rejected') {
        await riskEvent({
          severity: 'warning',
          code: 'TAKE_PROFIT_REJECTED',
          accountId: account.id,
          intentId: intent.id,
          details: { clientOrderId: takeProfit.clientOrderId, error: result.error },
        });
      }
    }
  }

  private async emergencyFlatten(
    adapter: TradingExchangeAdapter,
    account: TradingAccount,
    intent: TradingIntent,
    plan: TradingPlan,
    cause: unknown,
  ): Promise<void> {
    const position = await getDatabase().get<any>('SELECT * FROM trading_positions WHERE intent_id = ?', [intent.id]);
    if (!position || compareDecimal(position.quantity, '0') <= 0) return;
    await getDatabase().run(
      `UPDATE trading_positions SET status = 'emergency', updated_at = ? WHERE intent_id = ?`,
      [Date.now(), intent.id],
    );
    const order: PlannedOrder = {
      clientOrderId: replacementStopId(intent.id, position.quantity, 'flatten'),
      role: 'flatten',
      side: intent.side === 'LONG' ? 'sell' : 'buy',
      orderType: 'market',
      quantity: position.quantity,
      price: null,
      triggerPrice: null,
      reduceOnly: true,
      postOnly: false,
      targetIndex: null,
    };
    await getDatabase().run(
      `INSERT OR IGNORE INTO trading_orders (
         id, intent_id, account_id, client_order_id, exchange_order_id, role,
         side, order_type, status, price, trigger_price, quantity, filled_quantity,
         reduce_only, request_json, response_json, last_error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, NULL, 'flatten', ?, 'market', 'created', NULL, NULL, ?, '0', 1, ?, NULL, NULL, ?, ?)`,
      [randomUUID(), intent.id, account.id, order.clientOrderId, order.side, order.quantity, JSON.stringify(order), Date.now(), Date.now()],
    );
    try {
      const existing = await getDatabase().get<{ status: string }>(
        'SELECT status FROM trading_orders WHERE intent_id = ? AND client_order_id = ?',
        [intent.id, order.clientOrderId],
      );
      if (existing?.status === 'filled') {
        await updateTradingRuntimeState({
          executionEnabled: false,
          killSwitchActive: true,
          killSwitchReason: `Emergency flatten for intent ${intent.id} awaits exchange reconciliation`,
        });
        return;
      }
      if (existing && ['submitting', 'unknown', 'cancel_pending', 'open', 'partially_filled'].includes(existing.status)) {
        throw new ReconciliationMismatchError(`Emergency flatten status is ${existing.status}; exchange reconciliation is required.`);
      }
      const result = await submitTrackedOrder({ adapter, account, intent, plan, order });
      if (result.status !== 'filled') throw new Error(`Emergency flatten status is ${result.status}.`);
      await updateTradingRuntimeState({
        executionEnabled: false,
        killSwitchActive: true,
        killSwitchReason: `Emergency flatten for intent ${intent.id} awaits exchange reconciliation`,
      });
      let causeMessage = 'Unknown failure';
      if (cause instanceof Error) causeMessage = cause.message;
      else if (typeof cause === 'string') causeMessage = cause;
      await riskEvent({
        severity: 'critical', code: 'EMERGENCY_FLATTEN_PENDING_RECONCILIATION', accountId: account.id, intentId: intent.id,
        details: { cause: causeMessage },
      });
    } catch (flattenError: any) {
      await updateTradingRuntimeState({
        executionEnabled: false,
        killSwitchActive: true,
        killSwitchReason: `Emergency flatten unresolved for intent ${intent.id}`,
      });
      await riskEvent({
        severity: 'critical', code: 'EMERGENCY_FLATTEN_UNKNOWN', accountId: account.id, intentId: intent.id,
        details: { error: flattenError?.message || String(flattenError) },
      });
      throw flattenError;
    }
  }

  async reconcileAccount(accountId: string, options?: ReconciliationOptions): Promise<void> {
    const force = options?.force !== false;
    const now = Date.now();
    if (!force) {
      const inMemory = this.lastPeriodicReconciliationAt.get(accountId) || 0;
      if (now - inMemory < MIN_PERIODIC_RECONCILIATION_MS) return;
      this.lastPeriodicReconciliationAt.set(accountId, now);
      const latest = await getDatabase().get<{ completed_at: number | null }>(
        `SELECT MAX(completed_at) AS completed_at FROM trading_reconciliation_runs
         WHERE account_id = ? AND status = 'succeeded'`,
        [accountId],
      );
      if (latest?.completed_at && now - latest.completed_at < MIN_PERIODIC_RECONCILIATION_MS) {
        this.lastPeriodicReconciliationAt.set(accountId, latest.completed_at);
        return;
      }
    }
    const account = await getTradingAccount(accountId);
    if (!account) throw new Error('Trading account does not exist.');
    const adapter = this.adapter(account.exchange);
    const runId = randomUUID();
    const startedAt = Date.now();
    try {
      const remote = await adapter.openState(account) as RemoteStateWithIdentity;
      await this.assertRemoteAccountIdentity(account, remote);
      await this.applyRemoteState(account, adapter, remote);
      await this.recordReconciliationSuccess(accountId, runId, startedAt, remote);
    } catch (error: any) {
      await getDatabase().run(
        `INSERT INTO trading_reconciliation_runs (
           id, account_id, status, last_error, started_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          runId,
          accountId,
          error instanceof ReconciliationMismatchError ? 'mismatch' : 'failed',
          error?.message || String(error),
          startedAt,
          Date.now(),
        ],
      );
      await this.pruneReconciliationRuns(accountId);
      throw error;
    }
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
    await updateTradingRuntimeState({
      executionEnabled: false,
      killSwitchActive: true,
      killSwitchReason: `Remote account identity is untrusted for account ${account.id}`,
    });
    throw new ReconciliationMismatchError(message);
  }

  private async recordReconciliationSuccess(
    accountId: string,
    runId: string,
    startedAt: number,
    remote: RemoteStateWithIdentity,
  ): Promise<void> {
    const snapshot = compactRemoteSnapshot(remote);
    const previous = await getDatabase().get<{ id: string; remote_snapshot_json: string | null }>(
      `SELECT id, remote_snapshot_json FROM trading_reconciliation_runs
       WHERE account_id = ? AND status = 'succeeded'
       ORDER BY completed_at DESC LIMIT 1`,
      [accountId],
    );
    let coalesce = false;
    if (previous?.remote_snapshot_json) {
      try {
        const before = JSON.parse(previous.remote_snapshot_json) as { stateDigest?: unknown; accountFingerprint?: unknown };
        const after = JSON.parse(snapshot) as { stateDigest: string; accountFingerprint: string | null };
        coalesce = before.stateDigest === after.stateDigest
          && before.accountFingerprint === after.accountFingerprint;
      } catch {
        coalesce = false;
      }
    }
    if (coalesce && previous) {
      await getDatabase().run(
        `UPDATE trading_reconciliation_runs SET started_at = ?, completed_at = ?, remote_snapshot_json = ?
         WHERE id = ?`,
        [startedAt, Date.now(), snapshot, previous.id],
      );
    } else {
      await getDatabase().run(
        `INSERT INTO trading_reconciliation_runs (
           id, account_id, status, remote_snapshot_json, started_at, completed_at
         ) VALUES (?, ?, 'succeeded', ?, ?, ?)`,
        [runId, accountId, snapshot, startedAt, Date.now()],
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
  ): Promise<void> {
    await this.detectUnmanagedExposure(account, remote);
    await this.persistRemoteExecutions(account, remote);
    const localPositions = await getDatabase().all<any[]>(
      `SELECT position.*, intent.plan_json FROM trading_positions AS position
       JOIN trading_trade_intents AS intent ON intent.id = position.intent_id
       WHERE position.account_id = ? AND position.status IN ('opening', 'open', 'closing', 'emergency')`,
      [account.id],
    );
    for (const local of localPositions) {
      const position = remote.positions.find(candidate => candidate.symbol === local.symbol);
      if (position) await this.reconcileOpenRemotePosition(account, adapter, remote, local, position);
      else await this.reconcileMissingRemotePosition(account, remote, local);
    }
  }

  private async persistRemoteExecutions(account: TradingAccount, remote: ExchangeOpenState): Promise<void> {
    for (const order of remote.orders) {
      await getDatabase().run(
        `UPDATE trading_orders SET exchange_order_id = ?, status = ?, filled_quantity = ?,
           response_json = ?, updated_at = ? WHERE account_id = ? AND client_order_id = ?`,
        [order.exchangeOrderId, order.status, order.filledQuantity, JSON.stringify(order.raw), remote.observedAt, account.id, order.clientOrderId],
      );
    }
    for (const fill of remote.fills) {
      const localOrder = await getDatabase().get<any>(
        `SELECT id, intent_id, role, status FROM trading_orders
         WHERE account_id = ? AND client_order_id = ?`,
        [account.id, fill.clientOrderId],
      );
      if (!localOrder) continue;
      const inserted = await getDatabase().run(
        `INSERT OR IGNORE INTO trading_fills (
           id, order_id, account_id, exchange_fill_id, price, quantity,
           fee, fee_asset, filled_at, raw_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [randomUUID(), localOrder.id, account.id, fill.exchangeFillId, fill.price, fill.quantity, fill.fee, fill.feeAsset, fill.filledAt, JSON.stringify(fill.raw)],
      );
      if (Number(inserted.changes || 0) === 1 && localOrder.role === 'entry') {
        const intent = await getTradingIntent(localOrder.intent_id);
        if (intent) {
          await recordTradingExecutionEvent({
            eventType: 'first_fill',
            occurredAt: fill.filledAt,
            intentId: intent.id,
            channelId: intent.channelId,
            accountId: intent.accountId,
            exchange: intent.exchange,
            mode: intent.mode,
            details: { symbol: intent.symbol },
          });
          if (localOrder.status === 'filled') {
            await recordTradingExecutionEvent({
              eventType: 'fully_filled',
              occurredAt: fill.filledAt,
              intentId: intent.id,
              channelId: intent.channelId,
              accountId: intent.accountId,
              exchange: intent.exchange,
              mode: intent.mode,
              details: { symbol: intent.symbol },
            });
          }
        }
      }
    }
  }

  private async reconcileMissingRemotePosition(
    account: TradingAccount,
    remote: ExchangeOpenState,
    local: any,
  ): Promise<void> {
    if (compareDecimal(local.quantity, '0') > 0) {
      await this.closeRemotelyAbsentPosition(account, remote, local);
      return;
    }
    const entry = await getDatabase().get<{ status: string }>(
      `SELECT status FROM trading_orders
       WHERE intent_id = ? AND role = 'entry' ORDER BY created_at LIMIT 1`,
      [local.intent_id],
    );
    if (entry && ['cancelled', 'rejected'].includes(entry.status)) {
      await getDatabase().run(
        `UPDATE trading_positions SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?`,
        [remote.observedAt, remote.observedAt, local.id],
      );
      await setIntentState(local.intent_id, 'failed', { error: `Entry order ${entry.status} before opening a position.` });
    }
  }

  private async closeRemotelyAbsentPosition(
    account: TradingAccount,
    remote: ExchangeOpenState,
    local: any,
  ): Promise<void> {
    if (!await hasTerminalClosureProof(local.intent_id)) {
      await riskEvent({
        severity: 'critical', code: 'REMOTE_POSITION_ABSENCE_UNCONFIRMED',
        accountId: account.id, intentId: local.intent_id,
        details: { symbol: local.symbol, observedAt: remote.observedAt },
      });
      await updateTradingRuntimeState({
        executionEnabled: false,
        killSwitchActive: true,
        killSwitchReason: `Remote position absence is unconfirmed for account ${account.id}`,
      });
      throw new ReconciliationMismatchError(
        `Remote position ${local.symbol} is absent without terminal fill proof.`,
      );
    }
    const realizedPnl = await calculateIntentPnl(local.intent_id, local.side, local.average_entry_price);
    await getDatabase().run(
      `UPDATE trading_positions SET status = 'closed', quantity = '0', realized_pnl = ?,
         closed_at = ?, updated_at = ? WHERE id = ?`,
      [realizedPnl, remote.observedAt, remote.observedAt, local.id],
    );
    await setIntentState(local.intent_id, 'completed');
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
        details: { symbol: intent.symbol, realizedPnl },
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
  ): Promise<void> {
    await getDatabase().run(
      `UPDATE trading_positions SET status = 'open', quantity = ?, average_entry_price = ?,
         opened_at = COALESCE(opened_at, ?), updated_at = ? WHERE id = ?`,
      [position.quantity, position.averageEntryPrice, remote.observedAt, remote.observedAt, local.id],
    );
    const recoverableIntent = await getTradingIntent(local.intent_id);
    if (!recoverableIntent || !local.plan_json) throw new Error('Remote position has no recoverable trade plan.');
    const recoverablePlan = JSON.parse(local.plan_json) as TradingPlan;
    try {
      await assertTerminalEntrySlippage(
        recoverableIntent, recoverablePlan, position.averageEntryPrice, position.quantity,
      );
    } catch (error) {
      await this.emergencyFlatten(adapter, account, recoverableIntent, recoverablePlan, error);
      throw error;
    }
    await this.ensureProtectiveStop(account, adapter, local, position.quantity, remote);
    await this.submitExits(adapter, account, recoverableIntent, recoverablePlan);
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
      externalOrderIds: externalOrders.map(order => order.clientOrderId),
      externalPositions: externalPositions.map(position => ({ symbol: position.symbol, side: position.side })),
      unknownOrderIds: unknownOrders.map(order => order.clientOrderId),
    };
    await riskEvent({
      severity: 'critical',
      code: 'UNMANAGED_REMOTE_EXPOSURE',
      accountId: account.id,
      details,
    });
    await updateTradingRuntimeState({
      executionEnabled: false,
      killSwitchActive: true,
      killSwitchReason: `Unmanaged remote exposure detected for account ${account.id}`,
    });
    throw new ReconciliationMismatchError('Unmanaged remote order or position detected.');
  }

  private async ensureProtectiveStop(
    account: TradingAccount,
    adapter: TradingExchangeAdapter,
    local: any,
    quantity: string,
    remote: ExchangeOpenState,
  ): Promise<void> {
    const intent = await getTradingIntent(local.intent_id);
    if (!intent || !local.plan_json) throw new Error('Open position has no recoverable intent and plan.');
    const plan = JSON.parse(local.plan_json) as TradingPlan;
    const strategy = await getTradingStrategyVersion(intent.strategyVersionId);
    if (!strategy) throw new Error('Open position strategy version is missing.');
    const intentOrders = await getDatabase().all<Array<{ client_order_id: string }>>(
      'SELECT client_order_id FROM trading_orders WHERE intent_id = ?', [intent.id],
    );
    const intentOrderIds = new Set(intentOrders.map(order => order.client_order_id));
    const filledTargetState = await getDatabase().get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM trading_orders
       WHERE intent_id = ? AND role = 'take_profit' AND status = 'filled'`, [intent.id],
    );
    const filledTargets = Number(filledTargetState?.count || 0);
    const activeStops = matchingActiveStops(remote, intentOrderIds, local.symbol);
    const activeStop = safestActiveStop(activeStops, local.side);
    const protectiveQuantity = await requiredProtectiveQuantity(intent.id, plan, quantity);
    const decision = await desiredProtectiveStop({
      adapter,
      account,
      side: local.side,
      symbol: local.symbol,
      plan,
      strategy,
      filledTargets,
      currentTrigger: activeStop?.triggerPrice || null,
    });
    const exactStop = activeStops.find(stop => stop.quantity === protectiveQuantity && stop.triggerPrice === decision.trigger);
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
    }
    await this.cancelStaleProtectiveStops(account, adapter, intent, activeStops, protectedStop);
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
      if (result.status !== 'open') throw new Error(`Replacement stop status is ${result.status}.`);
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
  ): Promise<void> {
    for (const stale of activeStops) {
      if (stale.clientOrderId === protectedStop.clientOrderId) continue;
      try {
        const cancelled = await adapter.cancelOrder(account, stale.clientOrderId);
        await storeOrderResult(intent.id, cancelled);
        if (!['cancelled', 'filled'].includes(cancelled.status)) {
          throw new Error(`Stale protective stop cancellation status is ${cancelled.status}.`);
        }
      } catch (error: any) {
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
        await updateTradingRuntimeState({
          executionEnabled: false,
          killSwitchActive: true,
          killSwitchReason: `Protective stop cancellation is unresolved for account ${account.id}`,
        });
        throw new ReconciliationMismatchError('Replacement stop is active but the stale stop outcome is unresolved.');
      }
    }
  }
}

async function submitTrackedProtectedEntry(input: {
  adapter: TradingExchangeAdapter;
  account: TradingAccount;
  intent: TradingIntent;
  plan: TradingPlan;
  entry: PlannedOrder;
  stop: PlannedOrder;
}): Promise<{ entry: ExchangeOrderResult; protectiveStop: ExchangeOrderResult }> {
  if (!input.adapter.submitProtectedEntry) {
    throw new Error(`Exchange adapter ${input.account.exchange} lacks atomic protected-entry support.`);
  }
  await markOrderSubmitting(input.intent.id, input.stop.clientOrderId);
  await markOrderSubmitting(input.intent.id, input.entry.clientOrderId);
  try {
    const results = await input.adapter.submitProtectedEntry(
      input.account,
      requestFromOrder(input.account, input.plan, input.entry),
      requestFromOrder(input.account, input.plan, input.stop),
    );
    await withDatabaseTransaction(async () => {
      await storeOrderResult(input.intent.id, results.protectiveStop);
      await storeOrderResult(input.intent.id, results.entry);
    });
    return results;
  } catch (error: any) {
    await getDatabase().run(
      `UPDATE trading_orders SET status = 'unknown', last_error = ?, updated_at = ?
       WHERE intent_id = ? AND client_order_id IN (?, ?)`,
      [
        error?.message || 'Protected entry outcome is unknown.',
        Date.now(),
        input.intent.id,
        input.entry.clientOrderId,
        input.stop.clientOrderId,
      ],
    );
    throw error;
  }
}
