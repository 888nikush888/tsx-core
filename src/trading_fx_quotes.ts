import { compareDecimal } from './trading_decimal.js';
import { divideRational, rationalFromDecimal, type ExactRational } from './trading_rational.js';
import { fxEvidenceDigest, invalidFx, validateFxLegReceipt, type FxContext, type FxLegId, type FxLegReceipt } from './trading_fx_contract.js';

export interface FxConversionEvidence extends FxContext {
  version: 1; valuationBasis: 'provider_snapshot_index_asof'; policy: 'stable-index-asof-10s-v1';
  baseAsset: string; quoteAsset: string; at: number; earliestAt: number; latestAt: number; expiresAt: number;
  rate: ExactRational; receiptHashes: string[]; evidenceHash: string;
}
const LEG_ORDER: FxLegId[] = ['bybit:btc-usd-index:v1', 'bybit:btc-usdt-index:v1', 'bybit:usdc-usd-index:v1'];
function assetLegs(asset: string): FxLegId[] {
  if (asset === 'USD') return [];
  if (asset === 'USDT') return LEG_ORDER.slice(0, 2);
  if (asset === 'USDC') return [LEG_ORDER[2]!];
  return invalidFx('ASSET_UNSUPPORTED');
}
function eligibleReceipts(values: unknown[], required: FxLegId[], at: number, context: FxContext): FxLegReceipt[] {
  const rows = values.map(row => validateFxLegReceipt(row, context))
    .filter(row => required.includes(row.legId) && row.providerResponseAt <= at && row.providerResponseAt >= at - 10000);
  const observations = new Map<string, FxLegReceipt>();
  for (const row of rows) {
    const key = `${row.legId}:${row.providerResponseAt}`, prior = observations.get(key);
    if (prior && compareDecimal(prior.value, row.value) !== 0) invalidFx('QUOTE_CONFLICT');
    if (!prior || row.receiptHash < prior.receiptHash) observations.set(key, row);
  }
  return [...observations.values()].sort((a, b) => b.providerResponseAt - a.providerResponseAt || a.receiptHash.localeCompare(b.receiptHash));
}
function coherentLegs(rows: FxLegReceipt[], required: FxLegId[]): FxLegReceipt[] {
  // Try decreasing source times. The first complete one-second window is deterministic.
  for (const anchor of rows) {
    const selected = required.map(id => rows.find(row => row.legId === id && row.providerResponseAt <= anchor.providerResponseAt
      && row.providerResponseAt >= anchor.providerResponseAt - 1000));
    if (selected.every(row => row !== undefined)) return selected as FxLegReceipt[];
  }
  return invalidFx('QUOTE_UNAVAILABLE');
}
function usdRate(asset: string, receipts: FxLegReceipt[]): ExactRational {
  if (asset === 'USD') return rationalFromDecimal('1');
  const legs = assetLegs(asset).map(id => {
    const row = receipts.find(receipt => receipt.legId === id);
    if (!row) return invalidFx('QUOTE_UNAVAILABLE');
    return rationalFromDecimal(row.value);
  });
  return asset === 'USDC' ? legs[0]! : divideRational(legs[0]!, legs[1]!);
}
export function deriveFxConversion(values: unknown[], baseAsset: string, quoteAsset: string, at: number, context: FxContext): FxConversionEvidence {
  if (!Array.isArray(values) || values.length > 256 || !Number.isSafeInteger(at) || at < 0 || baseAsset === quoteAsset) invalidFx();
  const requiredSet = new Set([...assetLegs(baseAsset), ...assetLegs(quoteAsset)]);
  const required = LEG_ORDER.filter(id => requiredSet.has(id));
  const selected = coherentLegs(eligibleReceipts(values, required, at, context), required);
  const times = selected.map(row => row.providerResponseAt);
  const original = { version: 1 as const, valuationBasis: 'provider_snapshot_index_asof' as const, policy: 'stable-index-asof-10s-v1' as const,
    mode: context.mode, profileHash: context.profileHash, baseAsset, quoteAsset, at,
    earliestAt: Math.min(...times), latestAt: Math.max(...times), expiresAt: Math.min(...times) + 10000,
    rate: divideRational(usdRate(baseAsset, selected), usdRate(quoteAsset, selected)), receiptHashes: selected.map(row => row.receiptHash) };
  return { ...original, evidenceHash: fxEvidenceDigest('tsx-fx-conversion-v1', original) };
}
/** Pure final time/integrity fence. Persistent account, source and policy bindings remain mandatory. */
export function assertFxConversionFresh(value: FxConversionEvidence, now = Date.now()): void {
  const { evidenceHash, ...original } = value;
  if (evidenceHash !== fxEvidenceDigest('tsx-fx-conversion-v1', original) || value.version !== 1
    || value.policy !== 'stable-index-asof-10s-v1' || value.valuationBasis !== 'provider_snapshot_index_asof'
    || ![value.at, value.earliestAt, value.latestAt, value.expiresAt, now].every(Number.isSafeInteger)
    || value.earliestAt < 0 || value.latestAt < value.earliestAt || value.latestAt - value.earliestAt > 1000
    || value.at < value.latestAt || value.at > value.expiresAt || value.expiresAt !== value.earliestAt + 10000
    || now < value.latestAt || now > value.expiresAt) invalidFx('QUOTE_EXPIRED_OR_CHANGED');
}
