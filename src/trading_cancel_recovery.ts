import { getDatabase } from './db.js';
import { createHash } from 'node:crypto';
import { CANCEL_RETRY_MS } from './trading_cancel_budget.js';
import { assertCancelAcquisition, exactActiveCancelEvidence, type CancelOrder } from './trading_cancel_evidence.js';
import { transitionTradingOperation, type TradingOperationPhase } from './trading_recovery.js';
import type { ExchangeAcquisitionEvidence, ExchangeOpenState, ExchangeOrderSnapshot, TradingAccount } from './trading_types.js';

interface CancelAttempt {
  id: string; phase: TradingOperationPhase; expected_orders_json: string; evidence_json: string | null;
  account_fingerprint: string | null; credential_generation: string | null; updated_at: number;
  request_json: string; request_hash: string;
}
interface StillActiveEvidence {
  source: 'fresh_exact_cancel_still_active'; projection: 'exact_target_only'; attemptedAt: number;
  target: ExchangeOrderSnapshot; acquisition: ExchangeAcquisitionEvidence; observedAt: number; accountFingerprint: string | null;
}

export async function loadCancelOrder(accountId: string, clientOrderId: string): Promise<CancelOrder> {
  const row = await getDatabase().get<CancelOrder>(
    `SELECT orders.*, intent.symbol FROM trading_orders AS orders JOIN trading_trade_intents AS intent ON intent.id = orders.intent_id
     WHERE orders.account_id = ? AND orders.client_order_id = ?`, [accountId, clientOrderId]);
  if (!row) throw new Error('Cancellation has no exact managed order.');
  return row;
}

async function latestCancel(accountId: string, clientOrderId: string): Promise<CancelAttempt | undefined> {
  return getDatabase().get<CancelAttempt>(
    `SELECT * FROM trading_operations WHERE account_id = ? AND kind = 'cancel'
     AND EXISTS (SELECT 1 FROM json_each(expected_orders_json) WHERE json_extract(value, '$.client_order_id') = ?)
     ORDER BY created_at DESC, rowid DESC LIMIT 1`, [accountId, clientOrderId]);
}

function attemptMatches(attempt: CancelAttempt, row: CancelOrder, account: TradingAccount): boolean {
  if (attempt.account_fingerprint !== account.externalAccountId || attempt.credential_generation !== account.credentialGeneration) return false;
  try {
    if (createHash('sha256').update(attempt.request_json).digest('hex') !== attempt.request_hash) return false;
    const request = JSON.parse(attempt.request_json);
    if (Object.keys(request).length !== 1 || request.clientOrderId !== row.client_order_id) return false;
    const expected = JSON.parse(attempt.expected_orders_json);
    return Array.isArray(expected) && expected.length === 1 && expected[0]?.client_order_id === row.client_order_id
      && expected[0]?.exchange_order_id === row.exchange_order_id && expected[0]?.provider_symbol === row.provider_symbol;
  } catch { return false; }
}

function stillActive(attempt: CancelAttempt): StillActiveEvidence | null {
  try {
    const evidence = JSON.parse(attempt.evidence_json ?? 'null');
    return evidence?.source === 'fresh_exact_cancel_still_active' && evidence.projection === 'exact_target_only'
      && Number.isSafeInteger(evidence.attemptedAt) ? evidence : null;
  } catch { return null; }
}

/** Resolving a cancel attempt as still-active never terminalizes its order or clears the durable cancel wish. */
export async function resolveActiveCancelAttempts(account: TradingAccount, remote: ExchangeOpenState, entriesOnly = false): Promise<void> {
  const operations = await getDatabase().all<CancelAttempt[]>(
    `SELECT operation.* FROM trading_operations AS operation WHERE operation.account_id = ? AND operation.kind = 'cancel'
     AND operation.phase IN ('prepared', 'dispatching', 'unresolved', 'resolved')
     AND NOT EXISTS (SELECT 1 FROM trading_operations AS later WHERE later.account_id = operation.account_id
       AND later.logical_key = operation.logical_key AND later.generation > operation.generation)
     AND EXISTS (SELECT 1 FROM json_each(operation.expected_orders_json) AS expected JOIN trading_orders AS orders
       ON orders.account_id = operation.account_id AND orders.client_order_id = json_extract(expected.value, '$.client_order_id')
       WHERE orders.status IN ('open', 'partially_filled', 'cancel_pending', 'unknown'))`, [account.id]);
  for (const attempt of operations) await recoverActiveCancelAttempt(account, remote, attempt, entriesOnly);
}

async function recoverActiveCancelAttempt(account: TradingAccount, remote: ExchangeOpenState, attempt: CancelAttempt, entriesOnly: boolean): Promise<void> {
  const expected = JSON.parse(attempt.expected_orders_json) as Array<{ client_order_id: string }>;
  if (expected.length !== 1 || !expected[0]?.client_order_id) return;
  const row = await loadCancelOrder(account.id, expected[0].client_order_id);
  if (entriesOnly && row.role !== 'entry') return;
  if (!attemptMatches(attempt, row, account)) return;
  const previous = stillActive(attempt);
  if (attempt.phase === 'resolved' && !previous) return;
  const attemptedAt = previous?.attemptedAt ?? attempt.updated_at;
  const active = exactActiveCancelEvidence(row, remote, account, attemptedAt);
  if (!active) return;
  // Persist only the normalized positive target observation, not provider raw payloads or unrelated account data.
  const evidence: StillActiveEvidence = { source: 'fresh_exact_cancel_still_active', projection: 'exact_target_only', attemptedAt,
    target: { ...active.order, raw: null }, observedAt: remote.observedAt, acquisition: remote.acquisition!,
    accountFingerprint: account.externalAccountId };
  await recordStillActive(attempt, evidence);
}

async function recordStillActive(attempt: CancelAttempt, evidence: StillActiveEvidence): Promise<void> {
  if (attempt.phase === 'resolved') {
    await getDatabase().run(`UPDATE trading_operations SET evidence_json = ?, state_version = state_version + 1
      WHERE id = ? AND phase = 'resolved' AND evidence_json IS ?`, [JSON.stringify(evidence), attempt.id, attempt.evidence_json]);
  } else await transitionTradingOperation(attempt.id, attempt.phase, attempt.phase === 'prepared' ? 'abandoned' : 'resolved', evidence);
}

function retryAttempt(attempt: CancelAttempt, row: CancelOrder, account: TradingAccount) {
  if (!attemptMatches(attempt, row, account)) throw new Error('Cancellation journal identity conflicts with its bound order.');
  const evidence = stillActive(attempt);
  const unsent = ['prepared', 'abandoned'].includes(attempt.phase);
  if (!unsent && !(attempt.phase === 'resolved' && evidence)) throw new Error('Cancellation outcome remains unresolved; fresh active evidence is required.');
  const attemptedAt = evidence?.attemptedAt ?? attempt.updated_at;
  if (!unsent && Date.now() - attemptedAt < CANCEL_RETRY_MS) throw new Error('Cancellation retry requires its ten-second interval.');
  return { evidence, attemptedAt };
}

/** Before preparing the next journal generation. Prepared is unsent; unresolved requires a positive read first. */
export async function cancelRetryObservation(
  account: TradingAccount, row: CancelOrder, remote?: ExchangeOpenState,
): Promise<ExchangeOpenState | undefined> {
  if (row.role !== 'entry' && !remote) throw new Error('Exit cancellation requires a new full account observation.');
  const attempt = await latestCancel(account.id, row.client_order_id);
  if (!attempt) {
    if (row.status === 'cancel_pending') throw new Error('Pending cancellation omitted its durable journal.');
    return remote;
  }
  const { evidence, attemptedAt } = retryAttempt(attempt, row, account);
  const observation = remote ?? entryTargetObservation(evidence);
  if (observation) assertCancelAcquisition(observation, attemptedAt);
  if (!observation || !exactActiveCancelEvidence(row, observation, account, attemptedAt)) {
    throw new Error('Cancellation retry lacks fresh exact active order and remaining-quantity evidence.');
  }
  return observation;
}

/** Target-only persisted evidence is usable only for reducing an entry commitment, never stop removal or release. */
function entryTargetObservation(evidence: StillActiveEvidence | null): ExchangeOpenState | undefined {
  if (!evidence) return undefined;
  return Object.assign({ orders: [evidence.target], positions: [], fills: [], acquisition: evidence.acquisition, observedAt: evidence.observedAt },
    { accountFingerprint: evidence.accountFingerprint });
}

export async function cancelRetryAuthorized(accountId: string, clientOrderId: string): Promise<boolean> {
  const account = await getDatabase().get<{ externalAccountId: string | null; credentialGeneration: string | null; exchange: TradingAccount['exchange'] }>(
    `SELECT external_account_id AS externalAccountId, credential_generation AS credentialGeneration, exchange FROM trading_accounts WHERE id = ?`, [accountId]);
  if (!account) return false;
  try {
    const row = await loadCancelOrder(accountId, clientOrderId);
    await cancelRetryObservation({ ...account, id: accountId } as TradingAccount, row);
    return true;
  } catch { return false; }
}
