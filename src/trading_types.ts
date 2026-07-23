export type TradingExchange = 'paper' | 'hyperliquid' | 'bybit';
export type TradingAccountMode = 'paper' | 'testnet' | 'live';
export type TradingAccountStatus = 'unverified' | 'ready' | 'disabled' | 'error';
export type TradingSide = 'LONG' | 'SHORT';
export type TradingOrderSide = 'buy' | 'sell';
export type TradingOrderType = 'market' | 'limit';
export type TargetAllocationMode = 'manual' | 'adaptive_halving';
export type StopLossMode = 'configured' | 'adaptive_targets';
export type ExecutableSignalSchemaContract = 'standard' | 'cryptodanielvip' | 'loma';
export type TradingIntentStatus =
  | 'pending'
  | 'planned'
  | 'submitting'
  | 'monitoring'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'unknown';
export type TradingOrderStatus =
  | 'created'
  | 'submitting'
  | 'open'
  | 'partially_filled'
  | 'filled'
  | 'cancel_pending'
  | 'cancelled'
  | 'rejected'
  | 'unknown';
export type TradingPositionStatus = 'opening' | 'open' | 'closing' | 'closed' | 'emergency';

export interface DecimalRange {
  min: string;
  max: string;
}

export interface ExecutableSignal {
  /** User-managed schema profile identifier. */
  schema: string;
  action: TradingSide;
  symbol: string;
  entry: { type: 'market' } | ({ type: 'range' } & DecimalRange);
  targets: DecimalRange[];
  stopLoss: string;
  suggestedLeverage?: number;
  suggestedRiskPercent?: string;
  averagingPrice?: string;
}

export interface StrategyConfiguration {
  schemaVersion: 1;
  allowedSignalSchemas: string[];
  allowedSymbols: string[];
  allowedSides: TradingSide[];
  entry: {
    orderType: TradingOrderType;
    rangePrice: 'near' | 'midpoint' | 'far';
    postOnly: boolean;
    timeoutSeconds: number;
  };
  sizing: {
    riskPerTradePercent: string;
    maxPositionNotional: string;
    maxLeverage: number;
  };
  exits: {
    /** Existing fixed percentages or Blueprint v4's dynamic half-of-remainder ladder. */
    targetAllocationMode: TargetAllocationMode;
    targetAllocationsPercent: string[];
    /** Existing break-even/trailing settings or the TP(i-2) Blueprint v4 ladder. */
    stopLossMode: StopLossMode;
    moveStopToBreakEvenAfterTarget: number | null;
    trailingStopPercent: string | null;
    closeRemainderAtLastTarget: true;
  };
  safety: {
    maxConcurrentPositions: number;
    maxDailyLoss: string;
    maxSlippagePercent: string;
    entryOrderTtlSeconds: number;
    requireProtectiveStop: true;
  };
}

export interface TradingSignalSchema {
  id: string;
  name: string;
  description: string;
  parserSchema: ExecutableSignalSchemaContract;
  templateName: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface TradingStrategyVersion {
  id: string;
  strategyId: string;
  version: number;
  name: string;
  description: string;
  status: 'draft' | 'published' | 'archived';
  configuration: StrategyConfiguration;
  configurationSha256: string;
  createdAt: number;
  publishedAt: number | null;
}

export interface TradingAccount {
  id: string;
  name: string;
  exchange: TradingExchange;
  mode: TradingAccountMode;
  status: TradingAccountStatus;
  enabled: boolean;
  credentialRef: string | null;
  /** Stable provider account/subaccount identity; never a credential value. */
  externalAccountId: string | null;
  lastVerifiedAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TradingRoute {
  channelId: string;
  strategyVersionId: string;
  accountId: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface TradingRuntimeState {
  executionEnabled: boolean;
  liveTradingEnabled: boolean;
  killSwitchActive: boolean;
  killSwitchReason: string | null;
  updatedAt: number;
}

export interface TradingIntent {
  id: string;
  sourceSignalId: string;
  channelId: string;
  strategyVersionId: string;
  accountId: string;
  exchange: TradingExchange;
  mode: TradingAccountMode;
  symbol: string;
  side: TradingSide;
  status: TradingIntentStatus;
  signal: ExecutableSignal;
  plan: unknown;
  blockReason: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TradingAccountSnapshot {
  equity: string;
  availableBalance: string;
  unrealizedPnl: string;
  marginUsed: string;
  /** Signed funding credits/payments since 00:00 UTC; negative values are losses. */
  fundingPnlToday: string;
}

export interface TradingMarketSnapshot {
  symbol: string;
  markPrice: string;
  priceTick: string;
  quantityStep: string;
  minimumQuantity: string;
  minimumNotional: string;
  maxLeverage: number;
  observedAt: number;
}

export interface PlannedOrder {
  clientOrderId: string;
  role: 'entry' | 'take_profit' | 'stop_loss' | 'flatten';
  side: TradingOrderSide;
  orderType: 'market' | 'limit' | 'stop_market';
  quantity: string;
  price: string | null;
  triggerPrice: string | null;
  reduceOnly: boolean;
  postOnly: boolean;
  targetIndex: number | null;
}

export interface TradingPlan {
  version: 1;
  symbol: string;
  side: TradingSide;
  entryPrice: string;
  stopPrice: string;
  quantity: string;
  notional: string;
  riskAmount: string;
  leverage: number;
  entryTimeoutSeconds: number;
  entryOrderTtlSeconds: number;
  maxSlippagePercent: string;
  quantityStep: string;
  targetAllocationMode: TargetAllocationMode;
  targetAllocationsPercent: string[];
  stopLossMode: StopLossMode;
  orders: PlannedOrder[];
  createdAt: number;
}

export interface ExchangeOrderRequest extends PlannedOrder {
  accountId: string;
  symbol: string;
  leverage: number;
  timeoutSeconds: number;
}

export interface ExchangeOrderResult {
  clientOrderId: string;
  exchangeOrderId: string;
  status: 'open' | 'partially_filled' | 'filled' | 'cancelled' | 'rejected' | 'unknown';
  filledQuantity: string;
  averagePrice: string | null;
  error: string | null;
  raw: unknown;
}

export interface ExchangeFill {
  exchangeFillId: string;
  clientOrderId: string;
  price: string;
  quantity: string;
  fee: string;
  feeAsset: string | null;
  filledAt: number;
  raw: unknown;
}

export interface ExchangeOrderSnapshot extends ExchangeOrderResult {
  symbol: string;
  role: PlannedOrder['role'];
  side: TradingOrderSide;
  quantity: string;
  price: string | null;
  triggerPrice: string | null;
  reduceOnly: boolean;
}

export interface ExchangePositionSnapshot {
  symbol: string;
  side: TradingSide;
  quantity: string;
  averageEntryPrice: string;
  unrealizedPnl: string;
}

export interface ExchangeOpenState {
  orders: ExchangeOrderSnapshot[];
  positions: ExchangePositionSnapshot[];
  fills: ExchangeFill[];
  observedAt: number;
}

export interface TradingExchangeAdapter {
  readonly exchange: TradingExchange;
  accountSnapshot(account: TradingAccount): Promise<TradingAccountSnapshot>;
  marketSnapshot(account: TradingAccount, symbol: string): Promise<TradingMarketSnapshot>;
  submitOrder(account: TradingAccount, request: ExchangeOrderRequest): Promise<ExchangeOrderResult>;
  /**
   * Atomically registers an entry and its reduce-only protective stop at the
   * provider boundary. Live/testnet adapters must implement this contract;
   * callers may only fall back for the transactional paper simulator.
   */
  submitProtectedEntry?(
    account: TradingAccount,
    entry: ExchangeOrderRequest,
    protectiveStop: ExchangeOrderRequest,
  ): Promise<{ entry: ExchangeOrderResult; protectiveStop: ExchangeOrderResult }>;
  cancelOrder(account: TradingAccount, clientOrderId: string): Promise<ExchangeOrderResult>;
  openState(account: TradingAccount): Promise<ExchangeOpenState>;
}

export interface TradingOverview {
  runtime: TradingRuntimeState;
  accountCount: number;
  enabledRouteCount: number;
  openPositionCount: number;
  pendingIntentCount: number;
  unknownOrderCount: number;
  latestReconciliationAt: number | null;
}
