import { getDatabase } from './db.js';
import { CANCEL_RETRY_MS, MAX_CANCEL_ATTEMPTS } from './trading_cancel_budget.js';
import { cancelRetryAuthorized, resolveActiveCancelAttempts } from './trading_cancel_recovery.js';
import type { ExchangeOpenState, TradingAccount } from './trading_types.js';

export interface EntryCommitment {
  intent_id: string; account_id: string; client_order_id: string; status: string;
  exchange_order_id: string | null; provider_symbol: string | null;
  entry_drain_attempted_at: number | null;
}

export const ENTRY_DRAIN_RETRY_MS = CANCEL_RETRY_MS;
export const MAX_ENTRY_DRAIN_ATTEMPTS = MAX_CANCEL_ATTEMPTS;
export const TERMINAL_ORDER_STATES = ['filled', 'cancelled', 'rejected'] as const;

/** Zero position quantity is deliberately not an input to this proof. */
export function entryCommitmentReason(status: string, unresolvedOperation: boolean): string | null {
  if (unresolvedOperation) return 'ENTRY_OPERATION_UNRESOLVED';
  if ((TERMINAL_ORDER_STATES as readonly string[]).includes(status)) return null;
  if (status === 'created') return 'ENTRY_DISPATCH_INTENT';
  if (status === 'open' || status === 'partially_filled') return 'ENTRY_CAN_FILL';
  return 'ENTRY_OUTCOME_UNRESOLVED';
}

/** Caller owns the account mutation coordinator. This intent survives timeouts and restarts. */
export async function requestEntryDrain(accountId: string, reason: string, intentId?: string): Promise<void> {
  await getDatabase().run(
    `UPDATE trading_orders SET entry_drain_requested_at = COALESCE(entry_drain_requested_at, ?),
       entry_drain_reason = COALESCE(entry_drain_reason, ?)
     WHERE account_id = ? AND role = 'entry' AND (
       status NOT IN ('filled', 'cancelled', 'rejected') OR EXISTS (
         SELECT 1 FROM trading_operations AS operation, json_each(operation.expected_orders_json) AS expected
         WHERE operation.account_id = trading_orders.account_id AND operation.intent_id = trading_orders.intent_id
           AND operation.phase IN ('dispatching', 'unresolved')
           AND json_extract(expected.value, '$.client_order_id') = trading_orders.client_order_id))
       AND (? IS NULL OR intent_id = ?) AND entry_drain_requested_at IS NULL`,
    [Date.now(), reason.slice(0, 300), accountId, intentId ?? null, intentId ?? null]);
}

export async function requestedEntryDrains(accountId: string, now = Date.now()): Promise<EntryCommitment[]> {
  return getDatabase().all<EntryCommitment[]>(
    `SELECT intent_id, account_id, client_order_id, status, exchange_order_id, provider_symbol, entry_drain_attempted_at
     FROM trading_orders WHERE account_id = ? AND role = 'entry' AND entry_drain_requested_at IS NOT NULL
       AND status NOT IN ('filled', 'cancelled', 'rejected')
       AND (entry_drain_attempted_at IS NULL OR entry_drain_attempted_at <= ?)
     ORDER BY COALESCE(entry_drain_attempted_at, 0), created_at, client_order_id LIMIT ?`,
    [accountId, now - ENTRY_DRAIN_RETRY_MS, MAX_ENTRY_DRAIN_ATTEMPTS]);
}

export async function pendingEntryDrainCount(accountId: string): Promise<number> {
  const row = await getDatabase().get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM trading_orders AS orders WHERE orders.account_id = ? AND orders.role = 'entry'
     AND orders.entry_drain_requested_at IS NOT NULL AND (
       orders.status NOT IN ('filled', 'cancelled', 'rejected') OR EXISTS (
         SELECT 1 FROM trading_operations AS operation, json_each(operation.expected_orders_json) AS expected
         WHERE operation.account_id = orders.account_id AND operation.intent_id = orders.intent_id
           AND operation.phase IN ('dispatching', 'unresolved')
           AND json_extract(expected.value, '$.client_order_id') = orders.client_order_id))`, [accountId]);
  return Number(row?.count ?? 0);
}

export async function markEntryDrainAttempt(accountId: string, clientOrderId: string): Promise<void> {
  await getDatabase().run(
    `UPDATE trading_orders SET entry_drain_attempted_at = ? WHERE account_id = ? AND client_order_id = ?
     AND role = 'entry' AND entry_drain_requested_at IS NOT NULL`, [Date.now(), accountId, clientOrderId]);
}

/** A fresh exact active order permits another cancel of THAT order, never a new entry.
 * The old cancellation outcome is recorded as still-active, not as entries-drained.
 * Concurrent completion of an older cancel cannot make an exact duplicate cancel add exposure.
 */
export async function resolveActiveEntryCancelAttempts(account: TradingAccount, remote: ExchangeOpenState): Promise<void> {
  return resolveActiveCancelAttempts(account, remote, true);
}

export async function entryCancelRetryAuthorized(accountId: string, clientOrderId: string): Promise<boolean> {
  return cancelRetryAuthorized(accountId, clientOrderId);
}
