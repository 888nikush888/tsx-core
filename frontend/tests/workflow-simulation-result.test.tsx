import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowSimulationResult } from "../src/app/workflow/workflow-simulation-result";

afterEach(cleanup);

describe("workflow fallback simulation", () => {
  it("shows executor errors and channels without a complete route", () => {
    const { rerender } = render(<WorkflowSimulationResult result={{ error: "Simulation fehlgeschlagen" }} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Simulation fehlgeschlagen");

    rerender(<WorkflowSimulationResult result={{ paths: [] }} />);
    expect(screen.getByText(/kein vollständiger Pfad/i)).toBeVisible();
  });

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

  it("keeps independent routes separate and explains disabled or rejected accounts", () => {
    render(<WorkflowSimulationResult result={{
      active: false,
      paths: [
        {
          id: "route-a",
          accountId: "Bybit Main",
          enabled: false,
          allowed: true,
        },
        {
          id: "route-b",
          accountId: "Kraken Futures",
          enabled: true,
          allowed: false,
          reason: "Risikoprüfung fehlgeschlagen",
        },
      ],
    }} />);

    expect(screen.getAllByText("Bybit Main")).toHaveLength(2);
    expect(screen.getAllByText("Kraken Futures")).toHaveLength(2);
    expect(screen.getAllByText("BLOCK")).toHaveLength(2);
    expect(screen.getByText("Konto nicht bereit")).toBeVisible();
    expect(screen.getByText("Risikoprüfung fehlgeschlagen")).toBeVisible();
    expect(screen.queryByText(/A→B:/)).not.toBeInTheDocument();
  });
});
