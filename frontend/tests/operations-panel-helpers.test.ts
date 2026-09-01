import { describe, expect, it } from "vitest";
import {
  buildEquityChartGroups,
  buildJournalQueryString,
  normalizeJournalSymbol,
  resolveDisplayedLeverage,
} from "@/app/workflow/operations-panel";

describe("buildEquityChartGroups", () => {
  it("never joins account balances that use different reporting currencies", () => {
    const points = [
      { accountId: "hyper", observedAt: 1000, equity: "1153.24" },
      { accountId: "paper", observedAt: 1001, equity: "10000" },
      { accountId: "hyper", observedAt: 2000, equity: "1160.00" },
    ];
    const accounts = [
      { id: "hyper", name: "Hyper Test", exchange: "hyperliquid", mode: "testnet", capabilities: { reportingCurrency: "USDC" } },
      { id: "paper", name: "Paper", exchange: "paper", mode: "paper", capabilities: null },
    ];

    expect(buildEquityChartGroups(points, accounts)).toEqual([
      {
        currency: "QUOTE",
        series: [{ accountId: "paper", dataKey: "account_0", name: "Paper" }],
        points: [{ observedAt: 1001, account_0: 10000 }],
      },
      {
        currency: "USDC",
        series: [{ accountId: "hyper", dataKey: "account_0", name: "Hyper Test" }],
        points: [
          { observedAt: 1000, account_0: 1153.24 },
          { observedAt: 2000, account_0: 1160 },
        ],
      },
    ]);
  });
});

describe("normalizeJournalSymbol", () => {
  it("trims, uppercases and removes slashes", () => {
    expect(normalizeJournalSymbol(" btc/usdt ")).toBe("BTCUSDT");
    expect(normalizeJournalSymbol("BTC/USDT")).toBe("BTCUSDT");
    expect(normalizeJournalSymbol(" btcusdt ")).toBe("BTCUSDT");
  });

  it("handles empty and whitespace only", () => {
    expect(normalizeJournalSymbol("")).toBe("");
    expect(normalizeJournalSymbol("   ")).toBe("");
    expect(normalizeJournalSymbol("/")).toBe("");
    expect(normalizeJournalSymbol(" // ")).toBe("");
  });

  it("preserves already normalized symbols", () => {
    expect(normalizeJournalSymbol("BTCUSDT")).toBe("BTCUSDT");
    expect(normalizeJournalSymbol("ETH/USDT")).toBe("ETHUSDT");
  });

  it("removes all slashes", () => {
    expect(normalizeJournalSymbol("a/b/c")).toBe("ABC");
  });
});

describe("buildJournalQueryString", () => {
  const empty = { from: "", to: "", channelId: "", accountId: "", symbol: "", status: "" };

  it("returns limit only for empty filters", () => {
    expect(buildJournalQueryString(empty)).toBe("limit=500");
  });

  it("adds from and to as timestamps", () => {
    const qs = buildJournalQueryString({ ...empty, from: "2026-01-02", to: "2026-01-03" });
    const params = new URLSearchParams(qs);
    expect(params.get("limit")).toBe("500");
    expect(params.get("from")).toBe(String(new Date("2026-01-02T00:00:00").getTime()));
    expect(params.get("to")).toBe(String(new Date("2026-01-03T23:59:59.999").getTime()));
  });

  it("adds channel and account", () => {
    const qs = buildJournalQueryString({ ...empty, channelId: "ch1", accountId: "acc2" });
    const params = new URLSearchParams(qs);
    expect(params.get("channelId")).toBe("ch1");
    expect(params.get("accountId")).toBe("acc2");
  });

  it("normalizes symbol and skips empty", () => {
    expect(new URLSearchParams(buildJournalQueryString({ ...empty, symbol: "btc/usdt" })).get("symbol")).toBe("BTCUSDT");
    expect(new URLSearchParams(buildJournalQueryString({ ...empty, symbol: "   " })).get("symbol")).toBeNull();
    expect(new URLSearchParams(buildJournalQueryString({ ...empty, symbol: "/" })).get("symbol")).toBeNull();
  });

  it("adds status", () => {
    const qs = buildJournalQueryString({ ...empty, status: "open" });
    expect(new URLSearchParams(qs).get("status")).toBe("open");
  });

  it("combines all filters", () => {
    const qs = buildJournalQueryString({
      from: "2026-01-01",
      to: "2026-01-02",
      channelId: "c1",
      accountId: "a1",
      symbol: "eth/usdt",
      status: "filled",
    });
    const p = new URLSearchParams(qs);
    expect(p.get("from")).toBeDefined();
    expect(p.get("to")).toBeDefined();
    expect(p.get("channelId")).toBe("c1");
    expect(p.get("accountId")).toBe("a1");
    expect(p.get("symbol")).toBe("ETHUSDT");
    expect(p.get("status")).toBe("filled");
  });
});

describe("resolveDisplayedLeverage", () => {
  it("prefers the effective leverage decision for new plans", () => {
    expect(resolveDisplayedLeverage({
      leverage: 50,
      leverageDecision: {
        source: "signal",
        requested: 75,
        strategyDefault: 10,
        strategyMaximum: 50,
        effective: 50,
        capped: true,
      },
    })).toBe(50);
  });

  it("falls back to the legacy leverage field", () => {
    expect(resolveDisplayedLeverage({ leverage: 20 })).toBe(20);
    expect(resolveDisplayedLeverage(null)).toBeNull();
  });
});
