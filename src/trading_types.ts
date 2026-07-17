export type TradingExchange = 'paper' | 'hyperliquid' | 'bybit';
export type TradingAccountMode = 'paper' | 'testnet' | 'live';
export type TradingAccountStatus = 'unverified' | 'ready' | 'disabled' | 'error';
export type TradingSide = 'LONG' | 'SHORT';
export type TradingOrderSide = 'buy' | 'sell';
export type TradingOrderType = 'market' | 'limit';
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
  allowedSignalSchemas: Array<'standard' | 'cryptodanielvip' | 'loma'>;
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
    targetAllocationsPercent: string[];
    moveStopToBreakEvenAfterTarget: number | null;
    trailingStopPercent: string | null;
    closeRemainderAtLastTarget: boolean;
  };
  safety: {
    maxConcurrentPositions: number;
    maxDailyLoss: string;
    maxSlippagePercent: string;
    entryOrderTtlSeconds: number;
    requireProtectiveStop: true;
  };
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
  plan: unknown | null;
  blockReason: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
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
