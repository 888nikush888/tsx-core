import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { exchangeAssessmentLabel, groupExchangeCatalog } from "@/app/workflow/exchange-catalog";
import type { ExchangeCatalog } from "@/app/workflow/types";
import { Accounts } from "@/features/accounts/accounts";

afterEach(cleanup);

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
    } as unknown as ExchangeCatalog);
    expect(grouped.certified.map((item) => item.id)).toEqual(["bybit"]);
    expect(grouped.candidates.map((item) => item.id)).toEqual(["okx", "binance"]);
    expect(grouped.others.map((item) => item.id)).toEqual(["restonly", "legacy", "drifted"]);
  });

  it("only exposes certified entries for account creation", () => {
    const grouped = groupExchangeCatalog({
      implementation: { library: "ccxt", version: "4.5.75", streaming: "ccxt-pro", orderAuthority: "rest" },
      exchanges: [entry("paper", "certified"), entry("okx", "candidate")],
    } as unknown as ExchangeCatalog);
    expect(grouped.creatable.map((item) => item.id)).toEqual(["paper"]);
  });

  it("explains pinned product scope and block reasons without changing creatable entries", () => {
    const blocked = {
      ...entry("okx", "discovered"),
      assessment: {
        decision: "not_easy", products: ["swap:linear", "future:inverse"],
        reasonCodes: ["optional_child_lifecycle_not_representable"],
      },
    } as unknown as ExchangeCatalog["exchanges"][number];
    expect(exchangeAssessmentLabel(blocked)).toEqual({
      product: "CCXT-SDK-Inventur, keine TSX-Handelsfreigabe: Swap (linear) · Future (invers)",
      decision: "Für TSX Core derzeit nicht freigabereif",
      reasons: "optional_child_lifecycle_not_representable",
    });
    const noDerivatives = {
      ...blocked,
      assessment: {
        decision: "not_derivative" as const, products: [],
        reasonCodes: ["pinned_sdk_explicitly_declares_no_derivatives"],
      },
    };
    expect(exchangeAssessmentLabel(noDerivatives).product).toBe("Keine Derivate laut gepinnter CCXT-Inventur");
    const hyperliquid = {
      ...blocked,
      id: "hyperliquid",
      assessment: {
        decision: "existing" as const,
        products: ["swap:inverse", "swap:linear"],
        reasonCodes: ["master_key_only_scope_locally_reviewed", "bound_parity_and_execution_receipt_required"],
      },
    };
    const hyperliquidLabel = exchangeAssessmentLabel(hyperliquid);
    expect(hyperliquidLabel.product).toContain("CCXT-SDK-Inventur, keine TSX-Handelsfreigabe");
    expect(hyperliquidLabel.product).toContain("Swap (invers)");
    expect(hyperliquidLabel.decision).toContain("nur first-DEX/USDC/linear/Perp");
    expect(hyperliquidLabel.decision).toContain("Provider-, Konto- und Release-Nachweise offen");
    expect(groupExchangeCatalog({
      implementation: { library: "ccxt", version: "4.5.75", reviewedInventoryHash: "a".repeat(64), streaming: "ccxt-pro", orderAuthority: "rest" },
      exchanges: [blocked],
    }).creatable).toEqual([]);
  });

  it("renders the assessment beside the catalog state without enabling an unreviewed account", () => {
    const catalog = {
      implementation: { library: "ccxt", version: "4.5.75", reviewedInventoryHash: "a".repeat(64), streaming: "ccxt-pro", orderAuthority: "rest" },
      exchanges: [{
        ...entry("okx", "discovered"),
        assessment: {
          decision: "not_easy", products: ["swap:linear"],
          reasonCodes: ["optional_child_lifecycle_not_representable"],
        },
      }],
    } as ExchangeCatalog;
    render(createElement(Accounts, { trading: null, catalog, onRefresh: () => undefined }));
    expect(screen.getByText("CCXT-SDK-Inventur, keine TSX-Handelsfreigabe: Swap (linear) · Für TSX Core derzeit nicht freigabereif")).toBeDefined();
    expect(screen.getByText("Prüf-/Blockgründe: optional_child_lifecycle_not_representable")).toBeDefined();
    expect(screen.getByRole("button", { name: "Konto" }).hasAttribute("disabled")).toBe(true);
  });
});
