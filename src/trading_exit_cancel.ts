import { getDatabase } from './db.js';
import { compareDecimal } from './trading_decimal.js';
import { assertCancelAcquisition, exactActiveCancelEvidence, type CancelOrder } from './trading_cancel_evidence.js';
import { cancelRetryObservation, loadCancelOrder } from './trading_cancel_recovery.js';
import { loadTradeLifecycle } from './trading_lifecycle.js';
import { loadProtectionOrders, protectiveStopCoverage, requiredStopQuantity } from './trading_protection.js';
import type { ExchangeOpenState, TradingAccount, TradingSide } from './trading_types.js';

export async function pendingCancelOrderIds(accountId: string, intentId: string): Promise<Set<string>> {
  const rows = await getDatabase().all<Array<{ client_order_id: string }>>(
    `SELECT orders.client_order_id FROM trading_orders AS orders WHERE orders.account_id = ? AND orders.intent_id = ?
     AND (orders.status = 'cancel_pending' OR EXISTS (SELECT 1 FROM trading_operations AS operation, json_each(operation.expected_orders_json) AS expected
       WHERE operation.account_id = orders.account_id AND operation.kind = 'cancel' AND operation.phase <> 'abandoned'
       AND json_extract(expected.value, '$.client_order_id') = orders.client_order_id))`, [accountId, intentId]);
  return new Set(rows.map(row => row.client_order_id));
}

async function entriesProvedTerminal(account: TradingAccount, row: CancelOrder, remote: ExchangeOpenState): Promise<boolean> {
  const entries = await getDatabase().all<Array<{ client_order_id: string }>>(
    "SELECT client_order_id FROM trading_orders WHERE account_id = ? AND intent_id = ? AND role = 'entry'", [account.id, row.intent_id]);
  if (!entries.length) return false;
  for (const entry of entries) {
    const local = await loadCancelOrder(account.id, entry.client_order_id);
    const found = remote.orders.filter(order => order.clientOrderId === local.client_order_id && order.exchangeOrderId === local.exchange_order_id
      && order.providerSymbol === local.provider_symbol && order.symbol === local.symbol);
    if (found.length !== 1 || !['filled', 'cancelled', 'rejected'].includes(found[0]!.status)
      || found[0]!.status !== local.status || found[0]!.filledQuantity !== local.filled_quantity) return false;
  }
  return true;
}

/** A pending cancel is not a durable replacement: an earlier cancel can still finish at any instant. */
async function hasIndependentProtection(account: TradingAccount, row: CancelOrder, remote: ExchangeOpenState,
  side: TradingSide, quantity: string, minimumTrigger: string): Promise<boolean> {
  const orders = await loadProtectionOrders(account.id, row.intent_id);
  const need = { accountId: account.id, intentId: row.intent_id, symbol: row.symbol, side,
    quantity: requiredStopQuantity(quantity, orders.filter(order => order.role === 'entry')), minimumTrigger };
  const cancelling = await pendingCancelOrderIds(account.id, row.intent_id);
  for (const candidate of orders.filter(order => order.role === 'stop_loss' && order.clientOrderId !== row.client_order_id)) {
    if (!candidate.clientOrderId || cancelling.has(candidate.clientOrderId)) continue;
    const local = await loadCancelOrder(account.id, candidate.clientOrderId);
    if (local.provider_symbol !== row.provider_symbol) continue;
    const active = exactActiveCancelEvidence(local, remote, account, 0);
    if (active && protectiveStopCoverage({ ...active.order, accountId: account.id, intentId: row.intent_id }, need).protected) return true;
  }
  return false;
}

export async function assertExitCancellationSafe(account: TradingAccount, row: CancelOrder, remote: ExchangeOpenState): Promise<void> {
  assertCancelAcquisition(remote);
  if (row.reduce_only !== 1 || row.role === 'entry') throw new Error('Exit cancellation is not bound to a reduce-only exit.');
  const position = await getDatabase().get<{ side: TradingSide; stop_price: string }>(
    'SELECT side, stop_price FROM trading_positions WHERE account_id = ? AND intent_id = ?', [account.id, row.intent_id]);
  if (!position) throw new Error('Exit cancellation has no managed lifecycle.');
  const proof = await loadTradeLifecycle(row.intent_id, position.side);
  const positions = remote.positions.filter(item => item.symbol === row.symbol);
  if (proof.flat && proof.entriesTerminal && positions.length === 0 && await entriesProvedTerminal(account, row, remote)) return;
  if (positions.length !== 1 || positions[0]!.providerSymbol !== row.provider_symbol || positions[0]!.side !== position.side
    || compareDecimal(positions[0]!.quantity, proof.ownership.netQuantity) !== 0) throw new Error('Exit cancellation lacks exact current owned exposure.');
  if (row.role === 'stop_loss' && !await hasIndependentProtection(account, row, remote, position.side, proof.ownership.netQuantity, position.stop_price)) {
    throw new Error('Stop cancellation requires a fresh independent replacement covering owned exposure and entry remainder.');
  }
}

async function assertCurrentAccount(account: TradingAccount): Promise<void> {
  const current = await getDatabase().get<{ exchange: string; mode: string; external_account_id: string | null; credential_generation: string | null }>(
    'SELECT exchange, mode, external_account_id, credential_generation FROM trading_accounts WHERE id = ?', [account.id]);
  if (!current || current.exchange !== account.exchange || current.mode !== account.mode || current.external_account_id !== account.externalAccountId
    || current.credential_generation !== account.credentialGeneration) throw new Error('Cancellation account binding changed before dispatch.');
}

export async function prepareCancelDispatch(account: TradingAccount, intentId: string, clientOrderId: string, remote?: ExchangeOpenState) {
  const boundAccount = structuredClone(account);
  const binding = (value: TradingAccount) => JSON.stringify([value.id, value.exchange, value.mode, value.externalAccountId, value.credentialGeneration]);
  const originalBinding = binding(boundAccount);
  const original = await loadCancelOrder(account.id, clientOrderId);
  if (original.intent_id !== intentId || !original.exchange_order_id || !original.provider_symbol) throw new Error('Cancellation lacks exact managed identifiers.');
  const observation = await cancelRetryObservation(account, original, remote);
  const evidence = observation ? structuredClone(observation) : undefined;
  if (evidence) assertCancelAcquisition(evidence);
  const stable = (row: CancelOrder) => JSON.stringify([row.intent_id, row.client_order_id, row.exchange_order_id, row.provider_symbol,
    row.symbol, row.role, row.side, row.quantity, row.reduce_only, row.price, row.trigger_price]);
  const currentTarget = async () => {
    if (evidence) assertCancelAcquisition(evidence);
    const row = await loadCancelOrder(account.id, clientOrderId);
    if (stable(row) !== stable(original) || row.status !== 'cancel_pending') throw new Error('Cancellation target changed before dispatch.');
    if (evidence && !exactActiveCancelEvidence(row, evidence, account, 0)) throw new Error('Cancellation evidence changed or expired before dispatch.');
    return row;
  };
  const beforeSend = async () => {
    const row = await currentTarget();
    if (row.role !== 'entry') {
      if (!evidence) throw new Error('Exit cancellation lacks fresh evidence.');
      await assertExitCancellationSafe(account, row, evidence);
    }
    // Protection checks await several ledger reads; bind the actual dispatch only after they have completed.
    await currentTarget();
    await assertCurrentAccount(boundAccount);
  };
  const guard = () => {
    if (binding(account) !== originalBinding) throw new Error('Cancellation request account identity changed at final dispatch.');
    if (evidence) assertCancelAcquisition(evidence);
  };
  return { beforeSend, guard };
}
