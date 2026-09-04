import { createHash } from 'node:crypto';

const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
export const fxDigest = (domain, value) => createHash('sha256').update(`${domain}\n${canonical(value)}`).digest('hex');
export const FX_CONTEXT = Object.freeze({ mode: 'testnet', profileHash: 'a'.repeat(64) });
const definitions = {
  usd: ['bybit:btc-usd-index:v1', 'bybit:usdt-usd-index-ratio:v1', 'inverse', 'BTCUSD', 'indexPrice', '60000'],
  usdt: ['bybit:btc-usdt-index:v1', 'bybit:usdt-usd-index-ratio:v1', 'linear', 'BTCUSDT', 'indexPrice', '60150'],
  usdc: ['bybit:usdc-usd-index:v1', 'bybit:usdc-usd-index:v1', 'spot', 'USDCUSDT', 'usdIndexPrice', '1.002'],
};
export function sealFxReceipt(receipt) {
  const { receiptHash: ignored, ...body } = receipt;
  void ignored;
  body.envelopeHash = fxDigest('bybit-fx-envelope-v1', body.envelope);
  return { ...body, receiptHash: fxDigest('bybit-fx-receipt-v1', body) };
}
export function fxReceipt(kind, at = Date.now() - 100, override = {}) {
  const [legId, routeId, category, symbol, field, value] = definitions[kind];
  return sealFxReceipt({ version: 1, provider: 'bybit', mode: 'testnet', origin: 'https://api-testnet.bybit.com',
    endpoint: '/v5/market/tickers', source: 'bybit-v5-rest-index-snapshot-v1', legId, routeId,
    ccxtVersion: '4.5.75', profileVersion: 1, profileHash: FX_CONTEXT.profileHash,
    category, symbol, field, value, providerQuoteAt: null, providerResponseAt: at,
    timeBasis: 'provider_snapshot_observation', startedAt: at - 10, completedAt: at + 10,
    envelope: { retCode: 0, retMsg: 'OK', result: { category, list: [{ symbol, [field]: value }] }, retExtInfo: {}, time: at },
    ...override });
}
