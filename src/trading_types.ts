export type TradingExchange = string;
export const TRADING_EXCHANGE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function tradingExchangeId(value: unknown): TradingExchange {
  if (typeof value !== 'string' || !TRADING_EXCHANGE_ID_PATTERN.test(value)) {
    throw new Error('Trading exchange identifier is invalid.');
  }
  return value;
}
export type TradingAccountMode = 'paper' | 'testnet' | 'live';
export type TradingAccountStatus = 'unverified' | 'ready' | 'disabled' | 'error' | 'degraded';
export type TradingSide = 'LONG' | 'SHORT';
export type TradingOrderSide = 'buy' | 'sell';
export type TradingOrderType = 'market' | 'limit';
export type TargetAllocationMode = 'manual' | 'adaptive_halving';
export type StopLossMode = 'configured' | 'adaptive_targets';
export type DailyLossLimitMode = 'absolute' | 'equity_percent';
export type PositionSizingMode = 'risk_percent' | 'equity_percent_notional' | 'equity_percent_margin';
export type ExecutableSignalSchemaContract = 'standard' | 'cryptodanielvip' | 'loma';
export type SignalContractVersionStatus = 'draft' | 'published' | 'archived';
export type SignalContractEntryMode = 'optional_range' | 'required_range' | 'typed';
export type SignalContractTargetShape = 'scalar' | 'range';
export type SignalContractFieldType = 'text' | 'decimal' | 'integer' | 'boolean';
export type ChannelRiskMode = 'fixed' | 'shadow' | 'automatic';
export type WeakChannelAction = 'none' | 'reduce' | 'block';
export type TradingIntentStatus =
  | 'pending'
  | 'planned'
  | 'submitting'
  | 'monitoring'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'unknown';

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
  schemaVersion: 1 | 2 | 3 | 4;
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
    /** Stop-distance risk, equity-based notional, or equity-based deployed margin/capital. */
    positionSizingMode?: PositionSizingMode;
    riskPerTradePercent: string;
    maxAdaptiveRiskPercent?: string;
    maxPositionNotional: string;
    /** Fallback leverage when the signal contains no explicit leverage. */
    defaultLeverage: number;
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
    /** @deprecated Capacity is account-scoped from schema v3 onward. */
    maxConcurrentPositions?: number;
    /** Interprets maxDailyLoss as quote currency or as a percentage of current account equity. */
    maxDailyLossMode?: DailyLossLimitMode;
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
  contractVersionId: string;
  contractDefinition: SignalContractDefinition;
  templateName: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SignalContractAdditionalField {
  path: string;
  type: SignalContractFieldType;
  required: boolean;
  allowedValues: string[];
  minimum?: string;
  maximum?: string;
  maximumLength?: number;
  pattern?: string;
}

export interface SignalContractDefinition {
  schemaVersion: 1;
  rootTag: 'signal';
  actionPath: string;
  pairPath: string;
  entry: {
    mode: SignalContractEntryMode;
    typePath?: string;
    marketValues: string[];
    rangeValues: string[];
    minimumPath: string;
    maximumPath: string;
  };
  targets: {
    containerPath: string;
    itemTag: string;
    shape: SignalContractTargetShape;
    minimumPath: string;
    maximumPath: string;
    minimumItems: number;
    maximumItems: number;
    sequentialIds: boolean;
  };
  stopLossPath: string;
  leveragePath?: string;
  riskPercentPath?: string;
  averagingPricePath?: string;
  additionalFields: SignalContractAdditionalField[];
  geometry: {
    stopOnLossSide: boolean;
    targetsOnProfitSide: boolean;
    orderedTargets: boolean;
    orderedRanges: boolean;
  };
  grounding: {
    action: boolean;
    pair: boolean;
    entry: boolean;
    targets: boolean;
    stopLoss: boolean;
    leverage: boolean;
    riskPercent: boolean;
    averagingPrice: boolean;
  };
}

export interface SignalContractVersion {
  id: string;
  contractId: string;
  version: number;
  status: SignalContractVersionStatus;
  definition: SignalContractDefinition;
  definitionSha256: string;
  createdAt: number;
  publishedAt: number | null;
  archivedAt: number | null;
}

export interface SignalContract {
  id: string;
  name: string;
  description: string;
  archived: boolean;
  versions: SignalContractVersion[];
  createdAt: number;
  updatedAt: number;
}

export interface ChannelRiskTier {
  riskPercent: string;
}

export interface ChannelRiskPolicy {
  channelId: string;
  mode: ChannelRiskMode;
  tiers: ChannelRiskTier[];
  currentTier: number;
  lookbackWeeks: number;
  minimumClosedTrades: number;
  lossThresholdPercent: string;
  profitThresholdPercent: string;
  weakChannelAction: WeakChannelAction;
  weakWeeksBeforeBlock: number;
  manuallyBlocked: boolean;
  blocked: boolean;
  blockReason: string | null;
  lockedTier: number | null;
  policyVersion: number;
  createdAt: number;
  updatedAt: number;
}

export interface ChannelRiskEvaluation {
  id: string;
  channelId: string;
  policyVersion: number;
  weekStartedAt: number;
  weekEndedAt: number;
  closedTrades: number;
  wins: number;
  losses: number;
  realizedPnl: string;
  startingEquity: string;
  returnPercent: string;
  previousTier: number;
  recommendedTier: number;
  appliedTier: number;
  action: 'hold' | 'increase' | 'decrease' | 'block';
  reason: string;
  createdAt: number;
}

export interface TradingEquityPoint {
  accountId: string;
  equity: string;
  availableBalance: string;
  unrealizedPnl: string;
  marginUsed: string;
  observedAt: number;
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
  /** Account-wide reservation and position capacity, shared by every workflow path. */
  maxConcurrentPositions: number;
  killSwitchActive: boolean;
  killSwitchReason: string | null;
  capabilities: Record<string, unknown> | null;
  lastVerifiedAt: number | null;
  lastReconciledAt: number | null;
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
  rootSourceSignalId: string;
  signalRunId: string | null;
  workflowRevisionId: string | null;
  executionPathId: string | null;
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

export type WorkflowResourceKind =
  | 'channel'
  | 'content_filter'
  | 'keyword_filter'
  | 'regex'
  | 'parser'
  | 'schema'
  | 'contract'
  | 'dedupe'
  | 'strategy'
  | 'sizing'
  | 'adaptive_risk'
  | 'account'
  | 'output';

export interface WorkflowResourceVersion {
  id: string;
  resourceId: string;
  version: number;
  kind: WorkflowResourceKind;
  name: string;
  description: string;
  status: 'draft' | 'published' | 'archived';
  configuration: Record<string, unknown>;
  configurationSha256: string;
  createdAt: number;
  publishedAt: number | null;
  archivedAt: number | null;
}

export interface WorkflowNode {
  id: string;
  kind: WorkflowResourceKind;
  resourceVersionId: string;
  position: { x: number; y: number };
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  /** Omitted by legacy schema-v1 graphs and interpreted as a normal flow edge. */
  kind?: 'flow' | 'account_fallback';
  /**
   * Optional origin-channel routing constraint. When omitted, every channel
   * lineage reaching the source node may traverse this edge. When present,
   * only lineages that started at one of these channel node identifiers may
   * continue to the target.
   */
  channelNodeIds?: string[];
}

export interface WorkflowGraph {
  schemaVersion: 1 | 2;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface WorkflowExecutionPath {
  id: string;
  workflowRevisionId: string;
  pathKey: string;
  channelId: string;
  accountId: string;
  strategyVersionId: string;
  parserResourceVersionId: string | null;
  schemaResourceVersionId: string | null;
  contractResourceVersionId: string | null;
  sizingResourceVersionId: string | null;
  adaptiveRiskResourceVersionId: string | null;
  /** Stable identity shared by mutually exclusive account candidates. */
  routeGroupKey: string;
  /** Zero-based position in the account fallback chain. */
  fallbackRank: number;
  nodeIds: string[];
  effectiveConfiguration: Record<string, unknown>;
  enabled: boolean;
  createdAt: number;
}

export interface WorkflowRouteCandidate {
  pathId: string;
  accountId: string;
  accountNodeId: string;
  rank: number;
  enabled: boolean;
}

export interface WorkflowRouteGroup {
  key: string;
  channelId: string;
  channelNodeId: string;
  primaryPathId: string;
  candidates: WorkflowRouteCandidate[];
}

export interface WorkflowRevision {
  id: string;
  revision: number;
  status: 'active' | 'archived';
  graph: WorkflowGraph;
  compiled: { paths: WorkflowExecutionPath[]; routeGroups: WorkflowRouteGroup[]; warnings: string[] };
  definitionSha256: string;
  baseRevisionId: string | null;
  createdBy: string;
  createdAt: number;
  archivedAt: number | null;
}

export interface WorkflowHistoryEntry {
  revisionId: string | null;
  label: string;
  capturedAt: number;
}

export type WorkflowHistoryMode = 'record' | 'undo' | 'redo' | 'ignore' | 'reset';
export type WorkflowHistoryDirection = 'undo' | 'redo';

export interface WorkflowHistoryStatus {
  limit: 5;
  undoCount: number;
  redoCount: number;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
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
  /** Optional for plans persisted before strategy schema v4. */
  leverageDecision?: LeverageDecision;
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

export interface LeverageDecision {
  requested: number;
  requestedSource: 'signal' | 'strategy_default';
  strategyMaximum: number;
  marketMaximum: number;
  effective: number;
  cappedBy: null | 'strategy' | 'market' | 'strategy_and_market';
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
  clientOrderId: string | null;
  exchangeOrderId: string;
  price: string;
  quantity: string;
  fee: string;
  feeAsset: string | null;
  filledAt: number;
  raw: unknown;
}

export interface ExchangeOrderSnapshot {
  clientOrderId: string | null;
  exchangeOrderId: string;
  status: ExchangeOrderResult['status'];
  filledQuantity: string;
  averagePrice: string | null;
  error: string | null;
  raw: unknown;
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

export type ExchangeStreamEventType =
  | 'order'
  | 'execution'
  | 'position'
  | 'market'
  | 'candle'
  | 'stream_status';

export interface ExchangeStreamEvent {
  cursor: number;
  eventKey: string;
  eventType: ExchangeStreamEventType;
  symbol: string | null;
  sequence: number | null;
  occurredAt: number;
  receivedAt: number;
  payload: unknown;
}

export interface ExchangeStreamHealth {
  status: 'starting' | 'healthy' | 'degraded' | 'stopped';
  startedAt: number | null;
  lastEventAt: number | null;
  lastError: string | null;
}

export interface ExchangeStreamBatch {
  events: ExchangeStreamEvent[];
  nextCursor: number;
  gap: boolean;
  health: ExchangeStreamHealth;
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
  /**
   * Reads normalized events from the official provider WebSocket stream.
   * The cursor is account-local and gaps must always trigger authoritative
   * REST reconciliation before the events influence trading state.
   */
  streamEvents?(
    account: TradingAccount,
    cursor: number,
    symbols: string[],
  ): Promise<ExchangeStreamBatch>;
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
