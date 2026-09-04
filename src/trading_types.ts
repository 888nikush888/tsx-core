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
  /** Builder-owned normalized output structure. */
  definition: SignalContractDefinition;
  definitionSha256: string;
  /** Optional legacy fallback; visual workflows use their connected contract node. */
  contractVersionId: string | null;
  contractDefinition: SignalContractDefinition | null;
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
  realizedPnl: string | null;
  realizedPnlValue: import('./trading_money_value.js').MoneyValue | null;
  startingEquity: string;
  returnPercent: string | null;
  returnPercentValue: import('./trading_money_value.js').MoneyValue | null;
  returnPercentReason: string | null;
  reportingCurrency: string | null;
  sourceHash: string | null;
  invalidatedAt: number | null;
  invalidationReason: string | null;
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
  /** Opaque verified executor credential generation; never an exchange secret. */
  credentialGeneration: string | null;
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

export const WORKFLOW_FALLBACK_REASONS = [
  'SYMBOL_UNAVAILABLE',
  'MAX_CONCURRENT_POSITIONS',
  'SYMBOL_ALREADY_OWNED',
] as const;

export type WorkflowFallbackReason = typeof WORKFLOW_FALLBACK_REASONS[number];

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
  /** Eligible, typed pre-selection reasons that may advance this account edge. */
  fallbackOn?: WorkflowFallbackReason[];
}

export interface WorkflowGraph {
  schemaVersion: 1 | 2 | 3;
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
  /** Snapshotted policy for advancing from this candidate to the next one. */
  fallbackOn: WorkflowFallbackReason[];
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
  fallbackOn: WorkflowFallbackReason[];
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
  fundingPnlToday: string | null;
  /** Additive exact value; fundingPnlToday is its exact decimal alias, not its completeness flag. */
  fundingPnlTodayValue?: import('./trading_money_value.js').MoneyValue | null;
  /** Additive transport evidence; required by the new-entry gate, not by protection/reconciliation. */
  accounting?: TradingAccountingEvidence;
}

export interface TradingFundingEvidence {
  /** Durable financial observation only; never an order/fill finality or negative-dispatch proof. */
  observation?: import('./trading_account_log_contract.js').FundingObservationProof;
  status: 'complete' | 'incomplete' | 'unsupported';
  since: number;
  until: number;
  cursor: string | null;
  source: string;
  reason: string | null;
  nextReadAt: number;
  events: Array<{ id: string; timestamp: number; amount: string; asset: string | null }>;
}

export interface TradingAccountingEvidence {
  accountFingerprint: string;
  reportingCurrency: string;
  settlementAssets: string[];
  source: string;
  observedAt: number;
  unrealizedPnlSemantics: 'price_only' | 'unverified';
  funding: TradingFundingEvidence;
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
  accounting?: ExchangeFillAccounting | null;
  leverageTiers?: TradingLeverageTierEvidence;
}

export interface TradingLeverageTier {
  lowerBound: string;
  /** Conservative upper-exclusive boundary; null means the final unlimited range. */
  upperBound: string | null;
  maxLeverage: number;
}

export interface TradingLeverageTierEvidence {
  version: 1;
  exchange: TradingAccount['exchange'];
  symbol: string;
  providerSymbol: string;
  accountFingerprint: string;
  credentialGeneration: string;
  ccxtVersion: string;
  profileHash: string;
  source: string;
  currency: string;
  contractSize: string;
  markPrice: string;
  observedAt: number;
  expiresAt: number;
  scope: { complete: true; positionQuantity: string; openOrderCount: number };
  tiers: TradingLeverageTier[];
}

export interface TradingLeverageTierDecision {
  version: 1 | 2;
  evidenceHash: string;
  providerSymbol: string;
  contractSize: string;
  tierIndex: number;
  quantity: string;
  leverage: number;
  maximumNotional: string | null;
  maximumNotionalCurrency?: string;
  maximumNotionalValue?: import('./trading_money_value.js').MoneyValue;
}

export interface TradingFxSizingContext {
  version: 1;
  conversionId: string;
  conversion: import('./trading_fx_quotes.js').FxConversionEvidence;
  reportingCurrency: string;
  notionalCurrency: string;
  strategyMaximumNotionalCurrency: string;
  riskAmountCurrency: string;
}

export interface PlannedOrder {
  clientOrderId: string;
  role: 'entry' | 'take_profit' | 'stop_loss' | 'flatten';
  side: TradingOrderSide;
  orderType: 'market' | 'limit' | 'stop_market';
  /** Market-based entries execute as bounded limit IOC; ordinary limits omit this field. */
  timeInForce?: 'IOC';
  quantity: string;
  price: string | null;
  triggerPrice: string | null;
  reduceOnly: boolean;
  postOnly: boolean;
  targetIndex: number | null;
}

export interface TradingEntryPriceBoundary {
  version: 1;
  referencePrice: string;
  maxSlippagePercent: string;
  priceTick: string;
  limitPrice: string;
}

export interface TradingPlan {
  version: 1;
  symbol: string;
  side: TradingSide;
  entryPrice: string;
  /** Immutable original market-reference boundary; absent only for ordinary signal limits or legacy plans. */
  entryPriceBoundary?: TradingEntryPriceBoundary | null;
  stopPrice: string;
  quantity: string;
  notional: string;
  riskAmount: string;
  fxSizing?: TradingFxSizingContext;
  leverage: number;
  /** Optional for plans persisted before strategy schema v4. */
  leverageDecision?: LeverageDecision;
  leverageTierDecision?: TradingLeverageTierDecision;
  entryTimeoutSeconds: number;
  entryOrderTtlSeconds: number;
  /** Original absolute admission/drain deadline; absent/null only for legacy persisted plans. */
  entryExpiresAt?: number | null;
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
  /** Original absolute signal deadline; absent only on legacy requests or independent reduce-only recovery. */
  entryExpiresAt?: number;
  /** Explicitly journaled request-to-response tag; never reconstructed from a response array index. */
  providerBatchTag?: { version: 1; tag: string };
  entryPriceBoundary?: TradingEntryPriceBoundary;
  leverageTierDecision?: TradingLeverageTierDecision;
  accountId: string;
  symbol: string;
  leverage: number;
  timeoutSeconds: number;
}

interface OrderIdentityScope {
  version: 1; clientOrderId: string; exchangeOrderId: string; providerSymbol: string;
}
export type ExchangeOrderIdentityEvidence =
  | (OrderIdentityScope & { profile: 'kraken_batch_tag_v1'; tag: string })
  | (OrderIdentityScope & { profile: 'hyperliquid_cloid_lookup_v1'; user: string; providerMarketId: string; startedAt: number; completedAt: number });

export interface ExchangeOrderResult {
  identityEvidence?: ExchangeOrderIdentityEvidence;
  clientOrderId: string;
  exchangeOrderId: string;
  /** CCXT unified symbol defining the provider order-id namespace. */
  providerSymbol?: string;
  status: 'open' | 'partially_filled' | 'filled' | 'cancelled' | 'rejected' | 'unknown';
  filledQuantity: string;
  averagePrice: string | null;
  error: string | null;
  raw: unknown;
}

export interface ExchangeFillIdentity {
  version: 1;
  profile: 'bybit_execution_v1' | 'hyperliquid_user_fill_v1' | 'kraken_history_execution_v3' | 'paper_fill_v1';
  marketNamespace: 'linear' | 'inverse' | 'spot' | 'option' | 'perpetual' | 'futures' | 'paper';
  providerMarketId: string;
  providerSymbol: string;
  providerFillId: string;
  scopeTimestamp: number | null;
}

export interface FillQuantityNormalization {
  version: 1; source: 'kraken-execution-normalization-v1'; inputField: 'execution.quantity';
  inputQuantity: string; inputUnit: 'kraken_native_execution_quantity'; appliedFactor: string;
  outputQuantity: string; outputUnit: 'base';
  arithmetic: { operation: 'multiply'; decimalPrecision: number; decimalRounding: string; exactProduct: boolean };
  market: { providerMarketId: string; providerSymbol: string; base: string; quote: string; settlementAsset: string;
    contract: true; linear: true; inverse: false; appliedContractSize: string; source: 'ccxt-4.5.75-loaded-market';
    sourceHash: string; observedAt: null; providerContractSize: null; providerOriginalStatus: 'not-retained' };
  nativeIdentity: ExchangeFillIdentity; originalExecutionHash: string; normalizedAt: number;
}

export interface ExchangeFill {
  identity?: ExchangeFillIdentity;
  /** Actual observed normalization, not a historical provider-unit or valuation proof. */
  quantityNormalization?: FillQuantityNormalization;
  exchangeFillId: string;
  clientOrderId: string | null;
  exchangeOrderId: string;
  symbol?: string;
  providerSymbol?: string;
  price: string;
  quantity: string;
  fee: string;
  feeAsset: string | null;
  filledAt: number;
  /** Explicit loaded-market economics, never inferred from fee asset or a symbol suffix. */
  accounting?: ExchangeFillAccounting | null;
  raw: unknown;
}

export interface ExchangeFillAccounting {
  version: 1;
  source: 'ccxt-market-v1' | 'paper-contract-v1';
  providerSymbol: string;
  settlementAsset: string;
  linear: true;
  quantityUnit: 'base';
}

export interface ExchangeOrderSnapshot {
  identityEvidence?: ExchangeOrderIdentityEvidence;
  clientOrderId: string | null;
  exchangeOrderId: string;
  providerSymbol?: string;
  /** Provider's last order event/update time; never substituted by local receipt or creation time. */
  providerTimestamp?: number | null;
  status: ExchangeOrderResult['status'];
  /** Null means the provider did not report cumulative execution, never zero. */
  filledQuantity: string | null;
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
  /** Exact provider market, including settlement and contract identity. */
  providerSymbol?: string;
  side: TradingSide;
  quantity: string;
  averageEntryPrice: string;
  /** Unknown valuation must not prevent quantity/stop reconciliation. */
  unrealizedPnl: string | null;
  markPrice?: string | null;
  accounting?: ExchangeFillAccounting | null;
}

export interface ExchangeOpenState {
  orders: ExchangeOrderSnapshot[];
  positions: ExchangePositionSnapshot[];
  fills: ExchangeFill[];
  unresolvedEvents?: ExchangeUnresolvedEvent[];
  observedAt: number;
  acquisition?: ExchangeAcquisitionEvidence;
}

export interface ExchangeRecoveryReference {
  clientOrderId: string;
  exchangeOrderId: string | null;
  providerSymbol: string | null;
  symbol: string;
  role: PlannedOrder['role'];
}

export interface ExchangeRecoveryQuery {
  recoverySchedule?: import('./trading_recovery_schedule_contract.js').RecoveryScheduleRequest;
  fxEvidence?: import('./trading_recovery_schedule_contract.js').FxEvidenceRequest;
  readAccountMode?: boolean;
  accountLogs?: import('./trading_account_log_contract.js').AccountLogCheckpoint;
  since: number;
  orders: ExchangeRecoveryReference[];
  history: ExchangeHistoryCheckpoint[];
}

export interface ExchangeHistoryCheckpoint {
  providerAccountUid?: string | null;
  /** Proven contiguous fills only. Undefined marks legacy traversal without this proof. */
  coverage?: ExchangeHistoryCoverage | null;
  /** Bounded Hyperliquid total-retention probe; never ownership or an evergreen proof. */
  retention?: ExchangeHistoryRetention | null;
  source: 'orders' | 'fills';
  providerSymbol: string | null;
  revision: number;
  baselineSince: number;
  windowSince: number;
  windowUntil: number | null;
  cursor: string | null;
  /** Traversal progress only. Does not prove ownership, retention or an atomic snapshot. */
  scannedThrough: number | null;
  nextReadAt: number;
  completeness: 'complete' | 'partial' | 'unknown';
  reason: string | null;
}

export interface ExchangeHistoryCoverage {
  version: 1;
  profile: string;
  since: number;
  through: number;
}

export interface ExchangeHistoryRetention {
  version: 1;
  phase: 'witness' | 'horizon' | 'scan' | 'verify' | 'proved';
  originalSince: number;
  originalUntil: number;
  startedAt: number;
  fixedUntil: number | null;
  cursor: number;
  /** Conservatively includes the first page and every overlap; must remain below 10,000. */
  count: number;
  anchor: { coin: string; tid: string; time: number; payloadHash: string } | null;
  validatedAt: number | null;
}

export interface ExchangeHistoryProgress {
  baseRevision: number;
  checkpoint: ExchangeHistoryCheckpoint;
  pages: number;
}

export interface ExchangeAcquisitionEvidence {
  recoverySchedule?: import('./trading_recovery_schedule_contract.js').RecoveryScheduleProgress;
  fxEvidence?: import('./trading_recovery_schedule_contract.js').FxEvidenceProgress;
  accountMode?: import('./trading_account_mode_contract.js').AccountModeProgress;
  targetedCalls?: number;
  accountLogs?: import('./trading_account_log_contract.js').AccountLogProgress;
  version: 1;
  startedAt: number;
  completedAt: number;
  sources: Array<{
    source: 'positions' | 'orders' | 'targeted_orders' | 'fills';
    startedAt: number;
    completedAt: number;
    completeness: 'complete' | 'partial' | 'unknown';
    reason: string | null;
    since: number | null;
    /** Traversed current-state scopes; not an atomic snapshot or historical retention proof. */
    scopes?: Array<{ scope: string; pages: number; complete: boolean }>;
  }>;
  checkedOrders: Array<{
    clientOrderId: string;
    status: 'observed' | 'not_found' | 'unsupported' | 'budget_exhausted' | 'transient';
  }>;
  history?: ExchangeHistoryProgress[];
}

export interface ExchangeUnresolvedEvent {
  kind: 'fill' | 'order';
  source: 'fetchMyTrades' | 'fetchOrders';
  reason: string;
  providerId: string | null;
  providerSymbol: string | null;
  evidence: Record<string, string | number | boolean | null>;
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

export interface ExchangeEntryConstraints {
  accountAbstraction?: string | null;
  version: 1;
  exchange: string;
  symbol: string;
  providerSymbol: string;
  accountFingerprint: string;
  credentialGeneration: string;
  ccxtVersion: string;
  profileVersion: number;
  profileHash: string;
  providerApiVersion: string;
  origin: 'authenticated' | 'public_bound_account';
  observedAt: number;
  expiresAt: number;
  entryAllowed: boolean;
  reason: string | null;
  positionMode: 'oneway' | 'hedged' | 'unknown';
  marginMode: 'cross' | 'isolated' | 'portfolio' | 'unknown';
  leverage: number | null;
  leverageSemantics: 'configured' | 'effective_collateral_ratio' | 'unknown';
  sources: string[];
}

export interface TradingExchangeAdapter {
  readonly exchange: TradingExchange;
  accountSnapshot(account: TradingAccount): Promise<TradingAccountSnapshot>;
  marketSnapshot(account: TradingAccount, symbol: string): Promise<TradingMarketSnapshot>;
  /** Fresh, symbol-scoped mode evidence for new entries only; never needed to protect or reduce exposure. */
  entryConstraints?(account: TradingAccount, symbol: string): Promise<ExchangeEntryConstraints>;
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
