import { describe, expect, it } from "vitest"

import { buildDashboardViewModel } from "@/app/dashboard/components/executive-dashboard-model"

function windowMetrics(overrides: Record<string, unknown> = {}) {
  return {
    realizedPnl: "0", grossProfit: "0", grossLoss: "0", closedTrades: 0,
    wins: 0, losses: 0, breakeven: 0, fills: 0, volume: "0", fees: {},
    intents: 0, completedIntents: 0, rejectedIntents: 0,
    riskEvents: 0, criticalRiskEvents: 0, ...overrides,
  }
}

function accountAnalytics(accountId: string, windows: Record<string, unknown>) {
  return {
    accountId,
    name: accountId === "paper" ? "Paper" : "Bybit Live",
    exchange: accountId === "paper" ? "paper" : "bybit",
    mode: accountId === "paper" ? "paper" : "live",
    windows: {
      "24h": windowMetrics(windows["24h"] as Record<string, unknown>),
      "7d": windowMetrics(windows["7d"] as Record<string, unknown>),
      "30d": windowMetrics(windows["30d"] as Record<string, unknown>),
      all: windowMetrics(windows.all as Record<string, unknown>),
    },
  }
}

describe("Executive dashboard metrics", () => {
  it("combines current paper and official exchange snapshots while preserving all time windows", () => {
    const model = buildDashboardViewModel({
      portfolio: {
        observedAt: 5_000,
        accounts: [
          { accountId: "paper", name: "Paper", exchange: "paper", mode: "paper", enabled: true, status: "ready", reportingCurrency: "QUOTE", equity: "10000", availableBalance: "8500", unrealizedPnl: "0", marginUsed: "1500", observedAt: 5_000 },
          { accountId: "live", name: "Bybit Live", exchange: "bybit", mode: "live", enabled: true, status: "ready", reportingCurrency: "USD", equity: "2500", availableBalance: "2000", unrealizedPnl: "75", marginUsed: "500", observedAt: 5_000 },
        ],
      },
      trading: {
        overview: { accountCount: 2, enabledRouteCount: 2, pendingIntentCount: 1, unknownOrderCount: 0, runtime: {} },
        analytics: { accounts: [
          accountAnalytics("paper", {
            "24h": { realizedPnl: "50", grossProfit: "100", grossLoss: "50", closedTrades: 2, wins: 1, losses: 1, fills: 3, volume: "900", fees: { USDC: "1" } },
            "7d": { realizedPnl: "125", grossProfit: "175", grossLoss: "50", closedTrades: 3, wins: 2, losses: 1 },
            "30d": { realizedPnl: "150" }, all: { realizedPnl: "175" },
          }),
          accountAnalytics("live", {
            "24h": { realizedPnl: "25", grossProfit: "25", closedTrades: 1, wins: 1, fills: 2, volume: "1100", fees: { USDT: "2" } },
            "7d": { realizedPnl: "100" }, "30d": { realizedPnl: "300" }, all: { realizedPnl: "450" },
          }),
        ] },
        activity: { positions: [], riskEvents: [], orders: [], reconciliations: [] },
      },
    })

    expect(model.finance).toMatchObject({
      nominalEquity: 12_500, availableBalance: 10_500, marginUsed: 2_000,
      unrealizedPnl: 75, paperEquity: 10_000, exchangeEquity: 2_500,
      utilizationPercent: 16,
    })
    expect(model.finance.reportingCurrencies).toEqual(["QUOTE", "USD"])
    expect(model.windows["24h"]).toMatchObject({ realizedPnl: 75, closedTrades: 3, wins: 2, losses: 1, fills: 5, volume: 2_000 })
    expect(model.windows["24h"].winRatePercent).toBeCloseTo(66.67, 2)
    expect(model.windows["24h"].profitFactor).toBe(2.5)
    expect(model.windows["7d"].realizedPnl).toBe(225)
    expect(model.windows["30d"].realizedPnl).toBe(450)
    expect(model.windows.all.realizedPnl).toBe(625)
  })

  it("applies an account drill-down to finance, execution controls, positions, risk, and reconciliation", () => {
    const model = buildDashboardViewModel({
      portfolio: { accounts: [
        { accountId: "paper", name: "Paper", exchange: "paper", mode: "paper", enabled: true, equity: "10000", availableBalance: "9000" },
        { accountId: "live", name: "Bybit", exchange: "bybit", mode: "live", enabled: true, equity: "2000", availableBalance: "1800" },
      ] },
      trading: {
        overview: { accountCount: 2, enabledRouteCount: 2, pendingIntentCount: 2, unknownOrderCount: 2, latestReconciliationAt: 9999, runtime: {} },
        analytics: { accounts: [accountAnalytics("paper", { "24h": {}, "7d": {}, "30d": {}, all: {} }), accountAnalytics("live", { "24h": {}, "7d": {}, "30d": {}, all: {} })] },
        routes: [{ accountId: "paper", enabled: true }, { accountId: "live", enabled: true }],
        intents: [{ accountId: "paper", status: "pending" }, { accountId: "live", status: "monitoring" }],
        activity: {
          positions: [{ id: "paper-open", accountId: "paper", status: "open" }, { id: "live-open", accountId: "live", status: "open" }],
          orders: [{ accountId: "paper", status: "unknown" }, { accountId: "live", status: "unknown" }],
          riskEvents: [{ id: "paper-risk", accountId: "paper", severity: "critical", acknowledgedAt: null }, { id: "live-risk", accountId: "live", severity: "warning", acknowledgedAt: null }],
          reconciliations: [{ accountId: "paper", status: "succeeded", completedAt: 1234 }, { accountId: "live", status: "succeeded", completedAt: 5678 }],
        },
      },
    }, ["live"])

    expect(model.finance.nominalEquity).toBe(2_000)
    expect(model.accounts.map(account => account.accountId)).toEqual(["live"])
    expect(model.trading).toMatchObject({ accountCount: 1, enabledRouteCount: 1, openPositionCount: 1, pendingIntentCount: 1, unknownOrderCount: 1, latestReconciliationAt: 5678, criticalRiskEvents: 0 })
    expect(model.activePositions.map(position => position.id)).toEqual(["live-open"])
    expect(model.recentRiskEvents.map(event => event.id)).toEqual(["live-risk"])
  })

  it("uses server-side signal windows and keeps unknown operations explicitly unknown", () => {
    const model = buildDashboardViewModel({
      signalAnalytics: { windows: {
        "24h": { messages: 10, processed: 7, filtered: 1, duplicates: 1, failed: 1, signals: 4 },
        "7d": { messages: 50, processed: 45, filtered: 2, duplicates: 2, failed: 1, signals: 20 },
        "30d": { messages: 100, processed: 90, filtered: 4, duplicates: 4, failed: 2, signals: 40 },
        all: { messages: 120, processed: 105, filtered: 5, duplicates: 6, failed: 4, signals: 45 },
      } },
    })

    expect(model.signalWindows["24h"]).toMatchObject({ messages: 10, signals: 4, extractionRatePercent: 40, processingRatePercent: 70 })
    expect(model.signalWindows.all.messages).toBe(120)
    expect(model.operations.backupHealthy).toBeNull()
    expect(model.operations.retentionHealthy).toBeNull()
    expect(model.operations.auditHealthy).toBeNull()
  })
})
