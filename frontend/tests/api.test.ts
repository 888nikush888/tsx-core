import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, clearDashboardToken, getDashboardToken, jsonRequest, onDashboardAuthRequired, setDashboardToken } from "@/lib/api";

describe("api helpers", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it("manages dashboard token", () => {
    expect(getDashboardToken()).toBe("");
    setDashboardToken("  secret  ");
    expect(getDashboardToken()).toBe("secret");
    clearDashboardToken();
    expect(getDashboardToken()).toBe("");
  });

  it("apiFetch adds auth and requested-with headers", async () => {
    setDashboardToken("tok");
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    await apiFetch("/api/x", { method: "POST" });
    const headers = fetchMock.mock.calls[0][1]?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer tok");
    expect(headers.get("X-Requested-With")).toBe("forwarder-dashboard");
  });

  it("apiFetch skips auth when no token and skips header for GET", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await apiFetch("/api/x");
    const headers = fetchMock.mock.calls[0][1]?.headers as Headers;
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("X-Requested-With")).toBeNull();
  });

  it("apiFetch dispatches auth-required on 401", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(new Response("{}", { status: 401 }));
    const listener = vi.fn();
    const off = onDashboardAuthRequired(listener);
    await apiFetch("/api/x");
    expect(listener).toHaveBeenCalled();
    off();
  });

  it("jsonRequest returns payload on ok", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { "content-type": "application/json" } }));
    const payload = await jsonRequest("/api/x");
    expect(payload).toEqual({ ok: 1 });
  });

  it("jsonRequest throws with payload error message", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "boom" }), { status: 400, headers: { "content-type": "application/json" } }),
    );
    await expect(jsonRequest("/api/x")).rejects.toThrow("boom");
  });

  it("jsonRequest throws fallback message when error missing", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({}), { status: 500 }));
    await expect(jsonRequest("/api/x")).rejects.toThrow("Anfrage fehlgeschlagen (500).");
  });

  it("jsonRequest handles non-json payload", async () => {
    const fetchMock = vi.mocked(fetch);
    // response.json will reject, catch returns {}
    fetchMock.mockResolvedValue(
      {
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError("bad json")),
      } as unknown as Response,
    );
    const payload = await jsonRequest("/api/x");
    expect(payload).toEqual({});
  });
});
