import "@testing-library/jest-dom/vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TradingTab } from "@/app/dashboard/components/trading-tab"

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

const configuration = {
  schemaVersion: 1,
  allowedSignalSchemas: ["standard"],
  allowedSymbols: [],
  allowedSides: ["LONG", "SHORT"],
  entry: { orderType: "limit", rangePrice: "midpoint", postOnly: false, timeoutSeconds: 10 },
  sizing: { riskPerTradePercent: "1", maxPositionNotional: "1000", maxLeverage: 3 },
  exits: { targetAllocationsPercent: ["100"], moveStopToBreakEvenAfterTarget: null, trailingStopPercent: null, closeRemainderAtLastTarget: true },
  safety: { maxConcurrentPositions: 1, maxDailyLoss: "100", maxSlippagePercent: "0.5", entryOrderTtlSeconds: 900, requireProtectiveStop: true },
}

function snapshot(strategies: unknown[]) {
  return {
    strategies,
    accounts: [],
    routes: [],
    analytics: { generatedAt: Date.now(), accounts: [] },
    overview: {
      runtime: { executionEnabled: false, liveTradingEnabled: false, killSwitchActive: false, killSwitchReason: null },
      openPositionCount: 0,
      enabledRouteCount: 0,
      pendingIntentCount: 0,
      unknownOrderCount: 0,
      latestReconciliationAt: null,
    },
    activity: { intents: [], positions: [], orders: [], fills: [], riskEvents: [], reconciliationRuns: [], paperMarkets: [] },
    confirmations: { live: "ENABLE LIVE TRADING", emergencyFlatten: "EMERGENCY FLATTEN ALL" },
  }
}

describe("Trading strategy control", () => {
  const requests: Array<{ url: string; init: RequestInit }> = []

  beforeEach(() => {
    requests.length = 0
    sessionStorage.clear()
    vi.restoreAllMocks()
    vi.spyOn(window, "confirm").mockReturnValue(true)
    let strategies: unknown[] = [
      {
        id: "strategy-delete",
        strategyId: "family-delete",
        version: 1,
        name: "Delete me",
        description: "Unused",
        status: "draft",
        configuration,
        configurationSha256: "a".repeat(64),
      },
      {
        id: "strategy-keep",
        strategyId: "family-keep",
        version: 1,
        name: "Keep me",
        description: "Replacement",
        status: "published",
        configuration,
        configurationSha256: "b".repeat(64),
      },
    ]
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      requests.push({ url, init })
      if (url.endsWith("/api/trading/strategies") && init.method === "DELETE") {
        strategies = strategies.filter((strategy: any) => strategy.id !== "strategy-delete")
        return response({ success: true, result: true })
      }
      if (url.endsWith("/api/trading")) return response(snapshot(strategies))
      return response({}, 404)
    }))
  })

  afterEach(() => cleanup())

  it("deletes a selected strategy only after confirmation and sends the destructive API contract", async () => {
    vi.mocked(window.confirm).mockReturnValueOnce(false).mockReturnValueOnce(true)
    render(<TradingTab config={{ sourceChannels: [] }} />)
    fireEvent.click(await screen.findByRole("button", { name: "Strategien" }))
    fireEvent.click(screen.getByRole("button", { name: /Delete me v1/ }))
    fireEvent.click(screen.getByRole("button", { name: "Strategie löschen" }))
    expect(requests.some(({ init }) => init.method === "DELETE")).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: "Strategie löschen" }))

    await screen.findByText("Strategieversion endgültig gelöscht.")
    const request = requests.find(({ init }) => init.method === "DELETE")
    expect(window.confirm).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(request?.init.body))).toEqual({ id: "strategy-delete" })
    expect(new Headers(request?.init.headers).get("X-Destructive-Confirmation")).toBe("delete-trading-strategy")
    await waitFor(() => expect(screen.queryByRole("button", { name: /Delete me v1/ })).not.toBeInTheDocument())
  })
})
