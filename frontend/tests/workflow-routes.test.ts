import { describe, expect, it } from "vitest";
import { buildWorkflowRouteTopology } from "@/app/workflow/workflow-routes";
import type {
  WorkflowGraph,
  WorkflowResource,
  WorkflowRevision,
} from "@/app/workflow/types";

function resource(
  id: string,
  kind: WorkflowResource["kind"],
  name: string,
  configuration: Record<string, unknown>,
): WorkflowResource {
  return {
    id,
    resourceId: id,
    version: 1,
    kind,
    name,
    description: "",
    status: "published",
    configuration,
    configurationSha256: "a".repeat(64),
    createdAt: 1,
    publishedAt: 1,
  };
}

function path(
  id: string,
  channelId: string,
  accountId: string,
  nodeIds: string[],
): WorkflowRevision["compiled"]["paths"][number] {
  return {
    id,
    pathKey: id,
    channelId,
    accountId,
    strategyVersionId: "strategy-v1",
    enabled: true,
    nodeIds,
    fallbackOn: [],
  };
}

describe("workflow route topology", () => {
  const resources = [
    resource("channel-a", "channel", "Kanal A", { channelId: "-1001" }),
    resource("channel-b", "channel", "Kanal B", { channelId: "-1002" }),
    resource("regex", "regex", "Gemeinsame Regex", { patterns: [] }),
    resource("parser", "parser", "Gemeinsamer Parser", { templateName: "shared" }),
    resource("strategy", "strategy", "Strategie", {
      strategyVersionId: "strategy-v1",
    }),
    resource("account-a", "account", "Kraken", { accountId: "kraken" }),
    resource("account-b", "account", "Hyperliquid", { accountId: "hyper" }),
  ];

  it("makes the cartesian routing of merged channels and branched accounts explicit", () => {
    const graph: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [
        { id: "c1", kind: "channel", resourceVersionId: "channel-a", position: { x: 0, y: 0 } },
        { id: "c2", kind: "channel", resourceVersionId: "channel-b", position: { x: 0, y: 100 } },
        { id: "r", kind: "regex", resourceVersionId: "regex", position: { x: 1, y: 0 } },
        { id: "p", kind: "parser", resourceVersionId: "parser", position: { x: 2, y: 0 } },
        { id: "a1", kind: "account", resourceVersionId: "account-a", position: { x: 3, y: 0 } },
        { id: "a2", kind: "account", resourceVersionId: "account-b", position: { x: 3, y: 100 } },
      ],
      edges: [
        { id: "c1-r", source: "c1", target: "r" },
        { id: "c2-r", source: "c2", target: "r" },
        { id: "r-p", source: "r", target: "p" },
        { id: "p-a1", source: "p", target: "a1" },
        { id: "p-a2", source: "p", target: "a2" },
      ],
    };
    const paths = [
      path("c1-a1", "-1001", "kraken", ["c1", "r", "p", "a1"]),
      path("c1-a2", "-1001", "hyper", ["c1", "r", "p", "a2"]),
      path("c2-a1", "-1002", "kraken", ["c2", "r", "p", "a1"]),
      path("c2-a2", "-1002", "hyper", ["c2", "r", "p", "a2"]),
    ];

    const topology = buildWorkflowRouteTopology(paths, graph, resources, [], []);
    expect(topology.routes).toHaveLength(4);
    expect(topology.matrix.filter((entry) => entry.routes.length)).toHaveLength(4);
    expect(topology.nodeUsage.get("p")).toMatchObject({
      pathCount: 4,
      channelCount: 2,
      accountCount: 2,
    });
    expect(topology.edgeUsage.get("p-a1")).toMatchObject({
      pathCount: 2,
      channelCount: 2,
      accountCount: 1,
    });
    expect(topology.crossProducts).toEqual([
      expect.objectContaining({
        channelCount: 2,
        accountCount: 2,
        routeCount: 4,
        sharedNodes: ["Gemeinsame Regex", "Gemeinsamer Parser"],
      }),
    ]);
  });

  it("distinguishes reused configurations in separate one-to-one paths", () => {
    const graph: WorkflowGraph = {
      schemaVersion: 1,
      nodes: [
        { id: "c1", kind: "channel", resourceVersionId: "channel-a", position: { x: 0, y: 0 } },
        { id: "c2", kind: "channel", resourceVersionId: "channel-b", position: { x: 0, y: 100 } },
        { id: "r1", kind: "regex", resourceVersionId: "regex", position: { x: 1, y: 0 } },
        { id: "r2", kind: "regex", resourceVersionId: "regex", position: { x: 1, y: 100 } },
        { id: "a1", kind: "account", resourceVersionId: "account-a", position: { x: 3, y: 0 } },
        { id: "a2", kind: "account", resourceVersionId: "account-b", position: { x: 3, y: 100 } },
      ],
      edges: [
        { id: "c1-r1", source: "c1", target: "r1" },
        { id: "r1-a1", source: "r1", target: "a1" },
        { id: "c2-r2", source: "c2", target: "r2" },
        { id: "r2-a2", source: "r2", target: "a2" },
      ],
    };
    const paths = [
      path("c1-a1", "-1001", "kraken", ["c1", "r1", "a1"]),
      path("c2-a2", "-1002", "hyper", ["c2", "r2", "a2"]),
    ];

    const topology = buildWorkflowRouteTopology(paths, graph, resources, [], []);
    expect(topology.crossProducts).toEqual([]);
    expect(topology.matrix.filter((entry) => entry.routes.length)).toHaveLength(2);
    expect(topology.nodeUsage.get("r1")).toMatchObject({
      pathCount: 1,
      resourceInstanceCount: 2,
    });
    expect(topology.nodeUsage.get("r2")).toMatchObject({
      pathCount: 1,
      resourceInstanceCount: 2,
    });
  });

  it("represents account fallback candidates as one exclusive ordered route", () => {
    const graph: WorkflowGraph = {
      schemaVersion: 2,
      nodes: [
        { id: "c1", kind: "channel", resourceVersionId: "channel-a", position: { x: 0, y: 0 } },
        { id: "p", kind: "parser", resourceVersionId: "parser", position: { x: 2, y: 0 } },
        { id: "a1", kind: "account", resourceVersionId: "account-a", position: { x: 3, y: 0 } },
        { id: "a2", kind: "account", resourceVersionId: "account-b", position: { x: 3, y: 100 } },
      ],
      edges: [
        { id: "c1-p", kind: "flow", source: "c1", target: "p" },
        { id: "p-a1", kind: "flow", source: "p", target: "a1" },
        { id: "a1-a2", kind: "account_fallback", source: "a1", target: "a2", channelNodeIds: ["c1"] },
      ],
    };
    const paths = [
      { ...path("c1-a1", "-1001", "kraken", ["c1", "p", "a1"]), routeGroupKey: "group-1", fallbackRank: 0 },
      { ...path("c1-a2", "-1001", "hyper", ["c1", "p", "a1", "a2"]), routeGroupKey: "group-1", fallbackRank: 1 },
    ];
    const topology = buildWorkflowRouteTopology(paths, graph, resources, [], []);
    expect(topology.routes).toHaveLength(1);
    expect(topology.routes[0]).toMatchObject({
      channelId: "-1001",
      accountId: "kraken",
      fallbackAccounts: [
        expect.objectContaining({ accountId: "kraken", rank: 0 }),
        expect.objectContaining({ accountId: "hyper", rank: 1 }),
      ],
    });
    expect(topology.edgeUsage.get("a1-a2")).toMatchObject({ pathCount: 1, accountCount: 2 });
  });

  it("carries the snapshotted V3 policy between ordered account candidates", () => {
    const fallbackOn = [
      "SYMBOL_UNAVAILABLE",
      "MAX_CONCURRENT_POSITIONS",
      "SYMBOL_ALREADY_OWNED",
    ] as const;
    const graph: WorkflowGraph = {
      schemaVersion: 3,
      nodes: [
        { id: "c1", kind: "channel", resourceVersionId: "channel-a", position: { x: 0, y: 0 } },
        { id: "a1", kind: "account", resourceVersionId: "account-a", position: { x: 3, y: 0 } },
        { id: "a2", kind: "account", resourceVersionId: "account-b", position: { x: 3, y: 100 } },
      ],
      edges: [
        { id: "c1-a1", kind: "flow", source: "c1", target: "a1" },
        { id: "a1-a2", kind: "account_fallback", source: "a1", target: "a2", channelNodeIds: ["c1"], fallbackOn: [...fallbackOn] },
      ],
    };
    const paths = [
      { ...path("c1-a1", "-1001", "kraken", ["c1", "a1"]), routeGroupKey: "group-v3", fallbackRank: 0, fallbackOn: [...fallbackOn] },
      { ...path("c1-a2", "-1001", "hyper", ["c1", "a1", "a2"]), routeGroupKey: "group-v3", fallbackRank: 1, fallbackOn: [] },
    ];

    const topology = buildWorkflowRouteTopology(paths, graph, resources, [], []);
    expect(topology.routes[0].fallbackAccounts).toEqual([
      expect.objectContaining({ accountId: "kraken", fallbackOn: [...fallbackOn] }),
      expect.objectContaining({ accountId: "hyper", fallbackOn: [] }),
    ]);
  });
});
