import { compareDecimal } from './trading_decimal.js';
import type { ExchangeFill, ExchangeOrderSnapshot, PlannedOrder } from './trading_types.js';

export interface LocalCorrelationOrder {
  client_order_id: string;
  exchange_order_id: string | null;
  provider_symbol: string | null;
  symbol: string;
  role: PlannedOrder['role'];
  side: string;
  quantity: string;
  reduce_only: number;
  trigger_price: string | null;
}

type RemoteIdentity = Pick<ExchangeFill, 'clientOrderId' | 'exchangeOrderId' | 'symbol' | 'providerSymbol'>;

function namespaceMatches(local: LocalCorrelationOrder, remote: RemoteIdentity): boolean {
  if (remote.symbol !== undefined && remote.symbol !== local.symbol) return false;
  if (local.provider_symbol) return remote.providerSymbol === local.provider_symbol;
  return remote.symbol === local.symbol;
}

function exactIdentity(localOrders: LocalCorrelationOrder[], remote: RemoteIdentity): LocalCorrelationOrder | undefined {
  const byClient = localOrders.find(local => local.client_order_id === remote.clientOrderId);
  if (byClient) {
    if ((byClient.exchange_order_id && byClient.exchange_order_id !== remote.exchangeOrderId)
      || (remote.symbol !== undefined && remote.symbol !== byClient.symbol)
      || (byClient.provider_symbol && remote.providerSymbol !== undefined && byClient.provider_symbol !== remote.providerSymbol)) {
      throw new Error('Remote order client identity conflicts with its exchange identity or symbol namespace.');
    }
    return byClient;
  }
  const byExchange = localOrders.filter(local => local.exchange_order_id === remote.exchangeOrderId && namespaceMatches(local, remote));
  if (byExchange.length > 1) throw new Error('Remote exchange identity maps to multiple local orders.');
  const match = byExchange[0];
  if (match && remote.clientOrderId !== null && remote.clientOrderId !== match.client_order_id) {
    throw new Error('Remote exchange identity has a conflicting provider client identifier.');
  }
  return match;
}

function validateOwnedOrder(local: LocalCorrelationOrder, remote: ExchangeOrderSnapshot): void {
  if (remote.side !== local.side || remote.reduceOnly !== (local.reduce_only === 1)
    || compareDecimal(remote.quantity, local.quantity) !== 0) {
    throw new Error('Remote order semantics conflict with the managed order.');
  }
  if (local.role === 'stop_loss' && (remote.triggerPrice === null || local.trigger_price === null
    || compareDecimal(remote.triggerPrice, local.trigger_price) !== 0)) {
    throw new Error('Remote protective trigger conflicts with the managed stop.');
  }
}

export function correlateRemoteOrders(localOrders: LocalCorrelationOrder[], remoteOrders: ExchangeOrderSnapshot[]): ExchangeOrderSnapshot[] {
  return remoteOrders.map(remote => {
    const local = exactIdentity(localOrders, remote);
    if (!local) return remote;
    validateOwnedOrder(local, remote);
    return { ...remote, clientOrderId: local.client_order_id, role: local.role };
  });
}

export function correlateRemoteFills(localOrders: LocalCorrelationOrder[], remoteFills: ExchangeFill[]): ExchangeFill[] {
  return remoteFills.map(remote => {
    const local = exactIdentity(localOrders, remote);
    return local ? { ...remote, clientOrderId: local.client_order_id } : remote;
  });
}
