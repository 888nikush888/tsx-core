import type {
  TradingAccount,
  WorkflowGraph,
  WorkflowFallbackReason,
  WorkflowKind,
  WorkflowResource,
  WorkflowRevision,
} from "./types";

export type WorkflowRoute = {
  id: string;
  enabled: boolean;
  channelId: string;
  channelName: string;
  accountId: string;
  accountName: string;
  accountDetail: string;
  strategyName: string;
  nodeIds: string[];
  nodeNames: string[];
  fallbackAccounts: Array<{
    accountId: string;
    accountName: string;
    accountDetail: string;
    rank: number;
    enabled: boolean;
    fallbackOn: WorkflowFallbackReason[];
  }>;
};

export type WorkflowRouteUsage = {
  pathCount: number;
  channelCount: number;
  accountCount: number;
  resourceInstanceCount: number;
  routeIds: string[];
};

export type WorkflowRouteMatrixEntry = {
  channelId: string;
  accountId: string;
  routes: WorkflowRoute[];
};

export type WorkflowCrossProduct = {
  id: string;
  channelCount: number;
  accountCount: number;
  routeCount: number;
  channels: string[];
  accounts: string[];
  sharedNodes: string[];
};

export type WorkflowRouteTopology = {
  routes: WorkflowRoute[];
  channels: Array<{ id: string; name: string }>;
  accounts: Array<{ id: string; name: string; detail: string }>;
  matrix: WorkflowRouteMatrixEntry[];
  nodeUsage: Map<string, WorkflowRouteUsage>;
  edgeUsage: Map<string, WorkflowRouteUsage>;
  crossProducts: WorkflowCrossProduct[];
};

function resourceForNode(
  nodeId: string | undefined,
  graph: WorkflowGraph,
  resources: Map<string, WorkflowResource>,
) {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  return node ? resources.get(node.resourceVersionId) : undefined;
}

function nodeIdForKind(
  path: WorkflowRevision["compiled"]["paths"][number],
  graph: WorkflowGraph,
  kind: WorkflowKind,
) {
  const nodeIds = kind === "account" ? [...path.nodeIds].reverse() : path.nodeIds;
  return nodeIds.find(
    (nodeId) => graph.nodes.find((node) => node.id === nodeId)?.kind === kind,
  );
}

function configuredId(
  resource: WorkflowResource | undefined,
  key: "channelId" | "accountId" | "strategyVersionId",
) {
  const value = resource?.configuration[key];
  return typeof value === "string" && value ? value : "unbekannt";
}

function routeUsage(
  routes: WorkflowRoute[],
  resourceInstanceCount = 1,
): WorkflowRouteUsage {
  return {
    pathCount: routes.length,
    channelCount: new Set(routes.map((route) => route.channelId)).size,
    accountCount: new Set(routes.flatMap((route) =>
      route.fallbackAccounts.map((candidate) => candidate.accountId))).size,
    resourceInstanceCount,
    routeIds: routes.map((route) => route.id),
  };
}

export function buildWorkflowRouteTopology(
  paths: WorkflowRevision["compiled"]["paths"],
  graph: WorkflowGraph,
  resourceList: WorkflowResource[],
  tradingAccounts: TradingAccount[],
  strategies: Array<{ id: string; name: string }>,
): WorkflowRouteTopology {
  const resources = new Map(
    resourceList.map((resource) => [resource.id, resource]),
  );
  const accounts = new Map(tradingAccounts.map((account) => [account.id, account]));
  const strategyNames = new Map(
    strategies.map((strategy) => [strategy.id, strategy.name]),
  );
  const resourceInstanceCounts = new Map<string, number>();
  for (const node of graph.nodes) {
    resourceInstanceCounts.set(
      node.resourceVersionId,
      (resourceInstanceCounts.get(node.resourceVersionId) || 0) + 1,
    );
  }

  const rawRoutes: WorkflowRoute[] = paths.map((path, index) => {
    const channelNodeId = nodeIdForKind(path, graph, "channel");
    const accountNodeId = nodeIdForKind(path, graph, "account");
    const strategyNodeId = nodeIdForKind(path, graph, "strategy");
    const channelResource = resourceForNode(channelNodeId, graph, resources);
    const accountResource = resourceForNode(accountNodeId, graph, resources);
    const strategyResource = resourceForNode(strategyNodeId, graph, resources);
    const channelId = path.channelId || configuredId(channelResource, "channelId");
    const accountId = path.accountId || configuredId(accountResource, "accountId");
    const strategyVersionId =
      path.strategyVersionId ||
      configuredId(strategyResource, "strategyVersionId");
    const account = accounts.get(accountId);
    return {
      id: path.id || `path-${index + 1}`,
      enabled: path.enabled,
      channelId,
      channelName: channelResource?.name || channelId,
      accountId,
      accountName: accountResource?.name || account?.name || accountId,
      accountDetail: account
        ? `${account.exchange} · ${account.mode}`
        : accountId,
      strategyName:
        strategyResource?.name ||
        strategyNames.get(strategyVersionId) ||
        strategyVersionId,
      nodeIds: [...path.nodeIds],
      nodeNames: path.nodeIds.map(
        (nodeId) => resourceForNode(nodeId, graph, resources)?.name || nodeId,
      ),
      fallbackAccounts: [{
        accountId,
        accountName: accountResource?.name || account?.name || accountId,
        accountDetail: account ? `${account.exchange} · ${account.mode}` : accountId,
        rank: path.fallbackRank ?? 0,
        enabled: path.enabled,
        fallbackOn: [...(path.fallbackOn || [])],
      }],
    };
  });
  const routeGroups = new Map<string, WorkflowRoute[]>();
  rawRoutes.forEach((route, index) => {
    const path = paths[index];
    const key = path.routeGroupKey || path.id || route.id;
    routeGroups.set(key, [...(routeGroups.get(key) ?? []), route]);
  });
  const routes = [...routeGroups.values()].map((group) => {
    const ordered = [...group].sort((left, right) =>
      left.fallbackAccounts[0].rank - right.fallbackAccounts[0].rank);
    const primary = ordered[0];
    const deepest = ordered.at(-1) ?? primary;
    return {
      ...primary,
      nodeIds: [...deepest.nodeIds],
      nodeNames: [...deepest.nodeNames],
      fallbackAccounts: ordered.map((route) => route.fallbackAccounts[0]),
    };
  });

  const nodeUsage = new Map<string, WorkflowRouteUsage>();
  for (const node of graph.nodes) {
    nodeUsage.set(
      node.id,
      routeUsage(
        routes.filter((route) => route.nodeIds.includes(node.id)),
        resourceInstanceCounts.get(node.resourceVersionId) || 1,
      ),
    );
  }

  const edgeUsage = new Map<string, WorkflowRouteUsage>();
  for (const edge of graph.edges) {
    const matching = routes.filter((route) => {
      const sourceIndex = route.nodeIds.indexOf(edge.source);
      return sourceIndex >= 0 && route.nodeIds[sourceIndex + 1] === edge.target;
    });
    edgeUsage.set(edge.id, routeUsage(matching));
  }

  const channelMap = new Map<string, string>();
  const accountMap = new Map<string, { name: string; detail: string }>();
  for (const route of routes) {
    channelMap.set(route.channelId, route.channelName);
    for (const candidate of route.fallbackAccounts) {
      accountMap.set(candidate.accountId, {
        name: candidate.accountName,
        detail: candidate.accountDetail,
      });
    }
  }
  const channels = [...channelMap]
    .map(([id, name]) => ({ id, name }))
    .sort((left, right) => left.name.localeCompare(right.name, "de-DE"));
  const accountRows = [...accountMap]
    .map(([id, value]) => ({ id, ...value }))
    .sort((left, right) => left.name.localeCompare(right.name, "de-DE"));
  const matrix = channels.flatMap((channel) =>
    accountRows.map((account) => ({
      channelId: channel.id,
      accountId: account.id,
      routes: routes.filter(
        (route) =>
          route.channelId === channel.id
          && route.fallbackAccounts.some((candidate) => candidate.accountId === account.id),
      ),
    })),
  );

  const productGroups = new Map<
    string,
    { routes: WorkflowRoute[]; nodeIds: string[] }
  >();
  for (const node of graph.nodes) {
    const matching = routes.filter((route) => route.nodeIds.includes(node.id));
    const channelIds = [
      ...new Set(matching.map((route) => route.channelId)),
    ].sort((left, right) => left.localeCompare(right, "de-DE"));
    const accountIds = [
      ...new Set(matching.map((route) => route.accountId)),
    ].sort((left, right) => left.localeCompare(right, "de-DE"));
    if (channelIds.length < 2 || accountIds.length < 2) continue;
    const key = `${channelIds.join("\0")}::${accountIds.join("\0")}`;
    const group = productGroups.get(key) || { routes: matching, nodeIds: [] };
    group.nodeIds.push(node.id);
    productGroups.set(key, group);
  }
  const crossProducts = [...productGroups.entries()].map(
    ([id, group]): WorkflowCrossProduct => {
      const channelsForGroup = [
        ...new Map(
          group.routes.map((route) => [route.channelId, route.channelName]),
        ).values(),
      ].sort((left, right) => left.localeCompare(right, "de-DE"));
      const accountsForGroup = [
        ...new Map(
          group.routes.map((route) => [route.accountId, route.accountName]),
        ).values(),
      ].sort((left, right) => left.localeCompare(right, "de-DE"));
      return {
        id,
        channelCount: channelsForGroup.length,
        accountCount: accountsForGroup.length,
        routeCount: group.routes.length,
        channels: channelsForGroup,
        accounts: accountsForGroup,
        sharedNodes: [
          ...new Set(
            group.nodeIds.map(
              (nodeId) =>
                resourceForNode(nodeId, graph, resources)?.name || nodeId,
            ),
          ),
        ],
      };
    },
  );

  return {
    routes,
    channels,
    accounts: accountRows,
    matrix,
    nodeUsage,
    edgeUsage,
    crossProducts,
  };
}
