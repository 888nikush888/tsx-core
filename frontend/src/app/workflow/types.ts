export const WORKFLOW_KINDS = [
  'channel', 'content_filter', 'keyword_filter', 'regex', 'parser', 'schema',
  'contract', 'dedupe', 'strategy', 'sizing', 'adaptive_risk', 'account', 'output',
] as const

export type WorkflowKind = typeof WORKFLOW_KINDS[number]

export type WorkflowResource = {
  id: string
  resourceId: string
  version: number
  kind: WorkflowKind
  name: string
  description: string
  status: 'draft' | 'published' | 'archived'
  configuration: Record<string, unknown>
  configurationSha256: string
  createdAt: number
  publishedAt: number | null
}

export type WorkflowNodeRecord = {
  id: string
  kind: WorkflowKind
  resourceVersionId: string
  position: { x: number; y: number }
}

export type WorkflowEdgeRecord = { id: string; source: string; target: string }

export type WorkflowGraph = {
  schemaVersion: 1
  nodes: WorkflowNodeRecord[]
  edges: WorkflowEdgeRecord[]
}

export type WorkflowRevision = {
  id: string
  revision: number
  status: 'active' | 'archived'
  graph: WorkflowGraph
  compiled: {
    paths: Array<{
      id: string
      pathKey: string
      channelId: string
      accountId: string
      strategyVersionId: string
      enabled: boolean
      nodeIds: string[]
    }>
    warnings: string[]
  }
  definitionSha256: string
  createdAt: number
}

export type WorkflowSnapshot = {
  workflow: WorkflowRevision | null
  resources: WorkflowResource[]
}

export type TradingAccount = {
  id: string
  name: string
  exchange: 'paper' | 'hyperliquid' | 'bybit' | 'krakenfutures'
  mode: 'paper' | 'testnet' | 'live'
  status: string
  enabled: boolean
  maxConcurrentPositions: number
  killSwitchActive: boolean
  killSwitchReason: string | null
  lastReconciledAt: number | null
  lastError: string | null
  credentials?: { configured: boolean }
}

export type TradingSnapshot = {
  overview: {
    runtime: {
      executionEnabled: boolean
      liveTradingEnabled: boolean
      killSwitchActive: boolean
      killSwitchReason: string | null
    }
    accountCount: number
    enabledRouteCount: number
    openPositionCount: number
    pendingIntentCount: number
    unknownOrderCount: number
    latestReconciliationAt: number | null
  }
  accounts: TradingAccount[]
  strategies: Array<{
    id: string
    strategyId: string
    version: number
    name: string
    description: string
    status: string
    configuration: Record<string, unknown>
  }>
  signalSchemas: Array<{
    id: string
    name: string
    description: string
    parserSchema: string
    enabled: boolean
    contractVersionId: string
    templateName: string
  }>
  signalContracts: Array<{
    id: string
    name: string
    description: string
    versions: Array<{ id: string; contractId: string; version: number; status: string; definition: Record<string, unknown> }>
  }>
  intents: Array<Record<string, unknown>>
  activity: {
    positions: Array<Record<string, unknown>>
    riskEvents: Array<Record<string, unknown>>
    reconciliations: Array<Record<string, unknown>>
  }
  analytics: {
    generatedAt: number
    accounts: Array<Record<string, any>>
  }
  executionAnalytics: Record<string, any>
  channelAnalytics: {
    generatedAt: number
    channels: Array<Record<string, any>>
    exchanges: Array<Record<string, any>>
    equity: Array<Record<string, any>>
  }
  channelRiskEvaluations: Array<Record<string, any>>
  workflowAdaptiveRisk: {
    states: Array<Record<string, any>>
    evaluations: Array<Record<string, any>>
  }
  equityHistory: Array<Record<string, any>>
  exchangeStreams: Array<Record<string, unknown>>
}

export type ExchangeCatalog = {
  implementation: { library: string; version: string; streaming: string; orderAuthority: string }
  exchanges: Array<{
    id: TradingAccount['exchange']
    name: string
    modes: TradingAccount['mode'][]
    credentialFields: Array<{ id: string; label: string; secret: boolean }>
    certified: boolean
    builderFeeEnabled?: boolean
    maxConcurrentPositions: { minimum: number; maximum: number }
  }>
}

export const KIND_META: Record<WorkflowKind, { label: string; short: string; color: string; order: number }> = {
  channel: { label: 'Telegram-Kanal', short: 'Kanal', color: '#2dd4bf', order: 0 },
  content_filter: { label: 'Inhaltstyp', short: 'Inhalt', color: '#38bdf8', order: 1 },
  keyword_filter: { label: 'Schlüsselwörter', short: 'Keywords', color: '#60a5fa', order: 2 },
  regex: { label: 'Regex-Filter', short: 'Regex', color: '#818cf8', order: 3 },
  parser: { label: 'KI-Parser', short: 'Parser', color: '#a78bfa', order: 4 },
  schema: { label: 'Signal-Schema', short: 'Schema', color: '#c084fc', order: 5 },
  contract: { label: 'Signal-Vertrag', short: 'Vertrag', color: '#e879f9', order: 6 },
  dedupe: { label: 'Duplikatschutz', short: 'Dedupe', color: '#f472b6', order: 7 },
  strategy: { label: 'Strategie', short: 'Strategie', color: '#fb7185', order: 8 },
  sizing: { label: 'Positionsgröße', short: 'Sizing', color: '#fb923c', order: 9 },
  adaptive_risk: { label: 'Adaptives Risiko', short: 'Risiko', color: '#facc15', order: 10 },
  account: { label: 'Börsenkonto', short: 'Konto', color: '#4ade80', order: 11 },
  output: { label: 'Ausgabe', short: 'Ausgabe', color: '#94a3b8', order: 12 },
}

export const COLUMN_GAP = 292
