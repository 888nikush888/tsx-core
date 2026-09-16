import { describe, expect, it } from "vitest";
import {
  buildDashboardCockpit,
  buildOperationsCockpit,
  resolveStatusbarCopy,
  selectCockpitItems,
} from "@/app/workflow/workflow-builder";

type DashboardRuntime = NonNullable<Parameters<typeof buildDashboardCockpit>[0]>;
type IncidentFixtures = Parameters<typeof buildDashboardCockpit>[2];

describe("workflow statusbar helpers", () => {
  it("resolves known workspace copies", () => {
    expect(resolveStatusbarCopy("dashboard")?.title).toBe("Dashboard");
    expect(resolveStatusbarCopy("operations")?.title).toBe("Betrieb");
    expect(resolveStatusbarCopy("analytics")).toBeNull();
    expect(resolveStatusbarCopy("unknown")).toBeNull();
  });

  it("builds dashboard cockpit with healthy states", () => {
    const runtime = { executionEnabled: true, killSwitchActive: false } as DashboardRuntime;
    const systemStatus = { connectionState: "connected" };
    const items = buildDashboardCockpit(runtime, systemStatus, []);
    expect(items).toHaveLength(3);
    expect(items[0].healthy).toBe(true);
    expect(items[1].healthy).toBe(true);
    expect(items[2].value).toBe("bereit");
    expect(items[2].healthy).toBe(true);
  });

  it("builds dashboard cockpit with degraded and incident states", () => {
    const runtime = { executionEnabled: false, killSwitchActive: true, killSwitchReason: "manual" } as DashboardRuntime;
    const systemStatus = { connectionState: "offline" };
    const openIncidents = [
      { id: "1", status: "open" },
      { id: "2", status: "open" },
    ] as IncidentFixtures;
    const items = buildDashboardCockpit(runtime, systemStatus, openIncidents);
    expect(items[0].healthy).toBe(false);
    expect(items[0].value).toBe("offline");
    expect(items[1].value).toBe("pausiert");
    expect(items[1].healthy).toBe(false);
    expect(items[2].value).toBe("manual");
    expect(items[2].healthy).toBe(false);
  });

  it("falls back to incident count when killSwitchReason missing", () => {
    const runtime = { killSwitchActive: true } as DashboardRuntime;
    const items = buildDashboardCockpit(runtime, {}, [{ id: "1", status: "open" }] as IncidentFixtures);
    expect(items[2].value).toBe("global gesperrt");
    const runtime2 = { killSwitchActive: false } as DashboardRuntime;
    const items2 = buildDashboardCockpit(runtime2, {}, [{ id: "1", status: "open" }, { id: "2", status: "open" }] as IncidentFixtures);
    expect(items2[2].value).toBe("2 Incident(s)");
    expect(items2[2].healthy).toBe(false);
  });

  it("builds operations cockpit", () => {
    const systemStatus = {
      state: "ok",
      operations: { backup: { integrityVerified: { verifiedAt: Date.now() }, healthy: true } },
      mcp: { mode: "active" },
    };
    const items = buildOperationsCockpit(systemStatus, []);
    expect(items[0].healthy).toBe(true);
    expect(items[1].healthy).toBe(true);
    expect(items[1].label).toBe("Letzte Backup-Integritätsprüfung");
    expect(items[2].healthy).toBe(true);
    expect(items[3].healthy).toBe(true);
  });

  it("builds operations cockpit with missing backup and inactive mcp", () => {
    const systemStatus = { error: "boom", operations: {}, mcp: { mode: "inaktiv" } };
    const items = buildOperationsCockpit(systemStatus, [{ id: "1", status: "open" }] as IncidentFixtures);
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
    expect(selectCockpitItems("dashboard", dash, ops)).toBe(dash);
    expect(selectCockpitItems("operations", dash, ops)).toBe(ops);
    expect(selectCockpitItems("analytics", dash, ops)).toEqual([]);
    expect(selectCockpitItems("builder", dash, ops)).toEqual([]);
  });
});
