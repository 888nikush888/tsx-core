import { describe, expect, it } from "vitest";
import {
  buildDashboardCockpit,
  buildOperationsCockpit,
  resolveStatusbarCopy,
  selectCockpitItems,
} from "@/app/workflow/workflow-builder";

describe("workflow statusbar helpers", () => {
  it("resolves known workspace copies", () => {
    expect(resolveStatusbarCopy("dashboard")?.title).toBe("Dashboard");
    expect(resolveStatusbarCopy("operations")?.title).toBe("Betrieb");
    expect(resolveStatusbarCopy("analytics")).toBeNull();
    expect(resolveStatusbarCopy("unknown")).toBeNull();
  });

  it("builds dashboard cockpit with healthy states", () => {
    const runtime: any = { executionEnabled: true, killSwitchActive: false };
    const systemStatus: any = { connectionState: "connected" };
    const items = buildDashboardCockpit(runtime, systemStatus, []);
    expect(items).toHaveLength(3);
    expect(items[0].healthy).toBe(true);
    expect(items[1].healthy).toBe(true);
    expect(items[2].value).toBe("bereit");
    expect(items[2].healthy).toBe(true);
  });

  it("builds dashboard cockpit with degraded and incident states", () => {
    const runtime: any = { executionEnabled: false, killSwitchActive: true, killSwitchReason: "manual" };
    const systemStatus: any = { connectionState: "offline" };
    const openIncidents: any = [
      { id: "1", status: "open" },
      { id: "2", status: "open" },
    ];
    const items = buildDashboardCockpit(runtime, systemStatus, openIncidents);
    expect(items[0].healthy).toBe(false);
    expect(items[0].value).toBe("offline");
    expect(items[1].value).toBe("pausiert");
    expect(items[1].healthy).toBe(false);
    expect(items[2].value).toBe("manual");
    expect(items[2].healthy).toBe(false);
  });

  it("falls back to incident count when killSwitchReason missing", () => {
    const runtime: any = { killSwitchActive: true };
    const items = buildDashboardCockpit(runtime, {}, [{ id: "1", status: "open" } as any]);
    expect(items[2].value).toBe("global gesperrt");
    const runtime2: any = { killSwitchActive: false };
    const items2 = buildDashboardCockpit(runtime2, {}, [{ id: "1", status: "open" } as any, { id: "2", status: "open" } as any]);
    expect(items2[2].value).toBe("2 Incident(s)");
    expect(items2[2].healthy).toBe(false);
  });

  it("builds operations cockpit", () => {
    const systemStatus: any = {
      state: "ok",
      operations: { backup: { lastSuccessAt: Date.now(), healthy: true } },
      mcp: { mode: "active" },
    };
    const items = buildOperationsCockpit(systemStatus, []);
    expect(items[0].healthy).toBe(true);
    expect(items[1].healthy).toBe(true);
    expect(items[2].healthy).toBe(true);
    expect(items[3].healthy).toBe(true);
  });

  it("builds operations cockpit with missing backup and inactive mcp", () => {
    const systemStatus: any = { error: "boom", operations: {}, mcp: { mode: "inaktiv" } };
    const items = buildOperationsCockpit(systemStatus, [{ id: "1", status: "open" } as any]);
    expect(items[0].healthy).toBe(false);
    expect(items[0].value).toBe("erreichbar");
    expect(items[1].value).toBe("Status in Backups");
    expect(items[1].healthy).toBe(false);
    expect(items[2].healthy).toBe(false);
    expect(items[3].healthy).toBe(false);
  });

  it("selects cockpit items by workspace", () => {
    const dash = [{ label: "a", value: "1", healthy: true }];
    const ops = [{ label: "b", value: "2", healthy: true }];
    expect(selectCockpitItems("dashboard", dash as any, ops as any)).toBe(dash);
    expect(selectCockpitItems("operations", dash as any, ops as any)).toBe(ops);
    expect(selectCockpitItems("analytics", dash as any, ops as any)).toEqual([]);
    expect(selectCockpitItems("builder", dash as any, ops as any)).toEqual([]);
  });
});
