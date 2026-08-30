import "@testing-library/jest-dom/vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => {
  const apiFetch = vi.fn()
  const jsonRequest = vi.fn(async (url: string, init?: RequestInit) => {
    const res = await apiFetch(url, init)
    const payload = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(payload.error || `Anfrage fehlgeschlagen (${res.status}).`)
    return payload
  })
  return { apiFetch, jsonRequest, clearDashboardToken: vi.fn(), setDashboardToken: vi.fn() }
})

vi.mock("@/lib/api", () => api)
vi.mock("recharts", () => {
  const Container = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  const Leaf = () => null
  return {
    Area: Leaf,
    AreaChart: Container,
    Bar: Leaf,
    BarChart: Container,
    CartesianGrid: Leaf,
    Line: Leaf,
    LineChart: Container,
    ResponsiveContainer: Container,
    Tooltip: Leaf,
    XAxis: Leaf,
    YAxis: Leaf,
  }
})

import { OperationsWorkspace, type OperationTab } from "@/app/workflow/operations-panel"

const now = Date.now()

const catalog = {
  implementation: { library: "ccxt", version: "4.5.75", streaming: "ccxt-pro", orderAuthority: "rest" },
  exchanges: [
    {
      id: "paper", name: "Paper", status: "certified", reason: null, provider: "paper", ccxt: null,
      markets: { linearSwap: true }, modes: ["paper"], credentialFields: [], capabilities: {},
    },
    {
      id: "bybit", name: "Bybit", status: "certified", reason: null, provider: "ccxt",
      ccxt: { rest: true, pro: true }, markets: { linearSwap: true }, modes: ["testnet", "live"],
      credentialFields: [{ id: "apiKey", label: "API Key", required: true, secret: true }], capabilities: {},
    },
  ],
} as any

const accounts = [
  { id: "paper-1", name: "Paper", exchange: "paper", mode: "paper", status: "ready", enabled: true, maxConcurrentPositions: 10, killSwitchActive: false, killSwitchReason: null, lastReconciledAt: now, lastError: null },
  { id: "bybit-1", name: "Bybit Test", exchange: "bybit", mode: "testnet", status: "isolated", enabled: true, maxConcurrentPositions: 5, killSwitchActive: true, killSwitchReason: "Unverwaltete Börsenorder", lastReconciledAt: now, lastError: "Abgleich erforderlich" },
]

const trading = {
  overview: {
    runtime: { executionEnabled: false, liveTradingEnabled: false, killSwitchActive: false, killSwitchReason: null },
    accountCount: 2,
    enabledRouteCount: 3,
    openPositionCount: 1,
    pendingIntentCount: 1,
    unknownOrderCount: 1,
    latestReconciliationAt: now,
  },
  accounts,
  strategies: [],
  signalSchemas: [],
  signalContracts: [],
  intents: [{
    id: "intent-1", accountId: "paper-1", channelId: "VIP", symbol: "BTC/USDT", side: "LONG", status: "monitoring",
    signal: { targets: [{ min: "65000" }, { min: "66000" }] }, plan: { leverage: 10, markPrice: "64050", unrealizedPnl: "12.5" },
  }],
  activity: {
    positions: [{ id: "position-1", intentId: "intent-1", accountId: "paper-1", symbol: "BTC/USDT", side: "LONG", status: "open", averageEntryPrice: "64000", stopPrice: "63000", realizedPnl: "4.99" }],
    orders: [
      { id: "tp-1", intentId: "intent-1", role: "take_profit_1", triggerPrice: "65000" },
      { id: "sl-1", intentId: "intent-1", role: "stop_loss", triggerPrice: "63000" },
    ],
    paperMarkets: [{ accountId: "paper-1", symbol: "BTC/USDT", markPrice: "64100" }],
    riskEvents: [{ id: "risk-1", severity: "warning", code: "REMOTE_ORDER_UNRESOLVED", accountId: "bybit-1", createdAt: now, acknowledgedAt: null }],
    reconciliations: [],
  },
  analytics: { generatedAt: now, accounts: [] },
  executionAnalytics: {},
  channelAnalytics: { generatedAt: now, channels: [{ id: "VIP" }], exchanges: [], equity: [] },
  channelRiskEvaluations: [],
  workflowAdaptiveRisk: {
    states: [{ stateKey: "VIP:paper-1", channelId: "VIP", accountId: "paper-1", resourceName: "VIP Risiko", updatedAt: now, blocked: false, currentTier: 5, lockedTier: null }],
    evaluations: [{ id: "evaluation-1", channelId: "VIP", accountId: "paper-1", action: "increase", reason: "positive Serie", closedTrades: 5, realizedPnl: "42", previousTier: 4, appliedTier: 5 }],
  },
  equityHistory: [{ observedAt: now, equity: 10_200 }],
  exchangeStreams: [],
  accountIncidents: [{ id: "incident-1", accountId: "bybit-1", category: "remote_order", severity: "critical", message: "Unverwaltete Börsenorder", status: "open", occurrenceCount: 3, firstSeenAt: now - 1000, lastSeenAt: now, resolvedAt: null, details: {} }],
  fallbackRuns: [{
    id: "fallback-run-1", channelId: "VIP", channelName: "VIP Coinsignals", sourceSignalId: "signal-1", routeGroupKey: "VIP:group-1",
    status: "selected", selectedRank: 1, stopReason: null, createdAt: now, updatedAt: now,
    candidates: [
      { id: "candidate-1", rank: 0, accountId: "bybit-1", accountName: "Bybit Test", exchange: "bybit", mode: "testnet", status: "unavailable", reasonCode: "SYMBOL_UNAVAILABLE", intentId: "intent-primary" },
      { id: "candidate-2", rank: 1, accountId: "paper-1", accountName: "Paper", exchange: "paper", mode: "paper", status: "selected", reasonCode: null, intentId: "intent-1" },
    ],
  }],
} as any

const analytics = {
  generatedAt: now,
  performance: {
    channels: [{ id: "VIP", closedTrades: 4, wins: 3, losses: 1, winRatePercent: 75, realizedPnl: 120, averageEntrySlippageBps: 1.5 }],
    exchanges: [{ id: "paper", intents: 4, completedIntents: 4, averageEntrySlippageBps: 1.5 }],
    equity: [{ observedAt: now - 1000, equity: 10_000, drawdownPercent: 0 }, { observedAt: now, equity: 10_120, drawdownPercent: 1.2 }],
  },
  execution: {
    funnel: { received: 5, submitted: 4, filled: 4 },
    latencyMs: { signalToSubmit: { p95: 850 } },
  },
  fallback: {
    runs: 3, selected: 2, exhausted: 1, stopped: 0, unavailableCandidates: 4,
    averageSelectedRank: 1.5, selectionRatePercent: 66.7,
    byAccount: [{ accountId: "paper-1", exchange: "paper", mode: "paper", attempts: 2, selected: 1, unavailable: 1 }],
  },
}

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }))
}

function bodyFor(url: string) {
  if (url === "/api/trading/portfolio") return { accounts: [{ accountId: "paper-1", name: "Paper", exchange: "paper", mode: "paper", equity: 10_200, availableBalance: 9_000, marginUsed: 1_200, unrealizedPnl: 12.5, reportingCurrency: "USDC" }] }
  if (url === "/api/processed-signals") return { signals: [{ id: "signal-1", channelId: "VIP", createdAt: now, templateName: "Signal", status: "verarbeitet" }] }
  if (url === "/api/access") return { actorId: "tailscale:test", role: "admin", identity: { name: "Remote Admin" }, remoteAccess: { connected: true, provider: "tailscale" } }
  if (url.startsWith("/api/trading/journal?")) return { entries: [{ intentId: "intent-1", symbol: "BTC/USDT", side: "LONG", status: "open", accountName: "Paper", exchange: "paper", strategy: { name: "VIP" }, createdAt: now, position: { realizedPnl: "4.99" }, channelId: "VIP", accountId: "paper-1" }] }
  if (url.startsWith("/api/trading/analytics?")) return analytics
  if (url.startsWith("/api/logs?")) return { entries: [{ cursor: 1, line: "[INFO] executor ready" }, { cursor: 2, line: "[WARN] test warning" }], nextCursor: 2 }
  if (url === "/api/backups") return { backups: ["backup-v3.1.0"] }
  if (url === "/api/mcp") return {
    runtime: { mode: "standby" }, endpoint: "/mcp", permissions: ["trading.read", "trading.write"], eventTypes: ["signal_received", "position_closed"],
    agents: [{ id: "agent-1", name: "Auditor", tokenPrefix: "tsx", permissions: ["trading.read"], eventSubscriptions: ["signal_received"], enabled: true }],
    proposals: [{ id: "proposal-1", status: "pending", action: "trade.preview", agentName: "Auditor", expiresAt: now + 10_000, preflight: { allowed: true, blockers: [] } }],
    sessions: [{ id: "session-1", disconnectedAt: null }], actions: [{ id: "action-1", outcome: "succeeded", toolName: "trading.snapshot", agentName: "Auditor", durationMs: 15, completedAt: now }],
  }
  if (url === "/api/telegram-viewer") return {
    settings: {
      enabled: false, allowedUserIds: ["1001"], timezone: "Europe/Berlin", locale: "de-DE",
      eventPollingIntervalMs: 2000,
      notifications: {
        positionOpened: true, takeProfitFilled: true, stopLossFilled: true, positionClosed: true,
        executionFailed: true, accountIncidentOpened: true, accountIncidentResolved: true,
        exchangeStreamDegraded: true, exchangeStreamRecovered: true, killSwitchActivated: true,
        signalReceived: false, signalValidated: false, intentCreated: false, exchangeAcknowledged: false,
      },
      display: { detailLevel: "normal", pnlMode: "absolute_and_percent", timeFormat: "24h" },
    },
    settingsRecovery: { active: false, reason: null },
    secrets: { botToken: { configured: true, updatedAt: now }, serviceToken: { configured: true, updatedAt: now } },
    service: { healthy: true, ready: true, reachable: true, enabled: false, allowedUsers: 1, lastPollAt: now, lastTest: null },
  }
  if (url === "/api/config") return { apiId: 12345, targetChannel: "", xmlParsing: { primaryModel: "model-a", fallbackModel: "model-b", externalDataPolicyAccepted: true, aiLimits: { requestTimeoutMs: 120_000 } } }
  if (url === "/api/runtime-settings") return { settings: { dashboardAuthMode: "tailscale", dashboardLocalTrust: false, dashboardAllowedOrigin: "https://tsx.test", tailscaleServeTrustedProxy: true, tailscaleAdminUsers: "admin@example.com", tailscaleViewerUsers: "", enterpriseMode: false, auditRemoteRequired: false, backupOffsiteRequired: false, workerCount: 2 } }
  if (url === "/api/secrets") return { secrets: { telegramApiHash: { configured: true }, openRouterApiKey: { configured: true }, auditWebhookToken: { configured: false } } }
  if (url === "/api/recovery") return { active: false, issues: [] }
  if (url === "/api/operations") return { operations: { audit: { healthy: true }, backup: { healthy: true, lastSuccessAt: now }, mcp: { healthy: true } } }
  return { success: true, result: {}, artifact: "backup-v3.1.0", token: "one-time-token" }
}

const headings: Record<OperationTab, string> = {
  overview: "Entscheidende Live-Gates",
  accounts: "Börsenkonten",
  journal: "Trade Journal",
  analytics: "Equity-Verlauf",
  logs: "Live Logs",
  backups: "Verifizierte Backups",
  mcp: "MCP & Agenten",
  "telegram-viewer": "Telegram Viewer",
  system: "Telegram-Routing",
}

function workspace(tab: OperationTab) {
  return render(
    <OperationsWorkspace
      trading={trading}
      catalog={catalog}
      systemStatus={{ connectionState: "connected", isRunning: true, resolvedSources: ["VIP"], queue: { running: 1, queued: 0 }, telegramLogin: { state: "idle" } }}
      onRefresh={vi.fn(async () => undefined)}
      initialTab={tab}
      availableTabs={[tab]}
      title="V3.1 Betrieb"
      description="Stabiler Betrieb"
    />,
  )
}

describe("operations workspace", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.apiFetch.mockImplementation((url: string) => json(bodyFor(url)))
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => undefined) } })
  })

  afterEach(() => cleanup())

  it.each(Object.entries(headings) as Array<[OperationTab, string]>) (
    "renders the data-rich %s workspace",
    async (tab, heading) => {
      workspace(tab)
      expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument()
      if (tab === "overview") await screen.findByText("Remote Admin")
      if (tab === "overview") await screen.findByText("VIP Coinsignals")
      if (tab === "journal") await screen.findByText(/PnL\s+4\.99/)
      if (tab === "analytics") await screen.findByText("75,0 %")
      if (tab === "analytics") await screen.findByText("Fallback-Auswahl je Börsenkonto")
      if (tab === "logs") await screen.findByText(/executor ready/)
      if (tab === "backups") await screen.findByText("backup-v3.1.0")
      if (tab === "mcp") await screen.findByText("Auditor")
      if (tab === "telegram-viewer") await screen.findByText("Bot-Token konfiguriert")
      if (tab === "system") await screen.findByDisplayValue("model-a")
    },
  )

  it("configures the read-only Telegram viewer without disclosing tokens", async () => {
    workspace("telegram-viewer")
    await screen.findByText("Bot-Token konfiguriert")
    fireEvent.click(screen.getByLabelText("Viewer aktiv"))
    fireEvent.change(screen.getByLabelText("Erlaubte Telegram User IDs"), { target: { value: "1001\n2002" } })
    fireEvent.change(screen.getByLabelText("Abfrageintervall (ms)"), { target: { value: "2500" } })
    fireEvent.click(screen.getByRole("button", { name: "Einstellungen speichern" }))
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith(
      "/api/telegram-viewer/settings", expect.objectContaining({ method: "POST" }),
    ))
    fireEvent.change(screen.getByLabelText("Neuer Bot-Token"), { target: { value: "123456789:abcdefghijklmnopqrstuvwxyzABCDE" } })
    fireEvent.click(screen.getByRole("button", { name: "Bot-Token setzen" }))
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith(
      "/api/telegram-viewer/token", expect.objectContaining({ method: "POST" }),
    ))
    expect(screen.queryByText(/123456789:/)).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText("Testnachricht"), { target: { value: "Sicherer Test" } })
    fireEvent.click(screen.getByRole("button", { name: "Test senden" }))
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith(
      "/api/telegram-viewer/test", expect.objectContaining({ method: "POST" }),
    ))
  })

  it("exercises safe account editing and account kill-switch release", async () => {
    workspace("accounts")
    fireEvent.click(screen.getByRole("button", { name: /Konto/ }))
    expect(screen.getByRole("button", { name: "Konto anlegen & verifizieren" })).toBeDisabled()
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Temporary" } })
    fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }))
    expect(screen.queryByDisplayValue("Temporary")).not.toBeInTheDocument()

    fireEvent.change(screen.getAllByLabelText("Positionslimit")[0], { target: { value: "12" } })
    fireEvent.click(screen.getAllByRole("button", { name: "Limit speichern" })[0])
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith("/api/trading/accounts/configuration", expect.objectContaining({ method: "POST" })))

    fireEvent.click(screen.getByRole("button", { name: "Prüfen & freigeben" }))
    fireEvent.change(screen.getByLabelText(/Zur Bestätigung exakt/), { target: { value: "RELEASE ACCOUNT KILL SWITCH" } })
    fireEvent.click(screen.getByRole("button", { name: "Prüfen und freigeben" }))
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith("/api/trading/accounts/kill-switch/release", expect.objectContaining({ method: "POST" })))
  })

  it("filters, copies, pauses and clears the local log view", async () => {
    workspace("logs")
    await screen.findByText(/executor ready/)
    fireEvent.change(screen.getByPlaceholderText("Logs filtern"), { target: { value: "warning" } })
    expect(screen.queryByText(/executor ready/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText("Regex"))
    fireEvent.change(screen.getByPlaceholderText("Logs filtern"), { target: { value: "[" } })
    expect(screen.getByText("Keine passenden Log-Einträge.")).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText("Logs filtern"), { target: { value: "WARN" } })
    fireEvent.click(screen.getByRole("button", { name: "Sichtbare kopieren" }))
    await screen.findByText(/Sichtbare Treffer kopiert/)
    fireEvent.click(screen.getByRole("button", { name: "Pausieren" }))
    expect(screen.getByRole("button", { name: "Fortsetzen" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Ansicht leeren" }))
    expect(screen.getByText(/Serverhistorie bleibt erhalten/)).toBeInTheDocument()
  })

  it("applies journal filters and acknowledges a risk event", async () => {
    workspace("journal")
    await screen.findByText(/PnL\s+4\.99/)
    fireEvent.change(screen.getByPlaceholderText("BTCUSDT"), { target: { value: "eth/usdt" } })
    fireEvent.change(screen.getAllByRole("combobox")[1], { target: { value: "paper-1" } })
    fireEvent.click(screen.getByRole("button", { name: "Quittieren" }))
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith("/api/trading/risk/acknowledge", expect.objectContaining({ method: "POST" })))
  })

  it("recalculates expectancy from the analytics panel", async () => {
    workspace("analytics")
    await screen.findByText("75,0 %")
    fireEvent.change(screen.getByLabelText("Trefferquote %"), { target: { value: "20" } })
    fireEvent.change(screen.getByLabelText("Ø Gewinn (R)"), { target: { value: "1" } })
    fireEvent.change(screen.getByLabelText("Ø Verlust (R)"), { target: { value: "2" } })
    expect(screen.getByText("-1,400 R")).toBeInTheDocument()
  })

  it("loads an existing MCP agent into the editor and persists its policy", async () => {
    workspace("mcp")
    fireEvent.click(await screen.findByRole("button", { name: /Auditor/ }))
    expect(screen.getByRole("heading", { name: "Agent bearbeiten" })).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText("trading.write"))
    fireEvent.click(screen.getByLabelText("position_closed"))
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }))
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith("/api/mcp/agents/update", expect.objectContaining({ method: "POST" })))
  })

  it("renders header and multi-tab navigation", async () => {
    render(
      <OperationsWorkspace
        trading={trading}
        catalog={catalog}
        systemStatus={{ connectionState: "connected", isRunning: true, resolvedSources: ["VIP"], queue: { running: 1, queued: 0 }, telegramLogin: { state: "idle" } }}
        onRefresh={vi.fn(async () => undefined)}
        initialTab="overview"
        availableTabs={["overview", "accounts", "journal"]}
        title="Custom Titel"
        description="Custom Beschreibung"
      />,
    )
    expect(screen.getByText("Custom Titel")).toBeInTheDocument()
    expect(screen.getByText("Custom Beschreibung")).toBeInTheDocument()
    const tabs = screen.getAllByRole("tab")
    expect(tabs).toHaveLength(3)
    fireEvent.click(screen.getByRole("tab", { name: /Börsen/ }))
    expect(await screen.findByRole("heading", { name: "Börsenkonten" })).toBeInTheDocument()
  })

  it("handles default props and single tab without header duplication", async () => {
    render(
      <OperationsWorkspace
        trading={trading}
        catalog={catalog}
        systemStatus={{ connectionState: "connected", isRunning: true, resolvedSources: ["VIP"], queue: { running: 1, queued: 0 }, telegramLogin: { state: "idle" } }}
        onRefresh={vi.fn(async () => undefined)}
      />,
    )
    expect(screen.getByRole("heading", { name: "Entscheidende Live-Gates" })).toBeInTheDocument()
  })

  it("covers system diagnostics and danger zone", async () => {
    const openMock = vi.fn()
    const originalOpen = window.open
    window.open = openMock as any
    workspace("system")
    const diagButton = await screen.findByRole("button", { name: "Diagnosestatus öffnen" })
    fireEvent.click(diagButton)
    expect(openMock).toHaveBeenCalledWith("/api/status", "_blank", "noopener,noreferrer")
    fireEvent.click(screen.getByRole("button", { name: "Audit erneut übertragen" }))
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith("/api/operations/audit-replay", expect.objectContaining({ method: "POST" })))
    const input = screen.getByPlaceholderText("DATENBANK LEEREN oder FACTORY RESET")
    fireEvent.change(input, { target: { value: "DATENBANK LEEREN" } })
    expect(input).toHaveValue("DATENBANK LEEREN")
    fireEvent.click(screen.getByRole("button", { name: "Datenbank leeren" }))
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith("/api/clear-database", expect.objectContaining({ method: "POST" })))
    fireEvent.change(input, { target: { value: "FACTORY RESET" } })
    fireEvent.click(screen.getByRole("button", { name: "Factory Reset" }))
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith("/api/factory-reset", expect.objectContaining({ method: "POST" })))
    window.open = originalOpen
  })

  it("renders degraded system with fallbacks", async () => {
    const degradedCatalog: any = {
      implementation: { library: "", version: "", streaming: "", orderAuthority: "" },
      exchanges: [],
    };
    api.apiFetch.mockImplementation((url: string) => {
      if (url === "/api/operations") return json({ operations: { audit: { healthy: true }, backup: { healthy: false }, mcp: { healthy: true } } });
      return json(bodyFor(url));
    });
    render(
      <OperationsWorkspace
        trading={trading}
        catalog={degradedCatalog}
        systemStatus={{ connectionState: "offline", isRunning: false, resolvedSources: [], queue: { running: 0, queued: 5 }, telegramLogin: { state: "idle" } }}
        onRefresh={vi.fn(async () => undefined)}
        initialTab="system"
        availableTabs={["system"]}
      />,
    );
    expect(await screen.findByText("Exchange Engine")).toBeInTheDocument();
    expect(screen.getByText("ccxt")).toBeInTheDocument();
    expect(screen.getByText("ccxt-pro")).toBeInTheDocument();
    expect(screen.getByText("rest")).toBeInTheDocument();
    expect(await screen.findByText("nicht aktuell – Aktion gesperrt")).toBeInTheDocument();
  })
})
