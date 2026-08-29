import { describe, expect, it } from "vitest";
import { groupExchangeCatalog } from "@/app/workflow/exchange-catalog";

const entry = (id: string, status: string) => ({
  id,
  name: id.toUpperCase(),
  status,
  reason: status === "ineligible" ? "Fehlende private Streams" : null,
  provider: "ccxt",
  ccxt: { rest: true, pro: status !== "ineligible" },
  markets: { linearSwap: status === "candidate" ? true : null },
  credentialFields: [],
  modes: status === "certified" ? ["testnet", "live"] : [],
  capabilities: {},
});

describe("groupExchangeCatalog", () => {
  it("separates certified, candidates and every other status", () => {
    const grouped = groupExchangeCatalog({
      implementation: { library: "ccxt", version: "4.5.75", streaming: "ccxt-pro", orderAuthority: "rest" },
      exchanges: [
        entry("bybit", "certified"),
        entry("okx", "candidate"),
        entry("binance", "discovered"),
        entry("restonly", "ineligible"),
        entry("legacy", "deprecated"),
        entry("drifted", "quarantined"),
      ],
    } as any);
    expect(grouped.certified.map((item) => item.id)).toEqual(["bybit"]);
    expect(grouped.candidates.map((item) => item.id)).toEqual(["okx", "binance"]);
    expect(grouped.others.map((item) => item.id)).toEqual(["restonly", "legacy", "drifted"]);
  });

  it("only exposes certified entries for account creation", () => {
    const grouped = groupExchangeCatalog({
      implementation: { library: "ccxt", version: "4.5.75", streaming: "ccxt-pro", orderAuthority: "rest" },
      exchanges: [entry("paper", "certified"), entry("okx", "candidate")],
    } as any);
    expect(grouped.creatable.map((item) => item.id)).toEqual(["paper"]);
  });
});
