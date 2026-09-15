import { isDeepStrictEqual } from 'node:util';
import type { ExchangeOrderIdentityEvidence } from './trading_types.js';

type OrderIdentityInput = {
  identityEvidence?: unknown; raw?: unknown; clientOrderId?: unknown;
  exchangeOrderId?: unknown; providerSymbol?: unknown;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid order identity evidence object.');
  return value as Record<string, unknown>;
}
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.length > 256 || /[\x00-\x1f]/.test(value)) {
    throw new Error('Invalid order identity evidence identifier.');
  }
}
function codeUnitOrder(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
export function validateOrderIdentityEvidence(result: OrderIdentityInput): ExchangeOrderIdentityEvidence | undefined {
  if (result.identityEvidence === undefined) return undefined;
  const proof = result.identityEvidence;
  assertIdentityEvidence(proof, result);
  return proof;
}

function assertIdentityEvidence(value: unknown, result: OrderIdentityInput): asserts value is ExchangeOrderIdentityEvidence {
  const proof = object(value);
  assertScope(proof, result);
  const base = ['version', 'profile', 'clientOrderId', 'exchangeOrderId', 'providerSymbol'];
  const raw = object(result.raw), info = object(raw.info);
  let fields: string[];
  if (proof.profile === 'kraken_batch_tag_v1') {
    fields = [...base, 'tag'];
    if (proof.tag !== proof.clientOrderId || info.order_tag !== proof.tag || info.order_id !== proof.exchangeOrderId) {
      throw new Error('Kraken batch tag lacks its exact original response.');
    }
  } else if (proof.profile === 'hyperliquid_cloid_lookup_v1') {
    fields = [...base, 'user', 'providerMarketId', 'startedAt', 'completedAt'];
    validateCloid(proof, info, raw);
  } else throw new Error('Unsupported native order identity evidence.');
  const actualFields = Object.keys(proof);
  actualFields.sort(codeUnitOrder);
  fields.sort(codeUnitOrder);
  if (!isDeepStrictEqual(actualFields, fields)) {
    throw new Error('Unexpected order identity evidence fields.');
  }
}
function assertScope(proof: Record<string, unknown>, result: OrderIdentityInput): void {
  for (const field of ['clientOrderId', 'exchangeOrderId', 'providerSymbol']) id(proof[field]);
  if (proof.version !== 1 || proof.exchangeOrderId !== result.exchangeOrderId || proof.providerSymbol !== result.providerSymbol
    || (result.clientOrderId !== null && result.clientOrderId !== proof.clientOrderId)) throw new Error('Order identity witness scope changed.');
  const raw = object(result.raw);
  if (raw.id !== proof.exchangeOrderId || (raw.clientOrderId != null && raw.clientOrderId !== proof.clientOrderId)) {
    throw new Error('Order identity witness contradicts the original provider identifiers.');
  }
}
function validateCloid(proof: Record<string, unknown>, info: Record<string, unknown>, raw: Record<string, unknown>): void {
  const native = object(info.order);
  id(proof.providerMarketId);
  if (typeof proof.user !== 'string' || !/^0x[0-9a-f]{40}$/.test(proof.user)
    || typeof proof.clientOrderId !== 'string' || !/^0x[0-9a-fA-F]{32}$/.test(proof.clientOrderId)
    || String(native.oid) !== proof.exchangeOrderId || native.coin !== proof.providerMarketId || raw.symbol !== proof.providerSymbol
    || (native.cloid != null && native.cloid !== proof.clientOrderId)) throw new Error('Hyperliquid lookup scope contradicts its original order.');
  // The range comparisons run only after both values pass Number.isSafeInteger.
  if (![proof.startedAt, proof.completedAt].every(Number.isSafeInteger) || (proof.startedAt as number) < 0
    || (proof.completedAt as number) < (proof.startedAt as number) || (proof.completedAt as number) > Date.now() + 60_000) throw new Error('Invalid cloid lookup read interval.');
}
