import { createHash } from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value)
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(key => [key, canonical(value[key])]));
  return value;
}
export function quantityHash(domain, value) {
  return createHash('sha256').update(`${domain}\n${JSON.stringify(canonical(value))}`).digest('hex');
}
export function quantityFill(input = '4', factor = '0.25', output = '1', now = Date.now()) {
  const identity = { version: 1, profile: 'kraken_history_execution_v3', marketNamespace: 'futures',
    providerMarketId: 'PF_XBTUSD', providerSymbol: 'BTC/USD:USD', providerFillId: 'execution', scopeTimestamp: null };
  const raw = { id: 'execution', order: 'remote', clientOrderId: 'client', symbol: 'BTC/USD:USD', side: 'buy',
    timestamp: now - 2000, price: '100', amount: input, fee: { cost: '0.01', currency: null }, historyMissingFee: false,
    info: { providerEventId: 'envelope', identitySource: 'kraken_history_execution_v3', executionUid: 'execution',
      orderUid: 'remote', tradeable: 'PF_XBTUSD', accountUid: 'provider-account', executionTimestamp: now - 2000 } };
  const market = { providerMarketId: 'PF_XBTUSD', providerSymbol: 'BTC/USD:USD', base: 'BTC', quote: 'USD',
    settlementAsset: 'USD', contract: true, linear: true, inverse: false, appliedContractSize: factor,
    source: 'ccxt-4.5.75-loaded-market', observedAt: null, providerContractSize: null, providerOriginalStatus: 'not-retained' };
  const fill = { exchangeFillId: raw.id, clientOrderId: 'client', exchangeOrderId: raw.order, symbol: 'BTCUSD',
    providerSymbol: raw.symbol, price: raw.price, quantity: output, fee: raw.fee.cost, feeAsset: null, filledAt: raw.timestamp,
    accounting: { version: 1, source: 'ccxt-market-v1', providerSymbol: raw.symbol, settlementAsset: 'USD', linear: true, quantityUnit: 'base' }, raw, identity };
  fill.quantityNormalization = { version: 1, source: 'kraken-execution-normalization-v1', inputField: 'execution.quantity',
    inputQuantity: input, inputUnit: 'kraken_native_execution_quantity', appliedFactor: factor, outputQuantity: output, outputUnit: 'base',
    arithmetic: { operation: 'multiply', decimalPrecision: 28, decimalRounding: 'ROUND_HALF_EVEN', exactProduct: true },
    market: { ...market, sourceHash: quantityHash('kraken-normalization-market-v1', market) }, nativeIdentity: identity,
    originalExecutionHash: quantityHash('kraken-normalization-original-v1', raw), normalizedAt: now };
  return fill;
}
export function quantityRead(now = Date.now()) {
  return { version: 1, startedAt: now - 100, completedAt: now + 100,
    sources: ['positions', 'orders', 'targeted_orders', 'fills'].map(source => ({ source, startedAt: now - 100,
      completedAt: now + 100, completeness: 'unknown', reason: 'bounded_history', since: 0 })), checkedOrders: [] };
}
