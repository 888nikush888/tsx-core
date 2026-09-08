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

  it.each(["https://outside.invalid/api", "//outside.invalid/api", "javascript:alert(1)", "data:text/plain,fixture"])(
    "rejects a non-dashboard destination before sending any token: %s", async (destination) => {
      setDashboardToken("dashboard-fixture-token");
      await expect(apiFetch(destination)).rejects.toThrow("restricted to this dashboard");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects external URL and Request objects and embedded credentials", async () => {
    const credentials = new URL("/api/x", window.location.origin);
    credentials.username = "fixture-user";
    for (const input of [new URL("https://outside.invalid/api"), new Request("https://outside.invalid/api"), credentials]) {
      await expect(apiFetch(input)).rejects.toThrow("restricted to this dashboard");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("checks the browser's real document base before adding credentials", async () => {
    const base = document.createElement("base");
    base.href = "https://outside.invalid/";
    document.head.prepend(base);
    try {
      await expect(apiFetch("/api/x")).rejects.toThrow("restricted to this dashboard");
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      base.remove();
    }
  });

  it("preserves a same-origin Request body and headers and recognizes its write method", async () => {
    setDashboardToken("dashboard-fixture-token");
    const input = new Request(new URL("/api/x", window.location.origin), {
      method: "POST", body: "payload", headers: { "Content-Type": "text/plain", "X-Fixture": "retained" },
    });
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(new Response("{}"));
    await apiFetch(input, { redirect: "follow" });
    const [request, options] = fetchMock.mock.calls[0];
    expect(request).toBe(input);
    expect(await input.text()).toBe("payload");
    const headers = new Headers(options?.headers);
    expect(headers.get("X-Fixture")).toBe("retained");
    expect(headers.get("Content-Type")).toBe("text/plain");
    expect(headers.get("Authorization")).toBe("Bearer dashboard-fixture-token");
    expect(headers.get("X-Requested-With")).toBe("forwarder-dashboard");
    expect(options?.redirect).toBe("error");
  });

  it("keeps same-origin URL inputs and respects an explicit method override", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(new Response("{}"));
    const url = new URL("/api/x?next=https://outside.invalid", window.location.origin);
    await apiFetch(url);
    expect(fetchMock.mock.calls[0][0]).toBe(url);
    const request = new Request(url, { method: "POST" });
    await apiFetch(request, { method: "GET" });
    const headers = new Headers(fetchMock.mock.calls[1][1]?.headers);
    expect(headers.get("X-Requested-With")).toBeNull();
  });
});
