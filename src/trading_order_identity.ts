import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { getDatabase } from './db.js';
import type { ExchangeOrderRequest, TradingAccount } from './trading_types.js';

export type OrderIdentityAccount = Pick<TradingAccount, 'id' | 'exchange' | 'externalAccountId' | 'credentialGeneration'>;

export class OrderIdentityBindingError extends Error {
  readonly code = 'ORDER_IDENTITY_UNPROVEN';
  constructor(detail: string) { super(`ORDER_IDENTITY_UNPROVEN: ${detail}`); this.name = 'OrderIdentityBindingError'; }
}

interface ProtectedRequests { entry: ExchangeOrderRequest; protectiveStop: ExchangeOrderRequest }
interface OriginalOperation {
  account_id: string; account_fingerprint: string | null; credential_generation: string | null;
  request_hash: string; request_json: string; expected_orders_json: string;
}

function reject(detail: string): never { throw new OrderIdentityBindingError(detail); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('Original request object is missing.');
  return value as Record<string, unknown>;
}
function withoutTag(request: ExchangeOrderRequest): Omit<ExchangeOrderRequest, 'providerBatchTag'> {
  const { providerBatchTag: _tag, ...original } = request;
  return original;
}
function checkedTag(request: ExchangeOrderRequest): ExchangeOrderRequest['providerBatchTag'] {
  const tag = request.providerBatchTag;
  if (tag === undefined) return undefined;
  if (!isDeepStrictEqual(tag, { version: 1, tag: request.clientOrderId })) reject('Batch tag differs from its original local leg.');
  return tag;
}
function tagged(request: ExchangeOrderRequest): ExchangeOrderRequest {
  checkedTag(request);
  return { ...request, providerBatchTag: { version: 1, tag: request.clientOrderId } };
}

function originalRequests(row: OriginalOperation, account: OrderIdentityAccount, requested: ProtectedRequests): ProtectedRequests {
  const checksum = createHash('sha256').update(row.request_json).digest('hex');
  if (row.account_id !== account.id || row.account_fingerprint !== account.externalAccountId
    || row.credential_generation !== account.credentialGeneration || checksum !== row.request_hash) {
    reject('Original operation account, generation or checksum changed.');
  }
  const original = object(JSON.parse(row.request_json));
  if (!isDeepStrictEqual(Object.keys(original).sort(), ['entry', 'protectiveStop'])) reject('Original protected request changed shape.');
  const entry = object(original.entry) as unknown as ExchangeOrderRequest;
  const protectiveStop = object(original.protectiveStop) as unknown as ExchangeOrderRequest;
  for (const [stored, expected] of [[entry, requested.entry], [protectiveStop, requested.protectiveStop]]) {
    checkedTag(stored!);
    if (!isDeepStrictEqual(withoutTag(stored!), withoutTag(expected!))) reject('Original protected leg differs from the expected request.');
    if (expected!.providerBatchTag !== undefined && !isDeepStrictEqual(expected!.providerBatchTag, stored!.providerBatchTag)) {
      reject('An existing tagless request cannot acquire a new tag.');
    }
  }
  const expected = JSON.parse(row.expected_orders_json);
  const ids = [requested.entry.clientOrderId, requested.protectiveStop.clientOrderId].sort();
  if (!Array.isArray(expected) || !isDeepStrictEqual(expected.map(item => object(item).client_order_id).sort(), ids)) {
    reject('Original journal does not bind the expected two legs.');
  }
  if (Boolean(entry.providerBatchTag) !== Boolean(protectiveStop.providerBatchTag)) reject('Only one original leg has a batch tag.');
  return { entry, protectiveStop };
}

async function assertLocalLegs(account: OrderIdentityAccount, intentId: string, requests: ProtectedRequests): Promise<void> {
  const ids = [requests.entry.clientOrderId, requests.protectiveStop.clientOrderId];
  if (ids[0] === ids[1] || ids.some(id => typeof id !== 'string' || !id || id.length > 256 || /[\x00-\x20]/.test(id))) {
    reject('Protected request lacks distinct exact client identifiers.');
  }
  if ([requests.entry, requests.protectiveStop].some(leg => leg.accountId !== account.id)) reject('Protected request account changed.');
  const rows = await getDatabase().all<Array<{ client_order_id: string; role: string }>>(
    'SELECT client_order_id,role FROM trading_orders WHERE intent_id=? AND account_id=? AND client_order_id IN (?,?)', [intentId, account.id, ...ids]);
  if (rows.length !== 2 || !rows.some(row => row.client_order_id === ids[0] && row.role === 'entry')
    || !rows.some(row => row.client_order_id === ids[1] && row.role === 'stop_loss')) reject('Protected request lacks its exact local orders.');
}

/** Read-only, including in the final No-Send fence. Never rewrites an old journal or caller object. */
export async function prepareProtectedOrderIdentityRequests(
  account: OrderIdentityAccount, intentId: string, entry: ExchangeOrderRequest, protectiveStop: ExchangeOrderRequest,
): Promise<ProtectedRequests> {
  const requested = { entry, protectiveStop };
  if (account.exchange !== 'krakenfutures') return requested;
  try {
    checkedTag(entry); checkedTag(protectiveStop);
    await assertLocalLegs(account, intentId, requested);
    const rows = await getDatabase().all<OriginalOperation[]>(
      "SELECT * FROM trading_operations WHERE intent_id=? AND kind='protected_entry' ORDER BY generation", [intentId]);
    if (rows.length === 0) return { entry: tagged(entry), protectiveStop: tagged(protectiveStop) };
    const originals = rows.map(row => originalRequests(row, account, requested));
    if (originals.some(original => !isDeepStrictEqual(original, originals[0]))) reject('Protected operation generations have different originals.');
    return originals[0]!;
  } catch (error) {
    if (error instanceof OrderIdentityBindingError) throw error;
    reject('Original protected request cannot be validated.');
  }
}
