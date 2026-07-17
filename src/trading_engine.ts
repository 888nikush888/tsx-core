import { createHash, randomUUID } from 'node:crypto';
import { getDatabase } from './db.js';
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
import { allocateTargetQuantities, createTradingPlan, TradingRiskError } from './trading_risk.js';
import type {
  ExchangeOpenState,
  ExchangeOrderRequest,
  ExchangeOrderResult,
  PlannedOrder,
  TradingAccount,
  TradingExchange,
  TradingExchangeAdapter,
  TradingIntent,
  TradingPlan,
} from './trading_types.js';

type TradingLogger = (message: string) => void;
type OpenEntryRow = {
  intent_id: string;
  account_id: string;
  client_order_id: string;
  created_at?: number;
  plan_json?: string;
};

class ReconciliationMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReconciliationMismatchError';
  }
}

function replacementStopId(intentId: string, quantity: string, trigger: string): string {
  return `0x${createHash('sha256').update(`${intentId}:stop:${quantity}:${trigger}`).digest('hex').slice(0, 32)}`;
}

async function transaction<T>(operation: () => Promise<T>): Promise<T> {
  const database = getDatabase();
  await database.exec('BEGIN IMMEDIATE');
  try {
    const result = await operation();
    await database.exec('COMMIT');
    return result;
  } catch (error) {
    await database.exec('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

function requestFromOrder(account: TradingAccount, plan: TradingPlan, order: PlannedOrder): ExchangeOrderRequest {
  return {
    ...order,
    accountId: account.id,
    symbol: plan.symbol,
    leverage: plan.leverage,
    timeoutSeconds: order.role === 'entry' ? plan.entryTimeoutSeconds : 12,
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
  await getDatabase().run(
    `INSERT INTO trading_risk_events (
       id, severity, code, account_id, intent_id, details_json, created_at, acknowledged_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    [randomUUID(), input.severity, input.code, input.accountId || null, input.intentId || null, JSON.stringify(input.details), Date.now()],
  );
}

async function realizedPnlSince(strategyVersionId: string, since: number): Promise<string> {
  const rows = await getDatabase().all<Array<{ realized_pnl: string }>>(
    `SELECT realized_pnl FROM trading_positions
     WHERE strategy_version_id = ? AND closed_at IS NOT NULL AND closed_at >= ?`,
    [strategyVersionId, since],
  );
  return rows.reduce((total, row) => addSignedDecimal(total, row.realized_pnl), '0');
}

async function assertCapacity(intent: TradingIntent, maxConcurrent: number, maxDailyLoss: string): Promise<void> {
  const database = getDatabase();
  const [strategyPositions, owner, unknownOrders] = await Promise.all([
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
  ]);
  if (Number(strategyPositions?.count || 0) >= maxConcurrent) {
    throw new TradingRiskError('MAX_CONCURRENT_POSITIONS', 'Strategy concurrent-position limit is reached.');
  }
  if (owner) throw new TradingRiskError('SYMBOL_ALREADY_OWNED', 'Another route already owns this account and symbol.');
  if (Number(unknownOrders?.count || 0) > 0) {
    throw new TradingRiskError('UNRESOLVED_ORDER', 'Account has an order with unknown outcome; new entries are fail-closed.');
  }
  const startOfDay = new Date().setUTCHours(0, 0, 0, 0);
  const pnl = signedDecimal(await realizedPnlSince(intent.strategyVersionId, startOfDay));
  if (pnl.startsWith('-') && compareDecimal(pnl.slice(1), maxDailyLoss) >= 0) {
    throw new TradingRiskError('MAX_DAILY_LOSS', 'Strategy daily-loss limit is reached.');
  }
}

async function calculateIntentPnl(intentId: string, side: 'LONG' | 'SHORT', entryPrice: string): Promise<string> {
  const fills = await getDatabase().all<Array<{ role: string; price: string; quantity: string; fee: string }>>(
    `SELECT orders.role, fills.price, fills.quantity, fills.fee
     FROM trading_fills AS fills JOIN trading_orders AS orders ON orders.id = fills.order_id
     WHERE orders.intent_id = ? AND orders.role <> 'entry'`,
    [intentId],
  );
  return fills.reduce((total, fill) => {
    const difference = side === 'LONG'
      ? signedDifference(fill.price, entryPrice)
      : signedDifference(entryPrice, fill.price);
    const gross = multiplyDecimal(difference.startsWith('-') ? difference.slice(1) : difference, fill.quantity);
    const signedGross = difference.startsWith('-') && gross !== '0' ? `-${gross}` : gross;
    return addSignedDecimal(addSignedDecimal(total, signedGross), `-${fill.fee}`);
  }, '0');
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

async function desiredProtectiveTrigger(input: {
  adapter: TradingExchangeAdapter;
  account: TradingAccount;
  side: 'LONG' | 'SHORT';
  symbol: string;
  plan: TradingPlan;
  strategy: NonNullable<Awaited<ReturnType<typeof getTradingStrategyVersion>>>;
  filledTargets: number;
  currentTrigger: string | null;
}): Promise<string> {
  const breakEvenAt = input.strategy.configuration.exits.moveStopToBreakEvenAfterTarget;
  let trigger = breakEvenAt !== null && input.filledTargets >= breakEvenAt
    ? input.plan.entryPrice
    : input.plan.stopPrice;
  if (input.currentTrigger) {
    const currentImproves = input.side === 'LONG'
      ? compareDecimal(input.currentTrigger, trigger) > 0
      : compareDecimal(input.currentTrigger, trigger) < 0;
    if (currentImproves) trigger = input.currentTrigger;
  }
  const trailingPercent = input.strategy.configuration.exits.trailingStopPercent;
  if (trailingPercent === null) return trigger;
  const market = await input.adapter.marketSnapshot(input.account, input.symbol);
  const distance = divideDecimal(multiplyDecimal(market.markPrice, trailingPercent), '100');
  const candidate = quantizeDecimalDown(
    input.side === 'LONG'
      ? subtractDecimal(market.markPrice, distance)
      : addDecimal(market.markPrice, distance),
    market.priceTick,
  );
  const improves = input.side === 'LONG'
    ? compareDecimal(candidate, trigger) > 0
    : compareDecimal(candidate, trigger) < 0;
  if (improves) trigger = candidate;
  return trigger;
}

function matchingActiveStop(
  remote: ExchangeOpenState,
  intentOrderIds: Set<string>,
  symbol: string,
) {
  return remote.orders.find(order =>
    intentOrderIds.has(order.clientOrderId)
    && order.role === 'stop_loss'
    && order.status === 'open'
    && order.symbol === symbol);
}

export class TradingEngine {
  private readonly adapters = new Map<TradingExchange, TradingExchangeAdapter>();

  constructor(adapters: TradingExchangeAdapter[], private readonly logger: TradingLogger = () => undefined) {
    for (const adapter of adapters) this.adapters.set(adapter.exchange, adapter);
  }

  private adapter(exchange: TradingExchange): TradingExchangeAdapter {
    const adapter = this.adapters.get(exchange);
    if (!adapter) throw new Error(`No ${exchange} exchange adapter is configured.`);
    return adapter;
  }

  async processIntent(intentId: string): Promise<void> {
    const intent = await getTradingIntent(intentId);
    if (!intent || intent.status !== 'pending') return;
    try {
      await this.executePendingIntent(intent);
    } catch (error: any) {
      await this.handleIntentFailure(intent, error);
    }
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

  private async executePendingIntent(intent: TradingIntent): Promise<void> {
    const [account, strategy, runtime] = await Promise.all([
      getTradingAccount(intent.accountId),
      getTradingStrategyVersion(intent.strategyVersionId),
      getTradingRuntimeState(),
    ]);
    if (runtime.killSwitchActive) throw new TradingRiskError('KILL_SWITCH_ACTIVE', 'Trading kill switch is active.');
    if (!runtime.executionEnabled) throw new TradingRiskError('EXECUTION_DISABLED', 'Trading execution is disabled.');
    if (!account || account.status !== 'ready' || !account.enabled) {
      throw new TradingRiskError('ACCOUNT_NOT_READY', 'Trading account is not ready.');
    }
    if (account.mode === 'live' && !runtime.liveTradingEnabled) {
      throw new TradingRiskError('LIVE_TRADING_DISABLED', 'Live trading is disabled.');
    }
    if (!strategy || strategy.status !== 'published') {
      throw new TradingRiskError('STRATEGY_NOT_PUBLISHED', 'Strategy version is not published.');
    }
    await assertCapacity(
      intent,
      strategy.configuration.safety.maxConcurrentPositions,
      strategy.configuration.safety.maxDailyLoss,
    );
    const adapter = this.adapter(account.exchange);
    const [accountSnapshot, market] = await Promise.all([
      adapter.accountSnapshot(account),
      adapter.marketSnapshot(account, intent.symbol),
    ]);
    const plan = createTradingPlan({
      intentId: intent.id,
      signal: intent.signal,
      strategy: strategy.configuration,
      account: accountSnapshot,
      market,
    });
    await persistPlan(intent, plan);
    const entry = plan.orders.find(order => order.role === 'entry')!;
    await setIntentState(intent.id, 'submitting', { plan });
    const entryResult = await submitTrackedOrder({ adapter, account, intent, plan, order: entry });
    if (entryResult.status === 'rejected') {
      throw new TradingRiskError('ENTRY_REJECTED', entryResult.error || 'Entry order rejected.');
    }
    await openLocalPosition(intent, entryResult);
    try {
      assertEntrySlippage(intent, plan, entryResult);
    } catch (error) {
      await this.emergencyFlatten(adapter, account, intent, plan, error);
      throw error;
    }
    if (entryResult.status === 'filled') {
      await this.submitExits(adapter, account, intent, plan);
    } else if (entryResult.status === 'partially_filled') {
      await this.ensureExitProtection(adapter, account, intent, plan);
    }
    await setIntentState(intent.id, 'monitoring', { plan });
    this.logger(`[TRADING] intent=${intent.id} submitted status=${entryResult.status}`);
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
      `INSERT INTO trading_orders (
         id, intent_id, account_id, client_order_id, exchange_order_id, role,
         side, order_type, status, price, trigger_price, quantity, filled_quantity,
         reduce_only, request_json, response_json, last_error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, NULL, 'flatten', ?, 'market', 'created', NULL, NULL, ?, '0', 1, ?, NULL, NULL, ?, ?)`,
      [randomUUID(), intent.id, account.id, order.clientOrderId, order.side, order.quantity, JSON.stringify(order), Date.now(), Date.now()],
    );
    try {
      const result = await submitTrackedOrder({ adapter, account, intent, plan, order });
      if (result.status !== 'filled') throw new Error(`Emergency flatten status is ${result.status}.`);
      await getDatabase().run(
        `UPDATE trading_positions SET status = 'closed', quantity = '0', closed_at = ?, updated_at = ? WHERE intent_id = ?`,
        [Date.now(), Date.now(), intent.id],
      );
      await riskEvent({
        severity: 'critical', code: 'EMERGENCY_FLATTENED', accountId: account.id, intentId: intent.id,
        details: { cause: cause instanceof Error ? cause.message : String(cause) },
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

  async reconcileAccount(accountId: string): Promise<void> {
    const account = await getTradingAccount(accountId);
    if (!account) throw new Error('Trading account does not exist.');
    const adapter = this.adapter(account.exchange);
    const runId = randomUUID();
    const startedAt = Date.now();
    await getDatabase().run(
      `INSERT INTO trading_reconciliation_runs (id, account_id, status, started_at)
       VALUES (?, ?, 'running', ?)`,
      [runId, accountId, startedAt],
    );
    try {
      const remote = await adapter.openState(account);
      await this.applyRemoteState(account, adapter, remote);
      await getDatabase().run(
        `UPDATE trading_reconciliation_runs SET status = 'succeeded', remote_snapshot_json = ?, completed_at = ? WHERE id = ?`,
        [JSON.stringify(remote), Date.now(), runId],
      );
    } catch (error: any) {
      await getDatabase().run(
        `UPDATE trading_reconciliation_runs SET status = ?, last_error = ?, completed_at = ? WHERE id = ?`,
        [error instanceof ReconciliationMismatchError ? 'mismatch' : 'failed', error?.message || String(error), Date.now(), runId],
      );
      throw error;
    }
  }

  private async applyRemoteState(
    account: TradingAccount,
    adapter: TradingExchangeAdapter,
    remote: ExchangeOpenState,
  ): Promise<void> {
    await this.detectUnmanagedExposure(account, remote);
    for (const order of remote.orders) {
      await getDatabase().run(
        `UPDATE trading_orders SET exchange_order_id = ?, status = ?, filled_quantity = ?,
           response_json = ?, updated_at = ? WHERE account_id = ? AND client_order_id = ?`,
        [order.exchangeOrderId, order.status, order.filledQuantity, JSON.stringify(order.raw), remote.observedAt, account.id, order.clientOrderId],
      );
    }
    for (const fill of remote.fills) {
      const localOrder = await getDatabase().get<any>(
        'SELECT id FROM trading_orders WHERE account_id = ? AND client_order_id = ?',
        [account.id, fill.clientOrderId],
      );
      if (!localOrder) continue;
      await getDatabase().run(
        `INSERT OR IGNORE INTO trading_fills (
           id, order_id, account_id, exchange_fill_id, price, quantity,
           fee, fee_asset, filled_at, raw_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [randomUUID(), localOrder.id, account.id, fill.exchangeFillId, fill.price, fill.quantity, fill.fee, fill.feeAsset, fill.filledAt, JSON.stringify(fill.raw)],
      );
    }
    const localPositions = await getDatabase().all<any[]>(
      `SELECT position.*, intent.plan_json FROM trading_positions AS position
       JOIN trading_trade_intents AS intent ON intent.id = position.intent_id
       WHERE position.account_id = ? AND position.status IN ('opening', 'open', 'closing', 'emergency')`,
      [account.id],
    );
    for (const local of localPositions) {
      const position = remote.positions.find(candidate => candidate.symbol === local.symbol);
      if (!position) {
        if (compareDecimal(local.quantity, '0') > 0) {
          const realizedPnl = await calculateIntentPnl(local.intent_id, local.side, local.average_entry_price);
          await getDatabase().run(
            `UPDATE trading_positions SET status = 'closed', quantity = '0', realized_pnl = ?,
               closed_at = ?, updated_at = ? WHERE id = ?`,
            [realizedPnl, remote.observedAt, remote.observedAt, local.id],
          );
          await setIntentState(local.intent_id, 'completed');
        } else {
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
        continue;
      }
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
          recoverableIntent,
          recoverablePlan,
          position.averageEntryPrice,
          position.quantity,
        );
      } catch (error) {
        await this.emergencyFlatten(adapter, account, recoverableIntent, recoverablePlan, error);
        throw error;
      }
      await this.ensureProtectiveStop(account, adapter, local, position.quantity, remote);
      await this.submitExits(
        adapter,
        account,
        recoverableIntent,
        recoverablePlan,
      );
    }
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
      ['open', 'partially_filled'].includes(order.status) && !orderIds.has(order.clientOrderId));
    const externalPositions = remote.positions.filter(position =>
      !localPositions.some(local => local.symbol === position.symbol && local.side === position.side));
    if (externalOrders.length === 0 && externalPositions.length === 0) return;
    const details = {
      externalOrderIds: externalOrders.map(order => order.clientOrderId),
      externalPositions: externalPositions.map(position => ({ symbol: position.symbol, side: position.side })),
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
    const activeStop = matchingActiveStop(remote, intentOrderIds, local.symbol);
    const protectiveQuantity = await requiredProtectiveQuantity(intent.id, plan, quantity);
    const trigger = await desiredProtectiveTrigger({
      adapter,
      account,
      side: local.side,
      symbol: local.symbol,
      plan,
      strategy,
      filledTargets,
      currentTrigger: activeStop?.triggerPrice || null,
    });
    if (activeStop && activeStop.quantity === protectiveQuantity && activeStop.triggerPrice === trigger) return;
    if (activeStop) {
      const cancelled = await adapter.cancelOrder(account, activeStop.clientOrderId);
      await storeOrderResult(intent.id, cancelled);
    }
    const replacement = await createReplacementStop(intent, plan, protectiveQuantity, trigger);
    try {
      const result = await submitTrackedOrder({ adapter, account, intent, plan, order: replacement });
      if (result.status !== 'open') throw new Error(`Replacement stop status is ${result.status}.`);
    } catch (error) {
      await this.emergencyFlatten(adapter, account, intent, plan, error);
      throw error;
    }
  }
}
