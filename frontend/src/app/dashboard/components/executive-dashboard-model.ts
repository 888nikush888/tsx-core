export type DashboardWindow = "24h" | "7d" | "30d" | "all"

export interface DashboardDataInput {
  trading?: any
  portfolio?: any
  signalAnalytics?: any
  operations?: any
  messages?: any[]
  signals?: any[]
  outbox?: any[]
}

export interface WindowAnalyticsView {
  realizedPnl: number
  grossProfit: number
  grossLoss: number
  closedTrades: number
  wins: number
  losses: number
  breakeven: number
  winRatePercent: number | null
  profitFactor: number | null
  fills: number
  volume: number
  fees: Record<string, number>
  intents: number
  completedIntents: number
  rejectedIntents: number
  riskEvents: number
  criticalRiskEvents: number
}

export interface AccountAnalyticsView {
  accountId: string
  name: string
  exchange: string
  mode: string
  enabled: boolean
  status: string
  reportingCurrency: string
  equity: number | null
  availableBalance: number | null
  unrealizedPnl: number | null
  marginUsed: number | null
  observedAt: number | null
  error: string | null
  windows: Record<DashboardWindow, WindowAnalyticsView>
}

export interface PerformancePoint {
  timestamp: number
  label: string
  pnl: number
}

export interface SignalWindowView {
  messages: number
  processed: number
  filtered: number
  duplicates: number
  failed: number
  signals: number
  extractionRatePercent: number | null
  processingRatePercent: number | null
}

export interface DashboardViewModel {
  finance: {
    nominalEquity: number
    availableBalance: number
    marginUsed: number
    unrealizedPnl: number
    paperEquity: number
    exchangeEquity: number
    utilizationPercent: number
    reportingCurrencies: string[]
    observedAt: number | null
    accountErrors: number
  }
  windows: Record<DashboardWindow, WindowAnalyticsView>
  signalWindows: Record<DashboardWindow, SignalWindowView>
  accounts: AccountAnalyticsView[]
  trading: {
    accountCount: number
    enabledRouteCount: number
    openPositionCount: number
    pendingIntentCount: number
    unknownOrderCount: number
    executionEnabled: boolean
    liveTradingEnabled: boolean
    killSwitchActive: boolean
    latestReconciliationAt: number | null
    unacknowledgedRiskEvents: number
    criticalRiskEvents: number
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
  performance: PerformancePoint[]
}

function finiteNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value)
  return Number.isFinite(number) ? number : 0
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function nullableTimestamp(value: unknown): number | null {
  const number = finiteNumber(value)
  return number > 0 ? number : null
}

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null
}

function emptyWindow(): WindowAnalyticsView {
  return {
    realizedPnl: 0, grossProfit: 0, grossLoss: 0, closedTrades: 0,
    wins: 0, losses: 0, breakeven: 0, winRatePercent: null,
    profitFactor: null, fills: 0, volume: 0, fees: {}, intents: 0,
    completedIntents: 0, rejectedIntents: 0, riskEvents: 0, criticalRiskEvents: 0,
  }
}

function windowView(source: any): WindowAnalyticsView {
  const closedTrades = finiteNumber(source?.closedTrades)
  const wins = finiteNumber(source?.wins)
  const grossProfit = finiteNumber(source?.grossProfit)
  const grossLoss = finiteNumber(source?.grossLoss)
  return {
    realizedPnl: finiteNumber(source?.realizedPnl),
    grossProfit,
    grossLoss,
    closedTrades,
    wins,
    losses: finiteNumber(source?.losses),
    breakeven: finiteNumber(source?.breakeven),
    winRatePercent: closedTrades > 0 ? wins / closedTrades * 100 : null,
    profitFactor: profitFactor(grossProfit, grossLoss),
    fills: finiteNumber(source?.fills),
    volume: finiteNumber(source?.volume),
    fees: Object.fromEntries(Object.entries(source?.fees || {}).map(([asset, value]) => [asset, finiteNumber(value)])),
    intents: finiteNumber(source?.intents),
    completedIntents: finiteNumber(source?.completedIntents),
    rejectedIntents: finiteNumber(source?.rejectedIntents),
    riskEvents: finiteNumber(source?.riskEvents),
    criticalRiskEvents: finiteNumber(source?.criticalRiskEvents),
  }
}

function aggregateWindows(accounts: AccountAnalyticsView[]): Record<DashboardWindow, WindowAnalyticsView> {
  return Object.fromEntries((["24h", "7d", "30d", "all"] as DashboardWindow[]).map(window => {
    const result = emptyWindow()
    for (const account of accounts) {
      const current = account.windows[window]
      result.realizedPnl += current.realizedPnl
      result.grossProfit += current.grossProfit
      result.grossLoss += current.grossLoss
      result.closedTrades += current.closedTrades
      result.wins += current.wins
      result.losses += current.losses
      result.breakeven += current.breakeven
      result.fills += current.fills
      result.volume += current.volume
      result.intents += current.intents
      result.completedIntents += current.completedIntents
      result.rejectedIntents += current.rejectedIntents
      result.riskEvents += current.riskEvents
      result.criticalRiskEvents += current.criticalRiskEvents
      for (const [asset, value] of Object.entries(current.fees)) result.fees[asset] = (result.fees[asset] || 0) + value
    }
    result.winRatePercent = result.closedTrades > 0 ? result.wins / result.closedTrades * 100 : null
    result.profitFactor = profitFactor(result.grossProfit, result.grossLoss)
    return [window, result]
  })) as Record<DashboardWindow, WindowAnalyticsView>
}

function profitFactor(grossProfit: number, grossLoss: number): number | null {
  if (grossLoss > 0) return grossProfit / grossLoss
  return grossProfit > 0 ? Number.POSITIVE_INFINITY : null
}

function signalWindow(source: any): SignalWindowView {
  const messages = finiteNumber(source?.messages)
  const signals = finiteNumber(source?.signals)
  const processed = finiteNumber(source?.processed)
  return {
    messages,
    processed,
    filtered: finiteNumber(source?.filtered),
    duplicates: finiteNumber(source?.duplicates),
    failed: finiteNumber(source?.failed),
    signals,
    extractionRatePercent: messages > 0 ? signals / messages * 100 : null,
    processingRatePercent: messages > 0 ? processed / messages * 100 : null,
  }
}

function signalAnalyticsSource(input: DashboardDataInput): Record<string, any> {
  const source = { ...input.signalAnalytics?.windows }
  if (source.all) return source
  const messages = Array.isArray(input.messages) ? input.messages : []
  const signals = Array.isArray(input.signals) ? input.signals : []
  const countStatus = (status: string) => messages.filter((item: any) => item.status === status).length
  source.all = {
    messages: messages.length,
    processed: countStatus("processed"),
    filtered: countStatus("filtered"),
    duplicates: countStatus("duplicate"),
    failed: countStatus("failed"),
    signals: signals.length,
  }
  return source
}

function performanceSeries(positions: any[], accountSelection: Set<string> | null) {
  const closedPositions = positions
    .filter((position: any) => position.status === "closed" && (!accountSelection || accountSelection.has(String(position.accountId))))
    .sort((a: any, b: any) => finiteNumber(a.closedAt || a.updatedAt) - finiteNumber(b.closedAt || b.updatedAt))
  let cumulativePnl = 0
  return closedPositions.map((position: any) => {
    cumulativePnl += finiteNumber(position.realizedPnl)
    const timestamp = finiteNumber(position.closedAt || position.updatedAt)
    return {
      timestamp,
      label: timestamp > 0 ? new Date(timestamp).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }) : "–",
      pnl: Number(cumulativePnl.toFixed(8)),
    }
  })
}

function latestReconciliation(reconciliations: any[], accountSelection: Set<string> | null): number | null {
  return reconciliations
    .filter((run: any) => run.status === "succeeded" && (!accountSelection || accountSelection.has(String(run.accountId))))
    .reduce((latest: number | null, run: any) => {
      const completedAt = nullableTimestamp(run.completedAt)
      if (completedAt === null) return latest
      return latest === null || completedAt > latest ? completedAt : latest
    }, null)
}

export function buildDashboardViewModel(input: DashboardDataInput, selectedAccountIds?: string[]): DashboardViewModel {
  const trading = input.trading || {}
  const activity = trading.activity || {}
  const overview = trading.overview || {}
  const runtime = overview.runtime || {}
  const positions = Array.isArray(activity.positions) ? activity.positions : []
  const riskEvents = Array.isArray(activity.riskEvents) ? activity.riskEvents : []
  const orders = Array.isArray(activity.orders) ? activity.orders : []
  const reconciliations = Array.isArray(activity.reconciliations) ? activity.reconciliations : []
  const routes = Array.isArray(trading.routes) ? trading.routes : []
  const intents = Array.isArray(trading.intents) ? trading.intents : []
  const analyticsAccounts = Array.isArray(trading.analytics?.accounts) ? trading.analytics.accounts : []
  const portfolioAccounts = Array.isArray(input.portfolio?.accounts) ? input.portfolio.accounts : []
  const portfolioById = new Map<string, any>(portfolioAccounts.map((account: any) => [String(account.accountId), account]))
  const analyticsById = new Map<string, any>(analyticsAccounts.map((account: any) => [String(account.accountId), account]))
  const accountIds = new Set([...portfolioById.keys(), ...analyticsById.keys()])
  const accountSelection = selectedAccountIds ? new Set(selectedAccountIds) : null
  const windows = ["24h", "7d", "30d", "all"] as DashboardWindow[]
  const accounts = [...accountIds].map(accountId => {
    const portfolio: any = portfolioById.get(accountId) || {}
    const analytics: any = analyticsById.get(accountId) || {}
    return {
      accountId,
      name: String(portfolio.name || analytics.name || accountId),
      exchange: String(portfolio.exchange || analytics.exchange || "unknown"),
      mode: String(portfolio.mode || analytics.mode || "unknown"),
      enabled: Boolean(portfolio.enabled),
      status: String(portfolio.status || "unknown"),
      reportingCurrency: String(portfolio.reportingCurrency || "USD"),
      equity: optionalNumber(portfolio.equity),
      availableBalance: optionalNumber(portfolio.availableBalance),
      unrealizedPnl: optionalNumber(portfolio.unrealizedPnl),
      marginUsed: optionalNumber(portfolio.marginUsed),
      observedAt: nullableTimestamp(portfolio.observedAt),
      error: portfolio.error ? String(portfolio.error) : null,
      windows: Object.fromEntries(windows.map(window => [window, windowView(analytics.windows?.[window])])) as Record<DashboardWindow, WindowAnalyticsView>,
    }
  }).filter(account => !accountSelection || accountSelection.has(account.accountId))

  const activePositions = positions.filter((position: any) => (
    position.status !== "closed" && (!accountSelection || accountSelection.has(String(position.accountId)))
  ))
  const performance = performanceSeries(positions, accountSelection)

  const nominalEquity = accounts.reduce((sum, account) => sum + (account.equity || 0), 0)
  const availableBalance = accounts.reduce((sum, account) => sum + (account.availableBalance || 0), 0)
  const marginUsed = accounts.reduce((sum, account) => sum + (account.marginUsed || 0), 0)
  const signalSource = signalAnalyticsSource(input)
  const operations = input.operations || {}
  const backup = operations.backup || {}
  const retention = operations.retention || {}
  const audit = operations.audit || {}
  const visibleRiskEvents = riskEvents.filter((event: any) => !accountSelection || !event.accountId || accountSelection.has(String(event.accountId)))
  const visibleRoutes = routes.filter((route: any) => !accountSelection || accountSelection.has(String(route.accountId)))
  const visibleIntents = intents.filter((intent: any) => !accountSelection || accountSelection.has(String(intent.accountId)))
  const visibleOrders = orders.filter((order: any) => !accountSelection || accountSelection.has(String(order.accountId)))
  const latestScopedReconciliation = latestReconciliation(reconciliations, accountSelection)

  return {
    finance: {
      nominalEquity,
      availableBalance,
      marginUsed,
      unrealizedPnl: accounts.reduce((sum, account) => sum + (account.unrealizedPnl || 0), 0),
      paperEquity: accounts.filter(account => account.exchange === "paper").reduce((sum, account) => sum + (account.equity || 0), 0),
      exchangeEquity: accounts.filter(account => account.exchange !== "paper").reduce((sum, account) => sum + (account.equity || 0), 0),
      utilizationPercent: nominalEquity > 0 ? Math.max(0, Math.min(100, (nominalEquity - availableBalance) / nominalEquity * 100)) : 0,
      reportingCurrencies: [...new Set(accounts.filter(account => account.equity !== null).map(account => account.reportingCurrency))],
      observedAt: nullableTimestamp(input.portfolio?.observedAt),
      accountErrors: accounts.filter(account => account.error).length,
    },
    windows: aggregateWindows(accounts),
    signalWindows: Object.fromEntries(windows.map(window => [
      window,
      signalWindow(signalSource[window] || (window === "all" ? signalSource.all : {})),
    ])) as Record<DashboardWindow, SignalWindowView>,
    accounts,
    trading: {
      accountCount: accountSelection ? accounts.length : finiteNumber(overview.accountCount),
      enabledRouteCount: accountSelection ? visibleRoutes.filter((route: any) => route.enabled).length : finiteNumber(overview.enabledRouteCount),
      openPositionCount: activePositions.length,
      pendingIntentCount: accountSelection
        ? visibleIntents.filter((intent: any) => ["pending", "planned", "submitting", "monitoring"].includes(String(intent.status))).length
        : finiteNumber(overview.pendingIntentCount),
      unknownOrderCount: accountSelection
        ? visibleOrders.filter((order: any) => order.status === "unknown").length
        : finiteNumber(overview.unknownOrderCount),
      executionEnabled: Boolean(runtime.executionEnabled),
      liveTradingEnabled: Boolean(runtime.liveTradingEnabled),
      killSwitchActive: Boolean(runtime.killSwitchActive),
      latestReconciliationAt: accountSelection ? latestScopedReconciliation : nullableTimestamp(overview.latestReconciliationAt),
      unacknowledgedRiskEvents: visibleRiskEvents.filter((event: any) => !event.acknowledgedAt).length,
      criticalRiskEvents: visibleRiskEvents.filter((event: any) => !event.acknowledgedAt && String(event.severity).toLowerCase() === "critical").length,
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
    activePositions: activePositions.slice(0, 12),
    recentRiskEvents: visibleRiskEvents.slice(0, 8),
    performance,
  }
}
