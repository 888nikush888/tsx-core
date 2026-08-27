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
