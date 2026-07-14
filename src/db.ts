import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';
import { mkdir, stat } from 'fs/promises';

let db: Database | null = null;

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

export async function initDb(
  dbPath = process.env.FORWARDER_DB_PATH || path.join(process.cwd(), 'session_data', 'forwarder.db')
): Promise<void> {
  if (db) {
    throw new Error('Database is already initialized. Call closeDb() before reinitializing.');
  }
  await mkdir(path.dirname(dbPath), { recursive: true });
  db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });
  await db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
  `);

  // Table for duplicate signal checks
  await db.exec(`
    CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY,
      chat_id TEXT,
      message_id INTEGER,
      xml_content TEXT,
      normalized_content TEXT,
      created_at INTEGER,
      template_name TEXT,
      schema_name TEXT,
      prompt_sha256 TEXT,
      model TEXT,
      provider_request_id TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      parser_version TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_signals_normalized ON signals(normalized_content);
    CREATE INDEX IF NOT EXISTS idx_signals_chat_created ON signals(chat_id, created_at);
  `);
  await ensureColumn(db, 'signals', 'template_name', 'TEXT');
  await ensureColumn(db, 'signals', 'schema_name', 'TEXT');
  await ensureColumn(db, 'signals', 'prompt_sha256', 'TEXT');
  await ensureColumn(db, 'signals', 'model', 'TEXT');
  await ensureColumn(db, 'signals', 'provider_request_id', 'TEXT');
  await ensureColumn(db, 'signals', 'prompt_tokens', 'INTEGER');
  await ensureColumn(db, 'signals', 'completion_tokens', 'INTEGER');
  await ensureColumn(db, 'signals', 'parser_version', 'TEXT');

  // Table for persistent forwarding queue
  await db.exec(`
    CREATE TABLE IF NOT EXISTS pending_tasks (
      id TEXT PRIMARY KEY,
      type TEXT,
      chat_id TEXT,
      message_id INTEGER,
      message_ids TEXT,             -- JSON string array
      media_group_id TEXT,
      added_at INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      claimed_at INTEGER,
      updated_at INTEGER NOT NULL DEFAULT 0,
      completed_at INTEGER,
      last_error TEXT,
      config_json TEXT,
      result_json TEXT
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS ai_usage_daily (
      usage_day TEXT PRIMARY KEY,
      request_count INTEGER NOT NULL DEFAULT 0,
      used_tokens INTEGER NOT NULL DEFAULT 0,
      reserved_tokens INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
  `);
  await ensureColumn(db, 'pending_tasks', 'status', "TEXT NOT NULL DEFAULT 'pending'");
  await ensureColumn(db, 'pending_tasks', 'attempts', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(db, 'pending_tasks', 'claimed_at', 'INTEGER');
  await ensureColumn(db, 'pending_tasks', 'updated_at', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(db, 'pending_tasks', 'completed_at', 'INTEGER');
  await ensureColumn(db, 'pending_tasks', 'last_error', 'TEXT');
  await ensureColumn(db, 'pending_tasks', 'config_json', 'TEXT');
  await ensureColumn(db, 'pending_tasks', 'result_json', 'TEXT');
  await db.exec(`
    UPDATE pending_tasks SET status = 'pending' WHERE status IS NULL OR status = '';
    UPDATE pending_tasks SET attempts = 0 WHERE attempts IS NULL;
    UPDATE pending_tasks SET updated_at = COALESCE(NULLIF(updated_at, 0), added_at, CAST(strftime('%s','now') AS INTEGER) * 1000);
    CREATE INDEX IF NOT EXISTS idx_pending_tasks_status_added ON pending_tasks(status, added_at);
  `);

  // Table for media group buffering
  await db.exec(`
    CREATE TABLE IF NOT EXISTS media_group_buffer (
      group_id TEXT PRIMARY KEY,
      from_chat_id TEXT,
      messages_json TEXT,           -- JSON array of message objects
      added_at INTEGER
    );
  `);

  // Persistent total used by the dashboard and metrics across process restarts
  await db.exec(`
    CREATE TABLE IF NOT EXISTS forwarding_stats (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO forwarding_stats (key, value) VALUES ('total_forwarded_count', 0);
    INSERT OR IGNORE INTO forwarding_stats (key, value) VALUES ('last_forwarded_at', 0);
  `);

  // Table for incoming messages and their routing status
  await db.exec(`
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
    CREATE INDEX IF NOT EXISTS idx_incoming_chat_msg ON incoming_messages(chat_id, message_id);
    CREATE INDEX IF NOT EXISTS idx_incoming_created ON incoming_messages(created_at);
  `);
  await db.exec(`
    DELETE FROM incoming_messages
    WHERE id NOT IN (
      SELECT MIN(id) FROM incoming_messages GROUP BY chat_id, message_id
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_incoming_chat_message ON incoming_messages(chat_id, message_id);
  `);
}

export async function closeDb(): Promise<void> {
  if (!db) return;
  await db.close();
  db = null;
}

export async function backupDatabase(destinationPath: string): Promise<void> {
  const resolvedDestination = path.resolve(destinationPath);
  await mkdir(path.dirname(resolvedDestination), { recursive: true });
  const destinationExists = await stat(resolvedDestination).then(() => true).catch((error: any) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (destinationExists) throw new Error(`Backup destination already exists: ${resolvedDestination}`);
  const nativeDatabase: any = getDb().getDatabaseInstance();
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

// Helper to make sure db is initialized
function getDb(): Database {
  if (!db) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  return db;
}

export async function getTotalForwardedCount(): Promise<number> {
  const row = await getDb().get<{ value: number }>(
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
      provenance?.templateName || null,
      provenance?.schemaName || null,
      provenance?.promptSha256 || null,
      provenance?.model || null,
      provenance?.providerRequestId || null,
      provenance?.promptTokens ?? null,
      provenance?.completionTokens ?? null,
      provenance?.parserVersion || null
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
    aiUsageDays: changes[3] || 0
  };
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

  const database = getDb();
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  const cutoffDay = new Date(cutoff).toISOString().slice(0, 10);
  await database.exec('BEGIN IMMEDIATE');
  try {
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
    await database.exec('COMMIT');
    await database.exec('PRAGMA optimize');
    return retentionResult([
      incoming.changes,
      signals.changes,
      completed.changes,
      aiUsage.changes
    ]);
  } catch (error) {
    await database.exec('ROLLBACK').catch(() => undefined);
    throw error;
  }
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
  try {
    return JSON.parse(String(value));
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
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 4000);
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

export async function clearDb(): Promise<void> {
  const database = getDb();
  await database.exec(`
    DELETE FROM signals;
    DELETE FROM pending_tasks;
    DELETE FROM media_group_buffer;
    DELETE FROM incoming_messages;
    UPDATE forwarding_stats SET value = 0 WHERE key IN ('total_forwarded_count', 'last_forwarded_at');
  `);
  await database.exec('VACUUM;');
}

export async function deleteIncomingMessage(id: number): Promise<void> {
  const database = getDb();
  await database.run(`DELETE FROM incoming_messages WHERE id = ?`, [id]);
}

export async function deleteProcessedSignal(id: string): Promise<void> {
  const database = getDb();
  await database.run(`DELETE FROM signals WHERE id = ?`, [id]);
}
