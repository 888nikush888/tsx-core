import { randomUUID } from 'node:crypto';
import { getDatabase } from './db.js';
import {
  createStrategyVersion,
  DEFAULT_STRATEGY_CONFIGURATION,
  strategyConfigurationSha256,
  validateStrategyConfiguration,
} from './trading_strategy.js';
import type {
  ExecutableSignal,
  TradingAccount,
  TradingAccountMode,
  TradingAccountStatus,
  TradingExchange,
  TradingIntent,
  TradingOverview,
  TradingRoute,
  TradingRuntimeState,
  TradingStrategyVersion,
} from './trading_types.js';

function boolean(value: unknown): boolean {
  return Number(value) === 1;
}

function numeric(value: unknown, fallback = 0): number {
  return value === null || value === undefined ? fallback : Number(value);
}

function nullableNumeric(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function parseJson<T>(value: unknown, label: string): T {
  try {
    return JSON.parse(String(value)) as T;
  } catch (error) {
    throw new Error(`Stored ${label} is invalid JSON.`, { cause: error });
  }
}

function strategyFromRow(row: any): TradingStrategyVersion {
  const configuration = validateStrategyConfiguration(parseJson(row.configuration_json, 'strategy configuration'));
  const hash = strategyConfigurationSha256(configuration);
  if (hash !== row.configuration_sha256) throw new Error(`Strategy version ${row.id} failed its integrity check.`);
  return {
    id: String(row.id),
    strategyId: String(row.strategy_id),
    version: Number(row.version),
    name: String(row.name),
    description: String(row.description || ''),
    status: row.status,
    configuration,
    configurationSha256: hash,
    createdAt: Number(row.created_at),
    publishedAt: row.published_at === null ? null : Number(row.published_at),
  };
}

function accountFromRow(row: any): TradingAccount {
  return {
    id: String(row.id),
    name: String(row.name),
    exchange: row.exchange,
    mode: row.mode,
    status: row.status,
    enabled: boolean(row.enabled),
    credentialRef: row.credential_ref || null,
    lastVerifiedAt: row.last_verified_at === null ? null : Number(row.last_verified_at),
    lastError: row.last_error || null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function routeFromRow(row: any): TradingRoute {
  return {
    channelId: String(row.channel_id),
    strategyVersionId: String(row.strategy_version_id),
    accountId: String(row.account_id),
    enabled: boolean(row.enabled),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function runtimeFromRow(row: any): TradingRuntimeState {
  if (!row) throw new Error('Trading runtime state is missing.');
  return {
    executionEnabled: boolean(row.execution_enabled),
    liveTradingEnabled: boolean(row.live_trading_enabled),
    killSwitchActive: boolean(row.kill_switch_active),
    killSwitchReason: row.kill_switch_reason || null,
    updatedAt: Number(row.updated_at),
  };
}

function intentFromRow(row: any): TradingIntent {
  return {
    id: String(row.id),
    sourceSignalId: String(row.source_signal_id),
    channelId: String(row.channel_id),
    strategyVersionId: String(row.strategy_version_id),
    accountId: String(row.account_id),
    exchange: row.exchange,
    mode: row.mode,
    symbol: String(row.symbol),
    side: row.side,
    status: row.status,
    signal: parseJson(row.signal_json, 'trade signal'),
    plan: row.plan_json ? parseJson(row.plan_json, 'trade plan') : null,
    blockReason: row.block_reason || null,
    error: row.last_error || null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
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

async function insertStrategy(strategy: TradingStrategyVersion): Promise<void> {
  await getDatabase().run(
    `INSERT INTO trading_strategy_versions (
       id, strategy_id, version, name, description, status, configuration_json,
       configuration_sha256, created_at, published_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      strategy.id,
      strategy.strategyId,
      strategy.version,
      strategy.name,
      strategy.description,
      strategy.status,
      JSON.stringify(strategy.configuration),
      strategy.configurationSha256,
      strategy.createdAt,
      strategy.publishedAt,
    ],
  );
}

export async function ensureTradingDefaults(now = Date.now()): Promise<void> {
  await transaction(async () => {
    const strategyCount = await getDatabase().get<{ count: number }>('SELECT COUNT(*) AS count FROM trading_strategy_versions');
    if (Number(strategyCount?.count || 0) === 0) {
      const strategy = createStrategyVersion({
        version: 1,
        name: 'Adaptive Signal',
        description: 'Safe default strategy using signal entries, mandatory protective stops and staged take profits.',
        configuration: DEFAULT_STRATEGY_CONFIGURATION,
        now,
      });
      await insertStrategy({ ...strategy, status: 'published', publishedAt: now });
    }
    await getDatabase().run(
      `INSERT OR IGNORE INTO trading_accounts (
         id, name, exchange, mode, status, enabled, credential_ref,
         last_verified_at, last_error, created_at, updated_at
       ) VALUES ('paper-default', 'Paper Trading', 'paper', 'paper', 'ready', 1, NULL, ?, NULL, ?, ?)`,
      [now, now, now],
    );
    await getDatabase().run(
      `INSERT OR IGNORE INTO trading_paper_accounts (
         account_id, equity, available_balance, realized_pnl, updated_at
       ) VALUES ('paper-default', '10000', '10000', '0', ?)`,
      [now],
    );
  });
}

export async function listTradingStrategies(): Promise<TradingStrategyVersion[]> {
  const rows = await getDatabase().all<any[]>('SELECT * FROM trading_strategy_versions ORDER BY name, version DESC');
  return rows.map(strategyFromRow);
}

export async function getTradingStrategyVersion(id: string): Promise<TradingStrategyVersion | null> {
  const row = await getDatabase().get('SELECT * FROM trading_strategy_versions WHERE id = ?', [id]);
  return row ? strategyFromRow(row) : null;
}

export async function createTradingStrategyDraft(input: {
  strategyId?: string;
  name: string;
  description?: string;
  configuration: unknown;
}): Promise<TradingStrategyVersion> {
  return transaction(async () => {
    let version = 1;
    if (input.strategyId) {
      const latest = await getDatabase().get<{ version: number }>(
        'SELECT MAX(version) AS version FROM trading_strategy_versions WHERE strategy_id = ?',
        [input.strategyId],
      );
      if (!latest?.version) throw new Error('Cannot create a version for an unknown strategy.');
      version = Number(latest.version) + 1;
    }
    const strategy = createStrategyVersion({ ...input, version });
    await insertStrategy(strategy);
    return strategy;
  });
}

export async function updateTradingStrategyDraft(id: string, input: {
  name: string;
  description?: string;
  configuration: unknown;
}): Promise<TradingStrategyVersion> {
  const configuration = validateStrategyConfiguration(input.configuration);
  const name = input.name?.trim();
  const description = input.description?.trim() || '';
  if (!name || name.length > 80) throw new Error('Strategy name must contain between 1 and 80 characters.');
  if (description.length > 500) throw new Error('Strategy description must not exceed 500 characters.');
  const result = await getDatabase().run(
    `UPDATE trading_strategy_versions
     SET name = ?, description = ?, configuration_json = ?, configuration_sha256 = ?
     WHERE id = ? AND status = 'draft'`,
    [name, description, JSON.stringify(configuration), strategyConfigurationSha256(configuration), id],
  );
  if (Number(result.changes || 0) !== 1) throw new Error('Only an existing draft strategy version can be edited.');
  return (await getTradingStrategyVersion(id))!;
}

export async function publishTradingStrategyVersion(id: string, now = Date.now()): Promise<TradingStrategyVersion> {
  const result = await getDatabase().run(
    `UPDATE trading_strategy_versions SET status = 'published', published_at = ?
     WHERE id = ? AND status = 'draft'`,
    [now, id],
  );
  if (Number(result.changes || 0) !== 1) throw new Error('Only an existing draft strategy version can be published.');
  return (await getTradingStrategyVersion(id))!;
}

export async function listTradingAccounts(): Promise<TradingAccount[]> {
  const rows = await getDatabase().all<any[]>('SELECT * FROM trading_accounts ORDER BY name, created_at');
  return rows.map(accountFromRow);
}

function validateTradingAccountInput(input: {
  name: string;
  exchange: TradingExchange;
  mode: TradingAccountMode;
  credentialRef?: string;
}): { name: string; paper: boolean; credentialRef: string | null } {
  const name = input.name?.trim();
  if (!name || name.length > 80) throw new Error('Account name must contain between 1 and 80 characters.');
  if (!['paper', 'hyperliquid', 'bybit'].includes(input.exchange)) throw new Error('Unsupported exchange.');
  if (!['paper', 'testnet', 'live'].includes(input.mode)) throw new Error('Unsupported account mode.');
  const paper = input.exchange === 'paper';
  if (paper !== (input.mode === 'paper')) throw new Error('Paper mode may only be used with the paper exchange.');
  const credentialRef = input.credentialRef?.trim() || null;
  if (!paper && !credentialRef) throw new Error('Exchange accounts require a credential reference.');
  return { name, paper, credentialRef };
}

export async function createTradingAccount(input: {
  name: string;
  exchange: TradingExchange;
  mode: TradingAccountMode;
  credentialRef?: string;
}, now = Date.now()): Promise<TradingAccount> {
  const { name, paper, credentialRef } = validateTradingAccountInput(input);
  const id = randomUUID();
  await getDatabase().run(
    `INSERT INTO trading_accounts (
       id, name, exchange, mode, status, enabled, credential_ref,
       last_verified_at, last_error, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    [id, name, input.exchange, input.mode, paper ? 'ready' : 'unverified', paper ? 1 : 0, credentialRef, paper ? now : null, now, now],
  );
  if (paper) {
    await getDatabase().run(
      `INSERT INTO trading_paper_accounts (
         account_id, equity, available_balance, realized_pnl, updated_at
       ) VALUES (?, '10000', '10000', '0', ?)`,
      [id, now],
    );
  }
  return accountFromRow(await getDatabase().get('SELECT * FROM trading_accounts WHERE id = ?', [id]));
}

export async function updateTradingAccountState(
  id: string,
  state: { status: TradingAccountStatus; enabled: boolean; error?: string | null; verifiedAt?: number | null },
): Promise<TradingAccount> {
  if (!['unverified', 'ready', 'disabled', 'error'].includes(state.status)) throw new Error('Unsupported account status.');
  if (state.enabled && state.status !== 'ready') throw new Error('Only a verified ready account can be enabled.');
  const result = await getDatabase().run(
    `UPDATE trading_accounts
     SET status = ?, enabled = ?, last_error = ?, last_verified_at = ?, updated_at = ?
     WHERE id = ?`,
    [state.status, state.enabled ? 1 : 0, state.error || null, state.verifiedAt ?? null, Date.now(), id],
  );
  if (Number(result.changes || 0) !== 1) throw new Error('Trading account does not exist.');
  return accountFromRow(await getDatabase().get('SELECT * FROM trading_accounts WHERE id = ?', [id]));
}

export async function listTradingRoutes(): Promise<TradingRoute[]> {
  const rows = await getDatabase().all<any[]>('SELECT * FROM trading_routes ORDER BY channel_id');
  return rows.map(routeFromRow);
}

export async function setTradingRoute(input: {
  channelId: string;
  strategyVersionId: string;
  accountId: string;
  enabled: boolean;
}, now = Date.now()): Promise<TradingRoute> {
  const channelId = input.channelId?.trim();
  if (!channelId || channelId.length > 128) throw new Error('A valid channel identifier is required.');
  await transaction(async () => {
    const strategy = await getDatabase().get<{ status: string }>(
      'SELECT status FROM trading_strategy_versions WHERE id = ?',
      [input.strategyVersionId],
    );
    if (strategy?.status !== 'published') throw new Error('Routes must pin a published immutable strategy version.');
    const account = await getDatabase().get<{ status: string; enabled: number }>(
      'SELECT status, enabled FROM trading_accounts WHERE id = ?',
      [input.accountId],
    );
    if (!account) throw new Error('Trading account does not exist.');
    if (input.enabled && (account.status !== 'ready' || !boolean(account.enabled))) {
      throw new Error('An enabled route requires an enabled, verified account.');
    }
    await getDatabase().run(
      `INSERT INTO trading_routes (
         channel_id, strategy_version_id, account_id, enabled, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET
         strategy_version_id = excluded.strategy_version_id,
         account_id = excluded.account_id,
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
      [channelId, input.strategyVersionId, input.accountId, input.enabled ? 1 : 0, now, now],
    );
  });
  return routeFromRow(await getDatabase().get('SELECT * FROM trading_routes WHERE channel_id = ?', [channelId]));
}

export async function deleteTradingRoute(channelId: string): Promise<boolean> {
  const active = await getDatabase().get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM trading_trade_intents
     WHERE channel_id = ? AND status IN ('pending', 'planned', 'submitting', 'monitoring', 'unknown')`,
    [channelId],
  );
  if (Number(active?.count || 0) > 0) throw new Error('Route cannot be deleted while it owns active or unresolved trades.');
  const result = await getDatabase().run('DELETE FROM trading_routes WHERE channel_id = ?', [channelId]);
  return Number(result.changes || 0) === 1;
}

export async function getTradingRuntimeState(): Promise<TradingRuntimeState> {
  return runtimeFromRow(await getDatabase().get('SELECT * FROM trading_runtime_state WHERE singleton_id = 1'));
}

export async function updateTradingRuntimeState(input: Partial<Pick<TradingRuntimeState,
  'executionEnabled' | 'liveTradingEnabled' | 'killSwitchActive' | 'killSwitchReason'
>>): Promise<TradingRuntimeState> {
  const current = await getTradingRuntimeState();
  const next = { ...current, ...input, updatedAt: Date.now() };
  if (next.killSwitchActive && !next.killSwitchReason?.trim()) throw new Error('Kill switch activation requires a reason.');
  if (next.killSwitchActive) next.executionEnabled = false;
  await getDatabase().run(
    `UPDATE trading_runtime_state SET
       execution_enabled = ?, live_trading_enabled = ?, kill_switch_active = ?,
       kill_switch_reason = ?, updated_at = ? WHERE singleton_id = 1`,
    [next.executionEnabled ? 1 : 0, next.liveTradingEnabled ? 1 : 0, next.killSwitchActive ? 1 : 0, next.killSwitchReason, next.updatedAt],
  );
  return getTradingRuntimeState();
}

export async function createTradingIntent(input: {
  sourceSignalId: string;
  channelId: string;
  signal: ExecutableSignal;
}): Promise<TradingIntent | null> {
  return transaction(async () => {
    const route = await getDatabase().get<any>(
      `SELECT route.*, strategy.status AS strategy_status,
              account.exchange, account.mode, account.status AS account_status, account.enabled AS account_enabled,
              runtime.execution_enabled, runtime.live_trading_enabled, runtime.kill_switch_active
       FROM trading_routes AS route
       JOIN trading_strategy_versions AS strategy ON strategy.id = route.strategy_version_id
       JOIN trading_accounts AS account ON account.id = route.account_id
       JOIN trading_runtime_state AS runtime ON runtime.singleton_id = 1
       WHERE route.channel_id = ?`,
      [input.channelId],
    );
    if (!route || !boolean(route.enabled)) return null;
    let status: TradingIntent['status'] = 'pending';
    let blockReason: string | null = null;
    if (route.strategy_status !== 'published') blockReason = 'STRATEGY_NOT_PUBLISHED';
    else if (route.account_status !== 'ready' || !boolean(route.account_enabled)) blockReason = 'ACCOUNT_NOT_READY';
    else if (boolean(route.kill_switch_active)) blockReason = 'KILL_SWITCH_ACTIVE';
    else if (!boolean(route.execution_enabled)) blockReason = 'EXECUTION_DISABLED';
    else if (route.mode === 'live' && !boolean(route.live_trading_enabled)) blockReason = 'LIVE_TRADING_DISABLED';
    if (blockReason) status = 'blocked';
    const id = randomUUID();
    const now = Date.now();
    await getDatabase().run(
      `INSERT INTO trading_trade_intents (
         id, source_signal_id, channel_id, strategy_version_id, account_id,
         exchange, mode, symbol, side, status, signal_json, plan_json,
         block_reason, last_error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)`,
      [
        id, input.sourceSignalId, input.channelId, route.strategy_version_id, route.account_id,
        route.exchange, route.mode, input.signal.symbol, input.signal.action, status,
        JSON.stringify(input.signal), blockReason, now, now,
      ],
    );
    return intentFromRow(await getDatabase().get('SELECT * FROM trading_trade_intents WHERE id = ?', [id]));
  });
}

export async function listTradingIntents(limit = 100): Promise<TradingIntent[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error('Intent limit must be between 1 and 1000.');
  const rows = await getDatabase().all<any[]>('SELECT * FROM trading_trade_intents ORDER BY created_at DESC LIMIT ?', [limit]);
  return rows.map(intentFromRow);
}

export async function getTradingIntent(id: string): Promise<TradingIntent | null> {
  const row = await getDatabase().get('SELECT * FROM trading_trade_intents WHERE id = ?', [id]);
  return row ? intentFromRow(row) : null;
}

export async function getTradingAccount(id: string): Promise<TradingAccount | null> {
  const row = await getDatabase().get('SELECT * FROM trading_accounts WHERE id = ?', [id]);
  return row ? accountFromRow(row) : null;
}

export async function getTradingOverview(): Promise<TradingOverview> {
  const [runtime, counts, reconciliation] = await Promise.all([
    getTradingRuntimeState(),
    getDatabase().get<any>(`SELECT
      (SELECT COUNT(*) FROM trading_accounts) AS accounts,
      (SELECT COUNT(*) FROM trading_routes WHERE enabled = 1) AS routes,
      (SELECT COUNT(*) FROM trading_positions WHERE status IN ('opening', 'open', 'closing', 'emergency')) AS positions,
      (SELECT COUNT(*) FROM trading_trade_intents WHERE status IN ('pending', 'planned', 'submitting', 'monitoring')) AS intents,
      (SELECT COUNT(*) FROM trading_orders WHERE status = 'unknown') AS unknown_orders`),
    getDatabase().get<{ latest: number | null }>(
      `SELECT MAX(completed_at) AS latest FROM trading_reconciliation_runs WHERE status = 'succeeded'`,
    ),
  ]);
  return {
    runtime,
    accountCount: Number(counts?.accounts || 0),
    enabledRouteCount: Number(counts?.routes || 0),
    openPositionCount: Number(counts?.positions || 0),
    pendingIntentCount: Number(counts?.intents || 0),
    unknownOrderCount: Number(counts?.unknown_orders || 0),
    latestReconciliationAt: reconciliation?.latest === null || reconciliation?.latest === undefined
      ? null
      : Number(reconciliation.latest),
  };
}

export async function listTradingActivity(limit = 200): Promise<{
  orders: Array<Record<string, unknown>>;
  fills: Array<Record<string, unknown>>;
  positions: Array<Record<string, unknown>>;
  riskEvents: Array<Record<string, unknown>>;
  reconciliations: Array<Record<string, unknown>>;
  paperAccounts: Array<Record<string, unknown>>;
  paperMarkets: Array<Record<string, unknown>>;
}> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error('Activity limit must be between 1 and 1000.');
  }
  const database = getDatabase();
  const [orders, fills, positions, riskEvents, reconciliations, paperAccounts, paperMarkets] = await Promise.all([
    database.all<any[]>(
      `SELECT id, intent_id AS intentId, account_id AS accountId, client_order_id AS clientOrderId,
              exchange_order_id AS exchangeOrderId, role, side, order_type AS orderType, status,
              price, trigger_price AS triggerPrice, quantity, filled_quantity AS filledQuantity,
              reduce_only AS reduceOnly, last_error AS error, created_at AS createdAt, updated_at AS updatedAt
       FROM trading_orders ORDER BY updated_at DESC LIMIT ?`, [limit]),
    database.all<any[]>(
      `SELECT id, order_id AS orderId, account_id AS accountId, exchange_fill_id AS exchangeFillId,
              price, quantity, fee, fee_asset AS feeAsset, filled_at AS filledAt
       FROM trading_fills ORDER BY filled_at DESC LIMIT ?`, [limit]),
    database.all<any[]>(
      `SELECT id, intent_id AS intentId, account_id AS accountId, strategy_version_id AS strategyVersionId,
              channel_id AS channelId, symbol, side, status, quantity,
              average_entry_price AS averageEntryPrice, stop_price AS stopPrice,
              realized_pnl AS realizedPnl, opened_at AS openedAt, closed_at AS closedAt, updated_at AS updatedAt
       FROM trading_positions ORDER BY updated_at DESC LIMIT ?`, [limit]),
    database.all<any[]>(
      `SELECT id, severity, code, account_id AS accountId, intent_id AS intentId,
              details_json AS detailsJson, created_at AS createdAt, acknowledged_at AS acknowledgedAt
       FROM trading_risk_events ORDER BY created_at DESC LIMIT ?`, [limit]),
    database.all<any[]>(
      `SELECT id, account_id AS accountId, status, last_error AS error,
              started_at AS startedAt, completed_at AS completedAt
       FROM trading_reconciliation_runs ORDER BY started_at DESC LIMIT ?`, [limit]),
    database.all<any[]>(
      `SELECT account_id AS accountId, equity, available_balance AS availableBalance,
              realized_pnl AS realizedPnl, updated_at AS updatedAt FROM trading_paper_accounts ORDER BY account_id`),
    database.all<any[]>(
      `SELECT account_id AS accountId, symbol, mark_price AS markPrice, price_tick AS priceTick,
              quantity_step AS quantityStep, minimum_quantity AS minimumQuantity,
              minimum_notional AS minimumNotional, max_leverage AS maxLeverage,
              updated_at AS updatedAt FROM trading_paper_markets ORDER BY account_id, symbol`),
  ]);
  return {
    orders: orders.map(row => ({ ...row, reduceOnly: boolean(row.reduceOnly) })),
    fills,
    positions,
    riskEvents: riskEvents.map(row => ({
      ...row,
      details: parseJson(row.detailsJson, 'risk event details'),
      detailsJson: undefined,
    })),
    reconciliations,
    paperAccounts,
    paperMarkets,
  };
}

export async function acknowledgeTradingRiskEvent(id: string, now = Date.now()): Promise<boolean> {
  const result = await getDatabase().run(
    'UPDATE trading_risk_events SET acknowledged_at = COALESCE(acknowledged_at, ?) WHERE id = ?',
    [now, id],
  );
  return Number(result.changes || 0) === 1;
}

export async function archiveTradingStrategyVersion(id: string): Promise<TradingStrategyVersion> {
  const activeRoute = await getDatabase().get<{ count: number }>(
    'SELECT COUNT(*) AS count FROM trading_routes WHERE strategy_version_id = ? AND enabled = 1', [id],
  );
  if (Number(activeRoute?.count || 0) > 0) throw new Error('An active routed strategy version cannot be archived.');
  const result = await getDatabase().run(
    "UPDATE trading_strategy_versions SET status = 'archived' WHERE id = ? AND status = 'published'", [id],
  );
  if (Number(result.changes || 0) !== 1) throw new Error('Only a published strategy version can be archived.');
  return (await getTradingStrategyVersion(id))!;
}

export async function deleteTradingAccount(id: string): Promise<boolean> {
  if (id === 'paper-default') throw new Error('The default paper account cannot be deleted.');
  return transaction(async () => {
    const references = await getDatabase().get<any>(
      `SELECT
         (SELECT COUNT(*) FROM trading_routes WHERE account_id = ?) AS routes,
         (SELECT COUNT(*) FROM trading_trade_intents WHERE account_id = ?) AS intents`,
      [id, id],
    );
    if (Number(references?.routes || 0) > 0 || Number(references?.intents || 0) > 0) {
      throw new Error('Account deletion requires all routes to be removed and no retained trade history. Disable it instead.');
    }
    const result = await getDatabase().run('DELETE FROM trading_accounts WHERE id = ?', [id]);
    return Number(result.changes || 0) === 1;
  });
}

export async function getTradingOperationalSnapshot(): Promise<{
  executionEnabled: boolean;
  liveTradingEnabled: boolean;
  killSwitchActive: boolean;
  enabledRoutes: number;
  openPositions: number;
  pendingIntents: number;
  unknownOrders: number;
  unprotectedPositions: number;
  unacknowledgedCriticalRiskEvents: number;
  intentCount: number;
  fillCount: number;
  latestReconciliationAt: number | null;
}> {
  const [runtime, values] = await Promise.all([
    getTradingRuntimeState(),
    getDatabase().get<any>(`SELECT
      (SELECT COUNT(*) FROM trading_routes WHERE enabled = 1) AS enabled_routes,
      (SELECT COUNT(*) FROM trading_positions WHERE status IN ('opening', 'open', 'closing', 'emergency') AND quantity <> '0') AS open_positions,
      (SELECT COUNT(*) FROM trading_trade_intents WHERE status IN ('pending', 'planned', 'submitting', 'monitoring')) AS pending_intents,
      (SELECT COUNT(*) FROM trading_orders WHERE status = 'unknown') AS unknown_orders,
      (SELECT COUNT(*) FROM trading_positions AS position
        WHERE position.status IN ('open', 'closing', 'emergency') AND position.quantity <> '0'
          AND NOT EXISTS (
            SELECT 1 FROM trading_orders AS stop
            WHERE stop.intent_id = position.intent_id AND stop.role = 'stop_loss' AND stop.status = 'open'
          )) AS unprotected_positions,
      (SELECT COUNT(*) FROM trading_risk_events WHERE severity = 'critical' AND acknowledged_at IS NULL) AS critical_risk,
      (SELECT COUNT(*) FROM trading_trade_intents) AS intent_count,
      (SELECT COUNT(*) FROM trading_fills) AS fill_count,
      (SELECT MAX(completed_at) FROM trading_reconciliation_runs WHERE status = 'succeeded') AS latest_reconciliation`),
  ]);
  return {
    executionEnabled: runtime.executionEnabled,
    liveTradingEnabled: runtime.liveTradingEnabled,
    killSwitchActive: runtime.killSwitchActive,
    enabledRoutes: numeric(values?.enabled_routes),
    openPositions: numeric(values?.open_positions),
    pendingIntents: numeric(values?.pending_intents),
    unknownOrders: numeric(values?.unknown_orders),
    unprotectedPositions: numeric(values?.unprotected_positions),
    unacknowledgedCriticalRiskEvents: numeric(values?.critical_risk),
    intentCount: numeric(values?.intent_count),
    fillCount: numeric(values?.fill_count),
    latestReconciliationAt: nullableNumeric(values?.latest_reconciliation),
  };
}
