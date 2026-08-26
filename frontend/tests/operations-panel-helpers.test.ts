import { describe, expect, it } from "vitest";
import { normalizeJournalSymbol } from "@/app/workflow/operations-panel";

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
