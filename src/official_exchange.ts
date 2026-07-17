import { getDatabase } from './db.js';
import type { TradingCredentialStore } from './trading_credentials.js';
import type {
  ExchangeOpenState,
  ExchangeOrderRequest,
  ExchangeOrderResult,
  TradingAccount,
  TradingAccountSnapshot,
  TradingExchangeAdapter,
  TradingMarketSnapshot,
} from './trading_types.js';

interface ExecutorErrorPayload {
  error?: string;
}

function executorUrl(): string {
  const value = process.env.EXCHANGE_EXECUTOR_URL?.trim() || 'http://exchange-executor:8090';
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('EXCHANGE_EXECUTOR_URL must be a plain internal HTTP origin.');
  }
  return parsed.origin;
}

function accountPayload(account: TradingAccount): Record<string, string> {
  return { id: account.id, exchange: account.exchange, mode: account.mode };
}

function assertObject(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} returned an invalid contract.`);
  return value as Record<string, any>;
}

function assertOrderResult(value: unknown): ExchangeOrderResult {
  const result = assertObject(value, 'Exchange executor');
  if (typeof result.clientOrderId !== 'string' || typeof result.exchangeOrderId !== 'string') {
    throw new Error('Exchange executor returned an invalid order identifier contract.');
  }
  if (!['open', 'partially_filled', 'filled', 'cancelled', 'rejected', 'unknown'].includes(result.status)) {
    throw new Error('Exchange executor returned an invalid order status.');
  }
  return result as ExchangeOrderResult;
}

export class OfficialExchangeAdapter implements TradingExchangeAdapter {
  readonly exchange: 'hyperliquid' | 'bybit';
  private readonly baseUrl: string;

  constructor(exchange: 'hyperliquid' | 'bybit', private readonly credentials: TradingCredentialStore) {
    this.exchange = exchange;
    this.baseUrl = executorUrl();
  }

  async verifyAccount(account: TradingAccount): Promise<{ verified: boolean; equity: string }> {
    return this.post('/v1/verify-account', { account: accountPayload(account) }) as Promise<{ verified: boolean; equity: string }>;
  }

  async accountSnapshot(account: TradingAccount): Promise<TradingAccountSnapshot> {
    return this.post('/v1/account-snapshot', { account: accountPayload(account) }) as Promise<TradingAccountSnapshot>;
  }

  async marketSnapshot(account: TradingAccount, symbol: string): Promise<TradingMarketSnapshot> {
    return this.post('/v1/market-snapshot', { account: accountPayload(account), symbol }) as Promise<TradingMarketSnapshot>;
  }

  async submitOrder(account: TradingAccount, request: ExchangeOrderRequest): Promise<ExchangeOrderResult> {
    return assertOrderResult(await this.post('/v1/submit-order', { account: accountPayload(account), request }));
  }

  async cancelOrder(account: TradingAccount, clientOrderId: string): Promise<ExchangeOrderResult> {
    const local = await getDatabase().get<{ symbol: string }>(
      `SELECT intent.symbol FROM trading_orders AS orders
       JOIN trading_trade_intents AS intent ON intent.id = orders.intent_id
       WHERE orders.account_id = ? AND orders.client_order_id = ?`,
      [account.id, clientOrderId],
    );
    if (!local) throw new Error('Cannot cancel an order without a local symbol mapping.');
    return assertOrderResult(await this.post('/v1/cancel-order', {
      account: accountPayload(account),
      clientOrderId,
      symbol: local.symbol,
    }));
  }

  async openState(account: TradingAccount): Promise<ExchangeOpenState> {
    const state = assertObject(await this.post('/v1/open-state', { account: accountPayload(account) }), 'Exchange executor');
    if (!Array.isArray(state.orders) || !Array.isArray(state.positions) || !Array.isArray(state.fills)) {
      throw new Error('Exchange executor returned an invalid open-state contract.');
    }
    const localOrders = await getDatabase().all<Array<{ client_order_id: string; role: string }>>(
      'SELECT client_order_id, role FROM trading_orders WHERE account_id = ?',
      [account.id],
    );
    const roles = new Map(localOrders.map(order => [order.client_order_id, order.role]));
    state.orders = state.orders.map((order: any) => ({
      ...order,
      role: roles.get(order.clientOrderId) || order.role || 'entry',
    }));
    return state as ExchangeOpenState;
  }

  private async post(endpoint: string, payload: unknown): Promise<unknown> {
    const token = await this.credentials.getOrCreateExecutorToken();
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(12_000),
    });
    const body = await response.json().catch(() => ({})) as ExecutorErrorPayload;
    if (!response.ok) throw new Error(`Exchange executor request failed (${response.status}): ${body.error || 'invalid response'}`);
    return body;
  }
}
