import { getDatabase } from './db.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function boundedLimit(value: unknown): number {
  const parsed = Number(value ?? DEFAULT_LIMIT);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('Viewer projection limit is invalid.');
  return Math.min(parsed, MAX_LIMIT);
}

function boundedOffset(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 100_000) {
    throw new Error('Viewer projection offset is invalid.');
  }
  return parsed;
}

function paginated<T>(rows: T[], limit: number, offset: number): {
  rows: T[];
  pagination: { offset: number; limit: number; hasMore: boolean };
} {
  return {
    rows: rows.slice(0, limit),
    pagination: { offset, limit, hasMore: rows.length > limit },
  };
}

function optionalIdentifier(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/.test(value)) {
    throw new Error('Viewer projection identifier is invalid.');
  }
  return value;
}

function safeJson(value: unknown): Record<string, any> {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function reportingCurrency(capabilitiesJson: unknown): string | null {
  const capabilities = safeJson(capabilitiesJson);
  for (const candidate of [
    capabilities.reportingCurrency,
    capabilities.reporting_currency,
    capabilities.settleCurrency,
    capabilities.settle,
  ]) {
    if (typeof candidate === 'string' && /^[A-Z0-9]{2,16}$/i.test(candidate)) return candidate.toUpperCase();
  }
  return null;
}

function leveragePresentation(planJson: unknown): Record<string, unknown> | null {
  const plan = safeJson(planJson);
  const legacy = Number(plan.leverage);
  const decision = plan.leverageDecision;
  if (decision && typeof decision === 'object' && !Array.isArray(decision)) {
    const source = decision as Record<string, unknown>;
    const requested = Number(source.requested);
    const effective = Number(source.effective);
    return {
      requested: Number.isFinite(requested) ? requested : null,
      effective: Number.isFinite(effective) ? effective : (Number.isFinite(legacy) ? legacy : null),
      source: typeof source.source === 'string' ? source.source : null,
      cappedBy: typeof source.cappedBy === 'string' ? source.cappedBy : null,
      legacy: Number.isFinite(legacy) ? legacy : null,
    };
  }
  return Number.isFinite(legacy)
    ? { requested: null, effective: legacy, source: 'legacy', cappedBy: null, legacy }
    : null;
}

function accountFromRow(row: any): Record<string, unknown> {
  return {
    id: String(row.id),
    name: String(row.name),
    exchange: String(row.exchange),
    mode: String(row.mode),
    status: String(row.status),
    enabled: Boolean(row.enabled),
    maxConcurrentPositions: Number(row.max_concurrent_positions),
    killSwitchActive: Boolean(row.kill_switch_active),
    killSwitchReason: row.kill_switch_reason === null ? null : String(row.kill_switch_reason),
    reportingCurrency: reportingCurrency(row.capabilities_json),
    lastVerifiedAt: row.last_verified_at === null ? null : Number(row.last_verified_at),
    lastReconciledAt: row.last_reconciled_at === null ? null : Number(row.last_reconciled_at),
    lastError: row.last_error === null ? null : String(row.last_error),
    equity: row.equity === null || row.equity === undefined ? null : String(row.equity),
    availableBalance: row.available_balance === null || row.available_balance === undefined
      ? null : String(row.available_balance),
    unrealizedPnl: row.unrealized_pnl === null || row.unrealized_pnl === undefined
      ? null : String(row.unrealized_pnl),
    marginUsed: row.margin_used === null || row.margin_used === undefined ? null : String(row.margin_used),
    observedAt: row.observed_at === null || row.observed_at === undefined ? null : Number(row.observed_at),
  };
}

const ACCOUNT_SELECT = `
  SELECT account.id, account.name, account.exchange, account.mode, account.status, account.enabled,
         account.max_concurrent_positions, account.kill_switch_active, account.kill_switch_reason,
         account.capabilities_json, account.last_verified_at, account.last_reconciled_at, account.last_error,
         equity.equity, equity.available_balance, equity.unrealized_pnl, equity.margin_used, equity.observed_at
  FROM trading_accounts AS account
  LEFT JOIN trading_equity_snapshots AS equity ON equity.id = (
    SELECT snapshot.id FROM trading_equity_snapshots AS snapshot
    WHERE snapshot.account_id = account.id ORDER BY snapshot.observed_at DESC LIMIT 1
  )`;

export async function viewerAccounts(input: { id?: unknown; limit?: unknown; offset?: unknown } = {}): Promise<Record<string, unknown>> {
  const id = optionalIdentifier(input.id);
  if (id) {
    const rows = await getDatabase().all<any[]>(`${ACCOUNT_SELECT} WHERE account.id = ? LIMIT 1`, [id]);
    return { account: rows[0] ? accountFromRow(rows[0]) : null };
  }
  const limit = boundedLimit(input.limit);
  const offset = boundedOffset(input.offset);
  const page = paginated(await getDatabase().all<any[]>(
    `${ACCOUNT_SELECT} ORDER BY account.created_at DESC, account.id LIMIT ? OFFSET ?`,
    [limit + 1, offset],
  ), limit, offset);
  return { accounts: page.rows.map(accountFromRow), pagination: page.pagination };
}

function positionFromRow(row: any): Record<string, unknown> {
  return {
    id: String(row.id), intentId: String(row.intent_id), accountId: String(row.account_id),
    accountName: String(row.account_name), exchange: String(row.exchange), mode: String(row.mode),
    channelId: String(row.channel_id), symbol: String(row.symbol), side: String(row.side), status: String(row.status),
    quantity: String(row.quantity), averageEntryPrice: row.average_entry_price === null ? null : String(row.average_entry_price),
    stopPrice: String(row.stop_price), realizedPnl: String(row.realized_pnl),
    openedAt: row.opened_at === null ? null : Number(row.opened_at),
    closedAt: row.closed_at === null ? null : Number(row.closed_at), updatedAt: Number(row.updated_at),
    leverage: leveragePresentation(row.plan_json),
  };
}

const POSITION_SELECT = `
  SELECT position.id, position.intent_id, position.account_id, account.name AS account_name,
         account.exchange, account.mode, position.channel_id, position.symbol, position.side,
         position.status, position.quantity, position.average_entry_price, position.stop_price,
         position.realized_pnl, position.opened_at, position.closed_at, position.updated_at, intent.plan_json
  FROM trading_positions AS position
  JOIN trading_accounts AS account ON account.id = position.account_id
  JOIN trading_trade_intents AS intent ON intent.id = position.intent_id`;

export async function viewerPositions(input: { id?: unknown; limit?: unknown; offset?: unknown } = {}): Promise<Record<string, unknown>> {
  const id = optionalIdentifier(input.id);
  if (id) {
    const rows = await getDatabase().all<any[]>(`${POSITION_SELECT} WHERE position.id = ? LIMIT 1`, [id]);
    return { position: rows[0] ? positionFromRow(rows[0]) : null };
  }
  const limit = boundedLimit(input.limit);
  const offset = boundedOffset(input.offset);
  const page = paginated(await getDatabase().all<any[]>(
    `${POSITION_SELECT} ORDER BY position.updated_at DESC, position.id LIMIT ? OFFSET ?`, [limit + 1, offset],
  ), limit, offset);
  return { positions: page.rows.map(positionFromRow), pagination: page.pagination };
}

function orderFromRow(row: any): Record<string, unknown> {
  return {
    id: String(row.id), intentId: String(row.intent_id), accountId: String(row.account_id),
    accountName: String(row.account_name), exchange: String(row.exchange), mode: String(row.mode),
    exchangeOrderId: row.exchange_order_id === null ? null : String(row.exchange_order_id),
    role: String(row.role), side: String(row.side), orderType: String(row.order_type), status: String(row.status),
    price: row.price === null ? null : String(row.price), triggerPrice: row.trigger_price === null ? null : String(row.trigger_price),
    quantity: String(row.quantity), filledQuantity: String(row.filled_quantity), reduceOnly: Boolean(row.reduce_only),
    lastError: row.last_error === null ? null : String(row.last_error), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

const ORDER_SELECT = `
  SELECT orders.id, orders.intent_id, orders.account_id, account.name AS account_name, account.exchange,
         account.mode, orders.exchange_order_id, orders.role, orders.side, orders.order_type, orders.status,
         orders.price, orders.trigger_price, orders.quantity, orders.filled_quantity, orders.reduce_only,
         orders.last_error, orders.created_at, orders.updated_at
  FROM trading_orders AS orders JOIN trading_accounts AS account ON account.id = orders.account_id`;

export async function viewerOrders(input: { id?: unknown; limit?: unknown; offset?: unknown } = {}): Promise<Record<string, unknown>> {
  const id = optionalIdentifier(input.id);
  if (id) {
    const rows = await getDatabase().all<any[]>(`${ORDER_SELECT} WHERE orders.id = ? LIMIT 1`, [id]);
    return { order: rows[0] ? orderFromRow(rows[0]) : null };
  }
  const limit = boundedLimit(input.limit);
  const offset = boundedOffset(input.offset);
  const page = paginated(await getDatabase().all<any[]>(
    `${ORDER_SELECT} ORDER BY orders.updated_at DESC, orders.id LIMIT ? OFFSET ?`, [limit + 1, offset],
  ), limit, offset);
  return { orders: page.rows.map(orderFromRow), pagination: page.pagination };
}

function tradeFromRow(row: any): Record<string, unknown> {
  return {
    id: String(row.id), channelId: String(row.channel_id), accountId: String(row.account_id),
    accountName: String(row.account_name), exchange: String(row.exchange), mode: String(row.mode),
    symbol: String(row.symbol), side: String(row.side), status: String(row.status),
    blockReason: row.block_reason === null ? null : String(row.block_reason),
    lastError: row.last_error === null ? null : String(row.last_error),
    realizedPnl: row.realized_pnl === null ? null : String(row.realized_pnl),
    fee: row.fee === null ? '0' : String(row.fee), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    leverage: leveragePresentation(row.plan_json),
  };
}

const TRADE_SELECT = `
  SELECT intent.id, intent.channel_id, intent.account_id, account.name AS account_name, intent.exchange,
         intent.mode, intent.symbol, intent.side, intent.status, intent.block_reason, intent.last_error,
         intent.plan_json, intent.created_at, intent.updated_at, position.realized_pnl,
         (SELECT COALESCE(SUM(CAST(fill.fee AS REAL)), 0) FROM trading_fills AS fill
          JOIN trading_orders AS fee_order ON fee_order.id = fill.order_id WHERE fee_order.intent_id = intent.id) AS fee
  FROM trading_trade_intents AS intent
  JOIN trading_accounts AS account ON account.id = intent.account_id
  LEFT JOIN trading_positions AS position ON position.intent_id = intent.id`;

export async function viewerTrades(input: { id?: unknown; limit?: unknown; offset?: unknown } = {}): Promise<Record<string, unknown>> {
  const id = optionalIdentifier(input.id);
  if (id) {
    const rows = await getDatabase().all<any[]>(`${TRADE_SELECT} WHERE intent.id = ? LIMIT 1`, [id]);
    return { trade: rows[0] ? tradeFromRow(rows[0]) : null };
  }
  const limit = boundedLimit(input.limit);
  const offset = boundedOffset(input.offset);
  const page = paginated(await getDatabase().all<any[]>(
    `${TRADE_SELECT} ORDER BY intent.updated_at DESC, intent.id LIMIT ? OFFSET ?`, [limit + 1, offset],
  ), limit, offset);
  return { trades: page.rows.map(tradeFromRow), pagination: page.pagination };
}

export async function viewerSystem(): Promise<Record<string, unknown>> {
  const runtime = await getDatabase().get<any>('SELECT * FROM trading_runtime_state WHERE singleton_id = 1');
  const incidents = await getDatabase().get<any>("SELECT COUNT(*) AS count FROM trading_account_incidents WHERE status = 'open'");
  const lastEvent = await getDatabase().get<any>('SELECT MAX(seq) AS seq FROM trading_notification_events');
  return {
    generatedAt: Date.now(),
    executionEnabled: Boolean(runtime?.execution_enabled), liveTradingEnabled: Boolean(runtime?.live_trading_enabled),
    killSwitchActive: Boolean(runtime?.kill_switch_active),
    killSwitchReason: runtime?.kill_switch_reason === null || runtime?.kill_switch_reason === undefined
      ? null : String(runtime.kill_switch_reason),
    updatedAt: runtime?.updated_at ? Number(runtime.updated_at) : null,
    openIncidents: Number(incidents?.count ?? 0), lastEventSeq: Number(lastEvent?.seq ?? 0),
  };
}

export async function viewerSummary(): Promise<Record<string, unknown>> {
  const [accounts, positions, intents, risk, incidents, system] = await Promise.all([
    getDatabase().get<any>('SELECT COUNT(*) AS total, SUM(enabled) AS enabled FROM trading_accounts'),
    getDatabase().get<any>("SELECT COUNT(*) AS total FROM trading_positions WHERE status <> 'closed'"),
    getDatabase().get<any>("SELECT COUNT(*) AS total FROM trading_trade_intents WHERE status IN ('pending','planned','submitting','monitoring','unknown')"),
    getDatabase().get<any>('SELECT COUNT(*) AS total FROM trading_risk_events WHERE acknowledged_at IS NULL'),
    getDatabase().get<any>("SELECT COUNT(*) AS total FROM trading_account_incidents WHERE status = 'open'"),
    viewerSystem(),
  ]);
  return {
    generatedAt: Date.now(), system,
    accounts: { total: Number(accounts?.total ?? 0), enabled: Number(accounts?.enabled ?? 0) },
    positions: { active: Number(positions?.total ?? 0) }, intents: { active: Number(intents?.total ?? 0) },
    risk: { unacknowledged: Number(risk?.total ?? 0) }, incidents: { open: Number(incidents?.total ?? 0) },
  };
}

export async function viewerPerformance(input: { days?: unknown } = {}): Promise<Record<string, unknown>> {
  const days = Number(input.days ?? 30);
  if (!Number.isSafeInteger(days) || days < 1 || days > 3650) throw new Error('Viewer performance period is invalid.');
  const since = Date.now() - days * 86_400_000;
  const [equity, trades] = await Promise.all([
    getDatabase().all<any[]>(
      `SELECT account_id, equity, available_balance, unrealized_pnl, margin_used, observed_at
       FROM trading_equity_snapshots WHERE observed_at >= ? ORDER BY observed_at LIMIT 100`, [since],
    ),
    getDatabase().all<any[]>(
      `SELECT intent.channel_id, intent.account_id, intent.exchange, intent.mode,
              COUNT(*) AS trades, COALESCE(SUM(CAST(position.realized_pnl AS REAL)), 0) AS realized_pnl
       FROM trading_trade_intents AS intent LEFT JOIN trading_positions AS position ON position.intent_id = intent.id
       WHERE intent.updated_at >= ? AND intent.status = 'completed'
       GROUP BY intent.channel_id, intent.account_id, intent.exchange, intent.mode ORDER BY trades DESC LIMIT 100`, [since],
    ),
  ]);
  return {
    generatedAt: Date.now(), days,
    equity: equity.map(row => ({
      accountId: String(row.account_id), equity: String(row.equity), availableBalance: String(row.available_balance),
      unrealizedPnl: String(row.unrealized_pnl), marginUsed: String(row.margin_used), observedAt: Number(row.observed_at),
    })),
    groups: trades.map(row => ({
      channelId: String(row.channel_id), accountId: String(row.account_id), exchange: String(row.exchange),
      mode: String(row.mode), trades: Number(row.trades), realizedPnl: String(row.realized_pnl),
    })),
  };
}

export async function viewerRisk(input: { limit?: unknown; offset?: unknown } = {}): Promise<Record<string, unknown>> {
  const limit = boundedLimit(input.limit);
  const offset = boundedOffset(input.offset);
  const rows = await getDatabase().all<any[]>(
    `SELECT id, severity, code, account_id, intent_id, created_at, acknowledged_at
     FROM trading_risk_events ORDER BY created_at DESC, id LIMIT ? OFFSET ?`, [limit + 1, offset],
  );
  const page = paginated(rows, limit, offset);
  return { events: page.rows.map(row => ({
    id: String(row.id), severity: String(row.severity), code: String(row.code),
    accountId: row.account_id === null ? null : String(row.account_id),
    intentId: row.intent_id === null ? null : String(row.intent_id), createdAt: Number(row.created_at),
    acknowledgedAt: row.acknowledged_at === null ? null : Number(row.acknowledged_at),
  })), pagination: page.pagination };
}

export async function viewerIncidents(input: { limit?: unknown; offset?: unknown } = {}): Promise<Record<string, unknown>> {
  const limit = boundedLimit(input.limit);
  const offset = boundedOffset(input.offset);
  const rows = await getDatabase().all<any[]>(
    `SELECT id, account_id, category, severity, message, status, occurrence_count,
            first_seen_at, last_seen_at, resolved_at
     FROM trading_account_incidents ORDER BY last_seen_at DESC, id LIMIT ? OFFSET ?`, [limit + 1, offset],
  );
  const page = paginated(rows, limit, offset);
  return { incidents: page.rows.map(row => ({
    id: String(row.id), accountId: String(row.account_id), category: String(row.category), severity: String(row.severity),
    message: String(row.message), status: String(row.status), occurrenceCount: Number(row.occurrence_count),
    firstSeenAt: Number(row.first_seen_at), lastSeenAt: Number(row.last_seen_at),
    resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
  })), pagination: page.pagination };
}
