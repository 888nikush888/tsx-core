import { describe, expect, it } from "vitest";
import { workflowImpactDescription, workflowResourceSummary } from "@/app/workflow/workflow-builder";
import type { TradingSnapshot, WorkflowKind, WorkflowResource } from "@/app/workflow/types";

function resource(kind: WorkflowKind, configuration: Record<string, unknown>): WorkflowResource {
  return {
    id: "resource-v1", resourceId: "resource", version: 1, kind,
    name: "Resource label", description: "", status: "published", configuration,
    configurationSha256: "a".repeat(64), createdAt: 1, publishedAt: 1,
  };
}

describe("workflow resource summaries", () => {
  it.each<[WorkflowKind, Record<string, unknown>, string]>([
    ["channel", { channelId: "-100123" }, "-100123"],
    ["content_filter", { allowedTypes: ["text", "photo"] }, "2 Inhaltstypen"],
    ["content_filter", {}, "0 Inhaltstypen"],
    ["keyword_filter", { allowedKeywords: ["LONG", "SHORT"], blockedKeywords: ["closed"] }, "2 erlaubt · 1 blockiert"],
    ["keyword_filter", {}, "0 erlaubt · 0 blockiert"],
    ["regex", { patterns: ["LONG", "SHORT"], mode: "any" }, "2 Muster · eines"],
    ["regex", { patterns: ["LONG"], mode: "all" }, "1 Muster · alle"],
    ["regex", {}, "0 Muster · alle"],
    ["parser", { timeoutMs: 2500, templateName: "signal-v2" }, "3 s · signal-v2"],
    ["parser", { templateName: "legacy" }, "0 s · legacy"],
    ["contract", { contractVersionId: "contract-v3" }, "contract-v3"],
    ["dedupe", { enabled: false, cooldownHours: 24 }, "deaktiviert"],
    ["dedupe", { cooldownHours: 24 }, "24 h Cooldown"],
    ["adaptive_risk", { enabled: false, mode: "progressive" }, "deaktiviert"],
    ["adaptive_risk", { enabled: true, mode: "progressive", tiers: [1, 2, 3] }, "progressive · 3 Stufen"],
    ["adaptive_risk", { mode: "fixed" }, "fixed · 0 Stufen"],
    ["output", { mode: "telegram_xml" }, "Telegram XML"],
    ["output", { mode: "telegram_original" }, "Telegram Original"],
    ["output", { mode: "none" }, "Keine Ausgabe"],
    ["output", { mode: "audit_only" }, "Audit & Journal"],
    ["output", {}, "Audit & Journal"],
  ])("presents %s configuration %j without changing its units or mode", (kind, configuration, expected) => {
    expect(workflowResourceSummary(resource(kind, configuration), null)).toBe(expected);
  });

  it("preserves decimal risk labels and the legacy maximum-leverage fallback", () => {
    const sizing = resource("sizing", {
      riskPerTradePercent: "0.25", maxAdaptiveRiskPercent: "1.50", defaultLeverage: 2, maxLeverage: 5,
    });
    expect(workflowResourceSummary(sizing, null)).toBe("0.25% Basis · 1.50% max · Hebel 2×/5×");
    expect(workflowResourceSummary({ ...sizing, configuration: { ...sizing.configuration, defaultLeverage: null } }, null))
      .toBe("0.25% Basis · 1.50% max · Hebel 5×/5×");
  });

  it("resolves only the referenced versions and retains identifiers while observations are missing", () => {
    // Only fields consumed by this pure presenter are needed in this observation fixture.
    const trading = {
      accounts: [], activity: { positions: [] },
      signalSchemas: [
        { id: "unrelated", name: "Wrong schema", templateName: "wrong" },
        { id: "schema-v2", name: "Futures signals", templateName: "futures-v2" },
      ],
      strategies: [{ id: "other", name: "Wrong strategy" }, { id: "strategy-v4", name: "Conservative" }],
    } as unknown as TradingSnapshot;
    const schema = resource("schema", { schemaId: "schema-v2" });
    const strategy = resource("strategy", { strategyVersionId: "strategy-v4" });
    expect(workflowResourceSummary(schema, trading)).toBe("Futures signals · futures-v2");
    expect(workflowResourceSummary(strategy, trading)).toBe("Conservative");
    expect(workflowResourceSummary(schema, null)).toBe("schema-v2");
    expect(workflowResourceSummary(strategy, null)).toBe("strategy-v4");
    expect(workflowResourceSummary(resource("schema", { schemaId: "removed-schema" }), trading)).toBe("removed-schema");
    expect(workflowResourceSummary(resource("strategy", { strategyVersionId: "removed-strategy" }), trading)).toBe("removed-strategy");
  });

  it("shows live account capacity from the selected account rather than unrelated or closed positions", () => {
    const account = { id: "account-1", exchange: "paper", mode: "paper", maxConcurrentPositions: 2 };
    const trading = {
      accounts: [{ ...account, id: "other", maxConcurrentPositions: 9 }, account],
      activity: { positions: [
        { accountId: "account-1", status: "open" },
        { accountId: "account-1", status: "closed" },
        { accountId: "other", status: "open" },
      ] },
    } as unknown as TradingSnapshot;
    const selected = resource("account", { accountId: "account-1" });
    expect(workflowResourceSummary(selected, trading)).toBe("paper · paper · 1/2 aktiv");
    trading.activity.positions.push({ accountId: "account-1", status: "opening" });
    expect(workflowResourceSummary(selected, trading)).toBe("paper · paper · 2/2 · VOLL");
    expect(workflowResourceSummary(selected, null)).toBe("account-1");
    expect(workflowResourceSummary(resource("account", { accountId: "missing" }), trading)).toBe("missing");
  });

  it("does not evaluate unrelated resource metadata when selecting a summary", () => {
    const configuration: Record<string, unknown> = { channelId: "-100123" };
    Object.defineProperty(configuration, "tiers", { get() { throw new Error("Unrelated risk metadata read"); } });
    expect(workflowResourceSummary(resource("channel", configuration), null)).toBe("-100123");
  });

  it("bounds the destructive-change preview without losing changed and removed totals", () => {
    const changed = Array.from({ length: 8 }, (_, index) => ({ channelId: `channel-${index}`, accountId: "primary" }));
    const removed = Array.from({ length: 4 }, (_, index) => ({ channelId: `removed-${index}`, accountId: "retired" }));
    const description = workflowImpactDescription({ changed, removed, destructive: true, confirmation: "ACTIVATE WORKFLOW IMPACT" });
    expect(description).toContain("8 Pfad(e) werden geändert.");
    expect(description).toContain("4 Pfad(e) werden entfernt.");
    expect(description).toContain("removed-1 → retired");
    expect(description).not.toContain("removed-2 → retired");
    expect(description.split("\n").filter(line => line.startsWith("•"))).toHaveLength(10);
  });
});
