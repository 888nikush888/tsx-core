import type { WorkflowFallbackReason, WorkflowGraph } from "./types";

export const FALLBACK_REASON_ORDER: WorkflowFallbackReason[] = [
  "SYMBOL_UNAVAILABLE",
  "MAX_CONCURRENT_POSITIONS",
  "SYMBOL_ALREADY_OWNED",
];

export const PAIR_ONLY_FALLBACK_POLICY: WorkflowFallbackReason[] = [
  "SYMBOL_UNAVAILABLE",
];

export const RECOMMENDED_FALLBACK_POLICY: WorkflowFallbackReason[] = [
  ...FALLBACK_REASON_ORDER,
];

export const FALLBACK_REASON_PRESENTATION: Record<WorkflowFallbackReason, {
  short: string;
  title: string;
  description: string;
}> = {
  SYMBOL_UNAVAILABLE: {
    short: "Paar",
    title: "Handelspaar nicht verfügbar",
    description: "Das nächste Konto wird geprüft, wenn dieses Konto das Signalpaar eindeutig nicht handeln kann.",
  },
  MAX_CONCURRENT_POSITIONS: {
    short: "Voll",
    title: "Positionslimit erreicht",
    description: "Das nächste Konto wird geprüft, wenn alle erlaubten Positionsplätze dieses Kontos belegt sind.",
  },
  SYMBOL_ALREADY_OWNED: {
    short: "Belegt",
    title: "Symbol bereits belegt",
    description: "Das nächste Konto wird geprüft, wenn dieses Symbol dort bereits eröffnet oder in Eröffnung ist.",
  },
};

export type WorkflowFallbackPolicyPreset = "pair_only" | "recommended" | "custom";

export function normalizeWorkflowFallbackPolicy(
  input?: readonly WorkflowFallbackReason[],
  source: "legacy" | "configured" = "configured",
): WorkflowFallbackReason[] {
  if (!input) return source === "legacy" ? [...PAIR_ONLY_FALLBACK_POLICY] : [...RECOMMENDED_FALLBACK_POLICY];
  const selected = new Set(input);
  return FALLBACK_REASON_ORDER.filter((reason) => selected.has(reason));
}

export function fallbackPolicyPreset(
  input?: readonly WorkflowFallbackReason[],
): WorkflowFallbackPolicyPreset {
  const policy = normalizeWorkflowFallbackPolicy(input, "legacy");
  if (samePolicy(policy, PAIR_ONLY_FALLBACK_POLICY)) return "pair_only";
  if (samePolicy(policy, RECOMMENDED_FALLBACK_POLICY)) return "recommended";
  return "custom";
}

export function fallbackPolicyShortLabel(input?: readonly WorkflowFallbackReason[]): string {
  return normalizeWorkflowFallbackPolicy(input, "legacy")
    .map((reason) => FALLBACK_REASON_PRESENTATION[reason].short)
    .join(" · ");
}

function samePolicy(left: readonly WorkflowFallbackReason[], right: readonly WorkflowFallbackReason[]) {
  return left.length === right.length && left.every((reason, index) => reason === right[index]);
}

export function upgradeWorkflowGraphForFallbackPolicy(graph: WorkflowGraph): WorkflowGraph {
  const candidate = structuredClone(graph);
  candidate.schemaVersion = 3;
  candidate.edges = candidate.edges.map((edge) => ({
    ...edge,
    kind: edge.kind || "flow",
    ...(edge.kind === "account_fallback"
      ? { fallbackOn: normalizeWorkflowFallbackPolicy(edge.fallbackOn, "legacy") }
      : {}),
  }));
  return candidate;
}

function scopesOverlap(left?: string[], right?: string[]): boolean {
  if (!left || !right) return true;
  return left.some((channel) => right.includes(channel));
}

export function fallbackChainEdgeIds(graph: WorkflowGraph, edgeId: string): string[] {
  const fallbackEdges = graph.edges.filter((edge) => edge.kind === "account_fallback");
  const origin = fallbackEdges.find((edge) => edge.id === edgeId);
  if (!origin) return [];
  const selected = new Set([origin.id]);
  const accounts = new Set([origin.source, origin.target]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of fallbackEdges) {
      if (selected.has(edge.id) || !scopesOverlap(origin.channelNodeIds, edge.channelNodeIds)) continue;
      if (!accounts.has(edge.source) && !accounts.has(edge.target)) continue;
      selected.add(edge.id);
      accounts.add(edge.source);
      accounts.add(edge.target);
      changed = true;
    }
  }
  return [...selected].sort((left, right) => left.localeCompare(right));
}

export function applyWorkflowFallbackPolicy(
  graph: WorkflowGraph,
  edgeId: string,
  fallbackOn: readonly WorkflowFallbackReason[],
  applyToChain: boolean,
): WorkflowGraph {
  const candidate = upgradeWorkflowGraphForFallbackPolicy(graph);
  const targetIds = new Set(applyToChain ? fallbackChainEdgeIds(candidate, edgeId) : [edgeId]);
  candidate.edges = candidate.edges.map((edge) => targetIds.has(edge.id)
    ? { ...edge, fallbackOn: normalizeWorkflowFallbackPolicy(fallbackOn) }
    : edge);
  return candidate;
}
