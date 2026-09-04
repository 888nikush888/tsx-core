import { createHash, createHmac } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { getDatabase, withDatabaseTransaction } from './db.js';
import { compareDecimal } from './trading_decimal.js';
import { correlateRemoteOrders, type LocalCorrelationOrder } from './exchange_order_correlation.js';
import { validateOrderIdentityEvidence } from './exchange_order_identity_contract.js';
import type { ExchangeOrderIdentityEvidence, ExchangeOrderResult, ExchangeOrderSnapshot, TradingAccount } from './trading_types.js';

type Evidence = Pick<ExchangeOrderResult, 'identityEvidence' | 'raw' | 'exchangeOrderId' | 'providerSymbol'> & { clientOrderId: string | null };
type AccountIdentity = Pick<TradingAccount, 'id' | 'exchange' | 'mode' | 'externalAccountId' | 'credentialGeneration'>;
interface Local extends LocalCorrelationOrder {
  id: string; account_id: string; intent_id: string; state_version: number; status: string;
  order_type: string; price: string | null;
}
interface Original { id: string; request_hash: string; request_json: string; expected_orders_json: string;
  account_fingerprint: string; credential_generation: string; kind: string; phase: string; generation: number; logical_key: string }
interface Binding { remote_order_key: string; profile: string; account_fingerprint: string; credential_generation: string;
  operation_id: string; request_hash: string; evidence_hash: string; evidence_json: string }
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const fail = (detail: string): never => { throw new Error(`ORDER_IDENTITY_UNPROVEN: ${detail}`); };

function assertProvider(account: AccountIdentity, proof: ExchangeOrderIdentityEvidence): void {
  if (proof.profile === 'kraken_batch_tag_v1') {
    if (account.exchange !== 'krakenfutures') fail('Batch proof has a foreign provider.');
    return;
  }
  const fingerprint = createHmac('sha256', proof.user).update(`external-account-id:v1:hyperliquid:${account.mode}`).digest('hex');
  if (account.exchange !== 'hyperliquid' || fingerprint !== account.externalAccountId) fail('Cloid query belongs to a different account.');
}

function assertOriginalLeg(original: Original, local: Local, proof: ExchangeOrderIdentityEvidence, account: AccountIdentity): void {
  if (hash(original.request_json) !== original.request_hash || original.account_fingerprint !== account.externalAccountId
    || original.credential_generation !== account.credentialGeneration) fail('Original journal scope or bytes changed.');
  const request = JSON.parse(original.request_json);
  const legs = original.kind === 'protected_entry' ? [request.entry, request.protectiveStop] : [request];
  const matches = legs.filter(leg => leg?.clientOrderId === local.client_order_id);
  if (matches.length !== 1) fail('Original request has no unique matching leg.');
  const leg = matches[0];
  assertLegFields(leg, local, account.id);
  assertExpectedLegs(original, local.intent_id, legs);
  if (proof.profile === 'kraken_batch_tag_v1' && (original.kind !== 'protected_entry'
    || !isDeepStrictEqual(leg.providerBatchTag, { version: 1, tag: proof.tag }))) fail('Tag was not in the actual dispatched request.');
}
function assertExpectedLegs(original: Original, intentId: string, legs: Array<Record<string, any>>): void {
  const expected = JSON.parse(original.expected_orders_json), ids = legs.map(leg => leg.clientOrderId).sort();
  if (!Array.isArray(expected) || expected.length !== ids.length || new Set(ids).size !== ids.length
    || !isDeepStrictEqual(expected.map(row => row.client_order_id).sort(), ids)) fail('Original expected leg set changed.');
  if (!Number.isSafeInteger(original.generation) || original.generation < 1
    || original.logical_key !== hash(JSON.stringify([original.kind, intentId, ids]))) fail('Original journal generation or logical key changed.');
}
function assertLegFields(leg: Record<string, any>, local: Local, accountId: string): void {
  if (leg.accountId !== accountId || leg.symbol !== local.symbol || leg.role !== local.role || leg.side !== local.side
    || leg.orderType !== local.order_type || leg.reduceOnly !== (local.reduce_only === 1)
    || compareDecimal(leg.quantity, local.quantity) !== 0) fail('Original request leg differs from its local order.');
  if (local.role === 'stop_loss' && (leg.triggerPrice === null || local.trigger_price === null
    || compareDecimal(leg.triggerPrice, local.trigger_price) !== 0)) fail('Original stop trigger changed.');
  assertOriginalPrice(leg.price, local.price);
}
function assertOriginalPrice(original: string | null | undefined, current: string | null): void {
  if (original !== current && (original == null || current === null || compareDecimal(original, current) !== 0)) fail('Original order price changed.');
}

async function originalFor(account: AccountIdentity, local: Local, proof: ExchangeOrderIdentityEvidence): Promise<Original> {
  const rows = await getDatabase().all<Original[]>(`SELECT * FROM trading_operations WHERE account_id=? AND intent_id=?
    AND kind IN ('protected_entry','submit') AND phase IN ('dispatching','acknowledged','unresolved')
    AND EXISTS(SELECT 1 FROM json_each(expected_orders_json) leg WHERE json_extract(leg.value,'$.client_order_id')=?)`,
  [account.id, local.intent_id, local.client_order_id]);
  if (rows.length !== 1) fail('No unique possibly dispatched original journal.');
  assertOriginalLeg(rows[0]!, local, proof, account);
  return rows[0]!;
}

/** Called inside the same transaction as the order ID CAS. No upsert or original rewrite. */
export async function persistNativeOrderBinding(account: AccountIdentity, localOrderId: string, result: Evidence): Promise<void> {
  const proof = validateOrderIdentityEvidence(result);
  if (!proof) return;
  assertProvider(account, proof);
  const local = await getDatabase().get<Local>(`SELECT orders.*,intent.symbol FROM trading_orders orders
    JOIN trading_trade_intents intent ON intent.id=orders.intent_id WHERE orders.id=? AND orders.account_id=?`, [localOrderId, account.id]);
  if (!local || local.client_order_id !== proof.clientOrderId) fail('Proof does not belong to this local order.');
  const remoteKey = JSON.stringify(['v1', account.exchange, proof.providerSymbol, proof.exchangeOrderId]);
  const existing = await getDatabase().get<Binding>(
    'SELECT * FROM trading_order_identity_bindings WHERE order_id=?', [localOrderId]);
  if (existing) {
    if (existing.remote_order_key !== remoteKey || existing.profile !== proof.profile || existing.account_fingerprint !== account.externalAccountId) fail('Existing immutable binding conflicts.');
    await verifyExistingBinding(existing, account, local, proof);
    return;
  }
  if (['filled', 'cancelled', 'rejected'].includes(local.status) && !local.exchange_order_id) fail('Terminal local order cannot acquire a new remote identity.');
  const original = await originalFor(account, local, proof);
  const payload = JSON.stringify({ version: 1, proof, originalRequestHash: original.request_hash, operationId: original.id,
    originalGeneration: original.generation, originalLogicalKey: original.logical_key });
  await getDatabase().run(`INSERT INTO trading_order_identity_bindings(order_id,account_id,operation_id,account_fingerprint,
    credential_generation,profile,remote_order_key,request_hash,evidence_hash,evidence_json,bound_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  [local.id, account.id, original.id, original.account_fingerprint, original.credential_generation, proof.profile, remoteKey,
    original.request_hash, hash(payload), payload, Date.now()]);
}

function stableProof(proof: ExchangeOrderIdentityEvidence): unknown {
  if (proof.profile !== 'hyperliquid_cloid_lookup_v1') return proof;
  const { startedAt: _startedAt, completedAt: _completedAt, ...scope } = proof;
  return scope;
}
async function verifyExistingBinding(binding: Binding, account: AccountIdentity, local: Local, proof: ExchangeOrderIdentityEvidence): Promise<void> {
  if (hash(binding.evidence_json) !== binding.evidence_hash) fail('Stored identity evidence hash changed.');
  const stored = JSON.parse(binding.evidence_json);
  if (stored.version !== 1 || stored.operationId !== binding.operation_id || stored.originalRequestHash !== binding.request_hash
    || !isDeepStrictEqual(stableProof(stored.proof), stableProof(proof))) fail('Stored original identity witness changed.');
  const original = await getDatabase().get<Original>('SELECT * FROM trading_operations WHERE id=? AND account_id=? AND intent_id=?',
    [binding.operation_id, account.id, local.intent_id]);
  if (!original || original.request_hash !== binding.request_hash || ['prepared', 'abandoned'].includes(original.phase)
    || stored.originalGeneration !== original.generation || stored.originalLogicalKey !== original.logical_key) fail('Bound original operation changed.');
  // Existing same-account bindings retain their historical generation across a verified credential rotation.
  assertOriginalLeg(original, local, stored.proof, { ...account, credentialGeneration: binding.credential_generation });
}

export async function persistNativeOrderBindingForLocal(localOrderId: string, result: Evidence): Promise<void> {
  if (!result.identityEvidence) return;
  const account = await getDatabase().get<AccountIdentity>(`SELECT account.id,account.exchange,account.mode,
    account.external_account_id AS externalAccountId,account.credential_generation AS credentialGeneration
    FROM trading_accounts account JOIN trading_orders orders ON orders.account_id=account.id WHERE orders.id=?`, [localOrderId]);
  if (!account) fail('Native order evidence has no local account.');
  await persistNativeOrderBinding(account, localOrderId, result);
}

/** Only positive native evidence + the immutable local journal may bind a missing provider client ID. */
export async function correlateNativeOrderEvidence(account: TradingAccount, orders: ExchangeOrderSnapshot[]): Promise<ExchangeOrderSnapshot[]> {
  return withDatabaseTransaction(async () => {
    const result: ExchangeOrderSnapshot[] = [];
    for (const remote of orders) result.push(await bindObservedOrder(account, remote));
    return result;
  });
}
async function bindObservedOrder(account: TradingAccount, remote: ExchangeOrderSnapshot): Promise<ExchangeOrderSnapshot> {
  const proof = validateOrderIdentityEvidence(remote);
  if (!proof) return remote;
  const local = await getDatabase().get<Local>(`SELECT orders.*,intent.symbol FROM trading_orders orders
    JOIN trading_trade_intents intent ON intent.id=orders.intent_id WHERE orders.account_id=? AND orders.client_order_id=?`,
  [account.id, proof.clientOrderId]);
  if (!local) fail('Lookup is not backed by an existing local order.');
  const [correlated] = correlateRemoteOrders([local], [{ ...remote, clientOrderId: proof.clientOrderId }]);
  await persistNativeOrderBinding(account, local.id, correlated!);
  if (!local.exchange_order_id) {
    const updated = await getDatabase().run(`UPDATE trading_orders SET exchange_order_id=?,provider_symbol=?,remote_order_key=?,
      state_version=state_version+1 WHERE id=? AND state_version=? AND exchange_order_id IS NULL`,
    [remote.exchangeOrderId, remote.providerSymbol, JSON.stringify(['v1', account.exchange, remote.providerSymbol, remote.exchangeOrderId]), local.id, local.state_version]);
    if (updated.changes !== 1) fail('Order changed before its native identity could commit.');
  }
  return correlated!;
}
