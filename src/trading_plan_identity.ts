import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { getDatabase } from './db.js';
import { requestFromOrder } from './trading_order_request.js';
import { prepareProtectedOrderIdentityRequests, type OrderIdentityAccount } from './trading_order_identity.js';
import type { TradingPlan } from './trading_types.js';

export interface OriginalPlanOperation {
  id: string; account_id: string; kind: string; phase: string; generation: number; logical_key: string;
  account_fingerprint: string | null; credential_generation: string | null;
  request_json: string; request_hash: string; expected_orders_json: string;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function originalEntryComparison(original: { entry?: object } | null, request: ReturnType<typeof requestFromOrder>) {
  const expected = { ...request };
  // Read-only recognition of a pre-deadline-transport journal. Do not upgrade
  // its outbound request or ignore an explicitly present, conflicting deadline.
  if (original?.entry && !Object.hasOwn(original.entry, 'entryExpiresAt')) delete expected.entryExpiresAt;
  return expected;
}

async function operationMatchesPlan(operation: OriginalPlanOperation, account: OrderIdentityAccount, intentId: string, plan: TradingPlan): Promise<boolean> {
  const entry = plan.orders.find(order => order.role === 'entry');
  const stop = plan.orders.find(order => order.role === 'stop_loss');
  if (!entry || !stop || operation.kind !== 'protected_entry' || operation.account_id !== account.id
    || operation.account_fingerprint !== account.externalAccountId || operation.credential_generation !== account.credentialGeneration
    || operation.generation !== 1 || hash(operation.request_json) !== operation.request_hash) return false;
  const ids = [entry.clientOrderId, stop.clientOrderId].sort();
  if (operation.logical_key !== hash(JSON.stringify(['protected_entry', intentId, ids]))) return false;
  const expected = JSON.parse(operation.expected_orders_json);
  const original = JSON.parse(operation.request_json);
  const entryRequest = originalEntryComparison(original, requestFromOrder(account, plan, entry));
  const requests = await prepareProtectedOrderIdentityRequests(account, intentId,
    entryRequest, requestFromOrder(account, plan, stop));
  return Array.isArray(expected) && expected.length === 2
    && isDeepStrictEqual(expected.map(row => row.client_order_id).sort(), ids)
    && expected.every(row => row.exchange_order_id === null && row.provider_symbol === null && row.status === 'created')
    && isDeepStrictEqual(original, requests);
}

/** Shared original-request proof for admission, restart and local retirement. This never writes or repairs evidence. */
export async function originalPlanJournalMatches(
  account: OrderIdentityAccount, intentId: string, plan: TradingPlan, operations: OriginalPlanOperation[],
): Promise<boolean> {
  if (operations.length > 1) return false;
  const foreign = await getDatabase().get(
    `SELECT 1 FROM trading_orders WHERE intent_id = ? AND account_id <> ?
     UNION ALL SELECT 1 FROM trading_positions WHERE intent_id = ? AND account_id <> ? LIMIT 1`,
    [intentId, account.id, intentId, account.id]);
  if (foreign) return false;
  try {
    for (const operation of operations) if (!await operationMatchesPlan(operation, account, intentId, plan)) return false;
    return true;
  } catch { return false; }
}
