import { createHash } from 'node:crypto';
import { getDatabase, saveSignal } from '../../src/db.js';
import { getTradingAccount, listTradingStrategies } from '../../src/trading_repository.js';
import { prepareTradingOperation, resolveObservedOperations, transitionTradingOperation } from '../../src/trading_recovery.js';
import { persistTradingOrderResult } from '../../src/trading_order_repository.js';
import { recordFeeEvent } from '../../src/trading_money_ledger.js';
import { nativeFillFixture } from './native_fill_identity.js';

export const legacyFillColumns = 'id,order_id,account_id,exchange_fill_id,price,quantity,fee,fee_asset,filled_at,raw_json,account_fingerprint,accounting_json,accounting_conflict';
export const identityHash = value => createHash('sha256').update(value).digest('hex');

/** Native originals + an actually dispatched and resolved journal, but no M40 identity metadata. */
export async function legacyFillFixture(name, exchange = 'bybit') {
  const db = getDatabase(), [strategy] = await listTradingStrategies();
  const fingerprint = identityHash(name), credential = identityHash(`${name}-credential`);
  await db.run(`INSERT INTO trading_accounts(id,name,exchange,mode,status,enabled,credential_ref,external_account_id,
    credential_generation,created_at,updated_at) VALUES(?,?,?,'testnet','ready',1,'fixture-only',?,?,1,1)`,
  [name, name, exchange, fingerprint, credential]);
  const account = await getTradingAccount(name), intentId = `${name}-intent`, orderId = `${name}-order`, fillId = `${name}-old-fill`;
  await saveSignal(name, name, 1, '<signal/>', '<signal/>');
  await db.run(`INSERT INTO trading_trade_intents(id,source_signal_id,root_source_signal_id,channel_id,strategy_version_id,
    account_id,exchange,mode,symbol,side,status,signal_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,'testnet','BTCUSDT','LONG','monitoring','{}',1,1)`, [intentId,name,name,name,strategy.id,name,exchange]);
  const request = { accountId: name, clientOrderId: `${name}-client`, symbol: 'BTCUSDT', role: 'entry', side: 'buy',
    orderType: 'limit', price: '100', quantity: '1', triggerPrice: null, reduceOnly: false, postOnly: false,
    targetIndex: null, leverage: 1, timeoutSeconds: 10 };
  await db.run(`INSERT INTO trading_orders(id,intent_id,account_id,client_order_id,role,side,order_type,status,
    price,quantity,filled_quantity,reduce_only,request_json,created_at,updated_at)
    VALUES(?,?,?,?,'entry','buy','limit','submitting','100','1','0',0,?,1,1)`, [orderId,intentId,name,request.clientOrderId,JSON.stringify(request)]);
  const operationId = await prepareTradingOperation({ account, intentId, kind: 'submit', clientOrderIds: [request.clientOrderId], request });
  await transitionTradingOperation(operationId, 'prepared', 'dispatching');
  const providerSymbol = exchange === 'bybit' ? 'BTC/USDT:USDT' : exchange === 'hyperliquid' ? 'BTC/USDC:USDC' : 'BTC/USD:USD';
  const ack = { clientOrderId: request.clientOrderId, exchangeOrderId: '1234', providerSymbol,
    status: 'filled', filledQuantity: '1', averagePrice: '100', error: null,
    raw: { id: '1234', clientOrderId: request.clientOrderId, symbol: providerSymbol,
      info: { orderId: '1234', orderLinkId: request.clientOrderId, symbol: 'BTCUSDT' } } };
  await persistTradingOrderResult(intentId, request.clientOrderId, ack);
  await resolveObservedOperations(account, [{ ...ack, symbol: 'BTCUSDT', role: 'entry', side: 'buy', quantity: '1',
    price: '100', triggerPrice: null, reduceOnly: false }]);
  const incoming = nativeFillFixture(exchange, { exchangeFillId: '5678', exchangeOrderId: ack.exchangeOrderId,
    clientOrderId: request.clientOrderId, symbol: 'BTCUSDT', providerSymbol, price: '100', quantity: '1', fee: '0.1', feeAsset: 'USDT', filledAt: 123, raw: {} });
  incoming.accounting = { version: 1, source: 'ccxt-market-v1', providerSymbol, settlementAsset: exchange === 'hyperliquid' ? 'USDC' : 'USDT', linear: true, quantityUnit: 'base' };
  await db.run(`INSERT INTO trading_fills(${legacyFillColumns}) VALUES(?,?,?,?,'100','1','0.1','USDT',123,?,?,?,0)`,
  [fillId,orderId,name,incoming.exchangeFillId,JSON.stringify(incoming.raw),fingerprint,JSON.stringify(incoming.accounting)]);
  const fee = { accountId: name, accountFingerprint: fingerprint, providerEventId: incoming.exchangeFillId, source: `${exchange}:own-fill-v1`,
    basis: 'fill', occurredAt: 123, fee: '0.1', asset: 'USDT', intentId, fillId };
  await recordFeeEvent(fee);
  return { account, intentId, orderId, fillId, operationId, incoming, fee, credential };
}
