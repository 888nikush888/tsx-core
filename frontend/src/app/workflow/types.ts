export const WORKFLOW_KINDS = [
  "channel",
  "content_filter",
  "keyword_filter",
  "regex",
  "parser",
  "schema",
  "contract",
  "dedupe",
  "strategy",
  "sizing",
  "adaptive_risk",
  "account",
  "output",
] as const;

export type WorkflowKind = (typeof WORKFLOW_KINDS)[number];

export type WorkflowResource = {
  id: string;
  resourceId: string;
  version: number;
  kind: WorkflowKind;
  name: string;
  description: string;
  status: "draft" | "published" | "archived";
  configuration: Record<string, unknown>;
  configurationSha256: string;
  createdAt: number;
  publishedAt: number | null;
};

export type WorkflowNodeRecord = {
  id: string;
  kind: WorkflowKind;
  resourceVersionId: string;
  position: { x: number; y: number };
};

export const WORKFLOW_FALLBACK_REASONS = [
  "SYMBOL_UNAVAILABLE",
  "MAX_CONCURRENT_POSITIONS",
  "SYMBOL_ALREADY_OWNED",
] as const;

export type WorkflowFallbackReason = (typeof WORKFLOW_FALLBACK_REASONS)[number];

export type WorkflowEdgeRecord = {
  id: string;
  source: string;
  target: string;
  /** Missing on legacy graph-v1 data and interpreted as a normal flow edge. */
  kind?: "flow" | "account_fallback";
  /** Missing means that every channel reaching the source is forwarded. */
  channelNodeIds?: string[];
  fallbackOn?: WorkflowFallbackReason[];
};

export type WorkflowGraph = {
  schemaVersion: 1 | 2 | 3;
  nodes: WorkflowNodeRecord[];
  edges: WorkflowEdgeRecord[];
};

export type WorkflowRevision = {
  id: string;
  revision: number;
  status: "active" | "archived";
  graph: WorkflowGraph;
  compiled: {
    paths: Array<{
      id: string;
      pathKey: string;
      channelId: string;
      accountId: string;
      strategyVersionId: string;
      enabled: boolean;
      nodeIds: string[];
      routeGroupKey?: string;
      fallbackRank?: number;
      fallbackOn: WorkflowFallbackReason[];
    }>;
    routeGroups?: Array<{
      key: string;
      channelId: string;
      channelNodeId: string;
      primaryPathId: string;
      candidates: Array<{
        pathId: string;
        accountId: string;
        accountNodeId: string;
        rank: number;
        enabled: boolean;
        fallbackOn: WorkflowFallbackReason[];
      }>;
    }>;
    warnings: string[];
  };
  definitionSha256: string;
  createdAt: number;
};

export type WorkflowSnapshot = {
  workflow: WorkflowRevision | null;
  resources: WorkflowResource[];
};

export type BuilderHistoryStatus = {
  limit: 5;
  undoCount: number;
  redoCount: number;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
};

export type StrategyConfiguration = {
  schemaVersion: 1 | 2 | 3 | 4;
  allowedSignalSchemas: string[];
  allowedSymbols: string[];
  allowedSides: Array<"LONG" | "SHORT">;
  entry: {
    orderType: "market" | "limit";
    rangePrice: "near" | "midpoint" | "far";
    postOnly: boolean;
    timeoutSeconds: number;
  };
  sizing: {
    positionSizingMode?:
      | "risk_percent"
      | "equity_percent_notional"
      | "equity_percent_margin";
    riskPerTradePercent: string;
    maxAdaptiveRiskPercent?: string;
    maxPositionNotional: string;
    defaultLeverage: number;
    maxLeverage: number;
  };
  exits: {
    targetAllocationMode: "manual" | "adaptive_halving";
    targetAllocationsPercent: string[];
    stopLossMode: "configured" | "adaptive_targets";
    moveStopToBreakEvenAfterTarget: number | null;
    trailingStopPercent: string | null;
    closeRemainderAtLastTarget: true;
  };
  safety: {
    maxConcurrentPositions?: number;
    maxDailyLossMode?: "absolute" | "equity_percent";
    maxDailyLoss: string;
    maxSlippagePercent: string;
    entryOrderTtlSeconds: number;
    requireProtectiveStop: true;
  };
};

export type SignalContractAdditionalField = {
  path: string;
  type: "text" | "decimal" | "integer" | "boolean";
  required: boolean;
  allowedValues: string[];
  minimum?: string;
  maximum?: string;
  maximumLength?: number;
  pattern?: string;
};

export type SignalContractDefinition = {
  schemaVersion: 1;
  rootTag: "signal";
  actionPath: string;
  pairPath: string;
  entry: {
    mode: "optional_range" | "required_range" | "typed";
    typePath?: string;
    marketValues: string[];
    rangeValues: string[];
    minimumPath: string;
    maximumPath: string;
  };
  targets: {
    containerPath: string;
    itemTag: string;
    shape: "scalar" | "range";
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
};

export type TradingAccount = {
  id: string;
  name: string;
  exchange: string;
  mode: "paper" | "testnet" | "live";
  status: string;
  enabled: boolean;
  maxConcurrentPositions: number;
  killSwitchActive: boolean;
  killSwitchReason: string | null;
  capabilities?: Record<string, unknown> | null;
  lastReconciledAt: number | null;
  lastError: string | null;
  credentials?: { configured: boolean };
};

export type TradingSnapshot = {
  overview: {
    runtime: {
      executionEnabled: boolean;
      liveTradingEnabled: boolean;
      killSwitchActive: boolean;
      killSwitchReason: string | null;
    };
    accountCount: number;
    enabledRouteCount: number;
    openPositionCount: number;
    pendingIntentCount: number;
    unknownOrderCount: number;
    latestReconciliationAt: number | null;
  };
  accounts: TradingAccount[];
  strategies: Array<{
    id: string;
    strategyId: string;
    version: number;
    name: string;
    description: string;
    status: string;
    configuration: StrategyConfiguration;
  }>;
  signalSchemas: Array<{
    id: string;
    name: string;
    description: string;
    parserSchema: string;
    definition: SignalContractDefinition;
    definitionSha256?: string;
    contractDefinition?: SignalContractDefinition | null;
    enabled: boolean;
    contractVersionId: string | null;
    templateName: string;
  }>;
  signalContracts: Array<{
    id: string;
    name: string;
    description: string;
    versions: Array<{
      id: string;
      contractId: string;
      version: number;
      status: string;
      definition: SignalContractDefinition;
    }>;
  }>;
  intents: Array<Record<string, unknown>>;
  activity: {
    positions: Array<Record<string, unknown>>;
    orders: Array<Record<string, any>>;
    paperMarkets: Array<Record<string, any>>;
    riskEvents: Array<Record<string, unknown>>;
    reconciliations: Array<Record<string, unknown>>;
  };
  analytics: {
    generatedAt: number;
    accounts: Array<Record<string, any>>;
  };
  executionAnalytics: Record<string, any>;
  channelAnalytics: {
    generatedAt: number;
    channels: Array<Record<string, any>>;
    exchanges: Array<Record<string, any>>;
    equity: Array<Record<string, any>>;
  };
  channelRiskEvaluations: Array<Record<string, any>>;
  workflowAdaptiveRisk: {
    states: Array<Record<string, any>>;
    evaluations: Array<Record<string, any>>;
  };
  equityHistory: Array<Record<string, any>>;
  exchangeStreams: Array<Record<string, unknown>>;
  accountIncidents: Array<{
    id: string;
    accountId: string;
    category: string;
    severity: "warning" | "critical";
    message: string;
    status: "open" | "resolved";
    occurrenceCount: number;
    firstSeenAt: number;
    lastSeenAt: number;
    resolvedAt: number | null;
    details: Record<string, unknown>;
  }>;
  fallbackRuns?: Array<{
    id: string;
    sourceSignalId: string;
    workflowRevisionId: string;
    signalRunId: string;
    routeGroupKey: string;
    channelId: string;
    channelName: string | null;
    status: "probing" | "selected" | "exhausted" | "stopped";
    currentRank: number;
    selectedIntentId: string | null;
    stopReason: string | null;
    createdAt: number;
    updatedAt: number;
    completedAt: number | null;
    candidates: Array<{
      rank: number;
      executionPathId: string;
      accountId: string;
      accountName: string;
      exchange: TradingAccount["exchange"];
      mode: TradingAccount["mode"];
      intentId: string | null;
      status: "waiting" | "pending" | "unavailable" | "selected" | "stopped";
      errorCode: string | null;
      fallbackOn: WorkflowFallbackReason[];
    }>;
  }>;
};

export type ExchangeCatalog = {
  implementation: {
    library: "ccxt";
    version: string;
    streaming: "ccxt-pro";
    orderAuthority: "rest";
  };
  exchanges: Array<{
    id: TradingAccount["exchange"];
    name: string;
    status:
      | "discovered"
      | "candidate"
      | "certified"
      | "quarantined"
      | "ineligible"
      | "deprecated";
    reason: string | null;
    provider: "paper" | "ccxt";
    ccxt: { rest: boolean; pro: boolean } | null;
    markets: { linearSwap: boolean | null };
    modes: TradingAccount["mode"][];
    credentialFields: Array<{
      id: string;
      label: string;
      required: boolean;
      secret: boolean;
    }>;
    capabilities: Record<string, unknown>;
  }>;
};

export const KIND_META: Record<
  WorkflowKind,
  { label: string; short: string; color: string; order: number }
> = {
  channel: {
    label: "Telegram-Kanal",
    short: "Kanal",
    color: "#2dd4bf",
    order: 0,
  },
  content_filter: {
    label: "Inhaltstyp",
    short: "Inhalt",
    color: "#38bdf8",
    order: 1,
  },
  keyword_filter: {
    label: "Schlüsselwörter",
    short: "Keywords",
    color: "#60a5fa",
    order: 2,
  },
  regex: { label: "Regex-Filter", short: "Regex", color: "#818cf8", order: 3 },
  parser: { label: "KI-Parser", short: "Parser", color: "#a78bfa", order: 4 },
  schema: {
    label: "Signal-Schema",
    short: "Schema",
    color: "#c084fc",
    order: 5,
  },
  contract: {
    label: "Signal-Vertrag",
    short: "Vertrag",
    color: "#e879f9",
    order: 6,
  },
  dedupe: {
    label: "Duplikatschutz",
    short: "Dedupe",
    color: "#f472b6",
    order: 7,
  },
  strategy: {
    label: "Strategie",
    short: "Strategie",
    color: "#fb7185",
    order: 8,
  },
  sizing: {
    label: "Positionsgröße",
    short: "Sizing",
    color: "#fb923c",
    order: 9,
  },
  adaptive_risk: {
    label: "Adaptives Risiko",
    short: "Risiko",
    color: "#facc15",
    order: 10,
  },
  account: {
    label: "Börsenkonto",
    short: "Konto",
    color: "#4ade80",
    order: 11,
  },
  output: { label: "Ausgabe", short: "Ausgabe", color: "#94a3b8", order: 12 },
};

export const COLUMN_GAP = 316;
