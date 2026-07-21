export interface DashboardDataInput {
  trading?: any
  operations?: any
  messages?: any[]
  signals?: any[]
  outbox?: any[]
}

export interface PerformancePoint {
  timestamp: number
  label: string
  pnl: number
}

export interface DashboardViewModel {
  finance: {
    paperEquity: number
    paperAvailable: number
    paperRealizedPnl: number
    paperUtilizationPercent: number
    openNotional: number
    openRisk: number
    feeTotal: number
    feeAsset: string | null
    mixedFeeAssets: boolean
  }
  trading: {
    accountCount: number
    enabledRouteCount: number
    openPositionCount: number
    pendingIntentCount: number
    completedIntentCount: number
    blockedIntentCount: number
    unknownOrderCount: number
    executionEnabled: boolean
    liveTradingEnabled: boolean
    killSwitchActive: boolean
    latestReconciliationAt: number | null
    closedPositionCount: number
    winRatePercent: number | null
    profitFactor: number | null
    unacknowledgedRiskEvents: number
    criticalRiskEvents: number
  }
  signals: {
    sampleSize: number
    extractedCount: number
    processedCount: number
    filteredCount: number
    duplicateCount: number
    failedCount: number
    extractionRatePercent: number | null
  }
  operations: {
    backupHealthy: boolean | null
    backupLastSuccessAt: number | null
    offsiteHealthy: boolean | null
    offsiteRequired: boolean
    retentionHealthy: boolean | null
    retentionLastSuccessAt: number | null
    auditHealthy: boolean | null
    auditRemoteRequired: boolean
    auditLastRemoteSuccessAt: number | null
  }
  activePositions: any[]
  recentRiskEvents: any[]
  recentIntents: any[]
  performance: PerformancePoint[]
}

function finiteNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value)
  return Number.isFinite(number) ? number : 0
}

function nullableTimestamp(value: unknown): number | null {
  const number = finiteNumber(value)
  return number > 0 ? number : null
}

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null
}

function statusCount(items: any[], statuses: string[]): number {
  const accepted = new Set(statuses)
  return items.filter((item) => accepted.has(String(item?.status || "").toLowerCase())).length
}

export function buildDashboardViewModel(input: DashboardDataInput): DashboardViewModel {
  const trading = input.trading || {}
  const activity = trading.activity || {}
  const overview = trading.overview || {}
  const runtime = overview.runtime || {}
  const paperAccounts = Array.isArray(activity.paperAccounts) ? activity.paperAccounts : []
  const positions = Array.isArray(activity.positions) ? activity.positions : []
  const fills = Array.isArray(activity.fills) ? activity.fills : []
  const riskEvents = Array.isArray(activity.riskEvents) ? activity.riskEvents : []
  const intents = Array.isArray(trading.intents) ? trading.intents : []
  const messages = Array.isArray(input.messages) ? input.messages : []
  const signals = Array.isArray(input.signals) ? input.signals : []
  const operations = input.operations || {}

  const paperAccountIds = new Set(paperAccounts.map((account: any) => String(account.accountId)))
  const activePositions = positions.filter((position: any) => position.status !== "closed")
  const closedPositions = positions.filter((position: any) => position.status === "closed")
  const closedPaperPositions = closedPositions
    .filter((position: any) => paperAccountIds.has(String(position.accountId)))
    .sort((a: any, b: any) => finiteNumber(a.closedAt || a.updatedAt) - finiteNumber(b.closedAt || b.updatedAt))

  const openNotional = activePositions.reduce((sum: number, position: any) => (
    sum + Math.abs(finiteNumber(position.quantity) * finiteNumber(position.averageEntryPrice))
  ), 0)
  const openRisk = activePositions.reduce((sum: number, position: any) => {
    const quantity = Math.abs(finiteNumber(position.quantity))
    const entry = finiteNumber(position.averageEntryPrice)
    const stop = finiteNumber(position.stopPrice)
    return entry > 0 && stop > 0 ? sum + Math.abs(entry - stop) * quantity : sum
  }, 0)

  const feeAssets = new Set<string>(
    fills
      .filter((fill: any) => Math.abs(finiteNumber(fill.fee)) > 0)
      .map((fill: any) => String(fill.feeAsset || "unknown").toUpperCase()),
  )
  const winning = closedPositions.filter((position: any) => finiteNumber(position.realizedPnl) > 0)
  const paperWinning = closedPaperPositions.filter((position: any) => finiteNumber(position.realizedPnl) > 0)
  const paperLosing = closedPaperPositions.filter((position: any) => finiteNumber(position.realizedPnl) < 0)
  const grossProfit = paperWinning.reduce((sum: number, position: any) => sum + finiteNumber(position.realizedPnl), 0)
  const grossLoss = Math.abs(paperLosing.reduce((sum: number, position: any) => sum + finiteNumber(position.realizedPnl), 0))

  let cumulativePnl = 0
  const performance = closedPaperPositions.map((position: any) => {
    cumulativePnl += finiteNumber(position.realizedPnl)
    const timestamp = finiteNumber(position.closedAt || position.updatedAt)
    return {
      timestamp,
      label: timestamp > 0 ? new Date(timestamp).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }) : "–",
      pnl: Number(cumulativePnl.toFixed(8)),
    }
  })

  const processedCount = statusCount(messages, ["processed"])
  const sampleSize = messages.length
  const backup = operations.backup || {}
  const retention = operations.retention || {}
  const audit = operations.audit || {}
  const unacknowledgedRiskEvents = riskEvents.filter((event: any) => !event.acknowledgedAt).length
  const criticalRiskEvents = riskEvents.filter((event: any) => (
    !event.acknowledgedAt && String(event.severity || "").toLowerCase() === "critical"
  )).length

  const paperEquity = paperAccounts.reduce((sum: number, account: any) => sum + finiteNumber(account.equity), 0)
  const paperAvailable = paperAccounts.reduce((sum: number, account: any) => sum + finiteNumber(account.availableBalance), 0)

  return {
    finance: {
      paperEquity,
      paperAvailable,
      paperRealizedPnl: paperAccounts.reduce((sum: number, account: any) => sum + finiteNumber(account.realizedPnl), 0),
      paperUtilizationPercent: paperEquity > 0 ? Math.max(0, Math.min(100, ((paperEquity - paperAvailable) / paperEquity) * 100)) : 0,
      openNotional,
      openRisk,
      feeTotal: fills.reduce((sum: number, fill: any) => sum + finiteNumber(fill.fee), 0),
      feeAsset: feeAssets.size === 1 ? [...feeAssets][0] : null,
      mixedFeeAssets: feeAssets.size > 1,
    },
    trading: {
      accountCount: finiteNumber(overview.accountCount),
      enabledRouteCount: finiteNumber(overview.enabledRouteCount),
      openPositionCount: finiteNumber(overview.openPositionCount),
      pendingIntentCount: finiteNumber(overview.pendingIntentCount),
      completedIntentCount: statusCount(intents, ["completed"]),
      blockedIntentCount: statusCount(intents, ["blocked", "failed", "unknown"]),
      unknownOrderCount: finiteNumber(overview.unknownOrderCount),
      executionEnabled: Boolean(runtime.executionEnabled),
      liveTradingEnabled: Boolean(runtime.liveTradingEnabled),
      killSwitchActive: Boolean(runtime.killSwitchActive),
      latestReconciliationAt: nullableTimestamp(overview.latestReconciliationAt),
      closedPositionCount: closedPositions.length,
      winRatePercent: closedPositions.length > 0 ? (winning.length / closedPositions.length) * 100 : null,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Number.POSITIVE_INFINITY : null),
      unacknowledgedRiskEvents,
      criticalRiskEvents,
    },
    signals: {
      sampleSize,
      extractedCount: signals.length,
      processedCount,
      filteredCount: statusCount(messages, ["filtered"]),
      duplicateCount: statusCount(messages, ["duplicate"]),
      failedCount: statusCount(messages, ["failed"]),
      extractionRatePercent: sampleSize > 0 ? Math.min(100, (signals.length / sampleSize) * 100) : null,
    },
    operations: {
      backupHealthy: nullableBoolean(backup.healthy),
      backupLastSuccessAt: nullableTimestamp(backup.lastSuccessAt),
      offsiteHealthy: nullableBoolean(backup.offsiteHealthy),
      offsiteRequired: Boolean(backup.offsiteRequired),
      retentionHealthy: nullableBoolean(retention.healthy),
      retentionLastSuccessAt: nullableTimestamp(retention.lastSuccessAt),
      auditHealthy: nullableBoolean(audit.healthy),
      auditRemoteRequired: Boolean(audit.remoteRequired),
      auditLastRemoteSuccessAt: nullableTimestamp(audit.lastRemoteSuccessAt),
    },
    activePositions: activePositions.slice(0, 8),
    recentRiskEvents: riskEvents.slice(0, 6),
    recentIntents: intents.slice(0, 6),
    performance,
  }
}
