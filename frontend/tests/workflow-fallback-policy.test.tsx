import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FALLBACK_REASON_ORDER,
  PAIR_ONLY_FALLBACK_POLICY,
  RECOMMENDED_FALLBACK_POLICY,
  fallbackPolicyPreset,
  fallbackPolicyShortLabel,
  normalizeWorkflowFallbackPolicy,
  applyWorkflowFallbackPolicy,
} from "@/app/workflow/workflow-fallback-policy";
import { WorkflowFallbackPolicyDialog } from "@/app/workflow/workflow-fallback-policy-dialog";

afterEach(cleanup);

describe("workflow fallback policy", () => {
  it("normalizes legacy edges to pair-only and preserves canonical reason order", () => {
    expect(normalizeWorkflowFallbackPolicy(undefined, "legacy")).toEqual(PAIR_ONLY_FALLBACK_POLICY);
    expect(normalizeWorkflowFallbackPolicy([
      "SYMBOL_ALREADY_OWNED",
      "SYMBOL_UNAVAILABLE",
      "MAX_CONCURRENT_POSITIONS",
    ])).toEqual(FALLBACK_REASON_ORDER);
    expect(fallbackPolicyPreset(PAIR_ONLY_FALLBACK_POLICY)).toBe("pair_only");
    expect(fallbackPolicyPreset(RECOMMENDED_FALLBACK_POLICY)).toBe("recommended");
    expect(fallbackPolicyShortLabel(RECOMMENDED_FALLBACK_POLICY)).toBe("Paar · Voll · Belegt");
  });

  it("uses the recommended policy for a new fallback edge", () => {
    const onSave = vi.fn();
    render(
      <WorkflowFallbackPolicyDialog
        open
        mode="create"
        sourceName="Kraken"
        targetName="Hyperliquid"
        saving={false}
        onClose={() => undefined}
        onSave={onSave}
      />,
    );
    expect(screen.getByRole("radio", { name: /Empfohlen/i })).toBeChecked();
    expect(screen.getByText(/Kill-Switch/)).toBeInTheDocument();
    expect(screen.getByText(/nicht übersprungen/)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Kill-Switch/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Tagesverlust/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /ungeklärte Orders/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Fallback übernehmen/i }));
    expect(onSave).toHaveBeenCalledWith(RECOMMENDED_FALLBACK_POLICY, false);
  });

  it("shows a legacy edge as pair-only and can apply an edit to the whole chain", () => {
    const onSave = vi.fn();
    render(
      <WorkflowFallbackPolicyDialog
        open
        mode="edit"
        sourceName="Kraken"
        targetName="Hyperliquid"
        initialFallbackOn={undefined}
        saving={false}
        onClose={() => undefined}
        onSave={onSave}
      />,
    );
    expect(screen.getByRole("radio", { name: /Nur Handelspaar/i })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: /gesamte Kette/i }));
    fireEvent.click(screen.getByRole("button", { name: /Fallback übernehmen/i }));
    expect(onSave).toHaveBeenCalledWith(PAIR_ONLY_FALLBACK_POLICY, true);
  });

  it("upgrades legacy policies and edits exactly one connected channel chain", () => {
    const graph = {
      schemaVersion: 2 as const,
      nodes: [],
      edges: [
        { id: "a-b", kind: "account_fallback" as const, source: "a", target: "b", channelNodeIds: ["channel-a"] },
        { id: "b-c", kind: "account_fallback" as const, source: "b", target: "c", channelNodeIds: ["channel-a"] },
        { id: "x-y", kind: "account_fallback" as const, source: "x", target: "y", channelNodeIds: ["channel-b"] },
      ],
    };
    const updated = applyWorkflowFallbackPolicy(graph, "a-b", RECOMMENDED_FALLBACK_POLICY, true);
    expect(updated.schemaVersion).toBe(3);
    expect(updated.edges.map((edge) => [edge.id, edge.fallbackOn])).toEqual([
      ["a-b", RECOMMENDED_FALLBACK_POLICY],
      ["b-c", RECOMMENDED_FALLBACK_POLICY],
      ["x-y", PAIR_ONLY_FALLBACK_POLICY],
    ]);
  });
});
