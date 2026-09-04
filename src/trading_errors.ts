import type { ExchangeOrderResult } from './trading_types.js';

export class TradingUnresolvedOrderError extends Error {
  readonly code = 'ORDER_OUTCOME_UNRESOLVED';
  readonly sideEffects = true;

  constructor(message: string, readonly confirmedOrders: ExchangeOrderResult[] = []) {
    super(message);
    this.name = 'TradingUnresolvedOrderError';
  }
}

export class TradingSymbolUnavailableError extends Error {
  readonly code = 'SYMBOL_UNAVAILABLE';
  readonly httpStatus = 422;
  readonly sideEffects = false;

  constructor(
    message: string,
    readonly details: { exchange?: string; accountId?: string; symbol?: string } = {},
  ) {
    super(message);
    this.name = 'TradingSymbolUnavailableError';
  }
}
