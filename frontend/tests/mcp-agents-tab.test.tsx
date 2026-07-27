import "@testing-library/jest-dom/vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
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

  it("deletes an agent only after confirmation and removes it from the active inventory", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true)
    let deleted = false
    const requests: Array<{ method: string; headers: Headers; body: unknown }> = []
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      if (init.method === "DELETE") {
        requests.push({
          method: init.method,
          headers: new Headers(init.headers),
          body: JSON.parse(String(init.body)),
        })
        deleted = true
        return new Response(JSON.stringify({ deleted: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response(JSON.stringify({
        endpoint: "http://127.0.0.1:8091/mcp",
        permissions: ["system.read"],
        eventTypes: ["signal_received"],
        agents: deleted ? [] : [{
          id: "agent-1",
          name: "Codex Operator",
          tokenPrefix: "tsx_mcp_example",
          permissions: ["system.read"],
          eventSubscriptions: ["signal_received"],
          enabled: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          lastSeenAt: null,
        }],
        sessions: [],
        actions: [],
      }), { status: 200, headers: { "Content-Type": "application/json" } })
    }))

    render(<McpAgentsTab />)
    fireEvent.click(await screen.findByRole("button", { name: /Codex Operator/ }))
    fireEvent.click(screen.getByRole("button", { name: "Agent löschen" }))

    await screen.findByText("Agent gelöscht. Token, Rechte und aktive Sitzungen wurden widerrufen.")
    await waitFor(() => expect(screen.queryByRole("button", { name: /Codex Operator/ })).not.toBeInTheDocument())
    expect(window.confirm).toHaveBeenCalledOnce()
    expect(requests).toHaveLength(1)
    expect(requests[0].body).toEqual({ id: "agent-1" })
    expect(requests[0].headers.get("X-Destructive-Confirmation")).toBe("delete-mcp-agent")
  })
})
