import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';
import { mkdir } from 'fs/promises';

let db: Database | null = null;

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

  // Table for duplicate signal checks
  await db.exec(`
    CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY,
      chat_id TEXT,
      message_id INTEGER,
      xml_content TEXT,
      normalized_content TEXT,
      created_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_signals_normalized ON signals(normalized_content);
    CREATE INDEX IF NOT EXISTS idx_signals_chat_created ON signals(chat_id, created_at);
  `);

  // Table for persistent forwarding queue
  await db.exec(`
    CREATE TABLE IF NOT EXISTS pending_tasks (
      id TEXT PRIMARY KEY,
      type TEXT,
      chat_id TEXT,
      message_id INTEGER,
      message_ids TEXT,             -- JSON string array
      media_group_id TEXT,
      added_at INTEGER
    );
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
}

export async function closeDb(): Promise<void> {
  if (!db) return;
  await db.close();
  db = null;
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

export async function incrementForwardedCount(amount = 1): Promise<void> {
  const increment = Math.max(0, Math.floor(amount));
  if (increment === 0) return;
  await getDb().run(
    `UPDATE forwarding_stats SET value = value + ? WHERE key = 'total_forwarded_count'`,
    [increment]
  );
}

// Signals Deduplication API
export async function saveSignal(id: string, chatId: string, messageId: number, xmlContent: string, normalizedContent: string): Promise<void> {
  const database = getDb();
  await database.run(
    `INSERT OR REPLACE INTO signals (id, chat_id, message_id, xml_content, normalized_content, created_at) 
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, chatId, messageId, xmlContent, normalizedContent, Date.now()]
  );
}

export async function findDuplicateSignal(normalizedContent: string, cooldownHours: number): Promise<{ isDupe: boolean; matchFile?: string; ageHours?: number } | null> {
  const database = getDb();
  const cooldownMs = cooldownHours * 60 * 60 * 1000;
  const now = Date.now();
  
  if (cooldownHours > 0) {
    const minTime = now - cooldownMs;
    const match = await database.get(
      `SELECT id, created_at FROM signals 
       WHERE normalized_content = ? AND created_at >= ? 
       ORDER BY created_at DESC LIMIT 1`,
      [normalizedContent, minTime]
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
       WHERE normalized_content = ? 
       ORDER BY created_at DESC LIMIT 1`,
      [normalizedContent]
    );
    if (match) {
      return { isDupe: true, matchFile: match.id };
    }
  }
  return null;
}

// Pending Tasks Queue API
export async function savePendingTask(task: {
  id: string;
  type: string;
  chatId: string;
  messageId?: number;
  messageIds?: number[];
  mediaGroupId?: string;
  addedAt: number;
}): Promise<void> {
  const database = getDb();
  await database.run(
    `INSERT OR REPLACE INTO pending_tasks (id, type, chat_id, message_id, message_ids, media_group_id, added_at) 
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      task.id,
      task.type,
      task.chatId,
      task.messageId || null,
      task.messageIds ? JSON.stringify(task.messageIds) : null,
      task.mediaGroupId || null,
      task.addedAt
    ]
  );
}

export async function removePendingTask(id: string): Promise<void> {
  const database = getDb();
  await database.run(`DELETE FROM pending_tasks WHERE id = ?`, [id]);
}

export async function getPendingTasks(): Promise<any[]> {
  const database = getDb();
  const rows = await database.all(`SELECT * FROM pending_tasks ORDER BY added_at ASC`);
  return rows.map(r => ({
    id: r.id,
    type: r.type,
    chatId: r.chat_id,
    messageId: r.message_id,
    messageIds: r.message_ids ? JSON.parse(r.message_ids) : undefined,
    mediaGroupId: r.media_group_id,
    addedAt: r.added_at
  }));
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
): Promise<void> {
  const database = getDb();
  await database.run(
    `INSERT INTO incoming_messages (chat_id, message_id, sender, text, type, status, created_at) 
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [chatId, messageId, sender, text, type, status, Date.now()]
  );
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
    UPDATE forwarding_stats SET value = 0 WHERE key = 'total_forwarded_count';
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
