import "@testing-library/jest-dom/vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { normalizeSignalWorkspace, SignalCenterTab, type SignalWorkspace } from "@/app/dashboard/components/signal-center-tab"

const config = {
  apiId: 123,
  sourceChannels: ["-1001", "-1002"],
  targetChannel: "-2001",
  forwardOptions: { forwardToTarget: true, maxConcurrency: 2, queueTimeoutSeconds: 60 },
  dupeBlocker: { enabled: true, cooldownHours: 24 },
  filters: { blockedKeywords: ["spam"], allowedTypes: ["text"], regexPatterns: ["LONG|SHORT"] },
  xmlParsing: { enabled: true },
}

function renderCenter(workspace: SignalWorkspace, overrides: Record<string, unknown> = {}) {
  const props = {
    config,
    setConfig: vi.fn(),
    secretStatus: {
      telegramApiHash: { configured: true, editable: true, source: "managed" },
      openRouterApiKey: { configured: true, editable: true, source: "managed" },
    },
    secretDraft: { telegramApiHash: "", openRouterApiKey: "" },
    setSecretDraft: vi.fn(),
    telegramLogin: { state: "completed" },
    setTelegramLogin: vi.fn(),
    workspace,
    onWorkspaceChange: vi.fn(),
    onSave: vi.fn(async () => undefined),
    isSaving: false,
    ...overrides,
  }
  render(<SignalCenterTab {...props} />)
  return props
}

describe("Signal Control Center", () => {
  afterEach(() => cleanup())

  it("organizes all signal and message functions as internal workspaces", () => {
    const props = renderCenter("overview")
    for (const label of ["Betrieb", "Nachrichten", "Signale", "Kanäle", "Verarbeitung", "Filter", "KI-Parser"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument()
    }
    fireEvent.click(screen.getByRole("button", { name: "Nachrichten" }))
    expect(props.onWorkspaceChange).toHaveBeenCalledWith("messages")
    expect(normalizeSignalWorkspace("invalid")).toBe("overview")
  })

  it("keeps configuration saving inside configurable workspaces", () => {
    const onSave = vi.fn(async () => undefined)
    renderCenter("processing", { onSave })
    fireEvent.click(screen.getByRole("button", { name: "Konfiguration speichern" }))
    expect(onSave).toHaveBeenCalledOnce()
  })
})
