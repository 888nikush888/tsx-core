import { createHash } from 'node:crypto';
import { decimal } from './trading_decimal.js';

export type FxLegId = 'bybit:btc-usd-index:v1' | 'bybit:btc-usdt-index:v1' | 'bybit:usdc-usd-index:v1';
export interface FxContext { mode: 'live' | 'testnet'; profileHash: string }
export interface FxLegReceipt extends FxContext {
  version: 1; provider: 'bybit'; origin: string; endpoint: '/v5/market/tickers';
  source: 'bybit-v5-rest-index-snapshot-v1'; legId: FxLegId; routeId: string;
  ccxtVersion: '4.5.75'; profileVersion: 1;
  category: 'inverse' | 'linear' | 'spot'; symbol: string; field: 'indexPrice' | 'usdIndexPrice'; value: string;
  providerQuoteAt: null; providerResponseAt: number; timeBasis: 'provider_snapshot_observation';
  startedAt: number; completedAt: number; envelope: Record<string, unknown>; envelopeHash: string; receiptHash: string;
}
const SHAPE = 'version provider mode origin endpoint source legId routeId ccxtVersion profileVersion profileHash category symbol field value providerQuoteAt providerResponseAt timeBasis startedAt completedAt envelope envelopeHash receiptHash'.split(' ').sort().join(',');
const DEFINITIONS = {
  'bybit:btc-usd-index:v1': ['bybit:usdt-usd-index-ratio:v1', 'inverse', 'BTCUSD', 'indexPrice'],
  'bybit:btc-usdt-index:v1': ['bybit:usdt-usd-index-ratio:v1', 'linear', 'BTCUSDT', 'indexPrice'],
  'bybit:usdc-usd-index:v1': ['bybit:usdc-usd-index:v1', 'spot', 'USDCUSDT', 'usdIndexPrice'],
} as const;
export class FxEvidenceError extends Error {
  readonly code: string;
  constructor(reason: string) {
    super(`FX_${reason}`);
    this.name = 'FxEvidenceError';
    this.code = `FX_${reason}`;
  }
}
export function invalidFx(reason = 'EVIDENCE_INVALID'): never { throw new FxEvidenceError(reason); }
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidFx();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return invalidFx();
  return value as Record<string, any>;
}
function canonicalArray(value: unknown[], depth: number, budget: { remaining: number }): string {
  if (value.length > budget.remaining || Object.keys(value).length !== value.length) return invalidFx();
  const items: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return invalidFx();
    items.push(canonical(value[index], depth + 1, budget));
  }
  return `[${items.join(',')}]`;
}
function canonical(value: unknown, depth: number, budget: { remaining: number }): string {
  budget.remaining -= 1;
  if (depth > 12 || budget.remaining < 0) return invalidFx();
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (typeof value === 'string' && Buffer.byteLength(value) < 32768 && !/[\uD800-\uDFFF]/u.test(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return canonicalArray(value, depth, budget);
  const row = object(value);
  return `{${Object.keys(row).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(key => {
    if ([...key].length > 256 || /[\x00-\x1f\x7f-\x9f]/.test(key) || /[\uD800-\uDFFF]/u.test(key)) return invalidFx();
    return `${canonical(key, depth + 1, budget)}:${canonical(row[key], depth + 1, budget)}`;
  }).join(',')}}`;
}
/** Hashes the retained JSON receipt; never claims preservation of unavailable HTTP bytes. */
export function fxEvidenceDigest(domain: 'bybit-fx-envelope-v1' | 'bybit-fx-receipt-v1' | 'tsx-fx-conversion-v1'
  | 'tsx-fx-observation-v1' | 'tsx-fx-account-conversion-v1'
  | 'tsx-fx-money-event-v1' | 'tsx-fx-money-valuation-v1', value: unknown): string {
  const encoded = canonical(value, 0, { remaining: domain === 'bybit-fx-envelope-v1' ? 256 : 512 });
  const byteLimit = domain === 'bybit-fx-envelope-v1' ? 65536 : 131072;
  if (Buffer.byteLength(encoded) >= byteLimit) return invalidFx();
  return createHash('sha256').update(`${domain}\n${encoded}`).digest('hex');
}
function timestamp(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalidFx();
}
function validateTimes(row: Record<string, any>): void {
  if (row.providerQuoteAt !== null || row.timeBasis !== 'provider_snapshot_observation') invalidFx();
  for (const field of ['startedAt', 'completedAt', 'providerResponseAt']) timestamp(row[field]);
  if (row.startedAt > row.completedAt || row.completedAt - row.startedAt > 10000
    || row.completedAt > Date.now() + 1000 || row.providerResponseAt < row.startedAt - 1000
    || row.providerResponseAt > row.completedAt + 1000) invalidFx();
}
function validateProfile(row: Record<string, any>, context: FxContext): void {
  if (row.version !== 1 || row.provider !== 'bybit' || row.source !== 'bybit-v5-rest-index-snapshot-v1'
    || row.endpoint !== '/v5/market/tickers' || row.ccxtVersion !== '4.5.75' || row.profileVersion !== 1) invalidFx();
  if (!['live', 'testnet'].includes(row.mode) || row.mode !== context.mode || row.profileHash !== context.profileHash
    || typeof row.profileHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.profileHash)
    || row.origin !== (row.mode === 'live' ? 'https://api.bybit.com' : 'https://api-testnet.bybit.com')) invalidFx();
}
function validateLeg(row: Record<string, any>): void {
  if (typeof row.legId !== 'string' || !Object.hasOwn(DEFINITIONS, row.legId)) invalidFx();
  const definition = DEFINITIONS[row.legId as FxLegId];
  if ([row.routeId, row.category, row.symbol, row.field].some((item, index) => item !== definition[index])) invalidFx();
  if (typeof row.value !== 'string' || /\s/.test(row.value)) invalidFx();
  try { decimal(row.value, { positive: true }); } catch { invalidFx(); }
}
function validateEnvelope(row: Record<string, any>): void {
  const envelope = object(row.envelope), result = object(envelope.result);
  if (envelope.retCode !== 0 || envelope.time !== row.providerResponseAt || result.category !== row.category
    || !Array.isArray(result.list) || result.list.length !== 1) invalidFx();
  const ticker = object(result.list[0]);
  if (ticker.symbol !== row.symbol || ticker[row.field] !== row.value) invalidFx();
  if (row.envelopeHash !== fxEvidenceDigest('bybit-fx-envelope-v1', envelope)) invalidFx();
}
export function validateFxLegReceipt(value: unknown, context: FxContext): FxLegReceipt {
  const row = object(value);
  if (Object.keys(row).sort().join(',') !== SHAPE) invalidFx();
  validateProfile(row, context);
  validateLeg(row);
  validateTimes(row);
  validateEnvelope(row);
  const { receiptHash, ...original } = row;
  if (receiptHash !== fxEvidenceDigest('bybit-fx-receipt-v1', original)) invalidFx();
  return row as FxLegReceipt;
}
