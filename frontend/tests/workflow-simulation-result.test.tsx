import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowSimulationResult } from "../src/app/workflow/workflow-simulation-result";

afterEach(cleanup);

describe("workflow fallback simulation", () => {
  it("shows the ordered account chain and each transition policy without mutating an exchange", () => {
    render(<WorkflowSimulationResult result={{
      active: true,
      paths: [
        {
          id: "path-a",
          accountId: "Bybit Main",
          routeGroupKey: "route-1",
          fallbackRank: 0,
          fallbackOn: ["SYMBOL_UNAVAILABLE", "MAX_CONCURRENT_POSITIONS", "SYMBOL_ALREADY_OWNED"],
          enabled: true,
          allowed: true,
        },
        {
          id: "path-b",
          accountId: "Hyperliquid Main",
          routeGroupKey: "route-1",
          fallbackRank: 1,
          fallbackOn: ["SYMBOL_UNAVAILABLE"],
          enabled: true,
          allowed: true,
        },
        {
          id: "path-c",
          accountId: "Kraken Futures",
          routeGroupKey: "route-1",
          fallbackRank: 2,
          fallbackOn: [],
          enabled: true,
          allowed: true,
        },
      ],
    }} />);

    expect(screen.getByText("Bybit Main → Hyperliquid Main → Kraken Futures")).toBeVisible();
    expect(screen.getByText("A→B: Paar · Voll · Belegt")).toBeVisible();
    expect(screen.getByText("B→C: Paar")).toBeVisible();
    expect(screen.getByText(/reine Vorschau/i)).toBeVisible();
  });
});
