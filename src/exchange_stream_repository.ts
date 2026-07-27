import { randomUUID } from 'node:crypto';
import type { Database } from 'sqlite';
import { getDatabase, withDatabaseTransaction } from './db.js';
import type {
  ExchangeStreamBatch,
  ExchangeStreamEvent,
  TradingAccount,
} from './trading_types.js';

const MAXIMUM_EVENT_JSON_BYTES = 64 * 1024;
const MAXIMUM_RETAINED_EVENTS_PER_ACCOUNT = 5_000;

function boundedError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message.replace(/[\r\n\0]+/g, ' ').slice(0, 500);
}

function eventPayload(event: ExchangeStreamEvent): string {
  const payload = JSON.stringify(event.payload ?? null);
  if (Buffer.byteLength(payload, 'utf8') > MAXIMUM_EVENT_JSON_BYTES) {
    throw new Error('Exchange stream event payload exceeds 64 KiB.');
  }
  return payload;
}

function validateBatch(batch: ExchangeStreamBatch): void {
  let previousCursor = 0;
  for (const event of batch.events) {
    if (event.cursor <= previousCursor || event.cursor > batch.nextCursor) {
      throw new Error('Exchange stream event cursors are not strictly ordered.');
    }
    previousCursor = event.cursor;
  }
}

async function insertExchangeEvents(
  database: Database,
  account: TradingAccount,
  events: ExchangeStreamEvent[],
): Promise<{ inserted: number; stateChanges: number }> {
  let inserted = 0;
  let stateChanges = 0;
  for (const event of events) {
    const result = await database.run(
      `INSERT OR IGNORE INTO trading_exchange_events (
         id, account_id, exchange, mode, event_key, event_type, symbol,
         sequence, occurred_at, received_at, payload_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(), account.id, account.exchange, account.mode,
        event.eventKey, event.eventType, event.symbol, event.sequence,
        event.occurredAt, event.receivedAt, eventPayload(event),
      ],
    );
    const changed = Number(result.changes || 0);
    inserted += changed;
    if (changed === 1 && ['order', 'execution', 'position'].includes(event.eventType)) stateChanges += 1;
  }
  return { inserted, stateChanges };
}

type ExistingStreamState = {
  status: string;
  last_poll_at: number | null;
  last_error: string | null;
};

function requiresStateUpdate(
  existing: ExistingStreamState | undefined,
  next: { status: string; error: string | null; inserted: number; gap: boolean; now: number },
): boolean {
  if (next.inserted > 0 || next.gap || !existing) return true;
  if (existing.status !== next.status || existing.last_error !== next.error) return true;
  return next.now - Number(existing.last_poll_at || 0) >= 5_000;
}

async function updateStreamState(
  database: Database,
  account: TradingAccount,
  batch: ExchangeStreamBatch,
  inserted: number,
): Promise<void> {
  const now = Date.now();
  const existing = await database.get<ExistingStreamState>(
    `SELECT status, last_poll_at, last_error
     FROM trading_exchange_stream_state WHERE account_id = ?`,
    [account.id],
  );
  const status = batch.gap ? 'degraded' : batch.health.status;
  const error = batch.gap
    ? 'WebSocket event cursor gap detected; REST reconciliation required.'
    : batch.health.lastError;
  if (!requiresStateUpdate(existing, { status, error, inserted, gap: batch.gap, now })) return;
  await database.run(
    `INSERT INTO trading_exchange_stream_state (
       account_id, status, cursor, gap_count, last_event_at, last_poll_at,
       last_error, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET
       status = excluded.status,
       cursor = MAX(trading_exchange_stream_state.cursor, excluded.cursor),
       gap_count = trading_exchange_stream_state.gap_count + excluded.gap_count,
       last_event_at = COALESCE(excluded.last_event_at, trading_exchange_stream_state.last_event_at),
       last_poll_at = excluded.last_poll_at,
       last_error = excluded.last_error,
       updated_at = excluded.updated_at`,
    [account.id, status, batch.nextCursor, batch.gap ? 1 : 0,
      batch.health.lastEventAt, now, error, now],
  );
}

async function pruneExchangeEvents(database: Database, accountId: string): Promise<void> {
  await database.run(
    `DELETE FROM trading_exchange_events
     WHERE account_id = ? AND id IN (
       SELECT id FROM trading_exchange_events
       WHERE account_id = ?
       ORDER BY received_at DESC, id DESC
       LIMIT -1 OFFSET ?
     )`,
    [accountId, accountId, MAXIMUM_RETAINED_EVENTS_PER_ACCOUNT],
  );
}

export async function persistExchangeStreamBatch(
  account: TradingAccount,
  batch: ExchangeStreamBatch,
): Promise<{ inserted: number; stateChanges: number; gap: boolean }> {
  if (account.exchange === 'paper' || account.mode === 'paper') {
    throw new Error('Paper accounts do not accept external exchange stream events.');
  }
  validateBatch(batch);
  return withDatabaseTransaction(async database => {
    const { inserted, stateChanges } = await insertExchangeEvents(database, account, batch.events);
    await updateStreamState(database, account, batch, inserted);
    await pruneExchangeEvents(database, account.id);
    return { inserted, stateChanges, gap: batch.gap };
  });
}

export async function recordExchangeStreamFailure(
  accountId: string,
  error: unknown,
): Promise<void> {
  const now = Date.now();
  const message = boundedError(error);
  const existing = await getDatabase().get<{
    status: string;
    last_poll_at: number | null;
    last_error: string | null;
  }>(
    `SELECT status, last_poll_at, last_error
     FROM trading_exchange_stream_state WHERE account_id = ?`,
    [accountId],
  );
  if (existing?.status === 'degraded'
    && existing.last_error === message
    && now - Number(existing.last_poll_at || 0) < 5_000) return;
  await getDatabase().run(
    `INSERT INTO trading_exchange_stream_state (
       account_id, status, cursor, gap_count, last_event_at, last_poll_at,
       last_error, updated_at
     ) VALUES (?, 'degraded', 0, 0, NULL, ?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET
       status = 'degraded',
       last_poll_at = excluded.last_poll_at,
       last_error = excluded.last_error,
       updated_at = excluded.updated_at`,
    [accountId, now, message, now],
  );
}

export async function markExchangeStreamsStopped(): Promise<void> {
  const now = Date.now();
  await getDatabase().run(
    `UPDATE trading_exchange_stream_state
     SET status = 'stopped', updated_at = ? WHERE status <> 'stopped'`,
    [now],
  );
}

export async function listExchangeStreamStates(): Promise<Array<Record<string, unknown>>> {
  return getDatabase().all<Array<Record<string, unknown>>>(
    `SELECT state.account_id AS accountId, account.name AS accountName,
            account.exchange, account.mode, state.status, state.cursor,
            state.gap_count AS gapCount, state.last_event_at AS lastEventAt,
            state.last_poll_at AS lastPollAt, state.last_error AS lastError,
            state.updated_at AS updatedAt
     FROM trading_exchange_stream_state AS state
     JOIN trading_accounts AS account ON account.id = state.account_id
     ORDER BY account.name, state.account_id`,
  );
}

export async function listActiveExchangeStreamSymbols(accountId: string): Promise<string[]> {
  const rows = await getDatabase().all<Array<{ symbol: string }>>(
    `SELECT DISTINCT symbol FROM (
       SELECT symbol FROM trading_positions
       WHERE account_id = ? AND status IN ('opening', 'open', 'closing', 'emergency')
       UNION
       SELECT symbol FROM trading_trade_intents
       WHERE account_id = ? AND status IN ('pending', 'planned', 'submitting', 'monitoring', 'unknown')
     ) ORDER BY symbol LIMIT 100`,
    [accountId, accountId],
  );
  return rows.map(row => row.symbol);
}
