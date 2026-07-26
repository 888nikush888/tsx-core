import "@testing-library/jest-dom/vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { CockpitDashboard } from "@/app/dashboard/components/cockpit-dashboard"

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

describe("CockpitDashboard", () => {
  const requests: string[] = []

  beforeEach(() => {
    requests.length = 0
    sessionStorage.clear()
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      requests.push(url)
      if (url.includes("/api/trading/portfolio")) {
        return response({ observedAt: Date.now(), cached: false, accounts: [{ accountId: "paper", equity: "10000", unrealizedPnl: "25" }] })
      }
      if (url.endsWith("/api/trading")) {
        return response({
          overview: { enabledRouteCount: 1, pendingIntentCount: 0, runtime: { executionEnabled: true } },
          activity: { positions: [{ id: "position-1", accountId: "paper", channelId: "-100", symbol: "BTCUSDT", side: "LONG", quantity: "0.1", averageEntryPrice: "60000", stopPrice: "59000", status: "open" }] },
          confirmations: { emergencyFlatten: "FLATTEN ALL MANAGED POSITIONS" },
        })
      }
      if (url.endsWith("/api/processed-signals")) {
        return response({ signals: [{ id: "signal-1", chat_id: "-100", message_id: 7, xml_content: "<signal><action>LONG</action><pair>BTCUSDT</pair></signal>", created_at: Date.now() }] })
      }
      return response({})
    }))
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("shows live operational state without analytics depth", async () => {
    render(<CockpitDashboard
      isRunning={true}
      connectionState="connected"
      totalForwardedCount={12}
      processedSinceRestart={3}
      forwardingEnabled={true}
      forwardXmlToTarget={true}
      uptime="1h"
      queue={{ running: 0, queued: 0, maxConcurrency: 2, paused: false }}
      parserEnabled={true}
      setupSteps={[]}
      setupComplete={true}
      routingConfigReady={true}
      metricsHistory={[]}
      onToggleRouting={vi.fn()}
      onNavigate={vi.fn()}
    />)

    await screen.findByRole("heading", { name: "Live-Cockpit" })
    await screen.findAllByText("BTCUSDT")
    expect(screen.getAllByText("25")).toHaveLength(2)
    await waitFor(() => expect(requests.some(url => url.endsWith("/api/trading"))).toBe(true))
    expect(requests.some(url => url.endsWith("/api/trading/portfolio"))).toBe(true)
    expect(requests.some(url => url.endsWith("/api/processed-signals"))).toBe(true)
    expect(screen.queryByText("Performance nach Zeitraum")).not.toBeInTheDocument()
  })
})
