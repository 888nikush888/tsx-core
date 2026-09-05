import { createHash, randomUUID } from 'node:crypto';
import { getDatabase, withDatabaseDispatchFence, withDatabaseTransaction } from './db.js';
import { historyCheckpoints } from './trading_history_repository.js';
import { accountLogCheckpoint } from './trading_account_log_repository.js';
import { accountModeReadRequired } from './trading_account_mode.js';
import { requiredAccountEvidenceSince } from './trading_account_baseline.js';
import { originalPlanJournalMatches, type OriginalPlanOperation } from './trading_plan_identity.js';
import type { OrderIdentityAccount } from './trading_order_identity.js';
import type { ExchangeOrderResult, ExchangeOrderSnapshot, ExchangeRecoveryQuery, PlannedOrder, TradingAccount, TradingIntent, TradingPlan } from './trading_types.js';

export type TradingOperationKind = 'submit' | 'protected_entry' | 'cancel';
export type TradingOperationPhase = 'prepared' | 'dispatching' | 'acknowledged' | 'unresolved' | 'resolved' | 'abandoned';

function codePointOrder(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

interface OperationOrder { client_order_id: string; exchange_order_id: string | null; provider_symbol: string | null; status: string }
interface TradingOperation {
  id: string; phase: TradingOperationPhase; request_hash: string; state_version: number;
  account_fingerprint: string | null; credential_generation: string | null;
}
export interface TradingOperationInput {
  account: TradingAccount;
  intentId: string;
  kind: TradingOperationKind;
  clientOrderIds: string[];
  /** Internal order request only; account secrets are never part of this record. */
  request: object;
}

declare const witnessBrand: unique symbol;
export interface TradingDispatchWitness { readonly [witnessBrand]: true }
interface DispatchIdentity {
  operationId: string; accountId: string; intentId: string; requestHash: string;
  accountFingerprint: string | null; credentialGeneration: string | null;
}
const liveDispatchWitnesses = new WeakMap<object, Readonly<DispatchIdentity>>();

/** Only this module can issue a witness; persisted IDs, clones and expired objects have no authority. */
export function currentDispatchIdentity(witness: TradingDispatchWitness | undefined): Readonly<DispatchIdentity> | null {
  return witness && typeof witness === 'object' ? liveDispatchWitnesses.get(witness) ?? null : null;
}

async function withDispatchWitness(input: TradingOperationInput, operationId: string, verify: (witness: TradingDispatchWitness) => Promise<void>): Promise<void> {
  const witness = Object.freeze({}) as TradingDispatchWitness;
  liveDispatchWitnesses.set(witness, Object.freeze({ operationId, accountId: input.account.id, intentId: input.intentId,
    requestHash: hash(JSON.stringify(input.request)), accountFingerprint: input.account.externalAccountId,
    credentialGeneration: input.account.credentialGeneration }));
  try { await verify(witness); } finally { liveDispatchWitnesses.delete(witness); }
}

export class TradingRecoveryRequiredError extends Error {
  constructor(message: string) { super(message); this.name = 'TradingRecoveryRequiredError'; }
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

/** Request old and uncertain local obligations, independent of what the provider's recent list contains. */
export async function exchangeRecoveryQuery(account: TradingAccount): Promise<ExchangeRecoveryQuery> {
  const rows = await getDatabase().all<Array<ExchangeRecoveryQuery['orders'][number] & { createdAt: number }>>(
    `SELECT orders.client_order_id AS clientOrderId, orders.exchange_order_id AS exchangeOrderId,
       orders.provider_symbol AS providerSymbol, intent.symbol, orders.role, orders.created_at AS createdAt
     FROM trading_orders AS orders JOIN trading_trade_intents AS intent ON intent.id = orders.intent_id
     WHERE orders.account_id = ? AND (orders.status IN ('submitting', 'unknown', 'cancel_pending', 'open', 'partially_filled')
       OR (orders.status <> 'created' AND EXISTS (SELECT 1 FROM trading_positions AS position
         WHERE position.intent_id = orders.intent_id AND position.status IN ('opening', 'open', 'closing', 'emergency'))))
     ORDER BY COALESCE(orders.last_recovery_attempt_at, 0), orders.created_at, orders.client_order_id LIMIT 250`, [account.id],
  );
  const since = await requiredAccountEvidenceSince(account);
  const accountLogs = await accountLogCheckpoint(account);
  const readAccountMode = await accountModeReadRequired(account);
  return { since, orders: rows.map(({ createdAt: _createdAt, ...reference }) => reference),
    ...(readAccountMode ? { readAccountMode } : {}),
    ...(accountLogs ? { accountLogs } : {}),
    history: await historyCheckpoints(account, since) };
}

async function expectedOrders(input: TradingOperationInput): Promise<OperationOrder[]> {
  const ids = [...new Set(input.clientOrderIds)].sort(codePointOrder);
  if (ids.length !== input.clientOrderIds.length || ids.length < 1 || ids.length > 2) throw new Error('Invalid operation order identities.');
  const rows = await getDatabase().all<OperationOrder[]>(
    `SELECT client_order_id, exchange_order_id, provider_symbol, status FROM trading_orders
     WHERE intent_id = ? AND account_id = ? AND client_order_id IN (${ids.map(() => '?').join(',')}) ORDER BY client_order_id`,
    [input.intentId, input.account.id, ...ids],
  );
  if (rows.length !== ids.length) throw new Error('Operation does not have all expected local orders.');
  return rows;
}

/** Prepared is a durable promise of no dispatch yet; dispatching is conservatively in-flight. */
export async function prepareTradingOperation(input: TradingOperationInput): Promise<string> {
  return withDatabaseTransaction(async () => {
    const orders = await expectedOrders(input);
    const logicalKey = hash(JSON.stringify([input.kind, input.intentId, orders.map(order => order.client_order_id)]));
    const requestJson = JSON.stringify(input.request);
    const requestHash = hash(requestJson);
    const previous = await getDatabase().get<TradingOperation & { generation: number }>(
      'SELECT * FROM trading_operations WHERE account_id = ? AND logical_key = ? ORDER BY generation DESC LIMIT 1',
      [input.account.id, logicalKey],
    );
    if (previous?.phase === 'prepared') {
      if (previous.request_hash !== requestHash || previous.account_fingerprint !== input.account.externalAccountId
        || previous.credential_generation !== input.account.credentialGeneration) {
        throw new TradingRecoveryRequiredError('Prepared operation identity or request changed; recovery is required.');
      }
      return previous.id;
    }
    if (previous && !['resolved', 'abandoned'].includes(previous.phase)) {
      throw new TradingRecoveryRequiredError(`Operation is ${previous.phase}; do not repeat the exchange write without recovery.`);
    }
    const id = randomUUID();
    const now = Date.now();
    await getDatabase().run(
      `INSERT INTO trading_operations (id, account_id, intent_id, kind, logical_key, generation, account_fingerprint,
       credential_generation, request_hash, request_json, expected_orders_json, phase, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`,
      [id, input.account.id, input.intentId, input.kind, logicalKey, (previous?.generation ?? 0) + 1,
        input.account.externalAccountId, input.account.credentialGeneration, requestHash, requestJson, JSON.stringify(orders), now, now],
    );
    return id;
  });
}

const OPERATION_TRANSITIONS: Record<TradingOperationPhase, TradingOperationPhase[]> = {
  prepared: ['dispatching', 'abandoned'], dispatching: ['acknowledged', 'unresolved', 'abandoned', 'resolved'],
  acknowledged: ['resolved', 'unresolved'], unresolved: ['resolved'], resolved: [], abandoned: [],
};

export async function transitionTradingOperation(
  id: string, expected: TradingOperationPhase, next: TradingOperationPhase,
  evidence: unknown = null, error: string | null = null,
): Promise<void> {
  if (!OPERATION_TRANSITIONS[expected].includes(next)) throw new Error('Invalid exchange operation phase transition.');
  const result = await getDatabase().run(
    `UPDATE trading_operations SET phase = ?, evidence_json = COALESCE(?, evidence_json), last_error = ?,
     updated_at = ?, state_version = state_version + 1 WHERE id = ? AND phase = ?`,
    [next, evidence === null ? null : JSON.stringify(evidence), error, Date.now(), id, expected],
  );
  if (result.changes !== 1) throw new TradingRecoveryRequiredError('Exchange operation changed before its phase could commit.');
}

function acknowledgement(results: ExchangeOrderResult[]): object[] {
  return results.map(result => ({ clientOrderId: result.clientOrderId, exchangeOrderId: result.exchangeOrderId,
    providerSymbol: result.providerSymbol ?? null, status: result.status, filledQuantity: result.filledQuantity,
    averagePrice: result.averagePrice }));
}

function dispatchInputHash(input: TradingOperationInput): string {
  const account = input.account;
  return hash(JSON.stringify({ accountId: account.id, exchange: account.exchange, mode: account.mode,
    fingerprint: account.externalAccountId, credentialGeneration: account.credentialGeneration, credentialRef: account.credentialRef,
    intentId: input.intentId, kind: input.kind, clientOrderIds: input.clientOrderIds, request: input.request }));
}

function assertDispatchInputCurrent(input: TradingOperationInput, original: string): void {
  if (dispatchInputHash(input) !== original) {
    throw new TradingRecoveryRequiredError('JOURNALED_REQUEST_CHANGED: outbound identity or request differs from its original preparation.');
  }
}

export async function runJournaledExchangeWrite<T>(input: TradingOperationInput & {
  beforeDispatch: () => Promise<void>;
  beforeSend?: (witness: TradingDispatchWitness) => Promise<void>;
  guard: () => void;
  send: () => Promise<T>;
  persist: (result: T) => Promise<ExchangeOrderResult[]>;
}): Promise<T> {
  const originalInput = dispatchInputHash(input);
  const id = await prepareTradingOperation(input);
  let phase: TradingOperationPhase = 'prepared';
  let sent = false;
  try {
    assertDispatchInputCurrent(input, originalInput);
    await input.beforeDispatch();
    assertDispatchInputCurrent(input, originalInput);
    await transitionTradingOperation(id, 'prepared', 'dispatching');
    phase = 'dispatching';
    // Preserve precise TTL/operator rejection before broader monetary checks; the final fence is still repeated immediately before send.
    if (input.beforeSend) { input.guard(); assertDispatchInputCurrent(input, originalInput); }
    const start = () => {
      // No await after the synchronous final fence and before the actual send.
      input.guard();
      assertDispatchInputCurrent(input, originalInput);
      sent = true;
      return input.send();
    };
    const pending = input.beforeSend
      ? (await withDatabaseDispatchFence(() => withDispatchWitness(input, id, input.beforeSend!), start)).pending : start();
    const result = await pending;
    phase = await withDatabaseTransaction(async () => {
      const orders = await input.persist(result);
      const cancelIncomplete = input.kind === 'cancel' && orders.some(order => !['cancelled', 'filled', 'rejected'].includes(order.status));
      const next = cancelIncomplete || orders.some(order => order.status === 'unknown') ? 'unresolved' : 'acknowledged';
      await transitionTradingOperation(id, 'dispatching', next, acknowledgement(orders));
      return next;
    });
    return result;
  } catch (error) {
    if (phase === 'prepared' || phase === 'dispatching') await recordWriteFailure(id, phase, sent, error);
    throw error;
  }
}

async function recordWriteFailure(id: string, phase: 'prepared' | 'dispatching', sent: boolean, error: unknown): Promise<void> {
  const current = await getDatabase().get<{ evidence_json: string | null; state_version: number }>(
    'SELECT evidence_json, state_version FROM trading_operations WHERE id = ?', [id]);
  const contradicted = !sent && (current?.evidence_json !== null || current?.state_version !== (phase === 'prepared' ? 0 : 1));
  const message = contradicted ? 'NO_SEND_CONTRADICTED: journal contains acknowledgement or unexpected phase history.'
    : error instanceof Error ? error.message.slice(0, 500) : 'Exchange operation failed.';
  // Corrupt legacy preparation has no legal negative proof; preserve it for review instead of declaring it unsent.
  if (contradicted && phase === 'prepared') throw new TradingRecoveryRequiredError(message);
  await transitionTradingOperation(id, phase, sent || contradicted ? 'unresolved' : 'abandoned', null, message);
  if (contradicted) throw new TradingRecoveryRequiredError(message);
}

export async function unresolvedOperationCount(accountId: string): Promise<number> {
  const row = await getDatabase().get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM trading_operations WHERE account_id = ? AND phase IN ('dispatching', 'unresolved')", [accountId],
  );
  return Number(row?.count || 0);
}

function observedOperationEvidence(
  expected: OperationOrder[], remote: ExchangeOrderSnapshot[], kind: TradingOperationKind,
): ExchangeOrderSnapshot[] | null {
  if (!Array.isArray(expected) || expected.length < 1 || expected.length > 2) return null;
  const observed: ExchangeOrderSnapshot[] = [];
  for (const order of expected) {
    const matches = remote.filter(candidate => candidate.clientOrderId === order.client_order_id);
    const candidate = matches[0];
    if (matches.length !== 1 || !candidate || candidate.filledQuantity === null || candidate.status === 'unknown') return null;
    if (order.exchange_order_id && order.exchange_order_id !== candidate.exchangeOrderId) return null;
    if (order.provider_symbol && order.provider_symbol !== candidate.providerSymbol) return null;
    if (kind === 'cancel' && !['cancelled', 'filled', 'rejected'].includes(candidate.status)) return null;
    observed.push(candidate);
  }
  return observed;
}

/** An empty listing never resolves a write. Every expected order must have exact positive evidence. */
export async function resolveObservedOperations(account: TradingAccount, remote: ExchangeOrderSnapshot[]): Promise<void> {
  const operations = await getDatabase().all<Array<TradingOperation & { kind: TradingOperationKind; expected_orders_json: string }>>(
    "SELECT * FROM trading_operations WHERE account_id = ? AND phase IN ('dispatching', 'unresolved', 'acknowledged') ORDER BY created_at", [account.id],
  );
  for (const operation of operations) {
    if (operation.account_fingerprint !== account.externalAccountId || operation.credential_generation !== account.credentialGeneration) continue;
    const expected = JSON.parse(operation.expected_orders_json) as OperationOrder[];
    const observed = observedOperationEvidence(expected, remote, operation.kind);
    if (!observed) continue;
    await transitionTradingOperation(operation.id, operation.phase, 'resolved', {
      source: 'authoritative_order_snapshot', orders: acknowledgement(observed as ExchangeOrderResult[]),
    });
  }
}

interface UnsubmittedOrder extends OperationOrder {
  filled_quantity: string; request_json: string; role: string; side: string; order_type: string;
  quantity: string; price: string | null; trigger_price: string | null; reduce_only: number;
}

/** Recovery of a standalone exit is authorized only by positive local no-dispatch evidence, never remote absence. */
export async function recoverPreparedExits(account: TradingAccount, intentId: string, role: 'stop_loss' | 'take_profit' | 'flatten'): Promise<void> {
  await withDatabaseTransaction(async () => {
    const rows = await getDatabase().all<Array<UnsubmittedOrder & { id: string; state_version: number }>>(
      `SELECT * FROM trading_orders WHERE intent_id = ? AND account_id = ? AND role = ? AND reduce_only = 1
       AND status = 'submitting' AND exchange_order_id IS NULL AND filled_quantity = '0'
       AND response_json IS NULL AND average_price IS NULL
       ORDER BY created_at, rowid LIMIT 5`, [intentId, account.id, role]);
    for (const row of rows) {
      if (await getDatabase().get('SELECT id FROM trading_fills WHERE order_id = ? LIMIT 1', [row.id])) continue;
      const operations = await getDatabase().all<PlanOperation[]>(
        `SELECT * FROM trading_operations WHERE intent_id = ? AND EXISTS (
          SELECT 1 FROM json_each(expected_orders_json) WHERE json_extract(value, '$.client_order_id') = ?)`, [intentId, row.client_order_id]);
      if (!operations.length || !operations.every(operation => operation.account_id === account.id
        && operation.account_fingerprint === account.externalAccountId && operation.credential_generation === account.credentialGeneration
        && provesUnsentExit(row, operation))) continue;
      const changed = await getDatabase().run(`UPDATE trading_orders SET status = 'created', state_version = state_version + 1, updated_at = ?
        WHERE id = ? AND status = 'submitting' AND state_version = ?`, [Date.now(), row.id, row.state_version]);
      if (changed.changes !== 1) throw new TradingRecoveryRequiredError('Prepared exit changed during recovery.');
    }
  });
}

function unsentExitPhase(operation: PlanOperation): boolean {
  if (operation.kind !== 'submit' || operation.evidence_json !== null) return false;
  return operation.phase === 'prepared' ? operation.state_version === 0
    : operation.phase === 'abandoned' && [1, 2].includes(operation.state_version);
}

function provesUnsentExit(order: UnsubmittedOrder, operation: PlanOperation): boolean {
  if (!unsentExitPhase(operation)
    || hash(operation.request_json) !== operation.request_hash) return false;
  try {
    const expected = JSON.parse(operation.expected_orders_json);
    const request = JSON.parse(operation.request_json);
    const planned = JSON.parse(order.request_json) as PlannedOrder;
    const rowFields = { role: planned.role, side: planned.side, order_type: planned.orderType, quantity: planned.quantity,
      price: planned.price, trigger_price: planned.triggerPrice, reduce_only: Number(planned.reduceOnly) };
    return Array.isArray(expected) && expected.length === 1 && expected[0]?.client_order_id === order.client_order_id
      && expected[0].exchange_order_id === null && expected[0].status === 'created'
      && request.clientOrderId === order.client_order_id && request.role === order.role && request.reduceOnly === true
      && Object.entries(planned).every(([key, value]) => request[key] === value)
      && Object.entries(rowFields).every(([key, value]) => order[key as keyof UnsubmittedOrder] === value);
  } catch { return false; }
}

interface PlanOperation extends OriginalPlanOperation {
  phase: TradingOperationPhase;
  evidence_json: string | null; state_version: number;
}

function unsentPlanOperation(operation: PlanOperation, allowAbandoned: boolean, dispatchId?: string): boolean {
  if (operation.kind !== 'protected_entry' || operation.evidence_json !== null) return false;
  if (operation.phase === 'prepared') return operation.state_version === 0;
  if (operation.phase === 'abandoned') return allowAbandoned && [1, 2].includes(operation.state_version);
  return operation.id === dispatchId && operation.phase === 'dispatching' && operation.state_version === 1;
}

export async function hasUndispatchedPlanProof(intent: TradingIntent, allowAbandoned: boolean, witness?: TradingDispatchWitness): Promise<boolean> {
  const dispatch = currentDispatchIdentity(witness);
  if (witness && !dispatchMatchesIntent(dispatch, intent)) return false;
  const plan = undispatchedPlanShape(intent);
  if (!plan) return false;
  const account = await getDatabase().get<OrderIdentityAccount & { mode: string }>(
    `SELECT id, exchange, mode, external_account_id AS externalAccountId, credential_generation AS credentialGeneration
     FROM trading_accounts WHERE id = ? AND retired_at IS NULL`, [intent.accountId]);
  if (!account || account.exchange !== intent.exchange || account.mode !== intent.mode) return false;
  const stored = await getDatabase().get<{ status: string; plan_json: string }>(
    'SELECT status, plan_json FROM trading_trade_intents WHERE id = ? AND account_id = ?', [intent.id, intent.accountId],
  );
  if (stored?.status !== intent.status || stored.plan_json !== JSON.stringify(intent.plan)) return false;
  const position = await getDatabase().get(
    `SELECT id FROM trading_positions WHERE intent_id = ? AND account_id = ? AND status IN ('opening', 'emergency')
     AND quantity = '0' AND average_entry_price IS NULL AND opened_at IS NULL AND closed_at IS NULL
     AND (? = 1 OR emergency_requested_at IS NULL)`, [intent.id, intent.accountId, Number(allowAbandoned)],
  );
  if (!position) return false;
  const orders = await getDatabase().all<UnsubmittedOrder[]>(
    'SELECT * FROM trading_orders WHERE intent_id = ? AND account_id = ?', [intent.id, intent.accountId],
  );
  const operations = await getDatabase().all<PlanOperation[]>(
    'SELECT * FROM trading_operations WHERE intent_id = ?', [intent.id],
  );
  if (operations.some(operation => !unsentPlanOperation(operation, allowAbandoned, dispatch?.operationId))) return false;
  if (!await originalPlanJournalMatches(account, intent.id, plan, operations)) return false;
  if (orders.length !== plan.orders.length) return false;
  const covered = new Set(operations.flatMap(operation => (JSON.parse(operation.expected_orders_json) as OperationOrder[]).map(order => order.client_order_id)));
  const filled = await getDatabase().get(
    `SELECT fills.id FROM trading_fills AS fills JOIN trading_orders AS orders ON orders.id = fills.order_id WHERE orders.intent_id = ? LIMIT 1`, [intent.id],
  );
  return !filled && orders.every(order => unsubmittedOrderMatchesPlan(order, plan, covered));
}

function dispatchMatchesIntent(dispatch: Readonly<DispatchIdentity> | null, intent: TradingIntent): boolean {
  return dispatch !== null && dispatch.accountId === intent.accountId && dispatch.intentId === intent.id;
}

function undispatchedPlanShape(intent: TradingIntent): TradingPlan | null {
  const plan = intent.plan as TradingPlan | null;
  if (!plan || !['planned', 'submitting'].includes(intent.status)) return null;
  if (plan.version !== 1 || !Array.isArray(plan.orders) || !plan.orders.length || !Number.isSafeInteger(plan.createdAt)) return null;
  return plan;
}

/** Resume only a provably unsubmitted persisted plan, never a negative remote lookup. */
export async function recoverUndispatchedPlan(intent: TradingIntent): Promise<boolean> {
  return withDatabaseTransaction(async () => {
    if (!await hasUndispatchedPlanProof(intent, false)) return false;
    await getDatabase().run(
      "UPDATE trading_orders SET status = 'created', updated_at = ? WHERE intent_id = ? AND status = 'submitting'", [Date.now(), intent.id],
    );
    return true;
  });
}

/** No remote cancellation: only positive local no-dispatch evidence can release the reservation. */
export async function abandonUndispatchedPlan(intent: TradingIntent): Promise<boolean> {
  return withDatabaseTransaction(async () => {
    if (!await hasUndispatchedPlanProof(intent, true)) return false;
    const now = Date.now();
    await getDatabase().run(
      "UPDATE trading_orders SET status = 'cancelled', updated_at = ? WHERE intent_id = ? AND status IN ('created', 'submitting')", [now, intent.id],
    );
    await getDatabase().run(
      "UPDATE trading_operations SET phase = 'abandoned', state_version = state_version + 1, updated_at = ? WHERE intent_id = ? AND phase = 'prepared'", [now, intent.id],
    );
    await getDatabase().run(
      "UPDATE trading_positions SET status = 'closed', closed_at = ?, updated_at = ? WHERE intent_id = ? AND status IN ('opening', 'emergency')", [now, now, intent.id],
    );
    return true;
  });
}

function unsubmittedOrderMatchesPlan(
  order: UnsubmittedOrder, plan: TradingPlan, covered: Set<string>,
): boolean {
  if (order.exchange_order_id !== null || order.filled_quantity !== '0') return false;
  if (order.status !== 'created' && !(order.status === 'submitting' && covered.has(order.client_order_id))) return false;
  const planned = plan.orders.find(candidate => candidate?.clientOrderId === order.client_order_id);
  if (!planned) return false;
  try {
    const stored = JSON.parse(order.request_json);
    const fields = { role: planned.role, side: planned.side, order_type: planned.orderType, quantity: planned.quantity,
      price: planned.price, trigger_price: planned.triggerPrice, reduce_only: planned.reduceOnly ? 1 : 0 };
    return Object.entries(planned).every(([key, value]) => stored[key] === value)
      && Object.entries(fields).every(([key, value]) => order[key as keyof UnsubmittedOrder] === value);
  } catch { return false; }
}
