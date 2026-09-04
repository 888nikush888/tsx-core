import { createHash } from 'node:crypto';
import { getDatabase } from './db.js';

/** Includes zero-quantity entry remainders and orphan entries. No absence/quantity-only no-duty inference. */
export async function protectionScopes(accountId?: string): Promise<Array<{ accountId: string; intentId: string }>> {
  return getDatabase().all(`SELECT account_id AS accountId, intent_id AS intentId FROM trading_positions
      WHERE status <> 'closed' AND (? IS NULL OR account_id = ?)
    UNION SELECT account_id AS accountId, intent_id AS intentId FROM trading_orders
      WHERE role = 'entry' AND status NOT IN ('filled', 'cancelled', 'rejected') AND (? IS NULL OR account_id = ?)
    ORDER BY accountId, intentId`, [accountId ?? null, accountId ?? null, accountId ?? null, accountId ?? null]);
}

/** Every account field except the two documented reconciliation metadata timestamps is immutable at receipt commit. */
export async function protectionAccountSource(accountId: string): Promise<{ version: number; digest: string }> {
  const account = await getDatabase().get<Record<string, unknown>>('SELECT * FROM trading_accounts WHERE id = ?', [accountId]);
  if (!account) throw new Error('PROTECTION_ACCOUNT_MISSING');
  const { state_version: version, last_reconciled_at: _lastReconciledAt, updated_at: _updatedAt, ...binding } = account;
  return { version: Number(version), digest: hash(binding) };
}

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Hash source rows only, never publish provider payloads or credentials. Monetary health is deliberately not a stop gate. */
export async function protectionSourceDigest(accountId: string): Promise<string> {
  const database = getDatabase();
  const source = {
    account: (await protectionAccountSource(accountId)).digest,
    runtime: await database.get('SELECT * FROM trading_runtime_state WHERE singleton_id = 1'),
    intents: await database.all('SELECT * FROM trading_trade_intents WHERE account_id = ? ORDER BY id', [accountId]),
    orders: await database.all('SELECT * FROM trading_orders WHERE account_id = ? ORDER BY id', [accountId]),
    positions: await database.all(`SELECT id, account_id, intent_id, symbol, side, status, quantity, average_entry_price,
      stop_price, opened_at, closed_at, emergency_requested_at FROM trading_positions WHERE account_id = ? ORDER BY id`, [accountId]),
    fills: await database.all(`SELECT id, account_id, order_id, exchange_fill_id, quantity, filled_at,
      remote_fill_key, provider_symbol, identity_status, identity_json
      FROM trading_fills WHERE account_id = ? ORDER BY id`, [accountId]),
    operations: await database.all('SELECT * FROM trading_operations WHERE account_id = ? ORDER BY id', [accountId]),
    orderBindings: await database.all(`SELECT order_id,account_id,operation_id,account_fingerprint,credential_generation,
      profile,remote_order_key,request_hash,evidence_hash,evidence_json,bound_at
      FROM trading_order_identity_bindings WHERE account_id=? ORDER BY order_id`, [accountId]),
    remote: await database.all(`SELECT id, content_hash, classification, account_fingerprint, external_baseline_id, baseline_reviewed_at
      FROM trading_remote_evidence WHERE account_id = ? ORDER BY id`, [accountId]),
    acquisition: await database.get(`SELECT id, account_fingerprint, payload_json, started_at, completed_at
      FROM trading_acquisition_evidence WHERE account_id = ? ORDER BY received_at DESC, rowid DESC LIMIT 1`, [accountId]),
    history: await database.all(`SELECT * FROM trading_history_checkpoints WHERE account_id = ?
      ORDER BY account_fingerprint, source, provider_symbol`, [accountId]),
    baselines: await database.all('SELECT * FROM trading_account_baselines WHERE account_id = ? ORDER BY id', [accountId]),
    modes: await database.all('SELECT * FROM trading_account_mode_observations WHERE account_id = ? ORDER BY evidence_hash', [accountId]),
    origins: await database.all('SELECT * FROM trading_account_baseline_bindings WHERE account_id = ? ORDER BY baseline_id, profile', [accountId]),
  };
  return hash(source);
}
