import { describe, expect, it } from "vitest";
import {
  channelNodesReachingSource,
  consolidateWorkflowResources,
  latestPublishedResources,
  moveWorkflowNode,
  normalizeWorkflowGrid,
  placedNodesByResourceIdentity,
  resourceBehaviorKey,
} from "@/app/workflow/workflow-graph";
import type {
  WorkflowGraph,
  WorkflowResource,
} from "@/app/workflow/types";
import { COLUMN_GAP } from "@/app/workflow/types";

function resource(
  id: string,
  resourceId: string,
  version: number,
  status: WorkflowResource["status"] = "published",
  behaviorSha = id,
): WorkflowResource {
  return {
    id,
    resourceId,
    version,
    kind: "sizing",
    name: `Sizing ${version}`,
    description: "",
    status,
    configuration: {},
    configurationSha256: behaviorSha,
    createdAt: version,
    publishedAt: status === "published" ? version : null,
  };
}

function node(id: string, resourceVersionId: string, y: number) {
  return {
    id,
    kind: "sizing" as const,
    resourceVersionId,
    position: { x: 0, y },
  };
}

describe("workflow graph controls", () => {
  it("exposes only the latest published version and one resource per behavior", () => {
    const resources = [
      resource("family-v1", "family", 1, "published", "old"),
      resource("family-v2", "family", 2, "published", "shared"),
      resource("family-v3", "family", 3, "draft"),
      resource("duplicate-v1", "duplicate", 1, "published", "shared"),
    ];
    expect(latestPublishedResources(resources).map((item) => item.id)).toEqual([
      "duplicate-v1",
    ]);
  });

  it("maps placements by logical and exact behavior identity", () => {
    const placedResource = resource(
      "family-v1",
      "family",
      1,
      "published",
      "shared",
    );
    const graph: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [node("placed", "family-v1", 0)],
      edges: [],
    };
    const placed = placedNodesByResourceIdentity(graph, [placedResource]);
    expect(placed.get("family")?.id).toBe("placed");
    expect(placed.get(resourceBehaviorKey(placedResource))?.id).toBe("placed");
  });

  it("consolidates old duplicate placements and preserves every connection", () => {
    const graph: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [
        {
          id: "channel",
          kind: "channel",
          resourceVersionId: "channel-v1",
          position: { x: 0, y: 0 },
        },
        node("old", "family-v1", 150),
        node("new", "duplicate-v1", 0),
        {
          id: "account-a",
          kind: "account",
          resourceVersionId: "account-a-v1",
          position: { x: 0, y: 0 },
        },
        {
          id: "account-b",
          kind: "account",
          resourceVersionId: "account-b-v1",
          position: { x: 0, y: 150 },
        },
      ],
      edges: [
        { id: "in-old", source: "channel", target: "old" },
        { id: "in-new", source: "channel", target: "new" },
        { id: "out-a", source: "old", target: "account-a" },
        { id: "out-b", source: "new", target: "account-b" },
      ],
    };
    const resources: WorkflowResource[] = [
      resource("family-v1", "family", 1, "published", "shared"),
      resource("duplicate-v1", "duplicate", 1, "published", "shared"),
      {
        ...resource("channel-v1", "channel-family", 1),
        kind: "channel",
      },
      {
        ...resource("account-a-v1", "account-a-family", 1),
        kind: "account",
      },
      {
        ...resource("account-b-v1", "account-b-family", 1),
        kind: "account",
      },
    ];
    const result = consolidateWorkflowResources(graph, resources);
    expect(result).toMatchObject({
      duplicateBehaviorCount: 1,
      removedNodeCount: 1,
      redundantResourceIds: ["family"],
    });
    expect(result.graph.nodes.filter((item) => item.kind === "sizing")).toEqual([
      expect.objectContaining({ id: "new", resourceVersionId: "duplicate-v1" }),
    ]);
    expect(
      result.graph.edges.map((edge) => [edge.source, edge.target]),
    ).toEqual([
      ["channel", "new"],
      ["new", "account-a"],
      ["new", "account-b"],
    ]);
  });

  it("keeps resources of the same kind when their behavior differs", () => {
    const graph: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [node("first", "first-v1", 0), node("second", "second-v1", 150)],
      edges: [],
    };
    const result = consolidateWorkflowResources(graph, [
      resource("first-v1", "first", 1, "published", "behavior-a"),
      resource("second-v1", "second", 1, "published", "behavior-b"),
    ]);
    expect(result).toMatchObject({
      duplicateBehaviorCount: 0,
      removedNodeCount: 0,
      redundantResourceIds: [],
    });
    expect(result.graph.nodes).toHaveLength(2);
  });

  it("merges channel scopes when duplicate connections collapse", () => {
    const graph: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [
        { id: "channel-a", kind: "channel", resourceVersionId: "channel-a-v1", position: { x: 0, y: 0 } },
        { id: "channel-b", kind: "channel", resourceVersionId: "channel-b-v1", position: { x: 0, y: 150 } },
        { id: "shared", kind: "content_filter", resourceVersionId: "shared-v1", position: { x: 316, y: 0 } },
        node("old", "family-v1", 150),
        node("new", "duplicate-v1", 0),
      ],
      edges: [
        { id: "old-edge", source: "shared", target: "old", channelNodeIds: ["channel-a"] },
        { id: "new-edge", source: "shared", target: "new", channelNodeIds: ["channel-b"] },
      ],
    };
    const resources: WorkflowResource[] = [
      resource("family-v1", "family", 1, "published", "shared-sizing"),
      resource("duplicate-v1", "duplicate", 1, "published", "shared-sizing"),
      { ...resource("channel-a-v1", "channel-a", 1), kind: "channel" },
      { ...resource("channel-b-v1", "channel-b", 1), kind: "channel" },
      { ...resource("shared-v1", "shared", 1), kind: "content_filter" },
    ];
    const result = consolidateWorkflowResources(graph, resources);
    expect(result.graph.edges).toEqual([
      expect.objectContaining({
        source: "shared",
        target: "new",
        channelNodeIds: ["channel-a", "channel-b"],
      }),
    ]);
  });

  it("moves a block by keyboard-compatible column order", () => {
    const graph: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [node("first", "first-v1", 0), node("second", "second-v1", 150)],
      edges: [],
    };
    const moved = moveWorkflowNode(graph, "second", "up");
    expect(moved?.nodes.find((item) => item.id === "second")?.position.y).toBe(0);
    expect(moved?.nodes.find((item) => item.id === "first")?.position.y).toBe(150);
    expect(moveWorkflowNode(graph, "first", "up")).toBeNull();
  });

  it("normalizes every column onto the fixed grid", () => {
    const graph: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [
        node("lower", "lower-v1", 418),
        node("upper", "upper-v1", -37),
        {
          id: "channel",
          kind: "channel",
          resourceVersionId: "channel-v1",
          position: { x: 999, y: 88 },
        },
      ],
      edges: [],
    };
    const normalized = normalizeWorkflowGrid(graph);
    expect(normalized.nodes.find((item) => item.id === "upper")?.position).toEqual({
      x: 9 * COLUMN_GAP,
      y: 0,
    });
    expect(normalized.nodes.find((item) => item.id === "lower")?.position).toEqual({
      x: 9 * COLUMN_GAP,
      y: 150,
    });
    expect(normalized.nodes.find((item) => item.id === "channel")?.position).toEqual({
      x: 0,
      y: 0,
    });
  });

  it("keeps origin-channel reachability through shared and scoped edges", () => {
    const graph: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [
        { id: "channel-a", kind: "channel", resourceVersionId: "a", position: { x: 0, y: 0 } },
        { id: "channel-b", kind: "channel", resourceVersionId: "b", position: { x: 0, y: 150 } },
        { id: "shared", kind: "content_filter", resourceVersionId: "shared", position: { x: 280, y: 0 } },
        { id: "only-a", kind: "regex", resourceVersionId: "only-a", position: { x: 840, y: 0 } },
      ],
      edges: [
        { id: "a-shared", source: "channel-a", target: "shared" },
        { id: "b-shared", source: "channel-b", target: "shared" },
        { id: "shared-a", source: "shared", target: "only-a", channelNodeIds: ["channel-a"] },
      ],
    };
    expect(channelNodesReachingSource(graph, "shared")).toEqual([
      "channel-a",
      "channel-b",
    ]);
    expect(channelNodesReachingSource(graph, "only-a")).toEqual(["channel-a"]);
  });
});
