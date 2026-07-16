import "@testing-library/jest-dom/vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SystemTab } from "@/app/dashboard/components/system-tab"

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

describe("SystemTab enterprise control plane", () => {
  const requests: Array<{ url: string; init: RequestInit }> = []

  beforeEach(() => {
    requests.length = 0
    sessionStorage.clear()
    vi.restoreAllMocks()
    vi.spyOn(window, "prompt").mockReturnValue("RECOVER")
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      requests.push({ url, init })
      if (url.endsWith("/api/operations")) return response({ operations: { backup: { healthy: true } } })
      if (url.endsWith("/api/runtime-settings")) return response({ settings: { enterpriseMode: false } })
      if (url.endsWith("/api/backups")) return response({ backups: ["backup-2026-local"] })
      if (url.endsWith("/api/access-tokens")) return response({ role: "viewer", token: "v".repeat(64) }, 201)
      if (url.endsWith("/api/secrets")) return response({ secrets: {} })
      if (url.endsWith("/api/backups/recover-offsite")) {
        return response({ artifactName: "backup-2026-recovered" }, 201)
      }
      return response({})
    }))
  })

  afterEach(() => cleanup())

  it("generates a viewer bearer key and shows it exactly in the active session", async () => {
    render(<SystemTab config={{}} secretStatus={{}} onSecretStatusChange={vi.fn()} />)
    fireEvent.click(await screen.findByRole("button", { name: "Neuen Viewer-Key erzeugen" }))
    expect(await screen.findByText("v".repeat(64))).toBeInTheDocument()
    const request = requests.find(({ url }) => url.endsWith("/api/access-tokens"))
    expect(request?.init.method).toBe("POST")
    expect(JSON.parse(String(request?.init.body))).toEqual({ role: "viewer" })
  })

  it("recovers a named encrypted off-site object through the guarded web endpoint", async () => {
    render(<SystemTab config={{}} secretStatus={{}} onSecretStatusChange={vi.fn()} />)
    const input = await screen.findByPlaceholderText(/backup-2026-.*tgfb/)
    fireEvent.change(input, { target: { value: "backup-2026-remote.tgfb" } })
    fireEvent.click(screen.getByRole("button", { name: "Off-site-Backup abrufen" }))
    await screen.findByText(/backup-2026-recovered/)
    const request = requests.find(({ url }) => url.endsWith("/api/backups/recover-offsite"))
    expect(new Headers(request?.init.headers).get("X-Destructive-Confirmation")).toBe("recover-offsite-backup")
    expect(JSON.parse(String(request?.init.body))).toEqual({ objectName: "backup-2026-remote.tgfb" })
  })

  it("keeps an existing backup encryption key immutable in the UI", async () => {
    render(<SystemTab
      config={{}}
      secretStatus={{ backupEncryptionKey: { configured: true, editable: false } }}
      onSecretStatusChange={vi.fn()}
    />)
    const input = await screen.findByLabelText(/backupEncryptionKey/)
    expect(input).toBeDisabled()
    await waitFor(() => expect(screen.getByText(/Eine Rotation würde bestehende Off-site-Backups unlesbar machen/)).toBeInTheDocument())
  })
})
