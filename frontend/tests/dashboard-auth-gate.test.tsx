import "@testing-library/jest-dom/vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  clearDashboardToken: vi.fn(),
  getDashboardToken: vi.fn(() => ""),
  onDashboardAuthRequired: vi.fn(() => () => undefined),
  setDashboardToken: vi.fn(),
}))

vi.mock("@/lib/api", () => api)

import { DashboardAuthGate } from "@/components/dashboard-auth-gate"

describe("dashboard authentication gate", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.getDashboardToken.mockReturnValue("")
  })

  afterEach(() => cleanup())

  it("accepts an authenticated reverse-proxy identity without asking for a bearer token", async () => {
    api.apiFetch.mockImplementation(async (path: string) => {
      if (path === "/api/bootstrap/status") {
        return new Response(JSON.stringify({
          required: false,
          available: false,
          localSessionAvailable: false,
        }), { status: 200, headers: { "Content-Type": "application/json" } })
      }
      if (path === "/api/status") {
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      throw new Error(`Unexpected request: ${path}`)
    })

    render(<DashboardAuthGate><div>Authenticated dashboard</div></DashboardAuthGate>)

    await waitFor(() => expect(screen.getByText("Authenticated dashboard")).toBeInTheDocument())
    expect(screen.queryByLabelText("Bearer token")).not.toBeInTheDocument()
    expect(api.apiFetch).toHaveBeenCalledWith("/api/status")
  })
})
