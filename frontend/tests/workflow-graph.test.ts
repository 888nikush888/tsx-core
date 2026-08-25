import { describe, expect, it } from "vitest";
import {
  consolidateWorkflowResources,
  latestPublishedResources,
  moveWorkflowNode,
  placedNodesByResourceId,
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
    configurationSha256: id,
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
  it("exposes only the latest published version per logical resource", () => {
    const resources = [
      resource("family-v1", "family", 1),
      resource("family-v2", "family", 2),
      resource("family-v3", "family", 3, "draft"),
    ];
    expect(latestPublishedResources(resources).map((item) => item.id)).toEqual([
      "family-v2",
    ]);
  });

  it("maps placements by logical resource identity", () => {
    const graph: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [node("placed", "family-v1", 0)],
      edges: [],
    };
    expect(
      placedNodesByResourceId(graph, [resource("family-v1", "family", 1)]).get(
        "family",
      )?.id,
    ).toBe("placed");
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
        node("new", "family-v2", 0),
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
      resource("family-v1", "family", 1),
      resource("family-v2", "family", 2),
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
      duplicateFamilyCount: 1,
      removedNodeCount: 1,
    });
    expect(result.graph.nodes.filter((item) => item.kind === "sizing")).toEqual([
      expect.objectContaining({ id: "new", resourceVersionId: "family-v2" }),
    ]);
    expect(
      result.graph.edges.map((edge) => [edge.source, edge.target]),
    ).toEqual([
      ["channel", "new"],
      ["new", "account-a"],
      ["new", "account-b"],
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
});
