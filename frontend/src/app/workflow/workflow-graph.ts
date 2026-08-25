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

export function consolidateWorkflowResources(
  source: WorkflowGraph,
  resources: WorkflowResource[],
): WorkflowDuplicateSummary {
  const byVersionId = resourceMap(resources);
  const behaviors = new Map<string, WorkflowGraph["nodes"]>();
  const unknownNodes: WorkflowGraph["nodes"] = [];

  for (const node of source.nodes) {
    const resource = byVersionId.get(node.resourceVersionId);
    if (!resource) {
      unknownNodes.push(structuredClone(node));
      continue;
    }
    const behavior = behaviors.get(resourceBehaviorKey(resource)) || [];
    behavior.push(structuredClone(node));
    behaviors.set(resourceBehaviorKey(resource), behavior);
  }

  const replacement = new Map<string, string>();
  const nodes: WorkflowGraph["nodes"] = [...unknownNodes];
  const redundantResourceIds = new Set<string>();
  let duplicateBehaviorCount = 0;
  let removedNodeCount = 0;

  for (const behavior of behaviors.values()) {
    behavior.sort(
      (left, right) =>
        left.position.y - right.position.y || left.id.localeCompare(right.id),
    );
    const canonical = behavior[0];
    const canonicalResource = byVersionId.get(canonical.resourceVersionId);
    const newest = behavior
      .map((node) => byVersionId.get(node.resourceVersionId))
      .filter((resource): resource is WorkflowResource => Boolean(resource))
      .filter(
        (resource) => resource.resourceId === canonicalResource?.resourceId,
      )
      .sort((left, right) => right.version - left.version)[0];
    if (newest) canonical.resourceVersionId = newest.id;
    canonical.position = {
      x: KIND_META[canonical.kind].order * COLUMN_GAP,
      y: Math.min(...behavior.map((node) => node.position.y)),
    };
    nodes.push(canonical);
    for (const node of behavior) {
      replacement.set(node.id, canonical.id);
      const resource = byVersionId.get(node.resourceVersionId);
      if (
        resource &&
        canonicalResource &&
        resource.resourceId !== canonicalResource.resourceId
      ) {
        redundantResourceIds.add(resource.resourceId);
      }
    }
    if (behavior.length > 1) {
      duplicateBehaviorCount += 1;
      removedNodeCount += behavior.length - 1;
    }
  }

  const seenEdges = new Set<string>();
  const edges: WorkflowGraph["edges"] = [];
  for (const edge of source.edges) {
    const sourceId = replacement.get(edge.source) || edge.source;
    const targetId = replacement.get(edge.target) || edge.target;
    const identity = `${sourceId}\u0000${targetId}`;
    if (sourceId === targetId || seenEdges.has(identity)) continue;
    seenEdges.add(identity);
    edges.push({ ...edge, source: sourceId, target: targetId });
  }

  return {
    graph: { schemaVersion: 1, nodes, edges },
    duplicateBehaviorCount,
    removedNodeCount,
    redundantResourceIds: [...redundantResourceIds].sort(),
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
