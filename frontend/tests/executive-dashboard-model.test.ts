import { describe, expect, it } from "vitest"

import { buildDashboardViewModel } from "@/app/dashboard/components/executive-dashboard-model"

describe("Executive dashboard metrics", () => {
  it("keeps paper finance separate while deriving managed trade statistics", () => {
    const model = buildDashboardViewModel({
      trading: {
        overview: {
          accountCount: 2,
          enabledRouteCount: 2,
          openPositionCount: 1,
          pendingIntentCount: 1,
          unknownOrderCount: 0,
          runtime: { executionEnabled: true, liveTradingEnabled: false, killSwitchActive: false },
        },
        intents: [{ status: "completed" }, { status: "blocked" }],
        activity: {
          paperAccounts: [{ accountId: "paper", equity: "10000", availableBalance: "8500", realizedPnl: "125" }],
          positions: [
            { id: "paper-closed", accountId: "paper", status: "closed", realizedPnl: "100", closedAt: 1000 },
            { id: "paper-loss", accountId: "paper", status: "closed", realizedPnl: "-50", closedAt: 2000 },
            { id: "live-closed", accountId: "live", status: "closed", realizedPnl: "900", closedAt: 3000 },
            { id: "open", accountId: "live", status: "open", quantity: "2", averageEntryPrice: "100", stopPrice: "90" },
          ],
          fills: [{ fee: "1.5", feeAsset: "USDT" }, { fee: "0.5", feeAsset: "USDC" }],
          riskEvents: [],
        },
      },
    })

    expect(model.finance.paperEquity).toBe(10_000)
    expect(model.finance.paperAvailable).toBe(8_500)
    expect(model.finance.paperRealizedPnl).toBe(125)
    expect(model.finance.paperUtilizationPercent).toBe(15)
    expect(model.finance.openNotional).toBe(200)
    expect(model.finance.openRisk).toBe(20)
    expect(model.finance.mixedFeeAssets).toBe(true)
    expect(model.trading.winRatePercent).toBeCloseTo(66.67, 2)
    expect(model.trading.profitFactor).toBe(2)
    expect(model.performance).toEqual([
      { timestamp: 1000, label: "01.01.", pnl: 100 },
      { timestamp: 2000, label: "01.01.", pnl: 50 },
    ])
  })

  it("reports the bounded signal funnel without treating unknown operations as healthy", () => {
    const model = buildDashboardViewModel({
      messages: [
        { status: "processed" },
        { status: "processed" },
        { status: "filtered" },
        { status: "duplicate" },
        { status: "failed" },
      ],
      signals: [{ id: "1" }, { id: "2" }],
    })

    expect(model.signals).toMatchObject({
      sampleSize: 5,
      extractedCount: 2,
      processedCount: 2,
      filteredCount: 1,
      duplicateCount: 1,
      failedCount: 1,
      extractionRatePercent: 40,
    })
    expect(model.operations.backupHealthy).toBeNull()
    expect(model.operations.retentionHealthy).toBeNull()
    expect(model.operations.auditHealthy).toBeNull()
  })

  it("surfaces unresolved critical risk and unknown execution outcomes", () => {
    const model = buildDashboardViewModel({
      trading: {
        overview: { unknownOrderCount: 2, runtime: { killSwitchActive: true } },
        intents: [{ status: "unknown" }, { status: "failed" }, { status: "pending" }],
        activity: {
          riskEvents: [
            { severity: "critical", acknowledgedAt: null },
            { severity: "warning", acknowledgedAt: null },
            { severity: "critical", acknowledgedAt: 123 },
          ],
        },
      },
    })

    expect(model.trading.killSwitchActive).toBe(true)
    expect(model.trading.unknownOrderCount).toBe(2)
    expect(model.trading.blockedIntentCount).toBe(2)
    expect(model.trading.unacknowledgedRiskEvents).toBe(2)
    expect(model.trading.criticalRiskEvents).toBe(1)
  })
})
