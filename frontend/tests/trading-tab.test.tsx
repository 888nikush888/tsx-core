import "@testing-library/jest-dom/vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TradingTab } from "@/app/dashboard/components/trading-tab"
import { NavigationProvider } from "@/lib/navigation"

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

const contractDefinition = {
  schemaVersion: 1,
  rootTag: "signal",
  actionPath: "action",
  pairPath: "pair",
  entry: {
    mode: "optional_range",
    marketValues: [],
    rangeValues: [],
    minimumPath: "entry_range.min",
    maximumPath: "entry_range.max",
  },
  targets: {
    containerPath: "targets",
    itemTag: "target",
    shape: "scalar",
    minimumPath: "min",
    maximumPath: "max",
    minimumItems: 1,
    maximumItems: 20,
    sequentialIds: true,
  },
  stopLossPath: "stoploss",
  geometry: { stopOnLossSide: true, targetsOnProfitSide: true, orderedTargets: true, orderedRanges: true },
  grounding: { action: true, pair: true, entry: true, targets: true, stopLoss: true, leverage: false, riskPercent: false, averagingPrice: false },
  additionalFields: [],
}

function snapshot(strategies: unknown[], signalSchemas: unknown[] = [], signalContracts: unknown[] = []) {
  return {
    strategies,
    signalSchemas,
    signalContracts,
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

function renderTradingTab() {
  return render(<NavigationProvider><TradingTab config={{ sourceChannels: [] }} /></NavigationProvider>)
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
    let signalSchemas: any[] = [
      { id: "standard", name: "Standard", description: "", parserSchema: "standard", templateName: "default", enabled: true },
    ]
    let signalContracts: any[] = [{
      id: "desk-contract",
      name: "Desk Contract",
      description: "Editable XML contract",
      versions: [{
        id: "desk-contract:v1",
        contractId: "desk-contract",
        version: 1,
        status: "draft",
        definition: contractDefinition,
      }],
    }, {
      id: "published-contract",
      name: "Published Contract",
      description: "Published XML contract",
      versions: [{
        id: "published-contract:v1",
        contractId: "published-contract",
        version: 1,
        status: "published",
        definition: contractDefinition,
      }],
    }]
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      requests.push({ url, init })
      if (url.endsWith("/api/trading/signal-schemas") && init.method === "POST") {
        const schema = JSON.parse(String(init.body))
        signalSchemas.push(schema)
        return response({ success: true, result: schema }, 201)
      }
      if (url.endsWith("/api/trading/signal-schemas/update") && init.method === "POST") {
        const schema = JSON.parse(String(init.body))
        signalSchemas = signalSchemas.map(item => item.id === schema.id ? schema : item)
        return response({ success: true, result: schema })
      }
      if (url.endsWith("/api/trading/signal-schemas") && init.method === "DELETE") {
        const { id } = JSON.parse(String(init.body))
        signalSchemas = signalSchemas.filter(schema => schema.id !== id)
        return response({ success: true, result: true })
      }
      if (url.endsWith("/api/trading/strategies") && init.method === "DELETE") {
        strategies = strategies.filter((strategy: any) => strategy.id !== "strategy-delete")
        return response({ success: true, result: true })
      }
      if (url.endsWith("/api/trading/strategies/update") && init.method === "POST") {
        return response({ success: true, result: JSON.parse(String(init.body)) })
      }
      if (url.endsWith("/api/trading/signal-contracts/drafts") && init.method === "DELETE") {
        const { versionId } = JSON.parse(String(init.body))
        signalContracts = signalContracts
          .map(contract => ({ ...contract, versions: contract.versions.filter((version: any) => version.id !== versionId) }))
          .filter(contract => contract.versions.length > 0)
        return response({ success: true, result: true })
      }
      if (url.endsWith("/api/trading/signal-contracts/versions") && init.method === "DELETE") {
        const { versionId } = JSON.parse(String(init.body))
        signalContracts = signalContracts
          .map(contract => ({ ...contract, versions: contract.versions.filter((version: any) => version.id !== versionId) }))
          .filter(contract => contract.versions.length > 0)
        return response({ success: true, result: true })
      }
      if (url.endsWith("/api/trading")) return response(snapshot(strategies, signalSchemas, signalContracts))
      return response({}, 404)
    }))
  })

  afterEach(() => cleanup())

  it("deletes a selected strategy only after confirmation and sends the destructive API contract", async () => {
    vi.mocked(window.confirm).mockReturnValueOnce(false).mockReturnValueOnce(true)
    renderTradingTab()
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

  it("controls adaptive TP allocation and SL movement independently and persists both modes", async () => {
    renderTradingTab()
    fireEvent.click(await screen.findByRole("button", { name: "Strategien" }))
    fireEvent.click(screen.getByRole("button", { name: /Delete me v1/ }))

    const targetSwitch = screen.getByRole("switch", { name: "Adaptive TP-Staffelung (Halbierungsregel)" })
    const stopSwitch = screen.getByRole("switch", { name: "Adaptives SL-Nachziehen nach TP-Stufen" })
    expect(targetSwitch).not.toBeChecked()
    expect(stopSwitch).not.toBeChecked()
    fireEvent.click(targetSwitch)
    fireEvent.click(stopSwitch)

    expect(screen.getByText(/Jeder TP bis zum vorletzten schließt die Hälfte/)).toBeInTheDocument()
    expect(screen.getByText(/Nach TP1 und TP2 wird der SL auf Break-even gesetzt/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Entwurf speichern" }))

    await screen.findByText("Strategieentwurf gespeichert.")
    const request = requests.find(({ url, init }) => url.endsWith("/api/trading/strategies/update") && init.method === "POST")
    const body = JSON.parse(String(request?.init.body))
    expect(body.configuration.exits.targetAllocationMode).toBe("adaptive_halving")
    expect(body.configuration.exits.stopLossMode).toBe("adaptive_targets")
    expect(body.configuration.exits.targetAllocationsPercent).toEqual(["100"])
  })

  it("creates, edits and deletes an allowed signal schema profile", async () => {
    renderTradingTab()
    fireEvent.click(await screen.findByRole("button", { name: "Strategien" }))

    fireEvent.change(screen.getByLabelText("Kennung"), { target: { value: "desk-alpha" } })
    fireEvent.change(screen.getByLabelText("Anzeigename"), { target: { value: "Desk Alpha" } })
    fireEvent.change(screen.getByLabelText("Parser-Template"), { target: { value: "desk-alpha-template" } })
    fireEvent.click(screen.getByRole("button", { name: "Schema anlegen" }))
    await screen.findByText("Signal-Schema angelegt.")
    expect(screen.getByText("Desk Alpha", { selector: "span" })).toBeInTheDocument()

    let card = screen.getByText("Desk Alpha", { selector: "span" }).closest(".rounded-md")
    expect(card).not.toBeNull()
    fireEvent.click(within(card as HTMLElement).getByRole("button", { name: "Bearbeiten" }))
    fireEvent.change(screen.getByLabelText("Anzeigename"), { target: { value: "Desk Alpha bearbeitet" } })
    fireEvent.click(screen.getByRole("button", { name: "Schema speichern" }))
    await screen.findByText("Signal-Schema aktualisiert.")

    card = screen.getByText("Desk Alpha bearbeitet", { selector: "span" }).closest(".rounded-md")
    fireEvent.click(within(card as HTMLElement).getByRole("button", { name: "Löschen" }))
    await screen.findByText("Signal-Schema gelöscht.")
    await waitFor(() => expect(screen.queryByText("Desk Alpha bearbeitet", { selector: "span" })).not.toBeInTheDocument())

    const createRequest = requests.find(({ url, init }) => url.endsWith("/api/trading/signal-schemas") && init.method === "POST")
    const deleteRequest = requests.find(({ url, init }) => url.endsWith("/api/trading/signal-schemas") && init.method === "DELETE")
    expect(JSON.parse(String(createRequest?.init.body)).id).toBe("desk-alpha")
    expect(new Headers(deleteRequest?.init.headers).get("X-Destructive-Confirmation")).toBe("delete-trading-signal-schema")
  })

  it("exposes the XML contract workspace and deletes a selected draft through its destructive API", async () => {
    renderTradingTab()
    fireEvent.click(await screen.findByRole("button", { name: "Verträge" }))

    expect(screen.getByText("Versionierte Signalverträge")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Neuer Vertrag" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /v1.*draft/ }))
    fireEvent.click(screen.getByRole("button", { name: "Entwurf löschen" }))

    await screen.findByText("Vertragsentwurf gelöscht.")
    await waitFor(() => expect(screen.queryByText("Desk Contract")).not.toBeInTheDocument())
    const request = requests.find(({ url, init }) =>
      url.endsWith("/api/trading/signal-contracts/drafts") && init.method === "DELETE")
    expect(JSON.parse(String(request?.init.body))).toEqual({ versionId: "desk-contract:v1" })
    expect(new Headers(request?.init.headers).get("X-Destructive-Confirmation")).toBe("delete-signal-contract-draft")
  })

  it("deletes an unreferenced published contract version after explicit confirmation", async () => {
    vi.mocked(window.confirm).mockReturnValue(true)
    renderTradingTab()
    fireEvent.click(await screen.findByRole("button", { name: "Verträge" }))

    const card = screen.getByText("Published Contract").closest(".rounded-md")
    expect(card).not.toBeNull()
    fireEvent.click(within(card as HTMLElement).getByRole("button", { name: /v1.*published/ }))
    fireEvent.click(screen.getByRole("button", { name: "Vertragsversion löschen" }))

    await screen.findByText("Vertragsversion endgültig gelöscht.")
    await waitFor(() => expect(screen.queryByText("Published Contract")).not.toBeInTheDocument())
    const request = requests.find(({ url, init }) =>
      url.endsWith("/api/trading/signal-contracts/versions") && init.method === "DELETE")
    expect(window.confirm).toHaveBeenCalledOnce()
    expect(JSON.parse(String(request?.init.body))).toEqual({ versionId: "published-contract:v1" })
    expect(new Headers(request?.init.headers).get("X-Destructive-Confirmation")).toBe("delete-signal-contract-version")
  })
})
