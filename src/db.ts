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
  'isolated-paper-exchange-state'
] as const;

export const REQUIRED_DATABASE_TABLES = [
  'schema_migrations',
  'signals',
  'pending_tasks',
  'media_group_buffer',
  'forwarding_stats',
  'incoming_messages',
  'ai_usage_daily',
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

async function ensureColumn(database: Database, table: string, column: string, definition: string): Promise<void> {
  const columns = await database.all<Array<{ name: string }>>(`PRAGMA table_info(${table})`);
  if (!columns.some(existing => existing.name === column)) {
    await database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
  }
];

export const LATEST_SCHEMA_VERSION = migrations.length;

function migrationChecksum(migration: SchemaMigration): string {
  return createHash('sha256')
    .update(JSON.stringify({
      version: migration.version,
      name: migration.name,
      columns: migration.columns,
      sql: migration.sql
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
  if (applied.length < migrations.length && beforeApply) await beforeApply(applied.length);
  for (const migration of migrations.slice(applied.length)) {
    await database.exec('BEGIN IMMEDIATE;');
    try {
      await applyMigration(database, migration);
      await database.run(
        'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
        [migration.version, migration.name, migrationChecksum(migration), Date.now()]
      );
      await database.exec('COMMIT;');
    } catch (error) {
      await database.exec('ROLLBACK;').catch(() => {});
      throw new Error(`Database migration ${migration.version} (${migration.name}) failed.`, { cause: error });
    }
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

export async function verifyDatabaseIntegrity(databasePath: string): Promise<void> {
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

async function pruneTradingData(database: Database, cutoff: number, batchSize: number): Promise<Array<number | undefined>> {
  await database.exec(`
    DROP TABLE IF EXISTS temp.retention_trade_intents;
    CREATE TEMP TABLE retention_trade_intents (id TEXT PRIMARY KEY);
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
     ORDER BY updated_at ASC LIMIT ?`,
    [cutoff, batchSize]
  );
  await database.run('DELETE FROM trading_risk_events WHERE intent_id IN (SELECT id FROM retention_trade_intents)');
  await database.run(`DELETE FROM trading_fills WHERE order_id IN (
    SELECT id FROM trading_orders WHERE intent_id IN (SELECT id FROM retention_trade_intents)
  )`);
  await database.run('DELETE FROM trading_orders WHERE intent_id IN (SELECT id FROM retention_trade_intents)');
  await database.run('DELETE FROM trading_positions WHERE intent_id IN (SELECT id FROM retention_trade_intents)');
  const intents = await database.run('DELETE FROM trading_trade_intents WHERE id IN (SELECT id FROM retention_trade_intents)');
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
  excludeSignalId?: string
): Promise<{ isDupe: boolean; matchFile?: string; ageHours?: number } | null> {
  const database = getDb();
  const cooldownMs = cooldownHours * 60 * 60 * 1000;
  const now = Date.now();
  
  if (cooldownHours > 0) {
    const minTime = now - cooldownMs;
    const match = await database.get(
      `SELECT id, created_at FROM signals 
       WHERE normalized_content = ? AND created_at >= ? AND (? IS NULL OR id <> ?)
       ORDER BY created_at DESC LIMIT 1`,
      [normalizedContent, minTime, excludeSignalId || null, excludeSignalId || null]
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
       ORDER BY created_at DESC LIMIT 1`,
      [normalizedContent, excludeSignalId || null, excludeSignalId || null]
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
  const message = (error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : 'Unknown outbox failure').slice(0, 4000);
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
    const placeholders = statuses.map(() => '?').join(', ');
    rows = await getDb().all(
      `SELECT * FROM pending_tasks WHERE status IN (${placeholders}) ORDER BY added_at ASC LIMIT ?`,
      [...statuses, safeLimit]
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
  const exclusionClause = excluded.length > 0
    ? ` AND id NOT IN (${excluded.map(() => '?').join(', ')})`
    : '';
  const rows = await getDb().all(
    `SELECT * FROM pending_tasks WHERE status = 'pending'${exclusionClause} ORDER BY added_at ASC, id ASC LIMIT ?`,
    [...excluded, safeLimit]
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

export async function deleteProcessedSignal(id: string): Promise<void> {
  const database = getDb();
  await database.run(`DELETE FROM signals WHERE id = ?`, [id]);
}
