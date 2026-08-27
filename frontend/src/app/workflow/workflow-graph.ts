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
