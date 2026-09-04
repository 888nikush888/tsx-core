import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { compareDecimal, decimal } from './trading_decimal.js';
import { validateFillIdentity } from './trading_fill_identity.js';
import type { ExchangeFill, ExchangeFillIdentity, FillQuantityNormalization } from './trading_types.js';
function invalid(): never { throw new Error('FILL_QUANTITY_EVIDENCE_INVALID'); }
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, any>;
}
function shape(value: unknown, keys: string): Record<string, any> {
  const row = object(value);
  if (!isDeepStrictEqual(Object.keys(row).sort(), keys.split(' ').sort())) invalid();
  return row;
}
function token(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.trim() !== value
    || /[\x00-\x1f\x7f]/.test(value) || /[\uD800-\uDFFF]/u.test(value)) invalid();
}
function positive(value: unknown): string {
  if (typeof value !== 'string' || value.trim() !== value) return invalid();
  return decimal(value, { positive: true });
}
function canonical(value: unknown, depth: number): string {
  if (depth > 12) return invalid();
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (typeof value === 'string' && value.length < 32768 && !/[\uD800-\uDFFF]/u.test(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(',')}]`;
  const row = object(value);
  return `{${Object.keys(row).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(key => {
    token(key); return `${JSON.stringify(key)}:${canonical(row[key], depth + 1)}`;
  }).join(',')}}`;
}
/** Hashes retained normalized originals, never a claim about unavailable HTTP bytes. */
export function fillQuantityDigest(domain: 'kraken-normalization-original-v1' | 'kraken-normalization-market-v1' | 'tsx-fill-quantity-observation-v1', value: unknown): string {
  const encoded = canonical(value, 0);
  if (Buffer.byteLength(encoded) >= 32768) invalid();
  return createHash('sha256').update(`${domain}\n${encoded}`).digest('hex');
}
function coefficient(value: string): { value: bigint; scale: number } {
  const [integer, fraction = ''] = positive(value).split('.');
  return { value: BigInt(integer + fraction), scale: fraction.length };
}
function exactProduct(input: string, factor: string, output: string): boolean {
  const a = coefficient(input), b = coefficient(factor), c = coefficient(output);
  return a.value * b.value * 10n ** BigInt(c.scale) === c.value * 10n ** BigInt(a.scale + b.scale);
}
function arithmetic(value: unknown, row: Record<string, any>): void {
  const a = shape(value, 'operation decimalPrecision decimalRounding exactProduct');
  if (a.operation !== 'multiply' || !Number.isSafeInteger(a.decimalPrecision) || a.decimalPrecision < 1 || a.decimalPrecision > 10000
    || !['ROUND_CEILING', 'ROUND_DOWN', 'ROUND_FLOOR', 'ROUND_HALF_DOWN', 'ROUND_HALF_EVEN', 'ROUND_HALF_UP', 'ROUND_UP', 'ROUND_05UP'].includes(a.decimalRounding)
    || a.exactProduct !== exactProduct(row.inputQuantity, row.appliedFactor, row.outputQuantity)) invalid();
}
function originalBinding(row: Record<string, any>, fill: ExchangeFill): ExchangeFillIdentity {
  const identity = validateFillIdentity(row.nativeIdentity), raw = object(fill.raw), info = object(raw.info);
  if (identity.profile !== 'kraken_history_execution_v3' || !isDeepStrictEqual(identity, fill.identity)) invalid();
  const pairs = [[identity.providerFillId, fill.exchangeFillId], [identity.providerSymbol, fill.providerSymbol],
    [raw.id, fill.exchangeFillId], [raw.order, fill.exchangeOrderId], [raw.symbol, fill.providerSymbol], [raw.timestamp, fill.filledAt],
    [raw.amount, row.inputQuantity], [info.identitySource, identity.profile], [info.executionUid, fill.exchangeFillId],
    [info.orderUid, fill.exchangeOrderId], [info.tradeable, identity.providerMarketId], [info.executionTimestamp, fill.filledAt]];
  if (pairs.some(([a, b]) => a !== b)) invalid();
  token(info.accountUid);
  if (compareDecimal(positive(raw.price), fill.price) !== 0 || row.originalExecutionHash !== fillQuantityDigest('kraken-normalization-original-v1', raw)) invalid();
  return identity;
}
function marketBinding(value: unknown, row: Record<string, any>, fill: ExchangeFill, identity: ExchangeFillIdentity): void {
  const m = shape(value, 'providerMarketId providerSymbol base quote settlementAsset contract linear inverse appliedContractSize source sourceHash observedAt providerContractSize providerOriginalStatus');
  for (const name of ['providerMarketId', 'providerSymbol', 'base', 'quote', 'settlementAsset']) token(m[name]);
  if (m.contract !== true || m.linear !== true || m.inverse !== false || m.source !== 'ccxt-4.5.75-loaded-market'
    || m.observedAt !== null || m.providerContractSize !== null || m.providerOriginalStatus !== 'not-retained') invalid();
  if (m.providerMarketId !== identity.providerMarketId || m.providerSymbol !== identity.providerSymbol
    || m.settlementAsset !== fill.accounting?.settlementAsset || m.appliedContractSize !== row.appliedFactor) invalid();
  const { sourceHash, ...original } = m;
  if (sourceHash !== fillQuantityDigest('kraken-normalization-market-v1', original)) invalid();
}
export function validateFillQuantityNormalization(value: unknown, fill: ExchangeFill): FillQuantityNormalization {
  const row = shape(value, 'version source inputField inputQuantity inputUnit appliedFactor outputQuantity outputUnit arithmetic market nativeIdentity originalExecutionHash normalizedAt');
  if (row.version !== 1 || row.source !== 'kraken-execution-normalization-v1' || row.inputField !== 'execution.quantity'
    || row.inputUnit !== 'kraken_native_execution_quantity' || row.outputUnit !== 'base') invalid();
  for (const field of ['inputQuantity', 'appliedFactor', 'outputQuantity']) positive(row[field]);
  if (row.outputQuantity !== fill.quantity || !Number.isSafeInteger(row.normalizedAt) || row.normalizedAt < 0
    || row.normalizedAt > Date.now() + 60000) invalid();
  arithmetic(row.arithmetic, row);
  marketBinding(row.market, row, fill, originalBinding(row, fill));
  return row as FillQuantityNormalization;
}
