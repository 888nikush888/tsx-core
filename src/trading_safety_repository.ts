import { getDatabase } from './db.js';
import { compareDecimal, decimal, signedDecimal } from './trading_decimal.js';
import { assertOwnedPositionNamespace, loadOwnershipProof } from './trading_ownership.js';
import { requiredAccountEvidenceSince } from './trading_account_baseline.js';
import { unresolvedEvidenceCount } from './trading_evidence_repository.js';
import { unresolvedFillIdentityCount } from './trading_fill_identity_repository.js';
import { TERMINAL_ORDER_STATES } from './trading_entry_commitment.js';
import { fundingTotalValue, validateAccountingEvidence } from './trading_accounting_contract.js';
import { assertAccountingFresh } from './trading_accounting.js';
import { assertFundingObservationCurrent } from './trading_funding_observation.js';
import type { ExchangeOpenState, TradingAccount, TradingAccountSnapshot, TradingSide } from './trading_types.js';
import type { HistoricalTradeSafety, SafetyBinding, SafetyEvidence, SafetyOperation, SafetyOrder, SafetyPosition } from './trading_safety_proof.js';

interface StoredSafetyOrder extends Omit<SafetyOrder, 'remoteConfirmed' | 'reduceOnly'> {
  reduceOnly: number; providerSymbol: string | null;
}
export interface ReconciledAccountEvidence {
  account: TradingAccount; accountVersion: number; remote: ExchangeOpenState;
}
export interface AccountSafetyEvidenceRequest {
  reconciled: ReconciledAccountEvidence; current: TradingAccount; epoch: string; requestedAt: number;
  runtimeCurrent?: boolean;
}
export interface ReleaseEvidenceRequest extends AccountSafetyEvidenceRequest {
  verificationAccount: TradingAccount;
  balance: TradingAccountSnapshot; balanceStartedAt: number; balanceCompletedAt: number;
}

function sameIdentity(current: TradingAccount, expected: TradingAccount): boolean {
  return current.id === expected.id && current.exchange === expected.exchange && current.mode === expected.mode
    && current.externalAccountId === expected.externalAccountId && current.credentialGeneration === expected.credentialGeneration;
}

function remoteConfirms(order: StoredSafetyOrder, state: ExchangeOpenState): boolean {
  const found = state.orders.filter(remote => remote.clientOrderId === order.clientOrderId
    && remote.exchangeOrderId === order.exchangeOrderId && remote.providerSymbol === order.providerSymbol);
  if (found.length !== 1) return false;
  const remote = found[0]!;
  return remote.symbol === order.symbol && remote.side === order.side && remote.reduceOnly === (Number(order.reduceOnly) === 1)
    && remote.status === order.status && remote.filledQuantity === order.filledQuantity && remote.quantity === order.quantity
    && remote.triggerPrice === order.triggerPrice;
}

async function safetyOrders(accountId: string, remote: ExchangeOpenState): Promise<SafetyOrder[]> {
  const rows = await getDatabase().all<StoredSafetyOrder[]>(
    `SELECT orders.account_id AS accountId, orders.intent_id AS intentId, orders.client_order_id AS clientOrderId,
       orders.exchange_order_id AS exchangeOrderId, orders.provider_symbol AS providerSymbol, intent.symbol,
       orders.role, orders.side, orders.status, orders.reduce_only AS reduceOnly,
       orders.quantity, orders.filled_quantity AS filledQuantity, orders.trigger_price AS triggerPrice
     FROM trading_orders AS orders JOIN trading_trade_intents AS intent ON intent.id = orders.intent_id
     WHERE orders.account_id = ? ORDER BY orders.client_order_id`, [accountId]);
  return rows.map(order => ({ ...order, reduceOnly: Number(order.reduceOnly) === 1, remoteConfirmed: remoteConfirms(order, remote) }));
}

async function safetyPositions(accountId: string, remote: ExchangeOpenState): Promise<SafetyPosition[]> {
  const rows = await getDatabase().all<Array<SafetyPosition['need']>>(
    `SELECT account_id AS accountId, intent_id AS intentId, symbol, side, quantity, stop_price AS minimumTrigger
     FROM trading_positions WHERE account_id = ? AND status <> 'closed' ORDER BY intent_id`, [accountId]);
  const positions: SafetyPosition[] = [];
  for (const need of rows) {
    let ownership = null;
    const matches = remote.positions.filter(position => position.symbol === need.symbol);
    try {
      if (matches.length === 1) await assertOwnedPositionNamespace(need.intentId, matches[0]!);
      ownership = await loadOwnershipProof(need.intentId, need.side);
    } catch { /* Unproved is not zero. */ }
    const remoteMatches = ownership !== null
      && (matches.length === 0 ? ownership.netQuantity === '0' : matches.length === 1 && matches[0]!.side === need.side
        && compareDecimal(matches[0]!.quantity, ownership.netQuantity) === 0);
    const projectionMatches = ownership !== null && compareDecimal(need.quantity, ownership.netQuantity) === 0;
    positions.push({ need, ownership, remoteMatches, projectionMatches });
  }
  return positions;
}

async function safetyOperations(accountId: string): Promise<SafetyOperation[]> {
  const rows = await getDatabase().all<Array<Omit<SafetyOperation, 'hasEntry'> & { hasEntry: number }>>(
    `SELECT operation.id, operation.intent_id AS intentId, operation.phase,
       EXISTS (SELECT 1 FROM json_each(operation.expected_orders_json) AS expected JOIN trading_orders AS orders
         ON orders.client_order_id = json_extract(expected.value, '$.client_order_id') AND orders.intent_id = operation.intent_id
         WHERE orders.role = 'entry') AS hasEntry
     FROM trading_operations AS operation WHERE operation.account_id = ? AND operation.phase NOT IN ('resolved', 'abandoned')
     ORDER BY operation.id`, [accountId]);
  return rows.map(row => ({ ...row, hasEntry: row.hasEntry === 1 }));
}

async function historicalTrades(accountId: string, orders: SafetyOrder[]): Promise<HistoricalTradeSafety[]> {
  const rows = await getDatabase().all<Array<{ intentId: string; side: TradingSide; quantity: string | null }>>(
    `SELECT intent.id AS intentId, intent.side, position.quantity FROM trading_trade_intents AS intent
     LEFT JOIN trading_positions AS position ON position.intent_id = intent.id
     WHERE intent.account_id = ? AND (position.id IS NULL OR position.status = 'closed')
       AND (intent.status = 'completed' OR EXISTS (SELECT 1 FROM trading_orders AS orders WHERE orders.intent_id = intent.id))
     ORDER BY intent.id`, [accountId]);
  const entries = new Set(orders.filter(order => order.role === 'entry').map(order => order.intentId));
  const result: HistoricalTradeSafety[] = [];
  for (const row of rows) {
    let ownership = null;
    let closedProjectionQuantity = row.quantity;
    try {
      if (row.quantity !== null) closedProjectionQuantity = decimal(row.quantity);
      ownership = await loadOwnershipProof(row.intentId, row.side);
    } catch { /* Historic labels cannot override missing or conflicting execution evidence. */ }
    result.push({ accountId, intentId: row.intentId, hasEntryHistory: entries.has(row.intentId), ownership, closedProjectionQuantity });
  }
  return result;
}

async function balanceVerified(input: ReleaseEvidenceRequest, now: number): Promise<boolean> {
  if (input.balanceStartedAt < input.requestedAt || input.balanceCompletedAt < input.balanceStartedAt
    || input.balanceCompletedAt > now || now - input.balanceStartedAt > 30_000) return false;
  try {
    decimal(input.balance.equity); decimal(input.balance.availableBalance); decimal(input.balance.marginUsed);
    signedDecimal(input.balance.unrealizedPnl);
    await releaseFundingVerified(input, now);
    return true;
  } catch { return false; }
}

async function releaseFundingVerified(input: ReleaseEvidenceRequest, now: number): Promise<void> {
  const { balance } = input;
  if (balance.fundingPnlTodayValue === undefined && balance.fundingPnlToday !== null) {
    signedDecimal(balance.fundingPnlToday);
    return;
  }
  const evidence = validateAccountingEvidence(balance.accounting, balance.fundingPnlToday, balance.fundingPnlTodayValue);
  assertAccountingFresh(evidence, now);
  if (!fundingTotalValue(evidence.funding, evidence.reportingCurrency)) throw new Error('Funding is unresolved.');
  if (evidence.funding.observation) await assertFundingObservationCurrent(input.current, evidence.funding.observation);
  else signedDecimal(balance.fundingPnlToday); // Native legacy amounts retain their original release contract.
}

/** Caller owns the account coordinator and the database transaction through the final decision commit. */
export async function collectAccountSafetyEvidence(input: AccountSafetyEvidenceRequest): Promise<SafetyEvidence> {
  const { current, reconciled } = input;
  const rawAccount = await getDatabase().get<{ state_version: number }>('SELECT state_version FROM trading_accounts WHERE id = ?', [current.id]);
  const remoteFingerprint = (reconciled.remote as ExchangeOpenState & { accountFingerprint?: string }).accountFingerprint;
  const identityVerified = sameIdentity(current, reconciled.account)
    && (current.exchange === 'paper' || (current.externalAccountId !== null && current.credentialGeneration !== null
      && remoteFingerprint === current.externalAccountId));
  const binding: SafetyBinding = { accountId: current.id, accountVersion: rawAccount?.state_version ?? -1, runtimeEpoch: input.epoch,
    accountFingerprint: current.externalAccountId, credentialGeneration: current.credentialGeneration };
  const orders = await safetyOrders(current.id, reconciled.remote);
  const positions = await safetyPositions(current.id, reconciled.remote);
  const operations = await safetyOperations(current.id);
  const incidents = await getDatabase().all<Array<{ id: string }>>(
    "SELECT id FROM trading_account_incidents WHERE account_id = ? AND status = 'open' ORDER BY id", [current.id]);
  const risks = await getDatabase().all<Array<{ id: string }>>(
    `SELECT id FROM trading_risk_events WHERE severity = 'critical' AND acknowledged_at IS NULL
     AND (account_id = ? OR (account_id IS NULL AND intent_id IS NULL)) ORDER BY id`, [current.id]);
  const terminal = (status: string) => (TERMINAL_ORDER_STATES as readonly string[]).includes(status);
  const orphanIntents = orders.filter(order => !terminal(order.status) && !positions.some(position => position.need.intentId === order.intentId));
  const now = Date.now();
  return { binding, identityVerified, stateCurrent: rawAccount?.state_version === reconciled.accountVersion,
    accountReady: current.enabled && current.status === 'ready' && current.lastVerifiedAt !== null,
    entryAllowed: false, acquisition: reconciled.remote.acquisition, minimumAcquisitionStart: input.requestedAt,
    runtimeCurrent: input.runtimeCurrent,
    historyExchange: current.exchange === 'paper' ? undefined : current.exchange,
    requiredSince: await requiredAccountEvidenceSince(current), now, orders, positions, operations,
    unresolvedEvidence: await unresolvedEvidenceCount(current.id),
    fillIdentityUnresolved: await unresolvedFillIdentityCount(current),
    foreignOrders: reconciled.remote.orders.filter(remote => !terminal(remote.status)
      && !orders.some(order => order.clientOrderId === remote.clientOrderId && order.exchangeOrderId === remote.exchangeOrderId)).length,
    foreignPositions: reconciled.remote.positions.filter(remote => !positions.some(position => position.need.symbol === remote.symbol)).length,
    blockingIncidents: [...incidents, ...risks].map(incident => incident.id),
    reviewRequiredIntents: [...new Set(orphanIntents.map(order => order.intentId))],
    historicalTrades: await historicalTrades(current.id, orders), balanceVerified: false };
}

/** Balance and identity verification are additional requirements, never inferred from a lifecycle observation. */
export async function collectAccountReleaseEvidence(input: ReleaseEvidenceRequest): Promise<SafetyEvidence> {
  const evidence = await collectAccountSafetyEvidence(input);
  return { ...evidence, identityVerified: evidence.identityVerified && sameIdentity(input.current, input.verificationAccount),
    balanceVerified: await balanceVerified(input, evidence.now) };
}
