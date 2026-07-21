import "@testing-library/jest-dom/vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ExecutiveDashboard } from "@/app/dashboard/components/executive-dashboard"

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

describe("ExecutiveDashboard refresh", () => {
  const requests: string[] = []

  beforeEach(() => {
    requests.length = 0
    sessionStorage.clear()
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      requests.push(url)
      if (url.includes("/api/trading/portfolio")) return response({ observedAt: Date.now(), cached: false, accounts: [] })
      if (url.endsWith("/api/trading")) return response({ overview: { runtime: {} }, analytics: { accounts: [] }, activity: { positions: [], orders: [], riskEvents: [], reconciliations: [] }, routes: [], intents: [] })
      if (url.endsWith("/api/operations")) return response({ operations: {} })
      if (url.endsWith("/api/dashboard-analytics")) return response({ analytics: { windows: {} } })
      if (url.includes("/api/outbox")) return response({ tasks: [] })
      return response({})
    }))
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("forces a fresh official exchange snapshot when the user refreshes", async () => {
    render(<ExecutiveDashboard
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

    await screen.findByText(/Vollständig aktualisiert/)
    expect(requests.filter(url => url.endsWith("/api/trading/portfolio?refresh=true"))).toHaveLength(1)

    fireEvent.click(screen.getByRole("button", { name: "Alles aktualisieren" }))
    await waitFor(() => expect(requests.filter(url => url.endsWith("/api/trading/portfolio?refresh=true"))).toHaveLength(2))
    await screen.findByRole("button", { name: "Alles aktualisieren" })
  })
})
