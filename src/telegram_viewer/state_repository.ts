import path from 'node:path';
import { promises as fs } from 'node:fs';
import sqlite3 from 'sqlite3';
import { open, type Database } from 'sqlite';

export type ViewerDeliveryKind = 'notification' | 'test';

export interface PendingViewerDelivery {
  id: number;
  kind: ViewerDeliveryKind;
  sourceSeq: number;
  userId: string;
  payload: Record<string, unknown>;
  attempts: number;
}

const METADATA_DEFAULTS = {
  telegram_offset: '0',
  event_cursor: '0',
  test_cursor: '0',
};

export class TelegramViewerStateRepository {
  private database: Database | null = null;

  constructor(private readonly databasePath: string) {}

  async initialize(): Promise<void> {
    if (this.database) throw new Error('Telegram viewer state repository is already initialized.');
    const destination = path.resolve(this.databasePath);
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    this.database = await open({ filename: destination, driver: sqlite3.Database });
    try {
      // This is a separate delivery database, never another operational DB participant.
      // Check before WAL pragmas or schema writes, including hard links and custom paths.
      const tables = await this.database.all<Array<{ name: string }>>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
      );
      const permitted = new Set(['viewer_metadata', 'viewer_deliveries', 'viewer_last_test']);
      if (tables.some(table => !permitted.has(table.name))) {
        throw new Error('Telegram viewer state database contains unrelated tables; refusing the operational or another application database.');
      }
      await this.initializeSchema();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private async initializeSchema(): Promise<void> {
    await this.db().exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS viewer_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS viewer_deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK(kind IN ('notification', 'test')),
        source_seq INTEGER NOT NULL CHECK(source_seq > 0),
        source_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'retrying', 'delivered', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        next_retry_at INTEGER NOT NULL,
        last_error TEXT,
        delivered_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(kind, source_seq, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_viewer_deliveries_pending
        ON viewer_deliveries(status, next_retry_at, id);
      CREATE TABLE IF NOT EXISTS viewer_last_test (
        singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
        source_seq INTEGER NOT NULL,
        status TEXT NOT NULL,
        attempted_at INTEGER NOT NULL,
        delivered_at INTEGER,
        error TEXT
      );
    `);
    const now = Date.now();
    for (const [key, value] of Object.entries(METADATA_DEFAULTS)) {
      await this.db().run(
        'INSERT OR IGNORE INTO viewer_metadata (key, value, updated_at) VALUES (?, ?, ?)',
        [key, value, now],
      );
    }
  }

  private db(): Database {
    if (!this.database) throw new Error('Telegram viewer state repository is not initialized.');
    return this.database;
  }

  private async numberMetadata(key: keyof typeof METADATA_DEFAULTS): Promise<number> {
    const row = await this.db().get<{ value: string }>('SELECT value FROM viewer_metadata WHERE key = ?', [key]);
    return Number(row?.value ?? 0);
  }

  private async setNumberMetadata(key: keyof typeof METADATA_DEFAULTS, value: number): Promise<void> {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Viewer cursor is invalid.');
    await this.db().run(
      `INSERT INTO viewer_metadata (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, String(value), Date.now()],
    );
  }

  telegramOffset(): Promise<number> { return this.numberMetadata('telegram_offset'); }
  setTelegramOffset(value: number): Promise<void> { return this.setNumberMetadata('telegram_offset', value); }
  eventCursor(): Promise<number> { return this.numberMetadata('event_cursor'); }
  setEventCursor(value: number): Promise<void> { return this.setNumberMetadata('event_cursor', value); }
  testCursor(): Promise<number> { return this.numberMetadata('test_cursor'); }
  setTestCursor(value: number): Promise<void> { return this.setNumberMetadata('test_cursor', value); }

  async queueDeliveries(input: {
    kind: ViewerDeliveryKind;
    sourceSeq: number;
    sourceId: string;
    userIds: string[];
    payload: Record<string, unknown>;
    now: number;
  }): Promise<void> {
    const serialized = JSON.stringify(input.payload);
    await this.db().exec('BEGIN IMMEDIATE');
    try {
      for (const userId of input.userIds) {
        await this.db().run(
          `INSERT OR IGNORE INTO viewer_deliveries
           (kind, source_seq, source_id, user_id, payload_json, status, attempts,
            next_retry_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
          [input.kind, input.sourceSeq, input.sourceId, userId, serialized, input.now, input.now, input.now],
        );
      }
      await this.db().exec('COMMIT');
    } catch (error) {
      await this.db().exec('ROLLBACK');
      throw error;
    }
  }

  async pendingDeliveries(now: number, limit = 100): Promise<PendingViewerDelivery[]> {
    const rows = await this.db().all<any[]>(
      `SELECT id, kind, source_seq, user_id, payload_json, attempts
       FROM viewer_deliveries
       WHERE status IN ('pending', 'retrying') AND next_retry_at <= ?
       ORDER BY id LIMIT ?`,
      [now, Math.min(Math.max(limit, 1), 100)],
    );
    return rows.map(row => ({
      id: Number(row.id), kind: row.kind, sourceSeq: Number(row.source_seq), userId: String(row.user_id),
      payload: JSON.parse(String(row.payload_json)), attempts: Number(row.attempts),
    }));
  }

  async markDelivered(id: number, deliveredAt: number): Promise<void> {
    await this.db().run(
      `UPDATE viewer_deliveries SET status = 'delivered', attempts = attempts + 1,
       delivered_at = ?, last_error = NULL, updated_at = ? WHERE id = ?`,
      [deliveredAt, deliveredAt, id],
    );
  }

  async markFailed(id: number, attempts: number, error: unknown, now: number): Promise<void> {
    const nextAttempts = attempts + 1;
    const terminal = nextAttempts >= 8;
    const delay = Math.min(60_000, 1_000 * (2 ** Math.min(attempts, 6)));
    const message = error instanceof Error ? error.message : 'Telegram delivery failed.';
    await this.db().run(
      `UPDATE viewer_deliveries SET status = ?, attempts = ?, next_retry_at = ?, last_error = ?, updated_at = ?
       WHERE id = ?`,
      [terminal ? 'failed' : 'retrying', nextAttempts, now + delay, message.slice(0, 500), now, id],
    );
  }

  async setLastTest(input: { sourceSeq: number; status: string; attemptedAt: number; deliveredAt?: number; error?: string }): Promise<void> {
    await this.db().run(
      `INSERT INTO viewer_last_test (singleton_id, source_seq, status, attempted_at, delivered_at, error)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(singleton_id) DO UPDATE SET source_seq = excluded.source_seq, status = excluded.status,
         attempted_at = excluded.attempted_at, delivered_at = excluded.delivered_at, error = excluded.error`,
      [input.sourceSeq, input.status, input.attemptedAt, input.deliveredAt ?? null, input.error?.slice(0, 500) ?? null],
    );
  }

  async lastTest(): Promise<Record<string, unknown> | null> {
    const row = await this.db().get<any>('SELECT * FROM viewer_last_test WHERE singleton_id = 1');
    return row ? {
      sourceSeq: Number(row.source_seq), status: String(row.status), attemptedAt: Number(row.attempted_at),
      deliveredAt: row.delivered_at === null ? null : Number(row.delivered_at),
      error: row.error === null ? null : String(row.error),
    } : null;
  }

  async close(): Promise<void> {
    await this.database?.close();
    this.database = null;
  }
}
