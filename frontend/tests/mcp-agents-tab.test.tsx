import "@testing-library/jest-dom/vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { McpAgentsTab } from "@/app/dashboard/components/mcp-agents-tab"

describe("McpAgentsTab", () => {
  beforeEach(() => {
    sessionStorage.clear()
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      endpoint: "http://127.0.0.1:8091/mcp",
      permissions: ["system.read", "contracts.write", "trading.flatten"],
      eventTypes: ["signal_received", "position_closed"],
      agents: [{
        id: "agent-1",
        name: "Codex Operator",
        tokenPrefix: "tsx_mcp_example",
        permissions: ["system.read"],
        eventSubscriptions: ["signal_received"],
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastSeenAt: Date.now(),
      }],
      sessions: [{
        id: "session-1",
        agentId: "agent-1",
        clientName: "Codex",
        clientVersion: "1.0",
        connectedAt: Date.now(),
        lastSeenAt: Date.now(),
        disconnectedAt: null,
      }],
      actions: [{
        id: "action-1",
        agentId: "agent-1",
        agentName: "Codex Operator",
        toolName: "tsx_system_status",
        permission: "system.read",
        outcome: "succeeded",
        error: null,
        completedAt: Date.now(),
        durationMs: 12,
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })))
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("shows endpoint, permanent permissions, sessions and action history", async () => {
    render(<McpAgentsTab />)
    expect(await screen.findByText("http://127.0.0.1:8091/mcp")).toBeInTheDocument()
    expect(screen.getAllByText("Codex Operator").length).toBeGreaterThan(0)
    expect(screen.getByText("Systemstatus lesen")).toBeInTheDocument()
    expect(screen.getByText("Codex")).toBeInTheDocument()
    expect(screen.getByText("tsx_system_status")).toBeInTheDocument()
  })
})
