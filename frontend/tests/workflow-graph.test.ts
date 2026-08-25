import { describe, expect, it } from "vitest";
import {
  consolidateWorkflowResources,
  latestPublishedResources,
  moveWorkflowNode,
  placedNodesByResourceIdentity,
  resourceBehaviorKey,
} from "@/app/workflow/workflow-graph";
import type {
  WorkflowGraph,
  WorkflowResource,
} from "@/app/workflow/types";

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
});
