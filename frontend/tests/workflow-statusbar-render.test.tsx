import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceStatusbar } from "@/app/workflow/workflow-builder";

afterEach(cleanup);

const baseTrading: any = {
  overview: { runtime: { executionEnabled: true, killSwitchActive: false } },
  accountIncidents: [],
};
const baseSystem: any = {
  connectionState: "connected",
  state: "ok",
  operations: { backup: { lastSuccessAt: Date.now(), healthy: true } },
  mcp: { mode: "active" },
};

describe("WorkspaceStatusbar rendering", () => {
  it("renders dashboard cockpit", () => {
    render(
      <WorkspaceStatusbar workspace="dashboard" onRefresh={vi.fn(async () => undefined)} trading={baseTrading} systemStatus={baseSystem} refreshing={false} lastUpdated={Date.now()} />,
    );
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    expect(screen.getByText("Telegram")).toBeInTheDocument();
    expect(screen.getByText("Execution")).toBeInTheDocument();
  });

  it("renders operations cockpit", () => {
    render(
      <WorkspaceStatusbar workspace="operations" onRefresh={vi.fn(async () => undefined)} trading={baseTrading} systemStatus={baseSystem} refreshing={false} lastUpdated={null} />,
    );
    expect(screen.getByText("Betrieb")).toBeInTheDocument();
    expect(screen.getByText("System")).toBeInTheDocument();
    expect(screen.getByText("MCP")).toBeInTheDocument();
  });

  it("renders analytics fallback and triggers refresh", async () => {
    const onRefresh = vi.fn(async () => undefined);
    const { container } = render(
      <WorkspaceStatusbar workspace="analytics" onRefresh={onRefresh} trading={null} systemStatus={null} refreshing={true} lastUpdated={null} />,
    );
    expect(container.textContent).toContain("Analytics");
    expect(container.textContent).toContain("noch nicht aktualisiert");
    fireEvent.click(screen.getByRole("button", { name: "Aktualisieren" }));
    expect(onRefresh).toHaveBeenCalled();
  });

  it("shows lastUpdated timestamp", () => {
    const ts = Date.now() - 1000;
    const { container } = render(
      <WorkspaceStatusbar workspace="dashboard" onRefresh={vi.fn(async () => undefined)} trading={baseTrading} systemStatus={baseSystem} refreshing={false} lastUpdated={ts} />,
    );
    expect(container.textContent).toMatch(/zuletzt aktualisiert/);
  });
});
