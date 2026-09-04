/** Isolated provider-shaped originals. Never use this fixture builder for live evidence. */
export function nativeFillFixture(exchange, fill, accountUid = 'fixture-provider-account') {
  if (exchange === 'paper') return fill;
  const profiles = { bybit: ['bybit_execution_v1', 'linear', 'BTCUSDT'], hyperliquid: ['hyperliquid_user_fill_v1', 'perpetual', 'BTC'],
    krakenfutures: ['kraken_history_execution_v3', 'futures', 'PF_XBTUSD'] };
  const [profile, marketNamespace, providerMarketId] = profiles[exchange];
  const originals = {
    bybit: { execId: fill.exchangeFillId, orderId: fill.exchangeOrderId, symbol: providerMarketId, execTime: String(fill.filledAt) },
    hyperliquid: { tid: fill.exchangeFillId, oid: fill.exchangeOrderId, coin: providerMarketId, time: fill.filledAt },
    krakenfutures: { identitySource: profile, executionUid: fill.exchangeFillId, orderUid: fill.exchangeOrderId,
      tradeable: providerMarketId, accountUid, executionTimestamp: fill.filledAt },
  };
  return { ...fill, identity: { version: 1, profile, marketNamespace, providerMarketId, providerSymbol: fill.providerSymbol,
    providerFillId: fill.exchangeFillId, scopeTimestamp: exchange === 'hyperliquid' ? fill.filledAt : null },
    raw: { id: fill.exchangeFillId, order: fill.exchangeOrderId, symbol: fill.providerSymbol, timestamp: fill.filledAt,
      price: fill.price, amount: fill.quantity, fee: { cost: fill.fee, currency: fill.feeAsset }, info: originals[exchange] } };
}
