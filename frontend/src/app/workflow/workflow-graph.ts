import {
  COLUMN_GAP,
  KIND_META,
  type WorkflowGraph,
  type WorkflowResource,
} from "./types";

const ROW_GAP = 150;

function resourceMap(resources: WorkflowResource[]) {
  return new Map(resources.map((resource) => [resource.id, resource]));
}

export function resourceBehaviorKey(resource: WorkflowResource): string {
  return `${resource.kind}:${resource.configurationSha256}`;
}

export function latestPublishedResources(
  resources: WorkflowResource[],
): WorkflowResource[] {
  const latest = new Map<string, WorkflowResource>();
  for (const resource of resources) {
    if (resource.status !== "published") continue;
    const current = latest.get(resource.resourceId);
    if (!current || current.version < resource.version) {
      latest.set(resource.resourceId, resource);
    }
  }
  const ordered = [...latest.values()].sort((left, right) =>
    left.name.localeCompare(right.name, "de-DE"),
  );
  const uniqueBehaviors = new Map<string, WorkflowResource>();
  for (const resource of ordered) {
    const identity = resourceBehaviorKey(resource);
    if (!uniqueBehaviors.has(identity)) uniqueBehaviors.set(identity, resource);
  }
  return [...uniqueBehaviors.values()];
}

export function placedNodesByResourceIdentity(
  graph: WorkflowGraph,
  resources: WorkflowResource[],
): Map<string, WorkflowGraph["nodes"][number]> {
  const byVersionId = resourceMap(resources);
  const placed = new Map<string, WorkflowGraph["nodes"][number]>();
  for (const node of graph.nodes) {
    const resource = byVersionId.get(node.resourceVersionId);
    if (resource) {
      for (const identity of [
        resource.resourceId,
        resourceBehaviorKey(resource),
      ]) {
        if (!placed.has(identity)) placed.set(identity, node);
      }
    }
  }
  return placed;
}

export type WorkflowDuplicateSummary = {
  graph: WorkflowGraph;
  duplicateBehaviorCount: number;
  removedNodeCount: number;
  redundantResourceIds: string[];
};

type WorkflowEdge = WorkflowGraph["edges"][number];

function groupedBehaviorNodes(
  nodes: WorkflowGraph["nodes"],
  byVersionId: Map<string, WorkflowResource>,
) {
  const behaviors = new Map<string, WorkflowGraph["nodes"]>();
  const unknownNodes: WorkflowGraph["nodes"] = [];
  for (const node of nodes) {
    const resource = byVersionId.get(node.resourceVersionId);
    if (!resource) {
      unknownNodes.push(structuredClone(node));
      continue;
    }
    const key = resourceBehaviorKey(resource);
    const behavior = behaviors.get(key) || [];
    behavior.push(structuredClone(node));
    behaviors.set(key, behavior);
  }
  return { behaviors, unknownNodes };
}

function newestCanonicalResource(
  behavior: WorkflowGraph["nodes"],
  canonicalResource: WorkflowResource | undefined,
  byVersionId: Map<string, WorkflowResource>,
) {
  return behavior
    .map((node) => byVersionId.get(node.resourceVersionId))
    .filter((resource): resource is WorkflowResource => Boolean(resource))
    .filter((resource) => resource.resourceId === canonicalResource?.resourceId)
    .sort((left, right) => right.version - left.version)[0];
}

function appendCanonicalBehavior(
  behavior: WorkflowGraph["nodes"],
  byVersionId: Map<string, WorkflowResource>,
  nodes: WorkflowGraph["nodes"],
  replacement: Map<string, string>,
  redundantResourceIds: Set<string>,
): { duplicateBehaviorCount: number; removedNodeCount: number } {
  behavior.sort(
    (left, right) =>
      left.position.y - right.position.y || left.id.localeCompare(right.id),
  );
  const canonical = behavior[0];
  const canonicalResource = byVersionId.get(canonical.resourceVersionId);
  const newest = newestCanonicalResource(behavior, canonicalResource, byVersionId);
  if (newest) canonical.resourceVersionId = newest.id;
  canonical.position = {
    x: KIND_META[canonical.kind].order * COLUMN_GAP,
    y: Math.min(...behavior.map((node) => node.position.y)),
  };
  nodes.push(canonical);
  for (const node of behavior) {
    replacement.set(node.id, canonical.id);
    const resource = byVersionId.get(node.resourceVersionId);
    if (resource && canonicalResource && resource.resourceId !== canonicalResource.resourceId) {
      redundantResourceIds.add(resource.resourceId);
    }
  }
  return {
    duplicateBehaviorCount: behavior.length > 1 ? 1 : 0,
    removedNodeCount: Math.max(0, behavior.length - 1),
  };
}

function remappedChannelNodeIds(
  edge: WorkflowEdge,
  replacement: Map<string, string>,
): string[] | undefined {
  return edge.channelNodeIds
    ? [...new Set(edge.channelNodeIds.map((id) => replacement.get(id) || id))]
        .sort((left, right) => left.localeCompare(right))
    : undefined;
}

function consolidatedEdges(
  edges: WorkflowGraph["edges"],
  replacement: Map<string, string>,
): WorkflowGraph["edges"] {
  const edgesByIdentity = new Map<string, WorkflowEdge>();
  for (const edge of edges) {
    const source = replacement.get(edge.source) || edge.source;
    const target = replacement.get(edge.target) || edge.target;
    if (source === target) continue;
    const identity = `${edge.kind || "flow"}\u0000${source}\u0000${target}`;
    const channelNodeIds = remappedChannelNodeIds(edge, replacement);
    const existing = edgesByIdentity.get(identity);
    if (!existing) {
      edgesByIdentity.set(identity, {
        ...edge,
        source,
        target,
        ...(channelNodeIds ? { channelNodeIds } : {}),
      });
      continue;
    }
    if (!existing.channelNodeIds || !channelNodeIds) {
      delete existing.channelNodeIds;
      continue;
    }
    existing.channelNodeIds = [
      ...new Set([...existing.channelNodeIds, ...channelNodeIds]),
    ].sort((left, right) => left.localeCompare(right));
  }
  return [...edgesByIdentity.values()];
}

export function normalizeWorkflowGrid(source: WorkflowGraph): WorkflowGraph {
  const graph = structuredClone(source);
  for (const kind of Object.keys(KIND_META) as Array<keyof typeof KIND_META>) {
    const ordered = graph.nodes
      .filter((node) => node.kind === kind)
      .sort(
        (left, right) =>
          left.position.y - right.position.y || left.id.localeCompare(right.id),
      );
    ordered.forEach((node, index) => {
      node.position = {
        x: KIND_META[kind].order * COLUMN_GAP,
        y: index * ROW_GAP,
      };
    });
  }
  return graph;
}

export function channelNodesReachingSource(
  graph: WorkflowGraph,
  sourceId: string,
): string[] {
  const outgoing = new Map<string, WorkflowGraph["edges"]>();
  for (const edge of graph.edges) {
    const edges = outgoing.get(edge.source) || [];
    edges.push(edge);
    outgoing.set(edge.source, edges);
  }
  const reachesSource = (channelNodeId: string): boolean => {
    const pending = [channelNodeId];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current || visited.has(current)) continue;
      if (current === sourceId) return true;
      visited.add(current);
      for (const edge of outgoing.get(current) || []) {
        if (
          !edge.channelNodeIds ||
          edge.channelNodeIds.includes(channelNodeId)
        ) {
          pending.push(edge.target);
        }
      }
    }
    return false;
  };
  return graph.nodes
    .filter((node) => node.kind === "channel" && reachesSource(node.id))
    .map((node) => node.id)
    .sort((left, right) => left.localeCompare(right));
}

export function parserSourcesForSchema(
  graph: WorkflowGraph,
  resources: WorkflowResource[],
  schemaNodeId: string | null,
): Array<{
  nodeId: string;
  resourceVersionId: string;
  name: string;
  templateName: string;
  connected: boolean;
}> {
  const byVersionId = resourceMap(resources);
  const connectedParserIds = new Set(
    schemaNodeId
      ? graph.edges
          .filter(edge => edge.kind !== "account_fallback" && edge.target === schemaNodeId)
          .map(edge => edge.source)
      : [],
  );
  return graph.nodes
    .filter(node => node.kind === "parser")
    .map(node => {
      const resource = byVersionId.get(node.resourceVersionId);
      return {
        nodeId: node.id,
        resourceVersionId: node.resourceVersionId,
        name: resource?.name || "Fehlender Parser-Baustein",
        templateName: String(resource?.configuration.templateName || "inline"),
        connected: connectedParserIds.has(node.id),
      };
    })
    .sort((left, right) =>
      Number(right.connected) - Number(left.connected)
      || left.name.localeCompare(right.name, "de-DE"),
    );
}

export type WorkflowConnectionKind = "flow" | "account_fallback";

export type WorkflowConnectionPlan =
  | { type: "reject"; message: string; cancel: boolean }
  | {
      type: "scope";
      draft: {
        sourceId: string;
        targetId: string;
        kind: WorkflowConnectionKind;
      };
    }
  | { type: "activate"; graph: WorkflowGraph; edgeId: string };

function validConnectionTarget(
  source: WorkflowGraph["nodes"][number],
  target: WorkflowGraph["nodes"][number],
  kind: WorkflowConnectionKind,
): boolean {
  if (kind === "account_fallback") {
    return source.kind === "account" && target.kind === "account" && source.id !== target.id;
  }
  return KIND_META[source.kind].order < KIND_META[target.kind].order;
}

function connectionCandidateGraph(
  source: WorkflowGraph,
  kind: WorkflowConnectionKind,
): WorkflowGraph {
  const candidate = structuredClone(source);
  if (kind !== "account_fallback" && candidate.schemaVersion !== 2) return candidate;
  candidate.schemaVersion = 2;
  candidate.edges = candidate.edges.map((edge) => ({
    ...edge,
    kind: edge.kind || "flow",
  }));
  return candidate;
}

export function planWorkflowConnection(
  graph: WorkflowGraph,
  sourceId: string,
  targetId: string,
  kind: WorkflowConnectionKind,
  createEdgeId: () => string,
): WorkflowConnectionPlan {
  const source = graph.nodes.find((node) => node.id === sourceId);
  const target = graph.nodes.find((node) => node.id === targetId);
  if (!source || !target || !validConnectionTarget(source, target, kind)) {
    return {
      type: "reject",
      cancel: false,
      message:
        kind === "account_fallback"
          ? "Eine Fallback-Verbindung muss zwei unterschiedliche Börsenkonten derselben Spalte verbinden."
          : "Das Ziel muss rechts vom Ausgangsbaustein in einer späteren Verarbeitungsspalte liegen.",
    };
  }
  const duplicate = graph.edges.some(
    (edge) => edge.source === source.id && edge.target === target.id,
  );
  if (duplicate) {
    return {
      type: "reject",
      cancel: true,
      message: "Diese Verbindung besteht bereits.",
    };
  }
  const channelNodeIds = channelNodesReachingSource(graph, source.id);
  if (kind === "account_fallback" && channelNodeIds.length === 0) {
    return {
      type: "reject",
      cancel: true,
      message:
        "Das Ausgangskonto wird noch von keinem Kanal erreicht und kann deshalb keine Fallback-Reihenfolge erhalten.",
    };
  }
  if (kind === "account_fallback" || channelNodeIds.length > 1) {
    return {
      type: "scope",
      draft: { sourceId: source.id, targetId: target.id, kind },
    };
  }
  const candidate = connectionCandidateGraph(graph, kind);
  const edgeId = createEdgeId();
  candidate.edges.push({
    id: edgeId,
    source: source.id,
    target: target.id,
    ...(candidate.schemaVersion === 2 ? { kind } : {}),
    ...(channelNodeIds.length === 1 ? { channelNodeIds } : {}),
  });
  return { type: "activate", graph: candidate, edgeId };
}

export type WorkflowConnectionState = "idle" | "source" | "target" | "blocked";

export function workflowConnectionState(
  graph: WorkflowGraph,
  node: WorkflowGraph["nodes"][number],
  source: WorkflowGraph["nodes"][number] | null,
  kind: WorkflowConnectionKind,
): WorkflowConnectionState {
  if (!source) return "idle";
  if (node.id === source.id) return "source";
  const alreadyConnected = graph.edges.some(
    (edge) => edge.source === source.id && edge.target === node.id,
  );
  if (alreadyConnected) return "blocked";
  if (kind === "account_fallback") {
    return source.kind === "account" && node.kind === "account" ? "target" : "blocked";
  }
  return KIND_META[node.kind].order > KIND_META[source.kind].order ? "target" : "blocked";
}

export function workflowNodeMatchesSearch(
  name: string,
  kindLabel: string,
  description: string,
  query: string,
): boolean {
  const normalized = query.trim().toLocaleLowerCase("de-DE");
  if (!normalized) return true;
  return `${name} ${kindLabel} ${description}`
    .toLocaleLowerCase("de-DE")
    .includes(normalized);
}

export function workflowPathFocusState(
  routeIds: string[],
  selectedPathId: string | null,
): "idle" | "active" | "dimmed" {
  if (!selectedPathId) return "idle";
  return routeIds.includes(selectedPathId) ? "active" : "dimmed";
}

export function consolidateWorkflowResources(
  source: WorkflowGraph,
  resources: WorkflowResource[],
): WorkflowDuplicateSummary {
  const byVersionId = resourceMap(resources);
  const { behaviors, unknownNodes } = groupedBehaviorNodes(source.nodes, byVersionId);
  const replacement = new Map<string, string>();
  const nodes: WorkflowGraph["nodes"] = [...unknownNodes];
  const redundantResourceIds = new Set<string>();
  let duplicateBehaviorCount = 0;
  let removedNodeCount = 0;
  for (const behavior of behaviors.values()) {
    const counts = appendCanonicalBehavior(
      behavior,
      byVersionId,
      nodes,
      replacement,
      redundantResourceIds,
    );
    duplicateBehaviorCount += counts.duplicateBehaviorCount;
    removedNodeCount += counts.removedNodeCount;
  }
  return {
    graph: normalizeWorkflowGrid({
      schemaVersion: source.schemaVersion,
      nodes,
      edges: consolidatedEdges(source.edges, replacement),
    }),
    duplicateBehaviorCount,
    removedNodeCount,
    redundantResourceIds: [...redundantResourceIds].sort((left, right) =>
      left.localeCompare(right, "de-DE"),
    ),
  };
}

export function moveWorkflowNode(
  source: WorkflowGraph,
  nodeId: string,
  direction: "up" | "down",
): WorkflowGraph | null {
  const target = source.nodes.find((node) => node.id === nodeId);
  if (!target) return null;
  const ordered = source.nodes
    .filter((node) => node.kind === target.kind)
    .sort(
      (left, right) =>
        left.position.y - right.position.y || left.id.localeCompare(right.id),
    );
  const currentIndex = ordered.findIndex((node) => node.id === nodeId);
  const nextIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
  if (currentIndex < 0 || nextIndex < 0 || nextIndex >= ordered.length) {
    return null;
  }
  [ordered[currentIndex], ordered[nextIndex]] = [
    ordered[nextIndex],
    ordered[currentIndex],
  ];
  const positions = new Map(
    ordered.map((node, index) => [node.id, index * ROW_GAP]),
  );
  const graph = structuredClone(source);
  graph.nodes = graph.nodes.map((node) =>
    node.kind === target.kind
      ? {
          ...node,
          position: {
            x: KIND_META[node.kind].order * COLUMN_GAP,
            y: positions.get(node.id) ?? node.position.y,
          },
        }
      : node,
  );
  return graph;
}
