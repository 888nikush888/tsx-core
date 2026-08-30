import { describe, expect, it } from "vitest";
import {
  accountCapacity,
  formatAccountCapacitySummary,
} from "../src/app/workflow/account-capacity";

describe("account capacity presentation", () => {
  const account = {
    id: "account-a",
    name: "Bybit Main",
    exchange: "bybit",
    mode: "live" as const,
    status: "ready",
    enabled: true,
    maxConcurrentPositions: 3,
    killSwitchActive: false,
    killSwitchReason: null,
    lastReconciledAt: null,
    lastError: null,
  };

  it("counts exactly the backend opening, open, closing and emergency states", () => {
    const positions = [
      { accountId: "account-a", status: "opening" },
      { accountId: "account-a", status: "open" },
      { accountId: "account-a", status: "closing" },
      { accountId: "account-a", status: "emergency" },
      { accountId: "account-a", status: "closed" },
      { accountId: "account-a", status: "pending" },
      { accountId: "account-b", status: "open" },
    ];

    expect(accountCapacity(account, positions)).toEqual({ active: 4, maximum: 3, full: true });
  });

  it("shows available capacity and a distinct full state in account nodes", () => {
    expect(formatAccountCapacitySummary(account, [
      { accountId: "account-a", status: "open" },
      { accountId: "account-a", status: "opening" },
    ])).toBe("bybit · live · 2/3 aktiv");
    expect(formatAccountCapacitySummary(account, [
      { accountId: "account-a", status: "open" },
      { accountId: "account-a", status: "opening" },
      { accountId: "account-a", status: "closing" },
    ])).toBe("bybit · live · 3/3 · VOLL");
  });
});
