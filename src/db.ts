import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'node:path';
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

let db: Database | null = null;
let guardedDb: Database | null = null;

class SerializedDatabaseAccess {
  private tail: Promise<void> = Promise.resolve();
  private readonly owner = new AsyncLocalStorage<symbol>();

  isOwnedByCurrentOperation(): boolean {
    return this.owner.getStore() !== undefined;
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.isOwnedByCurrentOperation()) return operation();
    const operationOwner = Symbol('database-operation');
    const result = this.tail.then(() => this.owner.run(operationOwner, operation));
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async drain(): Promise<void> {
    await this.execute(async () => undefined);
  }
}

const serializedDatabaseAccess = new SerializedDatabaseAccess();
let databaseMaintenanceReason: string | null = null;

const GUARDED_DATABASE_METHODS = new Set(['all', 'each', 'exec', 'get', 'run']);

function createGuardedDatabase(database: Database): Database {
  return new Proxy(database as any, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (!GUARDED_DATABASE_METHODS.has(String(property))) return value.bind(target);
      return (...parameters: any[]) => {
        if (databaseMaintenanceReason && !serializedDatabaseAccess.isOwnedByCurrentOperation()) {
          return Promise.reject(new Error(`Database maintenance is active: ${databaseMaintenanceReason}`));
        }
        return serializedDatabaseAccess.execute(() => value.apply(target, parameters));
      };
    }
  }) as Database;
}

export interface DatabaseMaintenanceLock {
  release(): void;
}

/**
 * Prevents new database work and waits until every already accepted operation has drained.
 * The caller must release the lock if the process continues after the maintenance attempt.
 */
export async function beginDatabaseMaintenance(reason: string): Promise<DatabaseMaintenanceLock> {
  const normalized = reason.trim();
  if (!normalized) throw new Error('Database maintenance requires a reason.');
  if (databaseMaintenanceReason) throw new Error(`Database maintenance is already active: ${databaseMaintenanceReason}`);
  databaseMaintenanceReason = normalized;
  try {
    await serializedDatabaseAccess.drain();
  } catch (error) {
    databaseMaintenanceReason = null;
    throw error;
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      databaseMaintenanceReason = null;
    }
  };
}

export const DATABASE_FEATURE_SET = [
  'core-forwarding',
  'durable-outbox',
  'ai-provenance',
  'integrated-trading-control-plane',
  'isolated-paper-exchange-state',
  'managed-trading-signal-schemas',
  'versioned-signal-contracts',
  'channel-risk-and-execution-analytics',
  'mcp-agent-control-plane',
  'mcp-agent-retirement',
  'exchange-streams-mcp-approvals-trade-journal',
  'persistent-mcp-runtime-modes',
  'versioned-visual-workflows-and-account-capacity',
  'path-isolated-adaptive-risk',
  'account-protection-incidents',
  'dynamic-ccxt-exchange-registry',
  'server-persistent-workflow-builder-history',
  'telegram-viewer-notification-delivery'
] as const;

export const REQUIRED_DATABASE_TABLES = [
  'schema_migrations',
  'signals',
  'pending_tasks',
  'media_group_buffer',
  'forwarding_stats',
  'incoming_messages',
  'ai_usage_daily',
  'trading_signal_schemas',
  'trading_signal_contracts',
  'trading_signal_contract_versions',
  'trading_channel_risk_policies',
  'trading_channel_risk_evaluations',
  'trading_equity_snapshots',
  'trading_execution_events',
  'mcp_agents',
  'mcp_agent_sessions',
  'mcp_agent_actions',
  'mcp_runtime_state',
  'mcp_control_requests',
  'mcp_event_deliveries',
  'mcp_agent_proposals',
  'trading_strategy_versions',
  'trading_accounts',
  'trading_routes',
  'trading_runtime_state',
  'trading_trade_intents',
  'trading_orders',
  'trading_fills',
  'trading_positions',
  'trading_risk_events',
  'trading_reconciliation_runs',
  'trading_account_incidents',
  'trading_exchange_events',
  'trading_exchange_stream_state',
  'trading_journal_entries',
  'workflow_resource_versions',
  'workflow_revisions',
  'workflow_active_revision',
  'workflow_builder_history',
  'trading_notification_events',
  'telegram_viewer_test_events',
  'workflow_execution_paths',
  'workflow_signal_runs',
  'trading_fallback_runs',
  'trading_fallback_candidates',
  'workflow_adaptive_risk_state',
  'workflow_adaptive_risk_evaluations',
  'trading_paper_accounts',
  'trading_paper_markets',
  'trading_paper_orders',
  'trading_paper_fills',
  'trading_paper_positions'
] as const;

export type OutboxStatus = 'pending' | 'preparing' | 'sending' | 'completed' | 'failed' | 'unknown';

export interface OutboxTask {
  id: string;
  type: 'single' | 'mediaGroup';
  chatId: string;
  messageId?: number;
  messageIds?: number[];
  mediaGroupId?: string;
  addedAt: number;
  status: OutboxStatus;
  attempts: number;
  claimedAt?: number;
  updatedAt: number;
  completedAt?: number;
  lastError?: string;
  config?: any;
  result?: any;
}

export interface SignalProvenance {
  templateName: string;
  schemaName: string;
  promptSha256: string;
  model: string;
  providerRequestId?: string;
  promptTokens: number;
  completionTokens: number;
  parserVersion: string;
}

export interface OperationalRetentionResult {
  completedOutbox: number;
  incomingMessages: number;
  signals: number;
  aiUsageDays: number;
  tradingIntents: number;
  tradingReconciliations: number;
  paperOrders: number;
}

export interface DatabaseStorageStats {
  allocatedBytes: number;
  reusableBytes: number;
}

const MIGRATION_IDENTIFIER_PATTERN = /^[A-Za-z_]\w*$/;
const MIGRATION_COLUMN_DEFINITIONS = new Set([
  'TEXT',
  'INTEGER',
  "TEXT NOT NULL DEFAULT 'pending'",
  'INTEGER NOT NULL DEFAULT 0',
]);

function quotedMigrationIdentifier(value: string, label: string): string {
  if (!MIGRATION_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`Database migration ${label} is not a safe SQLite identifier.`);
  }
  return `"${value}"`;
}

function validatedMigrationColumnDefinition(definition: string): string {
  if (!MIGRATION_COLUMN_DEFINITIONS.has(definition)) {
    throw new Error('Database migration column definition is not allowlisted.');
  }
  return definition;
}

async function ensureColumn(database: Database, table: string, column: string, definition: string): Promise<void> {
  const quotedTable = quotedMigrationIdentifier(table, 'table');
  const quotedColumn = quotedMigrationIdentifier(column, 'column');
  const safeDefinition = validatedMigrationColumnDefinition(definition);
  const columns = await database.all<Array<{ name: string }>>(
    'SELECT name FROM pragma_table_info(?)',
    [table],
  );
  if (!columns.some(existing => existing.name === column)) {
    await database.exec(`ALTER TABLE ${quotedTable} ADD COLUMN ${quotedColumn} ${safeDefinition}`);
  }
}

interface MigrationColumn {
  table: string;
  name: string;
  sqlDefinition: string;
}

interface SchemaMigration {
  version: number;
  name: string;
  columns: MigrationColumn[];
  sql: string;
  /** Required only for audited table rebuilds that preserve existing foreign-key names. */
  foreignKeysOff?: boolean;
}

const migrations: SchemaMigration[] = [
  {
    version: 1,
    name: 'bootstrap_core_tables',
    columns: [],
    sql: `
        CREATE TABLE IF NOT EXISTS signals (
          id TEXT PRIMARY KEY,
          chat_id TEXT,
          message_id INTEGER,
          xml_content TEXT,
          normalized_content TEXT,
          created_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS pending_tasks (
          id TEXT PRIMARY KEY,
          type TEXT,
          chat_id TEXT,
          message_id INTEGER,
          message_ids TEXT,
          media_group_id TEXT,
          added_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS media_group_buffer (
          group_id TEXT PRIMARY KEY,
          from_chat_id TEXT,
          messages_json TEXT,
          added_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS forwarding_stats (
          key TEXT PRIMARY KEY,
          value INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS incoming_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id TEXT,
          message_id INTEGER,
          sender TEXT,
          text TEXT,
          type TEXT,
          status TEXT,
          created_at INTEGER
        );
      `
  },
  {
    version: 2,
    name: 'durable_outbox_ai_provenance',
    columns: [
      { table: 'signals', name: 'template_name', sqlDefinition: 'TEXT' },
      { table: 'signals', name: 'schema_name', sqlDefinition: 'TEXT' },
      { table: 'signals', name: 'prompt_sha256', sqlDefinition: 'TEXT' },
      { table: 'signals', name: 'model', sqlDefinition: 'TEXT' },
      { table: 'signals', name: 'provider_request_id', sqlDefinition: 'TEXT' },
      { table: 'signals', name: 'prompt_tokens', sqlDefinition: 'INTEGER' },
      { table: 'signals', name: 'completion_tokens', sqlDefinition: 'INTEGER' },
      { table: 'signals', name: 'parser_version', sqlDefinition: 'TEXT' },
      { table: 'pending_tasks', name: 'status', sqlDefinition: "TEXT NOT NULL DEFAULT 'pending'" },
      { table: 'pending_tasks', name: 'attempts', sqlDefinition: 'INTEGER NOT NULL DEFAULT 0' },
      { table: 'pending_tasks', name: 'claimed_at', sqlDefinition: 'INTEGER' },
      { table: 'pending_tasks', name: 'updated_at', sqlDefinition: 'INTEGER NOT NULL DEFAULT 0' },
      { table: 'pending_tasks', name: 'completed_at', sqlDefinition: 'INTEGER' },
      { table: 'pending_tasks', name: 'last_error', sqlDefinition: 'TEXT' },
      { table: 'pending_tasks', name: 'config_json', sqlDefinition: 'TEXT' },
      { table: 'pending_tasks', name: 'result_json', sqlDefinition: 'TEXT' }
    ],
    sql: `
        CREATE TABLE IF NOT EXISTS ai_usage_daily (
          usage_day TEXT PRIMARY KEY,
          request_count INTEGER NOT NULL DEFAULT 0,
          used_tokens INTEGER NOT NULL DEFAULT 0,
          reserved_tokens INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        );
        UPDATE pending_tasks SET status = 'pending' WHERE status IS NULL OR status = '';
        UPDATE pending_tasks SET attempts = 0 WHERE attempts IS NULL;
        UPDATE pending_tasks
        SET updated_at = COALESCE(NULLIF(updated_at, 0), added_at, CAST(strftime('%s','now') AS INTEGER) * 1000);
      `
  },
  {
    version: 3,
    name: 'integrity_indexes_and_stats',
    columns: [],
    sql: `
        DELETE FROM incoming_messages
        WHERE chat_id IS NOT NULL
          AND message_id IS NOT NULL
          AND id NOT IN (
            SELECT MIN(id) FROM incoming_messages
            WHERE chat_id IS NOT NULL AND message_id IS NOT NULL
            GROUP BY chat_id, message_id
          );
        CREATE UNIQUE INDEX IF NOT EXISTS uq_incoming_chat_message ON incoming_messages(chat_id, message_id);
        CREATE INDEX IF NOT EXISTS idx_incoming_chat_msg ON incoming_messages(chat_id, message_id);
        CREATE INDEX IF NOT EXISTS idx_incoming_created ON incoming_messages(created_at);
        CREATE INDEX IF NOT EXISTS idx_signals_normalized ON signals(normalized_content);
        CREATE INDEX IF NOT EXISTS idx_signals_chat_created ON signals(chat_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_pending_tasks_status_added ON pending_tasks(status, added_at);
        INSERT OR IGNORE INTO forwarding_stats (key, value) VALUES ('total_forwarded_count', 0);
        INSERT OR IGNORE INTO forwarding_stats (key, value) VALUES ('last_forwarded_at', 0);
      `
  },
  {
    version: 4,
    name: 'integrated_trading_control_plane',
    columns: [],
    sql: `
        CREATE TABLE IF NOT EXISTS trading_strategy_versions (
          id TEXT PRIMARY KEY,
          strategy_id TEXT NOT NULL,
          version INTEGER NOT NULL CHECK(version > 0),
          name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
          description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 500),
          status TEXT NOT NULL CHECK(status IN ('draft', 'published', 'archived')),
          configuration_json TEXT NOT NULL,
          configuration_sha256 TEXT NOT NULL CHECK(length(configuration_sha256) = 64),
          created_at INTEGER NOT NULL,
          published_at INTEGER,
          UNIQUE(strategy_id, version)
        );
        CREATE TABLE IF NOT EXISTS trading_accounts (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
          exchange TEXT NOT NULL CHECK(exchange IN ('paper', 'hyperliquid', 'bybit')),
          mode TEXT NOT NULL CHECK(mode IN ('paper', 'testnet', 'live')),
          status TEXT NOT NULL CHECK(status IN ('unverified', 'ready', 'disabled', 'error')),
          enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
          credential_ref TEXT,
          last_verified_at INTEGER,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          CHECK((exchange = 'paper' AND mode = 'paper' AND credential_ref IS NULL)
             OR (exchange <> 'paper' AND mode <> 'paper' AND credential_ref IS NOT NULL))
        );
        CREATE TABLE IF NOT EXISTS trading_routes (
          channel_id TEXT PRIMARY KEY,
          strategy_version_id TEXT NOT NULL REFERENCES trading_strategy_versions(id) ON DELETE RESTRICT,
          account_id TEXT NOT NULL REFERENCES trading_accounts(id) ON DELETE RESTRICT,
          enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS trading_runtime_state (
          singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
          execution_enabled INTEGER NOT NULL DEFAULT 0 CHECK(execution_enabled IN (0, 1)),
          live_trading_enabled INTEGER NOT NULL DEFAULT 0 CHECK(live_trading_enabled IN (0, 1)),
          kill_switch_active INTEGER NOT NULL DEFAULT 0 CHECK(kill_switch_active IN (0, 1)),
          kill_switch_reason TEXT,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS trading_trade_intents (
          id TEXT PRIMARY KEY,
          source_signal_id TEXT NOT NULL UNIQUE REFERENCES signals(id) ON DELETE RESTRICT,
          channel_id TEXT NOT NULL,
          strategy_version_id TEXT NOT NULL REFERENCES trading_strategy_versions(id) ON DELETE RESTRICT,
          account_id TEXT NOT NULL REFERENCES trading_accounts(id) ON DELETE RESTRICT,
          exchange TEXT NOT NULL CHECK(exchange IN ('paper', 'hyperliquid', 'bybit')),
          mode TEXT NOT NULL CHECK(mode IN ('paper', 'testnet', 'live')),
          symbol TEXT NOT NULL,
          side TEXT NOT NULL CHECK(side IN ('LONG', 'SHORT')),
          status TEXT NOT NULL CHECK(status IN ('pending', 'planned', 'submitting', 'monitoring', 'completed', 'blocked', 'failed', 'unknown')),
          signal_json TEXT NOT NULL,
          plan_json TEXT,
          block_reason TEXT,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS trading_orders (
          id TEXT PRIMARY KEY,
          intent_id TEXT NOT NULL REFERENCES trading_trade_intents(id) ON DELETE RESTRICT,
          account_id TEXT NOT NULL REFERENCES trading_accounts(id) ON DELETE RESTRICT,
          client_order_id TEXT NOT NULL,
          exchange_order_id TEXT,
          role TEXT NOT NULL CHECK(role IN ('entry', 'take_profit', 'stop_loss', 'flatten')),
          side TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
          order_type TEXT NOT NULL CHECK(order_type IN ('market', 'limit', 'stop_market')),
          status TEXT NOT NULL CHECK(status IN ('created', 'submitting', 'open', 'partially_filled', 'filled', 'cancel_pending', 'cancelled', 'rejected', 'unknown')),
          price TEXT,
          trigger_price TEXT,
          quantity TEXT NOT NULL,
          filled_quantity TEXT NOT NULL DEFAULT '0',
          reduce_only INTEGER NOT NULL CHECK(reduce_only IN (0, 1)),
          request_json TEXT NOT NULL,
          response_json TEXT,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(account_id, client_order_id)
        );
        CREATE TABLE IF NOT EXISTS trading_fills (
          id TEXT PRIMARY KEY,
          order_id TEXT NOT NULL REFERENCES trading_orders(id) ON DELETE RESTRICT,
          account_id TEXT NOT NULL REFERENCES trading_accounts(id) ON DELETE RESTRICT,
          exchange_fill_id TEXT NOT NULL,
          price TEXT NOT NULL,
          quantity TEXT NOT NULL,
          fee TEXT NOT NULL DEFAULT '0',
          fee_asset TEXT,
          filled_at INTEGER NOT NULL,
          raw_json TEXT NOT NULL,
          UNIQUE(account_id, exchange_fill_id)
        );
        CREATE TABLE IF NOT EXISTS trading_positions (
          id TEXT PRIMARY KEY,
          intent_id TEXT NOT NULL UNIQUE REFERENCES trading_trade_intents(id) ON DELETE RESTRICT,
          account_id TEXT NOT NULL REFERENCES trading_accounts(id) ON DELETE RESTRICT,
          strategy_version_id TEXT NOT NULL REFERENCES trading_strategy_versions(id) ON DELETE RESTRICT,
          channel_id TEXT NOT NULL,
          symbol TEXT NOT NULL,
          side TEXT NOT NULL CHECK(side IN ('LONG', 'SHORT')),
          status TEXT NOT NULL CHECK(status IN ('opening', 'open', 'closing', 'closed', 'emergency')),
          quantity TEXT NOT NULL,
          average_entry_price TEXT,
          stop_price TEXT NOT NULL,
          realized_pnl TEXT NOT NULL DEFAULT '0',
          opened_at INTEGER,
          closed_at INTEGER,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS trading_risk_events (
          id TEXT PRIMARY KEY,
          severity TEXT NOT NULL CHECK(severity IN ('info', 'warning', 'critical')),
          code TEXT NOT NULL,
          account_id TEXT REFERENCES trading_accounts(id) ON DELETE RESTRICT,
          intent_id TEXT REFERENCES trading_trade_intents(id) ON DELETE RESTRICT,
          details_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          acknowledged_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS trading_reconciliation_runs (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES trading_accounts(id) ON DELETE RESTRICT,
          status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'failed', 'mismatch')),
          local_snapshot_json TEXT,
          remote_snapshot_json TEXT,
          mismatch_json TEXT,
          last_error TEXT,
          started_at INTEGER NOT NULL,
          completed_at INTEGER
        );
        INSERT OR IGNORE INTO trading_runtime_state (
          singleton_id, execution_enabled, live_trading_enabled, kill_switch_active, updated_at
        ) VALUES (1, 0, 0, 0, CAST(strftime('%s','now') AS INTEGER) * 1000);
        CREATE INDEX IF NOT EXISTS idx_trading_strategy_status ON trading_strategy_versions(status, strategy_id, version);
        CREATE INDEX IF NOT EXISTS idx_trading_routes_account ON trading_routes(account_id, enabled);
        CREATE INDEX IF NOT EXISTS idx_trading_intents_status ON trading_trade_intents(status, created_at);
        CREATE INDEX IF NOT EXISTS idx_trading_orders_status ON trading_orders(account_id, status, updated_at);
        CREATE INDEX IF NOT EXISTS idx_trading_fills_order ON trading_fills(order_id, filled_at);
        CREATE INDEX IF NOT EXISTS idx_trading_positions_status ON trading_positions(account_id, status, updated_at);
        CREATE INDEX IF NOT EXISTS idx_trading_risk_created ON trading_risk_events(severity, created_at);
        CREATE INDEX IF NOT EXISTS idx_trading_reconcile_account ON trading_reconciliation_runs(account_id, started_at);
        CREATE UNIQUE INDEX IF NOT EXISTS uq_trading_active_account_symbol
          ON trading_positions(account_id, symbol)
          WHERE status IN ('opening', 'open', 'closing', 'emergency');
        CREATE TRIGGER IF NOT EXISTS trg_trading_strategy_immutable
        BEFORE UPDATE ON trading_strategy_versions
        WHEN OLD.status IN ('published', 'archived') AND (
          NEW.strategy_id <> OLD.strategy_id OR NEW.version <> OLD.version OR
          NEW.name <> OLD.name OR NEW.description <> OLD.description OR
          NEW.configuration_json <> OLD.configuration_json OR
          NEW.configuration_sha256 <> OLD.configuration_sha256 OR
          NEW.created_at <> OLD.created_at OR NEW.published_at IS NOT OLD.published_at
        )
        BEGIN
          SELECT RAISE(ABORT, 'published strategy versions are immutable');
        END;
      `
  },
  {
    version: 5,
    name: 'isolated_paper_exchange_state',
    columns: [],
    sql: `
        CREATE TABLE IF NOT EXISTS trading_paper_accounts (
          account_id TEXT PRIMARY KEY REFERENCES trading_accounts(id) ON DELETE CASCADE,
          equity TEXT NOT NULL,
          available_balance TEXT NOT NULL,
          realized_pnl TEXT NOT NULL DEFAULT '0',
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS trading_paper_markets (
          account_id TEXT NOT NULL REFERENCES trading_accounts(id) ON DELETE CASCADE,
          symbol TEXT NOT NULL,
          mark_price TEXT NOT NULL,
          price_tick TEXT NOT NULL,
          quantity_step TEXT NOT NULL,
          minimum_quantity TEXT NOT NULL,
          minimum_notional TEXT NOT NULL,
          max_leverage INTEGER NOT NULL CHECK(max_leverage BETWEEN 1 AND 125),
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(account_id, symbol)
        );
        CREATE TABLE IF NOT EXISTS trading_paper_orders (
          exchange_order_id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES trading_accounts(id) ON DELETE CASCADE,
          client_order_id TEXT NOT NULL,
          symbol TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('entry', 'take_profit', 'stop_loss', 'flatten')),
          side TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
          order_type TEXT NOT NULL CHECK(order_type IN ('market', 'limit', 'stop_market')),
          status TEXT NOT NULL CHECK(status IN ('open', 'partially_filled', 'filled', 'cancelled', 'rejected')),
          quantity TEXT NOT NULL,
          filled_quantity TEXT NOT NULL DEFAULT '0',
          average_price TEXT,
          price TEXT,
          trigger_price TEXT,
          reduce_only INTEGER NOT NULL CHECK(reduce_only IN (0, 1)),
          target_index INTEGER,
          leverage INTEGER NOT NULL CHECK(leverage BETWEEN 1 AND 125),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(account_id, client_order_id)
        );
        CREATE TABLE IF NOT EXISTS trading_paper_fills (
          exchange_fill_id TEXT PRIMARY KEY,
          exchange_order_id TEXT NOT NULL REFERENCES trading_paper_orders(exchange_order_id) ON DELETE CASCADE,
          account_id TEXT NOT NULL REFERENCES trading_accounts(id) ON DELETE CASCADE,
          client_order_id TEXT NOT NULL,
          price TEXT NOT NULL,
          quantity TEXT NOT NULL,
          fee TEXT NOT NULL DEFAULT '0',
          fee_asset TEXT,
          filled_at INTEGER NOT NULL,
          raw_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS trading_paper_positions (
          account_id TEXT NOT NULL REFERENCES trading_accounts(id) ON DELETE CASCADE,
          symbol TEXT NOT NULL,
          side TEXT NOT NULL CHECK(side IN ('LONG', 'SHORT')),
          quantity TEXT NOT NULL,
          average_entry_price TEXT NOT NULL,
          margin_used TEXT NOT NULL,
          realized_pnl TEXT NOT NULL DEFAULT '0',
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(account_id, symbol)
        );
        CREATE INDEX IF NOT EXISTS idx_paper_orders_state ON trading_paper_orders(account_id, status, updated_at);
        CREATE INDEX IF NOT EXISTS idx_paper_fills_account ON trading_paper_fills(account_id, filled_at);
      `
  },
  {
    version: 6,
    name: 'bind_external_trading_account_identity',
    columns: [
      { table: 'trading_accounts', name: 'external_account_id', sqlDefinition: 'TEXT' }
    ],
    sql: `
        CREATE UNIQUE INDEX IF NOT EXISTS uq_trading_external_account_identity
          ON trading_accounts(exchange, mode, external_account_id)
          WHERE external_account_id IS NOT NULL;
      `
  },
  {
    version: 7,
    name: 'managed_trading_signal_schemas',
    columns: [],
    sql: `
        CREATE TABLE IF NOT EXISTS trading_signal_schemas (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
          description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 500),
          parser_schema TEXT NOT NULL CHECK(parser_schema IN ('standard', 'cryptodanielvip', 'loma')),
          template_name TEXT NOT NULL COLLATE NOCASE UNIQUE,
          enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO trading_signal_schemas (
          id, name, description, parser_schema, template_name, enabled, created_at, updated_at
        ) VALUES
          ('standard', 'Standard', 'Standard XML trading signal contract.', 'standard', 'default', 1, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
          ('cryptodanielvip', 'CryptoDaniel VIP', 'CryptoDaniel VIP executable XML contract.', 'cryptodanielvip', 'cryptodanielvip', 1, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
          ('loma', 'Loma', 'Loma executable XML contract.', 'loma', 'loma', 1, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);
        CREATE INDEX IF NOT EXISTS idx_trading_signal_schemas_enabled
          ON trading_signal_schemas(enabled, name);
      `
  },
  {
    version: 8,
    name: 'versioned_dynamic_signal_contracts',
    columns: [
      { table: 'trading_signal_schemas', name: 'contract_version_id', sqlDefinition: 'TEXT' }
    ],
    sql: `
        CREATE TABLE IF NOT EXISTS trading_signal_contracts (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
          description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 500),
          archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1)),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS trading_signal_contract_versions (
          id TEXT PRIMARY KEY,
          contract_id TEXT NOT NULL REFERENCES trading_signal_contracts(id) ON DELETE RESTRICT,
          version INTEGER NOT NULL CHECK(version > 0),
          status TEXT NOT NULL CHECK(status IN ('draft', 'published', 'archived')),
          definition_json TEXT NOT NULL,
          definition_sha256 TEXT NOT NULL CHECK(length(definition_sha256) = 64),
          created_at INTEGER NOT NULL,
          published_at INTEGER,
          archived_at INTEGER,
          UNIQUE(contract_id, version)
        );
        CREATE INDEX IF NOT EXISTS idx_signal_contract_versions
          ON trading_signal_contract_versions(contract_id, status, version);
        CREATE INDEX IF NOT EXISTS idx_signal_schema_contract_version
          ON trading_signal_schemas(contract_version_id);
        CREATE TRIGGER IF NOT EXISTS trg_signal_contract_version_immutable
        BEFORE UPDATE ON trading_signal_contract_versions
        WHEN OLD.status IN ('published', 'archived') AND (
          NEW.contract_id <> OLD.contract_id OR NEW.version <> OLD.version OR
          NEW.definition_json <> OLD.definition_json OR
          NEW.definition_sha256 <> OLD.definition_sha256 OR
          NEW.created_at <> OLD.created_at OR NEW.published_at IS NOT OLD.published_at
        )
        BEGIN
          SELECT RAISE(ABORT, 'published signal contract versions are immutable');
        END;
      `
  },
  {
    version: 9,
    name: 'channel_risk_equity_and_execution_analytics',
    columns: [],
    sql: `
        CREATE TABLE IF NOT EXISTS trading_channel_risk_policies (
          channel_id TEXT PRIMARY KEY,
          mode TEXT NOT NULL CHECK(mode IN ('fixed', 'shadow', 'automatic')),
          tiers_json TEXT NOT NULL,
          current_tier INTEGER NOT NULL CHECK(current_tier >= 0),
          lookback_weeks INTEGER NOT NULL CHECK(lookback_weeks BETWEEN 1 AND 12),
          minimum_closed_trades INTEGER NOT NULL CHECK(minimum_closed_trades BETWEEN 1 AND 1000),
          loss_threshold_percent TEXT NOT NULL,
          profit_threshold_percent TEXT NOT NULL,
          weak_channel_action TEXT NOT NULL CHECK(weak_channel_action IN ('none', 'reduce', 'block')),
          weak_weeks_before_block INTEGER NOT NULL CHECK(weak_weeks_before_block BETWEEN 1 AND 52),
          manually_blocked INTEGER NOT NULL DEFAULT 0 CHECK(manually_blocked IN (0, 1)),
          blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0, 1)),
          block_reason TEXT,
          locked_tier INTEGER,
          policy_version INTEGER NOT NULL CHECK(policy_version > 0),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS trading_channel_risk_evaluations (
          id TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL,
          policy_version INTEGER NOT NULL,
          week_started_at INTEGER NOT NULL,
          week_ended_at INTEGER NOT NULL,
          closed_trades INTEGER NOT NULL,
          wins INTEGER NOT NULL,
          losses INTEGER NOT NULL,
          realized_pnl TEXT NOT NULL,
          starting_equity TEXT NOT NULL,
          return_percent TEXT NOT NULL,
          previous_tier INTEGER NOT NULL,
          recommended_tier INTEGER NOT NULL,
          applied_tier INTEGER NOT NULL,
          action TEXT NOT NULL CHECK(action IN ('hold', 'increase', 'decrease', 'block')),
          reason TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE(channel_id, policy_version, week_started_at)
        );
        CREATE TABLE IF NOT EXISTS trading_equity_snapshots (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES trading_accounts(id) ON DELETE RESTRICT,
          equity TEXT NOT NULL,
          available_balance TEXT NOT NULL,
          unrealized_pnl TEXT NOT NULL,
          margin_used TEXT NOT NULL,
          observed_at INTEGER NOT NULL,
          bucket_minute INTEGER NOT NULL,
          UNIQUE(account_id, bucket_minute)
        );
        CREATE TABLE IF NOT EXISTS trading_execution_events (
          id TEXT PRIMARY KEY,
          intent_id TEXT REFERENCES trading_trade_intents(id) ON DELETE RESTRICT,
          channel_id TEXT,
          account_id TEXT REFERENCES trading_accounts(id) ON DELETE RESTRICT,
          exchange TEXT,
          mode TEXT,
          event_type TEXT NOT NULL CHECK(event_type IN (
            'signal_received', 'signal_validated', 'intent_created', 'submit_started',
            'exchange_ack', 'first_fill', 'fully_filled', 'position_closed',
            'kill_switch_activated', 'contract_changed', 'risk_policy_changed'
          )),
          occurred_at INTEGER NOT NULL,
          details_json TEXT NOT NULL,
          correlation_id TEXT,
          UNIQUE(intent_id, event_type)
        );
        CREATE INDEX IF NOT EXISTS idx_channel_risk_evaluation_week
          ON trading_channel_risk_evaluations(channel_id, week_started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_equity_snapshots_account_time
          ON trading_equity_snapshots(account_id, observed_at);
        CREATE INDEX IF NOT EXISTS idx_execution_events_channel_time
          ON trading_execution_events(channel_id, occurred_at);
        CREATE INDEX IF NOT EXISTS idx_execution_events_intent_time
          ON trading_execution_events(intent_id, occurred_at);
      `
  },
  {
    version: 10,
    name: 'mcp_agent_control_plane',
    columns: [],
    sql: `
        CREATE TABLE IF NOT EXISTS mcp_agents (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
          token_sha256 TEXT NOT NULL UNIQUE CHECK(length(token_sha256) = 64),
          token_prefix TEXT NOT NULL CHECK(length(token_prefix) BETWEEN 8 AND 24),
          permissions_json TEXT NOT NULL,
          event_subscriptions_json TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          last_seen_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS mcp_agent_sessions (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL REFERENCES mcp_agents(id) ON DELETE RESTRICT,
          client_name TEXT NOT NULL,
          client_version TEXT NOT NULL,
          connected_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          disconnected_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS mcp_agent_actions (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL REFERENCES mcp_agents(id) ON DELETE RESTRICT,
          session_id TEXT REFERENCES mcp_agent_sessions(id) ON DELETE RESTRICT,
          tool_name TEXT NOT NULL,
          permission TEXT NOT NULL,
          outcome TEXT NOT NULL CHECK(outcome IN ('succeeded', 'rejected', 'failed')),
          request_json TEXT NOT NULL,
          result_json TEXT,
          error TEXT,
          started_at INTEGER NOT NULL,
          completed_at INTEGER NOT NULL,
          duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0)
        );
        CREATE TABLE IF NOT EXISTS mcp_control_requests (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL REFERENCES mcp_agents(id) ON DELETE RESTRICT,
          session_id TEXT REFERENCES mcp_agent_sessions(id) ON DELETE RESTRICT,
          action TEXT NOT NULL CHECK(action IN (
            'contracts.create', 'contracts.update', 'contracts.publish',
            'contracts.archive', 'contracts.delete_draft',
            'risk.update', 'risk.delete', 'trading.reconcile',
            'trading.cancel_entries', 'trading.kill_switch', 'trading.flatten'
          )),
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'succeeded', 'failed')),
          result_json TEXT,
          error TEXT,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          completed_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS mcp_event_deliveries (
          id TEXT PRIMARY KEY,
          source_event_id TEXT NOT NULL REFERENCES trading_execution_events(id) ON DELETE RESTRICT,
          agent_id TEXT NOT NULL REFERENCES mcp_agents(id) ON DELETE RESTRICT,
          session_id TEXT REFERENCES mcp_agent_sessions(id) ON DELETE RESTRICT,
          event_type TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('delivered', 'failed')),
          delivered_at INTEGER NOT NULL,
          error TEXT,
          UNIQUE(source_event_id, agent_id, session_id)
        );
        CREATE INDEX IF NOT EXISTS idx_mcp_sessions_agent_state
          ON mcp_agent_sessions(agent_id, disconnected_at, last_seen_at);
        CREATE INDEX IF NOT EXISTS idx_mcp_actions_agent_time
          ON mcp_agent_actions(agent_id, completed_at DESC);
        CREATE INDEX IF NOT EXISTS idx_mcp_control_requests_state
          ON mcp_control_requests(status, created_at);
        CREATE INDEX IF NOT EXISTS idx_mcp_event_delivery_agent
          ON mcp_event_deliveries(agent_id, delivered_at DESC);
      `
  },
  {
    version: 11,
    name: 'mcp_agent_retirement',
    columns: [
      {
        table: 'mcp_agents',
        name: 'deleted_at',
        sqlDefinition: 'INTEGER',
      },
    ],
    sql: `
        CREATE INDEX IF NOT EXISTS idx_mcp_agents_active
          ON mcp_agents(name COLLATE NOCASE, created_at)
          WHERE deleted_at IS NULL;
      `
  },
  {
    version: 12,
    name: 'exchange_streams_mcp_approvals_trade_journal',
    columns: [],
    sql: `
        CREATE TABLE IF NOT EXISTS trading_exchange_events (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES trading_accounts(id) ON DELETE RESTRICT,
          exchange TEXT NOT NULL CHECK(exchange IN ('hyperliquid', 'bybit')),
          mode TEXT NOT NULL CHECK(mode IN ('testnet', 'live')),
          event_key TEXT NOT NULL CHECK(length(event_key) = 64),
          event_type TEXT NOT NULL CHECK(event_type IN (
            'order', 'execution', 'position', 'market', 'candle', 'stream_status'
          )),
          symbol TEXT,
          sequence INTEGER,
          occurred_at INTEGER NOT NULL,
          received_at INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          UNIQUE(account_id, event_key)
        );
        CREATE TABLE IF NOT EXISTS trading_exchange_stream_state (
          account_id TEXT PRIMARY KEY REFERENCES trading_accounts(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK(status IN ('starting', 'healthy', 'degraded', 'stopped')),
          cursor INTEGER NOT NULL DEFAULT 0 CHECK(cursor >= 0),
          gap_count INTEGER NOT NULL DEFAULT 0 CHECK(gap_count >= 0),
          last_event_at INTEGER,
          last_poll_at INTEGER,
          last_error TEXT,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS trading_journal_entries (
          intent_id TEXT PRIMARY KEY REFERENCES trading_trade_intents(id) ON DELETE CASCADE,
          notes TEXT NOT NULL DEFAULT '' CHECK(length(notes) <= 10000),
          tags_json TEXT NOT NULL DEFAULT '[]',
          rating INTEGER CHECK(rating IS NULL OR rating BETWEEN 1 AND 5),
          reviewed INTEGER NOT NULL DEFAULT 0 CHECK(reviewed IN (0, 1)),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS mcp_agent_proposals (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL REFERENCES mcp_agents(id) ON DELETE RESTRICT,
          session_id TEXT REFERENCES mcp_agent_sessions(id) ON DELETE RESTRICT,
          action TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          preflight_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN (
            'pending', 'approved', 'rejected', 'executing', 'completed', 'failed', 'expired'
          )),
          requested_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          decided_at INTEGER,
          decided_by TEXT,
          executed_at INTEGER,
          result_json TEXT,
          error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_exchange_events_account_time
          ON trading_exchange_events(account_id, received_at DESC);
        CREATE INDEX IF NOT EXISTS idx_exchange_events_type_time
          ON trading_exchange_events(event_type, received_at DESC);
        CREATE INDEX IF NOT EXISTS idx_journal_review
          ON trading_journal_entries(reviewed, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_mcp_proposals_state
          ON mcp_agent_proposals(status, requested_at);
      `
  },
  {
    version: 13,
    name: 'empty_factory_distribution',
    columns: [],
    sql: `
        DELETE FROM trading_strategy_versions
        WHERE name = 'Adaptive Signal'
          AND description = 'Safe default strategy using signal entries, mandatory protective stops and staged take profits.'
          AND status = 'published'
          AND version = 1
          AND configuration_sha256 = '188df2aed035a99eee664358730d99ba465d7833ec135d66dadaabe4cb96f488'
          AND NOT EXISTS (SELECT 1 FROM trading_routes WHERE strategy_version_id = trading_strategy_versions.id)
          AND NOT EXISTS (SELECT 1 FROM trading_trade_intents WHERE strategy_version_id = trading_strategy_versions.id)
          AND NOT EXISTS (SELECT 1 FROM trading_positions WHERE strategy_version_id = trading_strategy_versions.id);

        DELETE FROM trading_signal_schemas
        WHERE (
          (id = 'standard' AND name = 'Standard' AND parser_schema = 'standard'
            AND template_name = 'default' AND (contract_version_id IS NULL OR contract_version_id = 'standard:v1'))
          OR (id = 'cryptodanielvip' AND name = 'CryptoDaniel VIP' AND parser_schema = 'cryptodanielvip'
            AND template_name = 'cryptodanielvip' AND (contract_version_id IS NULL OR contract_version_id = 'cryptodanielvip:v1'))
          OR (id = 'loma' AND name = 'Loma' AND parser_schema = 'loma'
            AND template_name = 'loma' AND (contract_version_id IS NULL OR contract_version_id = 'loma:v1'))
        )
          AND NOT EXISTS (
            SELECT 1 FROM trading_strategy_versions AS strategy,
              json_each(strategy.configuration_json, '$.allowedSignalSchemas') AS schema_id
            WHERE schema_id.value = trading_signal_schemas.id
          );

        DELETE FROM trading_signal_contract_versions
        WHERE (
          (id = 'standard:v1' AND contract_id = 'standard'
            AND definition_sha256 = '475af6f7e9d0d5d7da051e63659ca4f419c38a87d2cd7443bcdab295ec3f77f1')
          OR (id = 'cryptodanielvip:v1' AND contract_id = 'cryptodanielvip'
            AND definition_sha256 = 'f9b0cf2a5c2c2a899b882338a5fd8ebd6cb0804d68f194bd2552aa115e82c4c9')
          OR (id = 'loma:v1' AND contract_id = 'loma'
            AND definition_sha256 = 'ed8bf6bf3eeda55daceef96bc0c9966b66e39086f7e384f08bf453f8e111f293')
        )
          AND status = 'published'
          AND NOT EXISTS (
            SELECT 1 FROM trading_signal_schemas
            WHERE contract_version_id = trading_signal_contract_versions.id
          );

        DELETE FROM trading_signal_contracts
        WHERE (
          (id = 'standard' AND name = 'Standard')
          OR (id = 'cryptodanielvip' AND name = 'CryptoDaniel VIP')
          OR (id = 'loma' AND name = 'Loma')
        )
          AND NOT EXISTS (
            SELECT 1 FROM trading_signal_contract_versions
            WHERE contract_id = trading_signal_contracts.id
          );

        DELETE FROM trading_accounts
        WHERE id = 'paper-default'
          AND name = 'Paper Trading'
          AND exchange = 'paper'
          AND mode = 'paper'
          AND EXISTS (
            SELECT 1 FROM trading_paper_accounts
            WHERE account_id = 'paper-default' AND equity = '10000'
              AND available_balance = '10000' AND realized_pnl = '0'
          )
          AND NOT EXISTS (SELECT 1 FROM trading_paper_markets WHERE account_id = 'paper-default')
          AND NOT EXISTS (SELECT 1 FROM trading_paper_orders WHERE account_id = 'paper-default')
          AND NOT EXISTS (SELECT 1 FROM trading_paper_fills WHERE account_id = 'paper-default')
          AND NOT EXISTS (SELECT 1 FROM trading_paper_positions WHERE account_id = 'paper-default')
          AND NOT EXISTS (SELECT 1 FROM trading_routes WHERE account_id = 'paper-default')
          AND NOT EXISTS (SELECT 1 FROM trading_trade_intents WHERE account_id = 'paper-default')
          AND NOT EXISTS (SELECT 1 FROM trading_orders WHERE account_id = 'paper-default')
          AND NOT EXISTS (SELECT 1 FROM trading_fills WHERE account_id = 'paper-default')
          AND NOT EXISTS (SELECT 1 FROM trading_positions WHERE account_id = 'paper-default')
          AND NOT EXISTS (SELECT 1 FROM trading_risk_events WHERE account_id = 'paper-default')
          AND NOT EXISTS (SELECT 1 FROM trading_reconciliation_runs WHERE account_id = 'paper-default')
          AND NOT EXISTS (SELECT 1 FROM trading_equity_snapshots WHERE account_id = 'paper-default')
          AND NOT EXISTS (SELECT 1 FROM trading_execution_events WHERE account_id = 'paper-default');
      `
  },
  {
    version: 14,
    name: 'persistent_mcp_runtime_modes',
    columns: [],
    sql: `
        CREATE TABLE IF NOT EXISTS mcp_runtime_state (
          singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
          mode TEXT NOT NULL DEFAULT 'disabled' CHECK(mode IN ('active', 'standby', 'disabled')),
          updated_at INTEGER NOT NULL,
          updated_by TEXT NOT NULL CHECK(length(updated_by) BETWEEN 1 AND 128)
        );
        INSERT OR IGNORE INTO mcp_runtime_state (
          singleton_id, mode, updated_at, updated_by
        ) VALUES (
          1, 'disabled', CAST(strftime('%s','now') AS INTEGER) * 1000, 'system:factory-default'
        );
      `
  },
  {
    version: 15,
    name: 'versioned_visual_workflows_and_account_capacity',
    columns: [],
    foreignKeysOff: true,
    sql: `
        CREATE TABLE trading_accounts_next (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
          exchange TEXT NOT NULL CHECK(exchange IN ('paper', 'hyperliquid', 'bybit', 'krakenfutures')),
          mode TEXT NOT NULL CHECK(mode IN ('paper', 'testnet', 'live')),
          status TEXT NOT NULL CHECK(status IN ('unverified', 'ready', 'disabled', 'error', 'degraded')),
          enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
          credential_ref TEXT,
          external_account_id TEXT,
          max_concurrent_positions INTEGER NOT NULL DEFAULT 20 CHECK(max_concurrent_positions BETWEEN 1 AND 20),
          kill_switch_active INTEGER NOT NULL DEFAULT 0 CHECK(kill_switch_active IN (0, 1)),
          kill_switch_reason TEXT,
          capabilities_json TEXT,
          last_verified_at INTEGER,
          last_reconciled_at INTEGER,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          CHECK((exchange = 'paper' AND mode = 'paper' AND credential_ref IS NULL)
             OR (exchange <> 'paper' AND mode <> 'paper' AND credential_ref IS NOT NULL))
        );
        INSERT INTO trading_accounts_next (
          id, name, exchange, mode, status, enabled, credential_ref, external_account_id,
          max_concurrent_positions, kill_switch_active, kill_switch_reason, capabilities_json,
          last_verified_at, last_reconciled_at, last_error, created_at, updated_at
        )
        SELECT account.id, account.name, account.exchange, account.mode, account.status,
               account.enabled, account.credential_ref, account.external_account_id,
               COALESCE((
                 SELECT MIN(CAST(json_extract(strategy.configuration_json, '$.safety.maxConcurrentPositions') AS INTEGER))
                 FROM trading_routes AS route
                 JOIN trading_strategy_versions AS strategy ON strategy.id = route.strategy_version_id
                 WHERE route.account_id = account.id
               ), 20),
               0, NULL, NULL, account.last_verified_at, NULL, account.last_error,
               account.created_at, account.updated_at
        FROM trading_accounts AS account;
        DROP TABLE trading_accounts;
        ALTER TABLE trading_accounts_next RENAME TO trading_accounts;
        CREATE UNIQUE INDEX uq_trading_external_account_identity
          ON trading_accounts(exchange, mode, external_account_id)
          WHERE external_account_id IS NOT NULL;
        CREATE INDEX idx_trading_accounts_runtime
          ON trading_accounts(enabled, status, exchange, created_at);

        CREATE TABLE workflow_resource_versions (
          id TEXT PRIMARY KEY,
          resource_id TEXT NOT NULL,
          version INTEGER NOT NULL CHECK(version > 0),
          kind TEXT NOT NULL CHECK(kind IN (
            'channel', 'content_filter', 'keyword_filter', 'regex', 'parser', 'schema',
            'contract', 'dedupe', 'strategy', 'sizing', 'adaptive_risk', 'account', 'output'
          )),
          name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
          description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 500),
          status TEXT NOT NULL CHECK(status IN ('draft', 'published', 'archived')),
          configuration_json TEXT NOT NULL,
          configuration_sha256 TEXT NOT NULL CHECK(length(configuration_sha256) = 64),
          created_at INTEGER NOT NULL,
          published_at INTEGER,
          archived_at INTEGER,
          UNIQUE(resource_id, version)
        );
        CREATE INDEX idx_workflow_resource_versions
          ON workflow_resource_versions(kind, resource_id, version DESC);
        CREATE TRIGGER trg_workflow_resource_immutable
        BEFORE UPDATE ON workflow_resource_versions
        WHEN OLD.status IN ('published', 'archived') AND (
          NEW.resource_id <> OLD.resource_id OR NEW.version <> OLD.version OR NEW.kind <> OLD.kind OR
          NEW.name <> OLD.name OR NEW.description <> OLD.description OR
          NEW.configuration_json <> OLD.configuration_json OR
          NEW.configuration_sha256 <> OLD.configuration_sha256 OR NEW.created_at <> OLD.created_at OR
          NEW.published_at IS NOT OLD.published_at
        )
        BEGIN
          SELECT RAISE(ABORT, 'published workflow resource versions are immutable');
        END;

        CREATE TABLE workflow_revisions (
          id TEXT PRIMARY KEY,
          revision INTEGER NOT NULL UNIQUE CHECK(revision > 0),
          status TEXT NOT NULL CHECK(status IN ('active', 'archived')),
          graph_json TEXT NOT NULL,
          compiled_json TEXT NOT NULL,
          definition_sha256 TEXT NOT NULL CHECK(length(definition_sha256) = 64),
          base_revision_id TEXT REFERENCES workflow_revisions(id) ON DELETE RESTRICT,
          created_by TEXT NOT NULL CHECK(length(created_by) BETWEEN 1 AND 128),
          created_at INTEGER NOT NULL,
          archived_at INTEGER
        );
        CREATE UNIQUE INDEX uq_workflow_active_revision
          ON workflow_revisions(status) WHERE status = 'active';
        CREATE TRIGGER trg_workflow_revision_immutable
        BEFORE UPDATE ON workflow_revisions
        WHEN NEW.revision <> OLD.revision OR NEW.graph_json <> OLD.graph_json OR
             NEW.compiled_json <> OLD.compiled_json OR NEW.definition_sha256 <> OLD.definition_sha256 OR
             NEW.base_revision_id IS NOT OLD.base_revision_id OR NEW.created_by <> OLD.created_by OR
             NEW.created_at <> OLD.created_at
        BEGIN
          SELECT RAISE(ABORT, 'workflow revision definitions are immutable');
        END;
        CREATE TABLE workflow_active_revision (
          singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
          revision_id TEXT NOT NULL REFERENCES workflow_revisions(id) ON DELETE RESTRICT,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE workflow_execution_paths (
          id TEXT PRIMARY KEY,
          workflow_revision_id TEXT NOT NULL REFERENCES workflow_revisions(id) ON DELETE RESTRICT,
          path_key TEXT NOT NULL CHECK(length(path_key) = 64),
          channel_id TEXT NOT NULL,
          account_id TEXT NOT NULL REFERENCES trading_accounts(id) ON DELETE RESTRICT,
          strategy_version_id TEXT NOT NULL REFERENCES trading_strategy_versions(id) ON DELETE RESTRICT,
          parser_resource_version_id TEXT REFERENCES workflow_resource_versions(id) ON DELETE RESTRICT,
          schema_resource_version_id TEXT REFERENCES workflow_resource_versions(id) ON DELETE RESTRICT,
          contract_resource_version_id TEXT REFERENCES workflow_resource_versions(id) ON DELETE RESTRICT,
          sizing_resource_version_id TEXT REFERENCES workflow_resource_versions(id) ON DELETE RESTRICT,
          adaptive_risk_resource_version_id TEXT REFERENCES workflow_resource_versions(id) ON DELETE RESTRICT,
          node_ids_json TEXT NOT NULL,
          effective_configuration_json TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
          created_at INTEGER NOT NULL,
          UNIQUE(workflow_revision_id, path_key)
        );
        CREATE INDEX idx_workflow_paths_channel
          ON workflow_execution_paths(workflow_revision_id, channel_id, enabled);
        CREATE INDEX idx_workflow_paths_account
          ON workflow_execution_paths(account_id, enabled);
        CREATE TABLE workflow_signal_runs (
          id TEXT PRIMARY KEY,
          source_signal_id TEXT NOT NULL REFERENCES signals(id) ON DELETE RESTRICT,
          workflow_revision_id TEXT REFERENCES workflow_revisions(id) ON DELETE RESTRICT,
          channel_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('received', 'running', 'completed', 'partially_blocked', 'blocked', 'failed')),
          input_sha256 TEXT NOT NULL CHECK(length(input_sha256) = 64),
          result_json TEXT,
          error TEXT,
          created_at INTEGER NOT NULL,
          completed_at INTEGER,
          UNIQUE(source_signal_id, workflow_revision_id)
        );
        CREATE INDEX idx_workflow_signal_runs_time
          ON workflow_signal_runs(created_at DESC);

        CREATE TABLE trading_trade_intents_next (
          id TEXT PRIMARY KEY,
          source_signal_id TEXT NOT NULL REFERENCES signals(id) ON DELETE RESTRICT,
          root_source_signal_id TEXT NOT NULL REFERENCES signals(id) ON DELETE RESTRICT,
          signal_run_id TEXT REFERENCES workflow_signal_runs(id) ON DELETE RESTRICT,
          workflow_revision_id TEXT REFERENCES workflow_revisions(id) ON DELETE RESTRICT,
          execution_path_id TEXT REFERENCES workflow_execution_paths(id) ON DELETE RESTRICT,
          channel_id TEXT NOT NULL,
          strategy_version_id TEXT NOT NULL REFERENCES trading_strategy_versions(id) ON DELETE RESTRICT,
          account_id TEXT NOT NULL REFERENCES trading_accounts(id) ON DELETE RESTRICT,
          exchange TEXT NOT NULL CHECK(exchange IN ('paper', 'hyperliquid', 'bybit', 'krakenfutures')),
          mode TEXT NOT NULL CHECK(mode IN ('paper', 'testnet', 'live')),
          symbol TEXT NOT NULL,
          side TEXT NOT NULL CHECK(side IN ('LONG', 'SHORT')),
          status TEXT NOT NULL CHECK(status IN ('pending', 'planned', 'submitting', 'monitoring', 'completed', 'blocked', 'failed', 'unknown')),
          signal_json TEXT NOT NULL,
          plan_json TEXT,
          block_reason TEXT,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO trading_trade_intents_next (
          id, source_signal_id, root_source_signal_id, signal_run_id, workflow_revision_id,
          execution_path_id, channel_id, strategy_version_id, account_id, exchange, mode,
          symbol, side, status, signal_json, plan_json, block_reason, last_error, created_at, updated_at
        )
        SELECT id, source_signal_id, source_signal_id, NULL, NULL, NULL, channel_id,
               strategy_version_id, account_id, exchange, mode, symbol, side, status,
               signal_json, plan_json, block_reason, last_error, created_at, updated_at
        FROM trading_trade_intents;
        DROP TABLE trading_trade_intents;
        ALTER TABLE trading_trade_intents_next RENAME TO trading_trade_intents;
        CREATE INDEX idx_trading_intents_status
          ON trading_trade_intents(status, created_at);
        CREATE INDEX idx_trading_intents_account_status
          ON trading_trade_intents(account_id, status, created_at);
        CREATE UNIQUE INDEX uq_trading_intent_execution_path
          ON trading_trade_intents(root_source_signal_id, execution_path_id)
          WHERE execution_path_id IS NOT NULL;

        CREATE TABLE trading_exchange_events_next (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES trading_accounts(id) ON DELETE RESTRICT,
          exchange TEXT NOT NULL CHECK(exchange IN ('hyperliquid', 'bybit', 'krakenfutures')),
          mode TEXT NOT NULL CHECK(mode IN ('testnet', 'live')),
          event_key TEXT NOT NULL CHECK(length(event_key) = 64),
          event_type TEXT NOT NULL CHECK(event_type IN ('order', 'execution', 'position', 'market', 'candle', 'stream_status')),
          symbol TEXT,
          sequence INTEGER,
          occurred_at INTEGER NOT NULL,
          received_at INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          UNIQUE(account_id, event_key)
        );
        INSERT INTO trading_exchange_events_next
        SELECT * FROM trading_exchange_events;
        DROP TABLE trading_exchange_events;
        ALTER TABLE trading_exchange_events_next RENAME TO trading_exchange_events;
        CREATE INDEX idx_exchange_events_account_time
          ON trading_exchange_events(account_id, received_at DESC);
        CREATE INDEX idx_exchange_events_type_time
          ON trading_exchange_events(event_type, received_at DESC);
      `
  },
  {
    version: 16,
    name: 'path_isolated_adaptive_risk',
    columns: [],
    sql: `
        CREATE TABLE workflow_adaptive_risk_state (
          state_key TEXT PRIMARY KEY CHECK(length(state_key) = 64),
          channel_id TEXT NOT NULL,
          account_id TEXT NOT NULL REFERENCES trading_accounts(id) ON DELETE RESTRICT,
          resource_id TEXT NOT NULL,
          current_tier INTEGER NOT NULL CHECK(current_tier >= 0),
          locked_tier INTEGER,
          blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0, 1)),
          block_reason TEXT,
          policy_sha256 TEXT NOT NULL CHECK(length(policy_sha256) = 64),
          updated_at INTEGER NOT NULL,
          UNIQUE(channel_id, account_id, resource_id)
        );
        CREATE TABLE workflow_adaptive_risk_evaluations (
          id TEXT PRIMARY KEY,
          state_key TEXT NOT NULL REFERENCES workflow_adaptive_risk_state(state_key) ON DELETE RESTRICT,
          policy_sha256 TEXT NOT NULL CHECK(length(policy_sha256) = 64),
          week_started_at INTEGER NOT NULL,
          week_ended_at INTEGER NOT NULL,
          closed_trades INTEGER NOT NULL,
          wins INTEGER NOT NULL,
          losses INTEGER NOT NULL,
          realized_pnl TEXT NOT NULL,
          starting_equity TEXT NOT NULL,
          return_percent TEXT NOT NULL,
          previous_tier INTEGER NOT NULL,
          recommended_tier INTEGER NOT NULL,
          applied_tier INTEGER NOT NULL,
          action TEXT NOT NULL CHECK(action IN ('hold', 'increase', 'decrease', 'block')),
          reason TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE(state_key, policy_sha256, week_started_at)
        );
        CREATE INDEX idx_workflow_adaptive_risk_evaluations
          ON workflow_adaptive_risk_evaluations(state_key, week_ended_at DESC);
      `
  },
  {
    version: 17,
    name: 'account_protection_incidents',
    columns: [],
    sql: `
        CREATE TABLE trading_account_incidents (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES trading_accounts(id) ON DELETE RESTRICT,
          fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64),
          category TEXT NOT NULL,
          severity TEXT NOT NULL CHECK(severity IN ('warning', 'critical')),
          message TEXT NOT NULL,
          details_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('open', 'resolved')),
          occurrence_count INTEGER NOT NULL CHECK(occurrence_count >= 1),
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          resolved_at INTEGER
        );
        CREATE UNIQUE INDEX uq_trading_account_incident_open
          ON trading_account_incidents(account_id, fingerprint)
          WHERE status = 'open';
        CREATE INDEX idx_trading_account_incident_status
          ON trading_account_incidents(account_id, status, last_seen_at DESC);
      `
  },
  {
    version: 18,
    name: 'ordered_account_fallback_execution',
    columns: [
      { table: 'workflow_execution_paths', name: 'route_group_key', sqlDefinition: 'TEXT' },
      { table: 'workflow_execution_paths', name: 'fallback_rank', sqlDefinition: 'INTEGER NOT NULL DEFAULT 0' },
    ],
    sql: `
        CREATE INDEX IF NOT EXISTS idx_workflow_paths_route_group
          ON workflow_execution_paths(workflow_revision_id, route_group_key, fallback_rank);
        CREATE TABLE trading_fallback_runs (
          id TEXT PRIMARY KEY,
          source_signal_id TEXT NOT NULL REFERENCES signals(id) ON DELETE RESTRICT,
          workflow_revision_id TEXT NOT NULL REFERENCES workflow_revisions(id) ON DELETE RESTRICT,
          signal_run_id TEXT NOT NULL REFERENCES workflow_signal_runs(id) ON DELETE RESTRICT,
          route_group_key TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('probing', 'selected', 'exhausted', 'stopped')),
          current_rank INTEGER NOT NULL DEFAULT 0 CHECK(current_rank >= 0),
          selected_intent_id TEXT REFERENCES trading_trade_intents(id) ON DELETE RESTRICT,
          stop_reason TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          completed_at INTEGER,
          UNIQUE(source_signal_id, workflow_revision_id, route_group_key)
        );
        CREATE INDEX idx_trading_fallback_runs_status
          ON trading_fallback_runs(status, updated_at DESC);
        CREATE TABLE trading_fallback_candidates (
          fallback_run_id TEXT NOT NULL REFERENCES trading_fallback_runs(id) ON DELETE CASCADE,
          rank INTEGER NOT NULL CHECK(rank >= 0),
          execution_path_id TEXT NOT NULL REFERENCES workflow_execution_paths(id) ON DELETE RESTRICT,
          account_id TEXT NOT NULL REFERENCES trading_accounts(id) ON DELETE RESTRICT,
          intent_id TEXT REFERENCES trading_trade_intents(id) ON DELETE RESTRICT,
          status TEXT NOT NULL CHECK(status IN ('waiting', 'pending', 'unavailable', 'selected', 'stopped')),
          error_code TEXT,
          details_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(fallback_run_id, rank),
          UNIQUE(fallback_run_id, execution_path_id),
          UNIQUE(intent_id)
        );
        CREATE INDEX idx_trading_fallback_candidates_account
          ON trading_fallback_candidates(account_id, status, updated_at DESC);
      `
  },
  {
    version: 19,
    name: 'dynamic_ccxt_exchange_registry',
    columns: [],
    foreignKeysOff: true,
    sql: `
        CREATE TABLE trading_accounts_next (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
          exchange TEXT NOT NULL CHECK(length(exchange) BETWEEN 1 AND 64),
          mode TEXT NOT NULL CHECK(mode IN ('paper', 'testnet', 'live')),
          status TEXT NOT NULL CHECK(status IN ('unverified', 'ready', 'disabled', 'error', 'degraded')),
          enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
          credential_ref TEXT,
          external_account_id TEXT,
          max_concurrent_positions INTEGER NOT NULL DEFAULT 20 CHECK(max_concurrent_positions BETWEEN 1 AND 20),
          kill_switch_active INTEGER NOT NULL DEFAULT 0 CHECK(kill_switch_active IN (0, 1)),
          kill_switch_reason TEXT,
          capabilities_json TEXT,
          last_verified_at INTEGER,
          last_reconciled_at INTEGER,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          CHECK((exchange = 'paper' AND mode = 'paper' AND credential_ref IS NULL)
             OR (exchange <> 'paper' AND mode <> 'paper' AND credential_ref IS NOT NULL))
        );
        INSERT INTO trading_accounts_next (
          id, name, exchange, mode, status, enabled, credential_ref, external_account_id,
          max_concurrent_positions, kill_switch_active, kill_switch_reason, capabilities_json,
          last_verified_at, last_reconciled_at, last_error, created_at, updated_at
        )
        SELECT id, name, exchange, mode, status, enabled, credential_ref, external_account_id,
               max_concurrent_positions, kill_switch_active, kill_switch_reason, capabilities_json,
               last_verified_at, last_reconciled_at, last_error, created_at, updated_at
        FROM trading_accounts;
        DROP TABLE trading_accounts;
        ALTER TABLE trading_accounts_next RENAME TO trading_accounts;
        CREATE UNIQUE INDEX uq_trading_external_account_identity
          ON trading_accounts(exchange, mode, external_account_id)
          WHERE external_account_id IS NOT NULL;
        CREATE INDEX idx_trading_accounts_runtime
          ON trading_accounts(enabled, status, exchange, created_at);

        CREATE TABLE trading_trade_intents_next (
          id TEXT PRIMARY KEY,
          source_signal_id TEXT NOT NULL REFERENCES signals(id) ON DELETE RESTRICT,
          root_source_signal_id TEXT NOT NULL REFERENCES signals(id) ON DELETE RESTRICT,
          signal_run_id TEXT REFERENCES workflow_signal_runs(id) ON DELETE RESTRICT,
          workflow_revision_id TEXT REFERENCES workflow_revisions(id) ON DELETE RESTRICT,
          execution_path_id TEXT REFERENCES workflow_execution_paths(id) ON DELETE RESTRICT,
          channel_id TEXT NOT NULL,
          strategy_version_id TEXT NOT NULL REFERENCES trading_strategy_versions(id) ON DELETE RESTRICT,
          account_id TEXT NOT NULL REFERENCES trading_accounts(id) ON DELETE RESTRICT,
          exchange TEXT NOT NULL CHECK(length(exchange) BETWEEN 1 AND 64),
          mode TEXT NOT NULL CHECK(mode IN ('paper', 'testnet', 'live')),
          symbol TEXT NOT NULL,
          side TEXT NOT NULL CHECK(side IN ('LONG', 'SHORT')),
          status TEXT NOT NULL CHECK(status IN ('pending', 'planned', 'submitting', 'monitoring', 'completed', 'blocked', 'failed', 'unknown')),
          signal_json TEXT NOT NULL,
          plan_json TEXT,
          block_reason TEXT,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO trading_trade_intents_next
        SELECT * FROM trading_trade_intents;
        DROP TABLE trading_trade_intents;
        ALTER TABLE trading_trade_intents_next RENAME TO trading_trade_intents;
        CREATE INDEX idx_trading_intents_status
          ON trading_trade_intents(status, created_at);
        CREATE INDEX idx_trading_intents_account_status
          ON trading_trade_intents(account_id, status, created_at);
        CREATE UNIQUE INDEX uq_trading_intent_execution_path
          ON trading_trade_intents(root_source_signal_id, execution_path_id)
          WHERE execution_path_id IS NOT NULL;

        CREATE TABLE trading_exchange_events_next (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES trading_accounts(id) ON DELETE RESTRICT,
          exchange TEXT NOT NULL CHECK(length(exchange) BETWEEN 1 AND 64 AND exchange <> 'paper'),
          mode TEXT NOT NULL CHECK(mode IN ('testnet', 'live')),
          event_key TEXT NOT NULL CHECK(length(event_key) = 64),
          event_type TEXT NOT NULL CHECK(event_type IN ('order', 'execution', 'position', 'market', 'candle', 'stream_status')),
          symbol TEXT,
          sequence INTEGER,
          occurred_at INTEGER NOT NULL,
          received_at INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          UNIQUE(account_id, event_key)
        );
        INSERT INTO trading_exchange_events_next
        SELECT * FROM trading_exchange_events;
        DROP TABLE trading_exchange_events;
        ALTER TABLE trading_exchange_events_next RENAME TO trading_exchange_events;
        CREATE INDEX idx_exchange_events_account_time
          ON trading_exchange_events(account_id, received_at DESC);
        CREATE INDEX idx_exchange_events_type_time
          ON trading_exchange_events(event_type, received_at DESC);
      `
  },
  {
    version: 20,
    name: 'server_persistent_workflow_builder_history',
    columns: [],
    sql: `
        CREATE TABLE workflow_builder_history (
          singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
          undo_json TEXT NOT NULL DEFAULT '[]',
          redo_json TEXT NOT NULL DEFAULT '[]',
          updated_at INTEGER NOT NULL
        );
        INSERT INTO workflow_builder_history (
          singleton_id, undo_json, redo_json, updated_at
        ) VALUES (
          1, '[]', '[]', CAST(strftime('%s','now') AS INTEGER) * 1000
        );
      `
  },
  {
    version: 21,
    name: 'trading_notification_and_telegram_viewer_support',
    columns: [],
    sql: `
        CREATE TABLE trading_notification_events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          dedupe_key TEXT NOT NULL UNIQUE,
          event_type TEXT NOT NULL,
          intent_id TEXT,
          channel_id TEXT,
          account_id TEXT,
          exchange TEXT,
          mode TEXT,
          occurred_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          details_json TEXT NOT NULL
        );
        CREATE INDEX idx_trading_notification_events_created
          ON trading_notification_events(seq);
        CREATE INDEX idx_trading_notification_events_type_time
          ON trading_notification_events(event_type, occurred_at DESC);

        CREATE TABLE telegram_viewer_test_events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          created_by TEXT NOT NULL,
          message TEXT NOT NULL
        );
        CREATE INDEX idx_telegram_viewer_test_events_created
          ON telegram_viewer_test_events(seq);
      `
  }
];

export const LATEST_SCHEMA_VERSION = migrations.length;

function migrationChecksum(migration: SchemaMigration): string {
  return createHash('sha256')
    .update(JSON.stringify({
      version: migration.version,
      name: migration.name,
      columns: migration.columns,
      sql: migration.sql,
      ...(migration.foreignKeysOff ? { foreignKeysOff: true } : {}),
    }))
    .digest('hex');
}

export interface DatabaseMigrationDescriptor {
  version: number;
  name: string;
  checksum: string;
}

export function expectedDatabaseMigrations(): DatabaseMigrationDescriptor[] {
  return migrations.map(migration => ({
    version: migration.version,
    name: migration.name,
    checksum: migrationChecksum(migration)
  }));
}

async function applyMigration(database: Database, migration: SchemaMigration): Promise<void> {
  for (const column of migration.columns) {
    await ensureColumn(database, column.table, column.name, column.sqlDefinition);
  }
  await database.exec(migration.sql);
}

function validateAppliedMigrations(applied: Array<{ version: number; name: string; checksum: string }>): void {
  if (applied.some(record => record.version > LATEST_SCHEMA_VERSION)) {
    throw new Error(`Database schema is newer than this binary (supported version ${LATEST_SCHEMA_VERSION}).`);
  }
  for (let index = 0; index < applied.length; index += 1) {
    const record = applied[index];
    const migration = migrations[index];
    if (!migration || record.version !== migration.version) {
      throw new Error('Database migration history is non-contiguous or out of order.');
    }
    if (record.name !== migration.name || record.checksum !== migrationChecksum(migration)) {
      throw new Error(`Database migration ${record.version} checksum or name does not match this binary.`);
    }
  }
}

async function applyPendingMigration(database: Database, migration: SchemaMigration): Promise<void> {
  if (migration.foreignKeysOff) await database.exec('PRAGMA foreign_keys = OFF;');
  await database.exec('BEGIN IMMEDIATE;');
  try {
    await applyMigration(database, migration);
    if (migration.foreignKeysOff) {
      const violations = await database.all<Array<Record<string, unknown>>>('PRAGMA foreign_key_check;');
      if (violations.length > 0) throw new Error(`Foreign-key validation found ${violations.length} violation(s).`);
    }
    await database.run(
      'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
      [migration.version, migration.name, migrationChecksum(migration), Date.now()]
    );
    await database.exec('COMMIT;');
  } catch (error) {
    await database.exec('ROLLBACK;').catch(() => {});
    throw new Error(`Database migration ${migration.version} (${migration.name}) failed.`, { cause: error });
  } finally {
    if (migration.foreignKeysOff) await database.exec('PRAGMA foreign_keys = ON;');
  }
}

async function migrateDatabase(database: Database, beforeApply?: (fromVersion: number) => Promise<void>): Promise<void> {
  await database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  const applied = await database.all<Array<{ version: number; name: string; checksum: string }>>(
    'SELECT version, name, checksum FROM schema_migrations ORDER BY version'
  );
  validateAppliedMigrations(applied);
  if (applied.length < migrations.length && beforeApply) await beforeApply(applied.length);
  for (const migration of migrations.slice(applied.length)) {
    await applyPendingMigration(database, migration);
  }
}

async function copyDatabase(database: Database, destinationPath: string): Promise<void> {
  const resolvedDestination = path.resolve(destinationPath);
  await mkdir(path.dirname(resolvedDestination), { recursive: true });
  const destinationExists = await stat(resolvedDestination).then(() => true).catch((error: any) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (destinationExists) throw new Error(`Database copy destination already exists: ${resolvedDestination}`);
  const nativeDatabase: any = database.getDatabaseInstance();
  const backup: any = await new Promise((resolve, reject) => {
    const operation = nativeDatabase.backup(resolvedDestination, (error: Error | null) => {
      if (error) reject(error);
      else resolve(operation);
    });
  });
  await new Promise<void>((resolve, reject) => {
    backup.step(-1, (error: Error | null, completed: boolean) => {
      if (error) reject(error);
      else if (!completed || !backup.completed) reject(new Error('SQLite backup did not complete.'));
      else resolve();
    });
  });
}

async function verifyDatabaseIntegrity(databasePath: string): Promise<void> {
  const inspection = await open({
    filename: path.resolve(databasePath),
    driver: sqlite3.Database,
    mode: sqlite3.OPEN_READONLY
  });
  try {
    const result = await inspection.get<{ integrity_check: string }>('PRAGMA integrity_check;');
    if (result?.integrity_check !== 'ok') throw new Error(`SQLite integrity_check failed: ${result?.integrity_check || 'no result'}`);
  } finally {
    await inspection.close();
  }
}

async function createPreMigrationSnapshot(database: Database, databasePath: string, fromVersion: number): Promise<string> {
  const snapshotDirectory = path.join(path.dirname(path.resolve(databasePath)), '.migration-backups');
  const snapshotPath = path.join(
    snapshotDirectory,
    `pre-migration-v${fromVersion}-to-v${LATEST_SCHEMA_VERSION}-${Date.now()}-${randomUUID().slice(0, 8)}.db`
  );
  await copyDatabase(database, snapshotPath);
  await verifyDatabaseIntegrity(snapshotPath);
  return snapshotPath;
}

export async function initDb(
  dbPath = process.env.FORWARDER_DB_PATH || path.join(process.cwd(), 'session_data', 'forwarder.db')
): Promise<void> {
  if (db) {
    throw new Error('Database is already initialized. Call closeDb() before reinitializing.');
  }
  const resolvedDbPath = path.resolve(dbPath);
  const databaseExisted = await stat(resolvedDbPath).then(stats => stats.isFile() && stats.size > 0).catch((error: any) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  await mkdir(path.dirname(resolvedDbPath), { recursive: true });
  const openedDatabase = await open({
    filename: resolvedDbPath,
    driver: sqlite3.Database
  });
  try {
    await openedDatabase.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
    `);
    await migrateDatabase(openedDatabase, databaseExisted
      ? async fromVersion => {
          const snapshot = await createPreMigrationSnapshot(openedDatabase, resolvedDbPath, fromVersion);
          console.log(`[INFO] Verified pre-migration database snapshot created: ${snapshot}`);
        }
      : undefined);
    db = openedDatabase;
    guardedDb = createGuardedDatabase(openedDatabase);
  } catch (error) {
    await openedDatabase.close().catch(() => {});
    db = null;
    guardedDb = null;
    throw error;
  }
}

export async function getSchemaVersion(): Promise<number> {
  const row = await getDb().get<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations');
  return Number(row?.version || 0);
}

export async function closeDb(): Promise<void> {
  await serializedDatabaseAccess.execute(async () => {
    if (!db) return;
    const database = db;
    db = null;
    guardedDb = null;
    await database.close();
  });
}

export async function backupDatabase(destinationPath: string): Promise<void> {
  if (databaseMaintenanceReason) throw new Error(`Database maintenance is active: ${databaseMaintenanceReason}`);
  await serializedDatabaseAccess.execute(() => copyDatabase(rawDatabase(), destinationPath));
}

async function pathExists(filePath: string): Promise<boolean> {
  return stat(filePath).then(() => true).catch((error: any) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

interface PreservedDatabaseSet {
  previousDatabase: string | null;
  sidecars: Array<{ original: string; preserved: string }>;
}

async function validateMigrationRestoreRequest(snapshot: string, target: string, stateDirectory: string): Promise<void> {
  if (db) throw new Error('Migration snapshot restore requires the database connection to be closed.');
  if (snapshot === target) throw new Error('Migration snapshot and target database must be different files.');
  const snapshotStats = await stat(snapshot);
  if (!snapshotStats.isFile() || snapshotStats.size < 1) throw new Error('Migration snapshot must be a non-empty regular file.');
  for (const lockName of ['.process_active', '.routing_active']) {
    if (await pathExists(path.join(stateDirectory, lockName))) {
      throw new Error(`Migration restore refused while '${lockName}' exists.`);
    }
  }
  await verifyDatabaseIntegrity(snapshot);
}

async function preserveDatabaseSet(target: string, restoreId: string): Promise<PreservedDatabaseSet> {
  const preservationBase = `${target}.pre-migration-restore-${restoreId}`;
  const previousDatabase = await pathExists(target) ? preservationBase : null;
  if (previousDatabase) await rename(target, previousDatabase);
  const sidecars: PreservedDatabaseSet['sidecars'] = [];
  for (const suffix of ['-wal', '-shm']) {
    const original = `${target}${suffix}`;
    if (await pathExists(original)) {
      const preserved = `${preservationBase}${suffix}`;
      await rename(original, preserved);
      sidecars.push({ original, preserved });
    }
  }
  return { previousDatabase, sidecars };
}

async function rollbackMigrationRestore(
  target: string,
  temporary: string,
  preserved: PreservedDatabaseSet,
  installed: boolean
): Promise<void> {
  if (installed) await rm(target, { force: true });
  if (preserved.previousDatabase && await pathExists(preserved.previousDatabase)) {
    await rename(preserved.previousDatabase, target);
  }
  for (const sidecar of preserved.sidecars.slice().reverse()) {
    if (await pathExists(sidecar.preserved)) await rename(sidecar.preserved, sidecar.original);
  }
  await rm(temporary, { force: true });
}

export async function restorePreMigrationSnapshot(
  snapshotPath: string,
  targetDatabasePath = process.env.FORWARDER_DB_PATH || path.join(process.cwd(), 'session_data', 'forwarder.db'),
  stateDirectory = path.dirname(path.resolve(targetDatabasePath))
): Promise<{ previousDatabase: string | null }> {
  const snapshot = path.resolve(snapshotPath);
  const target = path.resolve(targetDatabasePath);
  await validateMigrationRestoreRequest(snapshot, target, path.resolve(stateDirectory));
  await mkdir(path.dirname(target), { recursive: true });
  const restoreId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const temporary = `${target}.migration-restore-${restoreId}.tmp`;
  let preserved: PreservedDatabaseSet = { previousDatabase: null, sidecars: [] };
  let installed = false;
  try {
    await copyFile(snapshot, temporary);
    await verifyDatabaseIntegrity(temporary);
    preserved = await preserveDatabaseSet(target, restoreId);
    await rename(temporary, target);
    installed = true;
    return { previousDatabase: preserved.previousDatabase };
  } catch (error) {
    await rollbackMigrationRestore(target, temporary, preserved, installed);
    throw error;
  }
}

// Helper to make sure db is initialized
export function getDatabase(): Database {
  if (!guardedDb) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  if (databaseMaintenanceReason && !serializedDatabaseAccess.isOwnedByCurrentOperation()) {
    throw new Error(`Database maintenance is active: ${databaseMaintenanceReason}`);
  }
  return guardedDb;
}

const getDb = getDatabase;

function rawDatabase(): Database {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

/** Runs a complete unit of work under the single SQLite transaction owner. */
export async function withDatabaseTransaction<T>(
  operation: (database: Database) => Promise<T>
): Promise<T> {
  if (serializedDatabaseAccess.isOwnedByCurrentOperation()) return operation(getDatabase());
  if (databaseMaintenanceReason) throw new Error(`Database maintenance is active: ${databaseMaintenanceReason}`);
  return serializedDatabaseAccess.execute(async () => {
    const database = rawDatabase();
    await database.exec('BEGIN IMMEDIATE');
    try {
      const result = await operation(getDatabase());
      await database.exec('COMMIT');
      return result;
    } catch (error) {
      await database.exec('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
}

export async function getTotalForwardedCount(): Promise<number> {
  const row = await getDatabase().get<{ value: number }>(
    `SELECT value FROM forwarding_stats WHERE key = 'total_forwarded_count'`
  );
  return Number(row?.value || 0);
}

export async function getLastForwardedAt(): Promise<number | null> {
  const row = await getDb().get<{ value: number }>(
    `SELECT value FROM forwarding_stats WHERE key = 'last_forwarded_at'`
  );
  const value = Number(row?.value || 0);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export async function incrementForwardedCount(amount = 1, forwardedAt = Date.now()): Promise<void> {
  const increment = Math.max(0, Math.floor(amount));
  if (increment === 0) return;
  if (!Number.isSafeInteger(forwardedAt) || forwardedAt <= 0) throw new Error('forwardedAt must be a positive timestamp.');
  await getDb().run(
    `UPDATE forwarding_stats
     SET value = CASE
       WHEN key = 'total_forwarded_count' THEN value + ?
       WHEN key = 'last_forwarded_at' THEN MAX(value, ?)
       ELSE value
     END
     WHERE key IN ('total_forwarded_count', 'last_forwarded_at')`,
    [increment, forwardedAt]
  );
}

// Signals Deduplication API
function signalProvenanceParameters(provenance?: SignalProvenance): Array<string | number | null> {
  const source: Partial<SignalProvenance> = provenance ?? {};
  return [
    source.templateName || null,
    source.schemaName || null,
    source.promptSha256 || null,
    source.model || null,
    source.providerRequestId || null,
    source.promptTokens ?? null,
    source.completionTokens ?? null,
    source.parserVersion || null
  ];
}

export async function saveSignal(
  id: string,
  chatId: string,
  messageId: number,
  xmlContent: string,
  normalizedContent: string,
  provenance?: SignalProvenance
): Promise<void> {
  const database = getDb();
  await database.run(
    `INSERT OR REPLACE INTO signals (
       id, chat_id, message_id, xml_content, normalized_content, created_at,
       template_name, schema_name, prompt_sha256, model, provider_request_id,
       prompt_tokens, completion_tokens, parser_version
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, chatId, messageId, xmlContent, normalizedContent, Date.now(),
      ...signalProvenanceParameters(provenance)
    ]
  );
}

export async function reserveAiUsage(
  usageDay: string,
  tokenAllowance: number,
  dailyRequestLimit: number,
  dailyTokenLimit: number
): Promise<boolean> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(usageDay)) throw new Error('usageDay must use YYYY-MM-DD.');
  if (![tokenAllowance, dailyRequestLimit, dailyTokenLimit].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('AI usage limits must be positive safe integers.');
  }
  const database = getDb();
  const now = Date.now();
  await database.run(
    `INSERT OR IGNORE INTO ai_usage_daily (usage_day, request_count, used_tokens, reserved_tokens, updated_at)
     VALUES (?, 0, 0, 0, ?)`,
    [usageDay, now]
  );
  const result = await database.run(
    `UPDATE ai_usage_daily
     SET request_count = request_count + 1,
         reserved_tokens = reserved_tokens + ?,
         updated_at = ?
     WHERE usage_day = ?
       AND request_count < ?
       AND used_tokens + reserved_tokens + ? <= ?`,
    [tokenAllowance, now, usageDay, dailyRequestLimit, tokenAllowance, dailyTokenLimit]
  );
  return Number(result.changes || 0) === 1;
}

export async function commitAiUsage(usageDay: string, tokenAllowance: number, actualTokens: number): Promise<void> {
  const safeActual = Number.isSafeInteger(actualTokens) && actualTokens >= 0 ? actualTokens : tokenAllowance;
  const result = await getDb().run(
    `UPDATE ai_usage_daily
     SET reserved_tokens = MAX(0, reserved_tokens - ?),
         used_tokens = used_tokens + ?,
         updated_at = ?
     WHERE usage_day = ?`,
    [tokenAllowance, safeActual, Date.now(), usageDay]
  );
  if (Number(result.changes || 0) !== 1) throw new Error(`No AI usage reservation exists for ${usageDay}.`);
}

export async function getAiUsage(usageDay: string): Promise<{ requestCount: number; usedTokens: number; reservedTokens: number }> {
  const row = await getDb().get<any>(
    `SELECT request_count, used_tokens, reserved_tokens FROM ai_usage_daily WHERE usage_day = ?`,
    [usageDay]
  );
  return {
    requestCount: Number(row?.request_count || 0),
    usedTokens: Number(row?.used_tokens || 0),
    reservedTokens: Number(row?.reserved_tokens || 0)
  };
}

export async function getOutboxStatusCounts(): Promise<Record<OutboxStatus, number>> {
  const counts: Record<OutboxStatus, number> = {
    pending: 0,
    preparing: 0,
    sending: 0,
    completed: 0,
    failed: 0,
    unknown: 0
  };
  const rows = await getDb().all<Array<{ status: OutboxStatus; count: number }>>(
    `SELECT status, COUNT(*) AS count FROM pending_tasks GROUP BY status`
  );
  for (const row of rows) {
    if (row.status in counts) counts[row.status] = Number(row.count || 0);
  }
  return counts;
}

export async function getOldestPendingOutboxAgeSeconds(now = Date.now()): Promise<number> {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Outbox age timestamp must be a non-negative safe integer.');
  const row = await getDb().get<{ oldest: number | null }>(
    `SELECT MIN(added_at) AS oldest FROM pending_tasks WHERE status IN ('pending', 'preparing', 'sending')`
  );
  if (row?.oldest === null || row?.oldest === undefined) return 0;
  const oldest = Number(row.oldest);
  if (!Number.isSafeInteger(oldest) || oldest < 0 || oldest > now) return 0;
  return Math.floor((now - oldest) / 1000);
}

export async function getDatabaseStorageStats(): Promise<DatabaseStorageStats> {
  const database = getDb();
  const pageCount = await database.get<{ page_count: number }>('PRAGMA page_count');
  const pageSize = await database.get<{ page_size: number }>('PRAGMA page_size');
  const freeList = await database.get<{ freelist_count: number }>('PRAGMA freelist_count');
  const size = Number(pageSize?.page_size || 0);
  return {
    allocatedBytes: Number(pageCount?.page_count || 0) * size,
    reusableBytes: Number(freeList?.freelist_count || 0) * size
  };
}

function retentionResult(changes: Array<number | undefined>): OperationalRetentionResult {
  return {
    incomingMessages: changes[0] || 0,
    signals: changes[1] || 0,
    completedOutbox: changes[2] || 0,
    aiUsageDays: changes[3] || 0,
    tradingIntents: changes[4] || 0,
    tradingReconciliations: changes[5] || 0,
    paperOrders: changes[6] || 0
  };
}

async function prepareTradingRetentionCandidates(
  database: Database,
  cutoff: number,
  batchSize: number,
): Promise<void> {
  await database.exec(`
    DROP TABLE IF EXISTS temp.retention_trade_intents;
    DROP TABLE IF EXISTS temp.retention_workflow_signal_runs;
    CREATE TEMP TABLE retention_trade_intents (id TEXT PRIMARY KEY);
    CREATE TEMP TABLE retention_workflow_signal_runs (id TEXT PRIMARY KEY);
  `);
  await database.run(
    `INSERT INTO retention_trade_intents (id)
     SELECT id FROM trading_trade_intents
     WHERE status IN ('completed', 'blocked', 'failed') AND updated_at < ?
       AND NOT EXISTS (
         SELECT 1 FROM trading_risk_events AS risk
         WHERE risk.intent_id = trading_trade_intents.id
           AND risk.severity = 'critical' AND risk.acknowledged_at IS NULL
       )
       AND NOT EXISTS (
         SELECT 1 FROM trading_journal_entries AS journal
         WHERE journal.intent_id = trading_trade_intents.id
       )
     ORDER BY updated_at ASC LIMIT ?`,
    [cutoff, batchSize]
  );
  await database.run(
    `DELETE FROM retention_trade_intents
     WHERE id IN (
       SELECT candidate.intent_id
       FROM trading_fallback_candidates AS candidate
       JOIN trading_fallback_runs AS run ON run.id = candidate.fallback_run_id
       WHERE candidate.intent_id IS NOT NULL
         AND (
           run.status = 'probing'
           OR EXISTS (
             SELECT 1
             FROM trading_fallback_candidates AS sibling
             WHERE sibling.fallback_run_id = candidate.fallback_run_id
               AND sibling.intent_id IS NOT NULL
               AND sibling.intent_id NOT IN (SELECT id FROM retention_trade_intents)
           )
         )
       )`,
  );
}

async function deleteRetainedWorkflowState(database: Database): Promise<void> {
  await database.run(
    `INSERT OR IGNORE INTO retention_workflow_signal_runs (id)
     SELECT DISTINCT signal_run_id
     FROM trading_trade_intents
     WHERE id IN (SELECT id FROM retention_trade_intents)
       AND signal_run_id IS NOT NULL`,
  );
  await database.run(
    `DELETE FROM trading_fallback_runs
     WHERE status IN ('selected', 'exhausted', 'stopped')
       AND EXISTS (
         SELECT 1 FROM trading_fallback_candidates AS candidate
         WHERE candidate.fallback_run_id = trading_fallback_runs.id
           AND candidate.intent_id IN (SELECT id FROM retention_trade_intents)
       )
       AND NOT EXISTS (
         SELECT 1 FROM trading_fallback_candidates AS candidate
         WHERE candidate.fallback_run_id = trading_fallback_runs.id
           AND candidate.intent_id IS NOT NULL
           AND candidate.intent_id NOT IN (SELECT id FROM retention_trade_intents)
       )`,
  );
}

async function pruneTradingData(database: Database, cutoff: number, batchSize: number): Promise<Array<number | undefined>> {
  await prepareTradingRetentionCandidates(database, cutoff, batchSize);
  await deleteRetainedWorkflowState(database);
  await database.run('DELETE FROM trading_risk_events WHERE intent_id IN (SELECT id FROM retention_trade_intents)');
  await database.run(`DELETE FROM trading_fills WHERE order_id IN (
    SELECT id FROM trading_orders WHERE intent_id IN (SELECT id FROM retention_trade_intents)
  )`);
  await database.run('DELETE FROM trading_orders WHERE intent_id IN (SELECT id FROM retention_trade_intents)');
  await database.run('DELETE FROM trading_positions WHERE intent_id IN (SELECT id FROM retention_trade_intents)');
  const intents = await database.run('DELETE FROM trading_trade_intents WHERE id IN (SELECT id FROM retention_trade_intents)');
  await database.run(
    `DELETE FROM workflow_signal_runs
     WHERE id IN (SELECT id FROM retention_workflow_signal_runs)
       AND NOT EXISTS (
         SELECT 1 FROM trading_trade_intents AS intent
         WHERE intent.signal_run_id = workflow_signal_runs.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM trading_fallback_runs AS run
         WHERE run.signal_run_id = workflow_signal_runs.id
       )`,
  );
  const reconciliations = await database.run(
    `DELETE FROM trading_reconciliation_runs WHERE id IN (
       SELECT id FROM trading_reconciliation_runs
       WHERE status = 'succeeded' AND completed_at < ?
       ORDER BY completed_at ASC LIMIT ?
     )`,
    [cutoff, batchSize]
  );
  const paperOrders = await database.run(
    `DELETE FROM trading_paper_orders WHERE exchange_order_id IN (
       SELECT exchange_order_id FROM trading_paper_orders
       WHERE status IN ('filled', 'cancelled', 'rejected') AND updated_at < ?
       ORDER BY updated_at ASC LIMIT ?
     )`,
    [cutoff, batchSize]
  );
  await database.run(
    `DELETE FROM trading_exchange_events WHERE id IN (
       SELECT id FROM trading_exchange_events
       WHERE received_at < ? ORDER BY received_at ASC LIMIT ?
     )`,
    [cutoff, batchSize],
  );
  return [intents.changes, reconciliations.changes, paperOrders.changes];
}

export async function pruneOperationalData(
  retentionDays: number,
  batchSize: number,
  now = Date.now()
): Promise<OperationalRetentionResult> {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 3_650) {
    throw new Error('Operational data retention must be between 1 and 3650 days.');
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 100 || batchSize > 10_000) {
    throw new Error('Operational data retention batch size must be between 100 and 10000.');
  }
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error('Retention timestamp is invalid.');

  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  const cutoffDay = new Date(cutoff).toISOString().slice(0, 10);
  const result = await withDatabaseTransaction(async database => {
    const tradingChanges = await pruneTradingData(database, cutoff, batchSize);
    const incoming = await database.run(
      `DELETE FROM incoming_messages WHERE id IN (
         SELECT id FROM incoming_messages
         WHERE created_at < ? AND status IN ('processed', 'filtered')
         ORDER BY created_at ASC LIMIT ?
       )`,
      [cutoff, batchSize]
    );
    const signals = await database.run(
      `DELETE FROM signals WHERE rowid IN (
         SELECT signal.rowid FROM signals AS signal
         WHERE signal.created_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM pending_tasks AS task
             WHERE task.chat_id = signal.chat_id
               AND task.message_id = signal.message_id
               AND task.status IN ('pending', 'preparing', 'sending', 'failed', 'unknown')
           )
           AND NOT EXISTS (
             SELECT 1 FROM trading_trade_intents AS intent
             WHERE intent.source_signal_id = signal.id
           )
         ORDER BY signal.created_at ASC LIMIT ?
       )`,
      [cutoff, batchSize]
    );
    const completed = await database.run(
      `DELETE FROM pending_tasks WHERE id IN (
         SELECT id FROM pending_tasks
         WHERE status = 'completed' AND completed_at IS NOT NULL AND completed_at < ?
         ORDER BY completed_at ASC LIMIT ?
       )`,
      [cutoff, batchSize]
    );
    const aiUsage = await database.run(
      `DELETE FROM ai_usage_daily WHERE usage_day IN (
         SELECT usage_day FROM ai_usage_daily
         WHERE usage_day < ? ORDER BY usage_day ASC LIMIT ?
       )`,
      [cutoffDay, batchSize]
    );
    return retentionResult([
      incoming.changes,
      signals.changes,
      completed.changes,
      aiUsage.changes,
      ...tradingChanges
    ]);
  });
  await getDb().exec('PRAGMA optimize');
  return result;
}

export async function isDatabaseHealthy(): Promise<boolean> {
  try {
    const row = await getDb().get<{ ok: number }>('SELECT 1 AS ok');
    return row?.ok === 1;
  } catch {
    return false;
  }
}

export async function findDuplicateSignal(
  normalizedContent: string,
  cooldownHours: number,
  excludeSignalId?: string,
  dedupeScope?: string,
): Promise<{ isDupe: boolean; matchFile?: string; ageHours?: number } | null> {
  const database = getDb();
  const cooldownMs = cooldownHours * 60 * 60 * 1000;
  const now = Date.now();
  if (dedupeScope !== undefined && !/^[a-f0-9]{64}$/.test(dedupeScope)) {
    throw new Error('Signal dedupe scope must be a SHA-256 identifier.');
  }
  const scopeSuffix = dedupeScope ? `_${dedupeScope}` : null;
  const scopeSql = scopeSuffix ? ' AND substr(id, -?) = ?' : '';
  const scopeParameters = scopeSuffix ? [scopeSuffix.length, scopeSuffix] : [];
  
  if (cooldownHours > 0) {
    const minTime = now - cooldownMs;
    const match = await database.get(
      `SELECT id, created_at FROM signals 
       WHERE normalized_content = ? AND created_at >= ? AND (? IS NULL OR id <> ?)
       ${scopeSql}
       ORDER BY created_at DESC LIMIT 1`,
      [normalizedContent, minTime, excludeSignalId || null, excludeSignalId || null, ...scopeParameters]
    );
    if (match) {
      const ageMs = now - (match.created_at as number);
      const ageHours = Number((ageMs / (60 * 60 * 1000)).toFixed(1));
      return { isDupe: true, matchFile: match.id, ageHours };
    }
  } else {
    // cooldownHours === 0 means "always block" (infinite cooldown)
    const match = await database.get(
      `SELECT id FROM signals 
       WHERE normalized_content = ? AND (? IS NULL OR id <> ?)
       ${scopeSql}
       ORDER BY created_at DESC LIMIT 1`,
      [normalizedContent, excludeSignalId || null, excludeSignalId || null, ...scopeParameters]
    );
    if (match) {
      return { isDupe: true, matchFile: match.id };
    }
  }
  return null;
}

function parseJsonField(value: unknown, field: string, taskId: string): any {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw new TypeError(`Outbox task ${taskId} has non-string ${field}.`);
  try {
    return JSON.parse(value);
  } catch (error: any) {
    throw new Error(`Outbox task ${taskId} has invalid ${field}: ${error.message}`, { cause: error });
  }
}

function mapOutboxRow(row: any): OutboxTask {
  return {
    id: String(row.id),
    type: row.type,
    chatId: String(row.chat_id),
    messageId: row.message_id === null ? undefined : Number(row.message_id),
    messageIds: parseJsonField(row.message_ids, 'message_ids', row.id),
    mediaGroupId: row.media_group_id || undefined,
    addedAt: Number(row.added_at),
    status: row.status,
    attempts: Number(row.attempts || 0),
    claimedAt: row.claimed_at === null ? undefined : Number(row.claimed_at),
    updatedAt: Number(row.updated_at || row.added_at),
    completedAt: row.completed_at === null ? undefined : Number(row.completed_at),
    lastError: row.last_error || undefined,
    config: parseJsonField(row.config_json, 'config_json', row.id),
    result: parseJsonField(row.result_json, 'result_json', row.id)
  };
}

// Durable inbox/outbox API
export async function enqueueOutboxTask(task: {
  id: string;
  type: 'single' | 'mediaGroup';
  chatId: string;
  messageId?: number;
  messageIds?: number[];
  mediaGroupId?: string;
  addedAt: number;
  config?: any;
}): Promise<boolean> {
  if (!task.id || !['single', 'mediaGroup'].includes(task.type)) {
    throw new Error('Outbox task id and type are required.');
  }
  if (task.type === 'single' && !Number.isSafeInteger(task.messageId)) {
    throw new Error(`Single outbox task ${task.id} requires a safe messageId.`);
  }
  if (task.type === 'mediaGroup' && (!Array.isArray(task.messageIds) || task.messageIds.length === 0 || task.messageIds.some(id => !Number.isSafeInteger(id)))) {
    throw new Error(`Media-group outbox task ${task.id} requires safe messageIds.`);
  }
  const database = getDb();
  const now = Date.now();
  const result = await database.run(
    `INSERT INTO pending_tasks (
       id, type, chat_id, message_id, message_ids, media_group_id, added_at,
       status, attempts, updated_at, config_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
    [
      task.id,
      task.type,
      task.chatId,
      task.messageId ?? null,
      task.messageIds ? JSON.stringify(task.messageIds) : null,
      task.mediaGroupId || null,
      task.addedAt,
      now,
      task.config === undefined ? null : JSON.stringify(task.config)
    ]
  );
  return Number(result.changes || 0) === 1;
}

export async function claimOutboxTask(id: string): Promise<OutboxTask | null> {
  const database = getDb();
  const now = Date.now();
  const row = await database.get(
    `UPDATE pending_tasks
     SET status = 'preparing', attempts = attempts + 1, claimed_at = ?, updated_at = ?,
         last_error = NULL, completed_at = NULL, result_json = NULL
     WHERE id = ? AND status IN ('pending', 'failed')
     RETURNING *`,
    [now, now, id]
  );
  return row ? mapOutboxRow(row) : null;
}

export async function markOutboxSending(id: string): Promise<void> {
  const database = getDb();
  const result = await database.run(
    `UPDATE pending_tasks SET status = 'sending', updated_at = ?
     WHERE id = ? AND status IN ('preparing', 'sending')`,
    [Date.now(), id]
  );
  if (Number(result.changes || 0) !== 1) {
    throw new Error(`Outbox task ${id} is not in a sendable state.`);
  }
}

export async function completeOutboxTask(id: string, result?: any): Promise<void> {
  const database = getDb();
  const now = Date.now();
  const update = await database.run(
    `UPDATE pending_tasks
     SET status = 'completed', updated_at = ?, completed_at = ?, last_error = NULL, result_json = ?
     WHERE id = ? AND status IN ('preparing', 'sending')`,
    [now, now, result === undefined ? null : JSON.stringify(result), id]
  );
  if (Number(update.changes || 0) !== 1) {
    throw new Error(`Outbox task ${id} cannot be completed from its current state.`);
  }
}

export async function failOutboxTask(id: string, error: unknown): Promise<OutboxStatus> {
  const database = getDb();
  let message = 'Unknown outbox failure';
  if (error instanceof Error) message = error.message;
  else if (typeof error === 'string') message = error;
  message = message.slice(0, 4000);
  const row = await database.get<{ status: OutboxStatus }>(
    `UPDATE pending_tasks
     SET status = CASE WHEN status = 'sending' THEN 'unknown' ELSE 'failed' END,
         updated_at = ?, last_error = ?, completed_at = NULL, result_json = NULL
     WHERE id = ? AND status IN ('preparing', 'sending')
     RETURNING status`,
    [Date.now(), message, id]
  );
  if (!row) throw new Error(`Outbox task ${id} cannot be failed from its current state.`);
  return row.status;
}

export async function recoverInterruptedOutboxTasks(): Promise<{ requeued: number; unknown: number }> {
  const database = getDb();
  const now = Date.now();
  const requeued = await database.run(
    `UPDATE pending_tasks
     SET status = 'pending', updated_at = ?, claimed_at = NULL,
         last_error = 'Process stopped while preparing; task safely requeued before provider send.'
     WHERE status = 'preparing'`,
    [now]
  );
  const unknown = await database.run(
    `UPDATE pending_tasks
     SET status = 'unknown', updated_at = ?,
         last_error = 'Process stopped after provider send began; automatic retry blocked to prevent duplicates.'
     WHERE status = 'sending'`,
    [now]
  );
  return { requeued: Number(requeued.changes || 0), unknown: Number(unknown.changes || 0) };
}

export async function getOutboxTask(id: string): Promise<OutboxTask | null> {
  const row = await getDb().get(`SELECT * FROM pending_tasks WHERE id = ?`, [id]);
  return row ? mapOutboxRow(row) : null;
}

export async function listOutboxTasks(statuses?: OutboxStatus[], limit = 100): Promise<OutboxTask[]> {
  const safeLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 1000)) : 100;
  let rows: any[];
  if (statuses && statuses.length > 0) {
    rows = await getDb().all(
      `SELECT * FROM pending_tasks
       WHERE status IN (SELECT value FROM json_each(?))
       ORDER BY added_at ASC LIMIT ?`,
      [JSON.stringify(statuses), safeLimit]
    );
  } else {
    rows = await getDb().all(`SELECT * FROM pending_tasks ORDER BY added_at ASC LIMIT ?`, [safeLimit]);
  }
  return rows.map(mapOutboxRow);
}

/**
 * Returns pending work which is not already represented by the bounded
 * in-memory scheduler window. The database remains the source of truth.
 */
export async function listPendingOutboxTasksForScheduling(excludedTaskIds: string[] = [], limit = 100): Promise<OutboxTask[]> {
  const safeLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 1000)) : 100;
  const excluded = [...new Set(excludedTaskIds.filter(id => typeof id === 'string' && id.length > 0))].slice(0, 1000);
  const rows = await getDb().all(
    `SELECT * FROM pending_tasks
     WHERE status = 'pending'
       AND id NOT IN (SELECT value FROM json_each(?))
     ORDER BY added_at ASC, id ASC LIMIT ?`,
    [JSON.stringify(excluded), safeLimit]
  );
  return rows.map(mapOutboxRow);
}

export async function requeueOutboxTask(id: string): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE pending_tasks
     SET status = 'pending', updated_at = ?, claimed_at = NULL, completed_at = NULL,
         last_error = 'Explicit operator retry requested.', result_json = NULL
     WHERE id = ? AND status IN ('failed', 'unknown')`,
    [Date.now(), id]
  );
  return Number(result.changes || 0) === 1;
}

export async function acknowledgeOutboxTask(id: string, reason: string): Promise<boolean> {
  const now = Date.now();
  const result = await getDb().run(
    `UPDATE pending_tasks
     SET status = 'completed', updated_at = ?, completed_at = ?, last_error = NULL, result_json = ?
     WHERE id = ? AND status = 'unknown'`,
    [now, now, JSON.stringify({ acknowledged: true, reason: reason.slice(0, 500) }), id]
  );
  return Number(result.changes || 0) === 1;
}

// Media Group Buffer API
export async function saveMediaGroupBuffer(groupId: string, fromChatId: string, messages: any[]): Promise<void> {
  const database = getDb();
  await database.run(
    `INSERT OR REPLACE INTO media_group_buffer (group_id, from_chat_id, messages_json, added_at) 
     VALUES (?, ?, ?, ?)`,
    [groupId, fromChatId, JSON.stringify(messages), Date.now()]
  );
}

export async function removeMediaGroupBuffer(groupId: string): Promise<void> {
  const database = getDb();
  await database.run(`DELETE FROM media_group_buffer WHERE group_id = ?`, [groupId]);
}

export async function getMediaGroupBuffers(): Promise<Record<string, any>> {
  const database = getDb();
  const rows = await database.all(`SELECT * FROM media_group_buffer`);
  const result: Record<string, any> = {};
  for (const r of rows) {
    result[r.group_id] = {
      messages: JSON.parse(r.messages_json),
      fromChatId: Number(r.from_chat_id)
    };
  }
  return result;
}

export async function saveIncomingMessage(
  chatId: string,
  messageId: number,
  sender: string,
  text: string,
  type: string,
  status: string
): Promise<boolean> {
  const database = getDb();
  const result = await database.run(
    `INSERT INTO incoming_messages (chat_id, message_id, sender, text, type, status, created_at) 
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id, message_id) DO NOTHING`,
    [chatId, messageId, sender, text, type, status, Date.now()]
  );
  return Number(result.changes || 0) === 1;
}

export async function updateIncomingMessageStatus(
  chatId: string,
  messageId: number,
  status: string
): Promise<void> {
  const database = getDb();
  await database.run(
    `UPDATE incoming_messages SET status = ? WHERE chat_id = ? AND message_id = ?`,
    [status, chatId, messageId]
  );
}

export async function getIncomingMessages(limit = 100): Promise<any[]> {
  const database = getDb();
  return await database.all(
    `SELECT * FROM incoming_messages ORDER BY created_at DESC LIMIT ?`,
    [limit]
  );
}

export async function getProcessedSignals(limit = 100): Promise<any[]> {
  const database = getDb();
  return await database.all(
    `SELECT * FROM signals ORDER BY created_at DESC LIMIT ?`,
    [limit]
  );
}

export type DashboardAnalyticsWindow = '24h' | '7d' | '30d' | 'all';

export interface SignalWindowAnalytics {
  messages: number;
  processed: number;
  filtered: number;
  duplicates: number;
  failed: number;
  signals: number;
}

export async function getSignalDashboardAnalytics(now = Date.now()): Promise<{
  generatedAt: number;
  windows: Record<DashboardAnalyticsWindow, SignalWindowAnalytics>;
}> {
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error('Dashboard analytics timestamp is invalid.');
  const definitions: Array<[DashboardAnalyticsWindow, number | null]> = [
    ['24h', now - 24 * 60 * 60 * 1_000],
    ['7d', now - 7 * 24 * 60 * 60 * 1_000],
    ['30d', now - 30 * 24 * 60 * 60 * 1_000],
    ['all', null],
  ];
  const database = getDb();
  const values = await Promise.all(definitions.map(async ([window, since]) => {
    const filter = since === null ? '' : ' WHERE created_at >= ?';
    const parameters = since === null ? [] : [since];
    const [messageRows, signalRow] = await Promise.all([
      database.all<Array<{ status: string | null; count: number }>>(
        `SELECT status, COUNT(*) AS count FROM incoming_messages${filter} GROUP BY status`, parameters),
      database.get<{ count: number }>(`SELECT COUNT(*) AS count FROM signals${filter}`, parameters),
    ]);
    const result: SignalWindowAnalytics = {
      messages: 0, processed: 0, filtered: 0, duplicates: 0, failed: 0,
      signals: Number(signalRow?.count || 0),
    };
    for (const row of messageRows) {
      const count = Number(row.count || 0);
      result.messages += count;
      if (row.status === 'processed') result.processed += count;
      else if (row.status === 'filtered') result.filtered += count;
      else if (row.status === 'duplicate') result.duplicates += count;
      else if (row.status === 'failed') result.failed += count;
    }
    return [window, result] as const;
  }));
  return {
    generatedAt: now,
    windows: Object.fromEntries(values) as Record<DashboardAnalyticsWindow, SignalWindowAnalytics>,
  };
}

export interface DatabaseClearResult {
  deletedIncomingMessages: number;
  deletedSignals: number;
  retainedTradingSignals: number;
  deletedPendingTasks: number;
  deletedMediaGroups: number;
}

export async function clearDb(): Promise<DatabaseClearResult> {
  return withDatabaseTransaction(async database => {
    const pendingTasks = await database.run('DELETE FROM pending_tasks');
    const mediaGroups = await database.run('DELETE FROM media_group_buffer');
    const incomingMessages = await database.run('DELETE FROM incoming_messages');
    const signals = await database.run(
      `DELETE FROM signals
       WHERE NOT EXISTS (
         SELECT 1 FROM trading_trade_intents AS intent
         WHERE intent.source_signal_id = signals.id
       )`,
    );
    await database.run(
      `UPDATE forwarding_stats SET value = 0
       WHERE key IN ('total_forwarded_count', 'last_forwarded_at')`,
    );
    const retained = await database.get<{ count: number }>('SELECT COUNT(*) AS count FROM signals');
    return {
      deletedIncomingMessages: Number(incomingMessages.changes || 0),
      deletedSignals: Number(signals.changes || 0),
      retainedTradingSignals: Number(retained?.count || 0),
      deletedPendingTasks: Number(pendingTasks.changes || 0),
      deletedMediaGroups: Number(mediaGroups.changes || 0),
    };
  });
}

export async function deleteIncomingMessage(id: number): Promise<void> {
  const database = getDb();
  await database.run(`DELETE FROM incoming_messages WHERE id = ?`, [id]);
}

export class SignalReferencedError extends Error {
  constructor() {
    super('Signal cannot be deleted because trading history still references it.');
    this.name = 'SignalReferencedError';
  }
}

export function isForeignKeyConstraint(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: string; message?: string };
  if (candidate.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') return true;
  return /foreign key/i.test(String(candidate.message || ''));
}

export async function deleteProcessedSignal(id: string): Promise<void> {
  const database = getDb();
  try {
    await database.run(`DELETE FROM signals WHERE id = ?`, [id]);
  } catch (error) {
    if (isForeignKeyConstraint(error)) throw new SignalReferencedError();
    throw error;
  }
}
