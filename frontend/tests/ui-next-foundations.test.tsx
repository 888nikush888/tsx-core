import "@testing-library/jest-dom/vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, getDashboardToken, mutateAndObserve, onDashboardAuthRequired, setDashboardToken } from "@/lib/api";
import { useVersionedDraft } from "@/shared/forms/use-versioned-draft";
import { usePoll } from "@/shared/api/use-poll";
import { analyticsQuery } from "@/features/risk-analytics/query";
import { portfolioTotal } from '@/features/accounts/portfolio-total';
import { runtimeInputError } from '@/features/operations/runtime-parameters';

describe("UI Next correctness boundaries", () => {
  beforeEach(() => { sessionStorage.clear(); vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('keeps portfolio decimals exact and separates live, testnet and missing account receipts', () => {
    const row = { observedAt: 1000, mode: 'paper', reportingCurrency: 'USDT', equity: '0.000000000000000001' };
    expect(portfolioTotal([row, row], 'equity')).toBe('0,000000000000000002 USDT (paper)');
    expect(portfolioTotal([row, { ...row, mode: 'live' }], 'equity')).toContain('USDT (paper) · 0,000000000000000001 USDT (live)');
    expect(portfolioTotal([row, { ...row, equity: null }], 'equity')).toContain('1 Kontobeleg(e) ungeklärt; keine Gesamtsumme');
    expect(portfolioTotal(undefined, 'equity')).toBe('nicht verfügbar');
  });
  it('rejects empty numeric runtime fields and unfamiliar parameter types', () => {
    const field: any = { path: 'shutdownGraceMs', type: 'number', editable: true, secret: false, range: [1000, 120000] };
    expect(runtimeInputError({ shutdownGraceMs: NaN }, [field])).toContain('ganze Zahl');
    expect(runtimeInputError({ shutdownGraceMs: 120000 }, [field])).toBeNull();
    expect(runtimeInputError({ shutdownGraceMs: 120001 }, [field])).toContain('ganze Zahl');
    expect(runtimeInputError({ shutdownGraceMs: {} }, [{ ...field, type: 'new-contract' }])).toContain('unbekannter');
  });

  it("adopts the one-time token before observing and retains success when observation fails", async () => {
    setDashboardToken("old");
    const operation = vi.fn(async () => ({ token: "new", requestId: "operation-1" }));
    const outcome = await mutateAndObserve(operation, ({ token }) => setDashboardToken(token), async () => {
      expect(getDashboardToken()).toBe("new");
      throw new Error("unavailable");
    });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ result: { token: "new", requestId: "operation-1" }, refreshError: "unavailable" });
  });

  it("does not revoke a new session for a delayed 401 from the old credential", async () => {
    let respond!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValue(new Promise((resolve) => { respond = resolve; }));
    setDashboardToken("old");
    const listener = vi.fn();
    const unsubscribe = onDashboardAuthRequired(listener);
    const reading = apiFetch("/api/status");
    setDashboardToken("new");
    respond(new Response("{}", { status: 401 }));
    await reading;
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("never retries an unknown write outcome", async () => {
    const operation = vi.fn(async () => { throw new TypeError("transport lost"); });
    const accepted = vi.fn();
    const observe = vi.fn();
    await expect(mutateAndObserve(operation, accepted, observe)).rejects.toThrow("transport lost");
    expect(operation).toHaveBeenCalledTimes(1);
    expect(accepted).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });

  it("preserves dirty permission drafts and exposes a server revision conflict", () => {
    const initial = { name: "Agent", permissions: ["system.read"], enabled: true };
    const { result, rerender } = renderHook(({ server, revision }) => useVersionedDraft("agent-1", server, revision, initial), { initialProps: { server: initial, revision: 1 } });
    act(() => result.current.setDraft({ ...initial, name: "Unsaved", enabled: false }));
    rerender({ server: { ...initial }, revision: 1 });
    expect(result.current.draft.name).toBe("Unsaved");
    expect(result.current.dirty).toBe(true);
    rerender({ server: { ...initial, permissions: ["journal.read"] }, revision: 2 });
    expect(result.current.conflict).toBe(true);
    expect(result.current.baseRevision).toBe(1);
    act(() => result.current.rebase());
    expect(result.current.conflict).toBe(false);
    expect(result.current.baseRevision).toBe(2);
    expect(result.current.draft.enabled).toBe(false);
    act(() => result.current.acceptServer());
    expect(result.current.draft.permissions).toEqual(["journal.read"]);
    expect(result.current.dirty).toBe(false);
  });

  it("recomputes relative windows while fixed historical windows remain fixed", () => {
    const filters = { range: "30d" as const, customFrom: "", customUntil: "", channelId: "", accountId: "", exchange: "", mode: "", status: "" };
    const now = Date.UTC(2026, 8, 5);
    const first = new URLSearchParams(analyticsQuery(filters, now));
    const next = new URLSearchParams(analyticsQuery(filters, now + 5000));
    expect(Number(next.get("until")) - Number(first.get("until"))).toBe(5000);
    expect(Number(next.get("since")) - Number(first.get("since"))).toBe(5000);
    const fixed = { ...filters, range: "custom" as const, customFrom: "2026-08-01T00:00:00Z", customUntil: "2026-08-31T23:59:59Z" };
    expect(analyticsQuery(fixed, now)).toBe(analyticsQuery(fixed, now + 5000));
  });

  it("cancels obsolete reads and ignores their late answers", async () => {
    let resolveOld!: (value: string) => void;
    let signalOld!: AbortSignal;
    const readOld = (signal: AbortSignal) => { signalOld = signal; return new Promise<string>((resolve) => { resolveOld = resolve; }); };
    const accept = vi.fn();
    const reject = vi.fn();
    const { rerender } = renderHook(({ read }) => usePoll(read, accept, reject), { initialProps: { read: readOld } });
    rerender({ read: async () => "current" });
    await act(async () => { resolveOld("obsolete"); });
    expect(signalOld.aborted).toBe(true);
    expect(accept.mock.calls).toEqual([["current"]]);
  });
});
